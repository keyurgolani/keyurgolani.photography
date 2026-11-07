import type { InboxWatcher, ReadyInboxSummary } from './inbox-view';

/**
 * #14 (A8): the Inbox's poll. While the page is open it reads
 * /api/curation/inbox/summary every 60 s and when the tab comes back, and the
 * page's one polite region says what changed since it loaded: new items that
 * need judgment, the watcher stopping or coming back, the browser going
 * offline or coming back. The open item changing is flagged for its own
 * `role="alert"`, never the polite line. A9's Publish watch is the model
 * (lib/curation/publish-watch.ts there); this one reads a route, not a
 * server action, and adds the offline state. Client-safe and pure apart from
 * the timers and the fetch it's given, so the bounds are tested here:
 *
 * - one check at a time: the next is scheduled only after an answer, and a
 *   wake while one is in flight does nothing;
 * - nothing while the tab is hidden or the browser says it's offline; when
 *   the tab comes back, one check, unless one ran in the last 15 s; when the
 *   browser is online again, one check at once, or 2 s after the last if one
 *   ran that recently, so the offline state clears as soon as one gets through;
 * - errors back off, doubling up to 10 minutes, and five in a row stop it. A
 *   check that can't reach the server is the offline state; resume(), when
 *   the browser is online again, starts over;
 * - it stops for good after 120 checks (about two hours), and quietly, with
 *   nothing said, once the server says the session is gone.
 */

export const INBOX_WATCH_INTERVAL_MS = 60_000;
export const INBOX_WATCH_MIN_GAP_MS = 15_000;
/** The least time between checks when the browser comes back online, so flapping on and offline is no request storm. */
export const INBOX_WATCH_ONLINE_GAP_MS = 2_000;
export const INBOX_WATCH_MAX_CHECKS = 120;
export const INBOX_WATCH_MAX_ERRORS = 5;
const MAX_BACKOFF_MS = 10 * 60_000;

export const SUMMARY_PATH = '/api/curation/inbox/summary';

/** The window event the open item listens for (ItemActions), once the poll sees it changed since the page loaded. */
export const ITEM_CHANGED_EVENT = 'curation-inbox:item-changed';

/** `rebased`: the server refused the cursor the poll sent, so this answer counts from its own cursor instead (4a). */
export type InboxWatchAnswer = { kind: 'summary'; summary: ReadyInboxSummary; rebased?: true } | { kind: 'signed-out' } | { kind: 'offline' } | { kind: 'unavailable' };

/** One wording for the offline state, in the notice and in the live line alike (A8 review N6). */
export const OFFLINE_TEXT = "You're offline, or the server can't be reached, so the inbox can't check for changes, and what it shows may be out of date. An action won't go through until you're back.";

export interface InboxWatchDeps {
    check: () => Promise<InboxWatchAnswer>;
    onAnswer: (answer: InboxWatchAnswer) => void;
    now: () => number;
    setTimer: (run: () => void, ms: number) => unknown;
    clearTimer: (timer: unknown) => void;
    hidden: () => boolean;
    /** True while the browser says it has no network. */
    offline?: () => boolean;
}

export interface InboxWatch {
    start(): void;
    stop(): void;
    /** The tab came back or took focus: check now, unless one ran moments ago or one is in flight. */
    wake(): void;
    /** The browser is online again: forget the backoff and check at once, or 2 s after the last check, even after errors stopped it. */
    resume(): void;
}

