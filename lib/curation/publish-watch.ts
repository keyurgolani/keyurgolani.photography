import type { RevisionFacts, ScreenView, WatchAnswer } from './publish-facts';

/**
 * A9's watch on the Publish screen (#182): while the page is open it asks
 * the server again, every 60 s and when the tab comes back, which rows are
 * stale now and whether the live revision moved, and the one live region
 * says what changed since the page loaded. Client-safe and pure apart from
 * the timers and the check it's given, so the bounds are tested here:
 *
 * - one check at a time: the next is scheduled only after an answer, and a
 *   wake while one is in flight does nothing;
 * - nothing while the tab is hidden, and on coming back one check, unless
 *   one ran in the last WATCH_MIN_GAP_MS, so switching tabs back and forth
 *   doesn't become a request storm;
 * - no check while a press of Validate, Publish or a fix waits, since the
 *   server runs one action at a time per page;
 * - errors back off, doubling up to 10 minutes, and WATCH_MAX_ERRORS in a
 *   row stop it, as an unreadable answer does;
 * - it stops for good after WATCH_MAX_CHECKS (about two hours), once the
 *   base moved, since only a reload shows the new ledger, and, quietly,
 *   once the server says the session is gone.
 */

export const WATCH_INTERVAL_MS = 60_000;
export const WATCH_MIN_GAP_MS = 15_000;
export const WATCH_MAX_CHECKS = 120;
export const WATCH_MAX_ERRORS = 5;
const MAX_BACKOFF_MS = 10 * 60_000;

export interface WatchDeps {
    check: () => Promise<WatchAnswer>;
    onAnswer: (answer: WatchAnswer) => void;
    now: () => number;
    setTimer: (run: () => void, ms: number) => unknown;
    clearTimer: (timer: unknown) => void;
    hidden: () => boolean;
    /** True while a press waits on the screen's own action. */
    busy?: () => boolean;
}

export interface Watch {
    start(): void;
    stop(): void;
    /** The tab came back or took focus: check now, unless one ran moments ago or one is in flight. */
    wake(): void;
}

export function createWatch(deps: WatchDeps): Watch {
    let timer: unknown = null;
    let stopped = true;
    let inFlight = false;
    let checks = 0;
    let errors = 0;
    let last = -Infinity;

    const clear = () => {
        if (timer !== null) deps.clearTimer(timer);
        timer = null;
    };
    const schedule = (ms: number) => {
        clear();
        if (!stopped) timer = deps.setTimer(tick, ms);
    };
    const end = () => {
        stopped = true;
        clear();
    };

    async function run(): Promise<void> {
        inFlight = true;
        last = deps.now();
        checks += 1;
        let failed = false;
        try {
            const answer = await deps.check();
            if (stopped) return;
            // The session ended: stop without a word, and never swap the page for an error (A9 review).
            if (answer.kind === 'signed-out') return end();
            deps.onAnswer(answer);
            if (answer.kind === 'base-moved') return end();
            failed = answer.kind === 'unavailable';
        } catch {
            failed = true;
        } finally {
            inFlight = false;
        }
        if (stopped) return;
        errors = failed ? errors + 1 : 0;
        if (errors >= WATCH_MAX_ERRORS || checks >= WATCH_MAX_CHECKS) return end();
        schedule(failed ? Math.min(WATCH_INTERVAL_MS * 2 ** errors, MAX_BACKOFF_MS) : WATCH_INTERVAL_MS);
    }

    function tick(): void {
        timer = null;
        if (stopped || inFlight) return;
        // Hidden: sleep with no timer; wake() picks it up when the tab comes back.
        if (deps.hidden()) return;
        if (deps.busy?.()) return schedule(WATCH_INTERVAL_MS);
        void run();
    }

    return {
        start() {
            if (!stopped) return;
            stopped = false;
            // The page's own load counts as a check, so a focus straight after it sends nothing.
            last = deps.now();
            schedule(WATCH_INTERVAL_MS);
        },
        stop: end,
        wake() {
            if (stopped || inFlight || deps.hidden()) return;
            // After an error the backoff's timer decides; one asleep while hidden picks it up again.
            if (errors > 0) {
                if (timer === null) schedule(Math.min(WATCH_INTERVAL_MS * 2 ** errors, MAX_BACKOFF_MS));
                return;
            }
            const since = deps.now() - last;
            if (since >= WATCH_MIN_GAP_MS && !deps.busy?.()) {
                clear();
                void run();
            } else if (timer === null) {
                schedule(Math.max(WATCH_MIN_GAP_MS - since, 0) || WATCH_INTERVAL_MS);
            }
        },
    };
}

/** What a watch answer means for the page: the line the live region says, the rows it newly announces, and the live revision when the base moved. */
export interface WatchNews {
    line: string;
    /** The keys it announced, row IDs and `draft-changed`, so the next answer doesn't say them again. */
    stale: string[];
    baseMoved: RevisionFacts | null;
}

const NOTHING: WatchNews = { line: '', stale: [], baseMoved: null };

/**
 * The news in a watch answer, against the page as it loaded and what was
 * announced already: rows on this page that weren't stale at load and are
 * now, the draft changing, or the base moving, each said once.
 */
export function watchNews(view: Pick<ScreenView, 'ledger'>, answer: WatchAnswer, announced: ReadonlySet<string>): WatchNews {
    if (answer.kind === 'unavailable' || answer.kind === 'signed-out') return NOTHING;
    if (answer.kind === 'base-moved') return { line: `Base moved. Revision ${answer.live.number} went live after this page loaded. Load the updated ledger.`, stale: [], baseMoved: answer.live };
    const rows = new Map([...view.ledger.authored, ...view.ledger.derived, ...view.ledger.health].map((row) => [row.id, row]));
    const fresh = answer.stale.filter((entry) => {
        const row = rows.get(entry.rowId);
        return row !== undefined && row.review !== 'stale' && row.review !== 'conflict' && !announced.has(entry.rowId);
    });
    if (fresh.length > 0) {
        const n = fresh.length;
        const lead = n === 1 ? '1 change went stale' : `${n} changes went stale`;
        return { line: `${lead} after this page loaded: ${fresh.map((entry) => entry.summary).join('; ')}. Load the updated ledger to review ${n === 1 ? 'it' : 'them'}.`, stale: fresh.map((entry) => entry.rowId), baseMoved: null };
    }
    if (answer.draftChanged && !announced.has('draft-changed')) return { line: 'The working catalog changed after this page loaded. Load the updated ledger.', stale: ['draft-changed'], baseMoved: null };
    return NOTHING;
}