export function createInboxWatch(deps: InboxWatchDeps): InboxWatch {
    let timer: unknown = null;
    let stopped = true;
    /** Stopped for good: the session ended, or the cap ran out. resume() doesn't undo it. */
    let ended = false;
    let inFlight = false;
    let checks = 0;
    let errors = 0;
    let last = -Infinity;

    const asleep = () => deps.hidden() || (deps.offline?.() ?? false);
    const backoff = () => Math.min(INBOX_WATCH_INTERVAL_MS * 2 ** errors, MAX_BACKOFF_MS);
    const clear = () => {
        if (timer !== null) deps.clearTimer(timer);
        timer = null;
    };
    const schedule = (ms: number) => {
        clear();
        if (!stopped) timer = deps.setTimer(tick, ms);
    };
    const end = (forGood: boolean) => {
        stopped = true;
        ended ||= forGood;
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
            // The session ended: stop without a word, and never swap the page for an error (A9's review).
            if (answer.kind === 'signed-out') return end(true);
            deps.onAnswer(answer);
            failed = answer.kind !== 'summary';
        } catch {
            failed = true;
            if (!stopped) deps.onAnswer({ kind: 'offline' });
        } finally {
            inFlight = false;
        }
        if (stopped) return;
        errors = failed ? errors + 1 : 0;
        if (checks >= INBOX_WATCH_MAX_CHECKS) return end(true);
        if (errors >= INBOX_WATCH_MAX_ERRORS) return end(false);
        schedule(failed ? backoff() : INBOX_WATCH_INTERVAL_MS);
    }

    function tick(): void {
        timer = null;
        if (stopped || inFlight) return;
        // Hidden or offline: sleep with no timer; wake() or resume() picks it up.
        if (asleep()) return;
        void run();
    }

    return {
        start() {
            if (!stopped || ended) return;
            stopped = false;
            // The page's own load counts as a check, so a focus straight after it sends nothing.
            last = deps.now();
            schedule(INBOX_WATCH_INTERVAL_MS);
        },
        stop: () => end(true),
        wake() {
            // A8 review S5: errors stopped it, but the curator is back on the tab: try again, at the backoff's cap.
            if (stopped && !ended && errors >= INBOX_WATCH_MAX_ERRORS && !asleep()) {
                stopped = false;
                schedule(MAX_BACKOFF_MS);
                return;
            }
            if (stopped || inFlight || asleep()) return;
            // After an error the backoff's timer decides; one asleep while hidden picks it up again.
            if (errors > 0) {
                if (timer === null) schedule(backoff());
                return;
            }
            const since = deps.now() - last;
            if (since >= INBOX_WATCH_MIN_GAP_MS) {
                clear();
                void run();
            } else if (timer === null) {
                schedule(Math.max(INBOX_WATCH_MIN_GAP_MS - since, 0) || INBOX_WATCH_INTERVAL_MS);
            }
        },
        resume() {
            if (ended || inFlight || asleep()) return;
            stopped = false;
            errors = 0;
            clear();
            // At once, so the offline state clears as soon as the server answers; 2 s apart at most, so flapping on and
            // offline is no request storm.
            const since = deps.now() - last;
            if (since >= INBOX_WATCH_ONLINE_GAP_MS) void run();
            else schedule(INBOX_WATCH_ONLINE_GAP_MS - since);
        },
    };
}

/** As lib/curation/events.ts's EVENT_ID_RE and EVENT_STATUSES, which this client-side module can't import. A test pins both (N2). */
export const SUMMARY_EVENT_ID_RE = /^evt_[0-9a-f]{24}$/;
export const SUMMARY_STATUSES: ReadonlySet<string> = new Set(['open', 'deferred', 'dismissed', 'approved', 'failed', 'resolved']);
const EVENT_ID = SUMMARY_EVENT_ID_RE;
const STATUSES = SUMMARY_STATUSES;
const count = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0;

function watcherOf(value: unknown): InboxWatcher | null {
    if (typeof value !== 'object' || value === null) return null;
    const watcher = value as Record<string, unknown>;
    if (watcher.state === 'running' || watcher.state === 'missing') return { state: watcher.state };
    if (watcher.state === 'stale' && typeof watcher.heartbeatAt === 'string' && typeof watcher.ageMs === 'number' && Number.isFinite(watcher.ageMs)) {
        return { state: 'stale', heartbeatAt: watcher.heartbeatAt, ageMs: watcher.ageMs };
    }
    return null;
}

/** The route's answer, if it has the shape the route answers. Anything else is unusable, never trusted. */
function summaryOf(value: unknown): ReadyInboxSummary | null {
    if (typeof value !== 'object' || value === null) return null;
    const body = value as Record<string, unknown>;
    if (body.state !== 'ready' || typeof body.readAt !== 'string') return null;
    if (![body.cursor, body.needsJudgment, body.waiting, body.placed, body.unplaced, body.total, body.unreadable].every(count)) return null;
    if (body.arrived !== null && !count(body.arrived)) return null;
    const watcher = watcherOf(body.watcher);
    if (watcher === null) return null;
    let item: ReadyInboxSummary['item'] = null;
    if (body.item !== null) {
        const raw = body.item as Record<string, unknown> | undefined;
        if (typeof raw !== 'object' || typeof raw.id !== 'string' || !EVENT_ID.test(raw.id) || !count(raw.version) || typeof raw.status !== 'string' || !STATUSES.has(raw.status)) return null;
        item = { id: raw.id, version: raw.version as number, status: raw.status as NonNullable<ReadyInboxSummary['item']>['status'] };
    }
    return {
        state: 'ready',
        readAt: body.readAt,
        cursor: body.cursor as number,
        arrived: body.arrived as number | null,
        needsJudgment: body.needsJudgment as number,
        waiting: body.waiting as number,
        placed: body.placed as number,
        unplaced: body.unplaced as number,
        total: body.total as number,
        unreadable: body.unreadable as number,
        watcher,
        item,
    };
}

/**
 * One read of the summary route, as the poll makes it: never cached, never following a redirect (a session that
 * ended is sent to the login page), and only on this origin. A 401, 403 or 404, or a redirect, is the session gone;
 * any other refusal, or an answer of another shape, unavailable; a request that never reached the server, offline.
 */
export async function fetchInboxSummary(itemId: string | null, since: number | null, fetcher: typeof fetch = fetch): Promise<InboxWatchAnswer> {
    const query = new URLSearchParams();
    if (itemId !== null && EVENT_ID.test(itemId)) query.set('item', itemId);
    if (since !== null && Number.isSafeInteger(since) && since >= 0) query.set('since', String(since));
    const at = () => (query.toString() ? `${SUMMARY_PATH}?${query.toString()}` : SUMMARY_PATH);
    const answer = await readSummary(at(), fetcher);
    // A8 review, 4a: a cursor the server didn't issue, as after a restore of the data root. Read again without it.
    if (answer === 'bad-cursor') {
        query.delete('since');
        const again = await readSummary(at(), fetcher);
        return again === 'bad-cursor' ? { kind: 'unavailable' } : again.kind === 'summary' ? { ...again, rebased: true } : again;
    }
    return answer;
}

async function readSummary(url: string, fetcher: typeof fetch): Promise<InboxWatchAnswer | 'bad-cursor'> {
    let response: Response;
    try {
        response = await fetcher(url, { cache: 'no-store', redirect: 'manual', credentials: 'same-origin', headers: { accept: 'application/json' } });
    } catch {
        return { kind: 'offline' };
    }
    if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 403 || response.status === 404 || (response.status >= 300 && response.status < 400)) return { kind: 'signed-out' };
    if (response.status === 400) {
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
        return body?.error === 'bad-cursor' ? 'bad-cursor' : { kind: 'unavailable' };
    }
    if (!response.ok) return { kind: 'unavailable' };
    try {
        const summary = summaryOf(await response.json());
        return summary === null ? { kind: 'unavailable' } : { kind: 'summary', summary };
    } catch {
        return { kind: 'unavailable' };
    }
}

/** What the page knows now: the count it showed, the watcher it last heard of, and the open item as it loaded. */
export interface InboxPageFacts {
    needsJudgment: number;
    watcher: InboxWatcher;
    item: { id: string; version: number } | null;
}

export interface InboxNews {
    /** What the polite region says, or '' for nothing new. */
    line: string;
    /** What it said, so the next answer doesn't say it again. */
    keys: string[];
    /** What it no longer holds as said, so it can say it again later: going offline once back online, and so on. */
    forget: string[];
    /** The open item changed or left since the page loaded: the item's own alert says so. */
    itemChanged: boolean;
    /** The version the page showed when it changed, so the item raises its alert only while it still shows that one (S4). */
    changedFrom: number | null;
    /** The line tells of new items, so the region follows it with the "Refresh the inbox" link. */
    refresh: boolean;
    offline: boolean;
    /** The watcher as this answer says it, or null when it says nothing about it. */
    watcher: InboxWatcher | null;
}

const OFFLINE_LINE = OFFLINE_TEXT;
const BACK_LINE = 'Back online. The inbox is checking for changes again.';

/**
 * The news in one answer, against what the page knows and what was said already, each said once: new items needing
 * judgment (by how many more than the page shows), the watcher stopping or coming back, the browser offline or back.
 */
export function inboxNews(page: InboxPageFacts, answer: InboxWatchAnswer, announced: ReadonlySet<string>): InboxNews {
    const news: InboxNews = { line: '', keys: [], forget: [], itemChanged: false, changedFrom: null, offline: false, refresh: false, watcher: null };
    if (answer.kind === 'signed-out' || answer.kind === 'unavailable') return news;
    if (answer.kind === 'offline') {
        news.offline = true;
        if (!announced.has('offline')) {
            news.line = OFFLINE_LINE;
            news.keys.push('offline');
        }
        return news;
    }
    const { summary } = answer;
    const lines: string[] = [];
    news.watcher = summary.watcher;
    if (announced.has('offline')) {
        lines.push(BACK_LINE);
        news.forget.push('offline');
    }
    // The link after the line is named "Refresh the inbox", so the line doesn't say it again (C1 review).
    // A8 review B4, 4a: the items that arrived after the page's cursor, by the server's own order, not the net count,
    // which an item decided elsewhere would cancel out.
    const more = summary.arrived ?? 0;
    if (more > 0 && !announced.has(`arrived:${more}`)) {
        lines.push(more === 1 ? '1 new item needs judgment.' : `${more} new items need judgment.`);
        news.refresh = true;
        news.keys.push(`arrived:${more}`);
    }
    const wasRunning = page.watcher.state === 'running';
    const running = summary.watcher.state === 'running';
    if (wasRunning && !running && !announced.has('watcher:stopped')) {
        lines.push("The watcher stopped checking in, so new photographs won't appear here until it runs.");
        news.keys.push('watcher:stopped');
    } else if (!wasRunning && running) {
        lines.push('The watcher is checking in again.');
        news.forget.push('watcher:stopped');
    }
    if (page.item !== null && !announced.has(`item:${page.item.id}`) && (summary.item === null || summary.item.id !== page.item.id || summary.item.version !== page.item.version)) {
        news.itemChanged = true;
        news.changedFrom = page.item.version;
        news.keys.push(`item:${page.item.id}`);
    }
    news.line = lines.join(' ');
    return news;
}
