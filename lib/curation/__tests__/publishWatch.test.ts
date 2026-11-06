import { describe, expect, it } from 'vitest';
import type { LedgerRow, ScreenView, WatchAnswer } from '../publish-facts';
import { createWatch, watchNews, WATCH_INTERVAL_MS, WATCH_MAX_CHECKS, WATCH_MAX_ERRORS, WATCH_MIN_GAP_MS } from '../publish-watch';
import { shownText, textDiff, TEXT_DIFF_MAX_CELLS } from '../text-diff';

/**
 * A9's Publish screen extras, pure: the word diff behind `<del>` and
 * `<ins>`, the watch that re-reads stale rows and the live revision every
 * 60 s without a request storm, and what it announces.
 */

describe('textDiff()', () => {
    it('keeps the words both sides share and marks the rest removed or added', () => {
        expect(textDiff('Five mornings on the estuary.', 'Six mornings on the estuary.')).toEqual([
            { type: 'removed', text: 'Five' },
            { type: 'added', text: 'Six' },
            { type: 'same', text: ' mornings on the estuary.' },
        ]);
        expect(textDiff('The coast road.', 'The coast road, west to east.')).toEqual([
            { type: 'same', text: 'The coast ' },
            { type: 'removed', text: 'road.' },
            { type: 'added', text: 'road, west to east.' },
        ]);
    });

    it('treats no text as all added or all removed, and equal text as the same', () => {
        expect(textDiff(null, 'New caption')).toEqual([{ type: 'added', text: 'New caption' }]);
        expect(textDiff('Old caption', null)).toEqual([{ type: 'removed', text: 'Old caption' }]);
        expect(textDiff('Same', 'Same')).toEqual([{ type: 'same', text: 'Same' }]);
        expect(textDiff(null, null)).toEqual([]);
    });

    it('stays within a budget on long text: past it, the whole old text is removed and the whole new one added', () => {
        const long = (word: string) => Array.from({ length: 1000 }, (_, index) => `${word}${index}`).join(' ');
        expect(1999 * 1999).toBeGreaterThan(TEXT_DIFF_MAX_CELLS);
        const started = performance.now();
        expect(textDiff(long('a'), long('b'))).toEqual([{ type: 'removed', text: long('a') }, { type: 'added', text: long('b') }]);
        expect(performance.now() - started).toBeLessThan(200);
    });
});

describe('shownText() (A9 review)', () => {
    it('says a change of spacing alone in words, never as an empty mark', () => {
        expect(shownText({ type: 'removed', text: '  ' })).toBe('whitespace changed');
        expect(shownText({ type: 'added', text: '\n' })).toBe('whitespace changed');
        expect(shownText({ type: 'added', text: ' west' })).toBe(' west');
        expect(shownText({ type: 'same', text: ' ' })).toBe(' ');
    });
});

/** A clock and timers the test drives. */
function harness(answers: (WatchAnswer | Error)[]) {
    let now = 0;
    let hidden = false;
    let busy = false;
    const timers = new Map<number, { at: number; fn: () => void }>();
    let next = 1;
    const seen: WatchAnswer[] = [];
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const pending: (() => void)[] = [];
    const watch = createWatch({
        check: () => {
            calls += 1;
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            const answer = answers.length > 1 ? answers.shift() : answers[0];
            return new Promise<WatchAnswer>((resolve, reject) => {
                pending.push(() => {
                    inFlight -= 1;
                    if (answer instanceof Error) reject(answer);
                    else resolve(answer as WatchAnswer);
                });
            });
        },
        onAnswer: (answer) => void seen.push(answer),
        now: () => now,
        setTimer: (fn, ms) => {
            const id = next++;
            timers.set(id, { at: now + ms, fn });
            return id;
        },
        clearTimer: (id) => void timers.delete(id as number),
        hidden: () => hidden,
        busy: () => busy,
    });
    /** Let every check that's waiting answer. */
    const settle = async () => {
        while (pending.length > 0) {
            (pending.shift() as () => void)();
            // A real macrotask, so the watch's own continuation runs before the next step.
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    };
    /** Move the clock on, firing each timer due, and let their checks answer. */
    const advance = async (ms: number) => {
        const end = now + ms;
        for (;;) {
            const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            timers.delete(due[0]);
            now = due[1].at;
            due[1].fn();
            await settle();
        }
        now = end;
    };
    return {
        watch,
        advance,
        settle,
        seen,
        calls: () => calls,
        maxInFlight: () => maxInFlight,
        timers: () => timers.size,
        setHidden: (value: boolean) => void (hidden = value),
        setBusy: (value: boolean) => void (busy = value),
    };
}

const OK: WatchAnswer = { kind: 'ok', stale: [], draftChanged: false };

describe('createWatch()', () => {
    it('checks once a minute, one request at a time', async () => {
        const h = harness([OK]);
        h.watch.start();
        expect(h.calls()).toBe(0);
        await h.advance(WATCH_INTERVAL_MS - 1);
        expect(h.calls()).toBe(0);
        await h.advance(1);
        expect(h.calls()).toBe(1);
        await h.advance(3 * WATCH_INTERVAL_MS);
        expect(h.calls()).toBe(4);
        expect(h.maxInFlight()).toBe(1);
        expect(h.seen).toHaveLength(4);
    });

    it('sleeps while the tab is hidden, and checks once on coming back, unless it checked moments ago', async () => {
        const h = harness([OK]);
        h.watch.start();
        h.setHidden(true);
        await h.advance(10 * WATCH_INTERVAL_MS);
        expect(h.calls()).toBe(0);
        expect(h.timers()).toBe(0);
        h.setHidden(false);
        h.watch.wake();
        await h.settle();
        expect(h.calls()).toBe(1);
        // Focus again straight away: no second request.
        h.watch.wake();
        h.watch.wake();
        await h.settle();
        expect(h.calls()).toBe(1);
        await h.advance(WATCH_MIN_GAP_MS);
        h.watch.wake();
        await h.settle();
        expect(h.calls()).toBe(2);
    });

    it('never stacks a check on one in flight', async () => {
        const h = harness([OK]);
        h.watch.start();
        await h.advance(WATCH_INTERVAL_MS - 1);
        // The timer fires and its check waits; focus comes and goes meanwhile.
        const fired = h.advance(1);
        for (let index = 0; index < 5; index++) h.watch.wake();
        await fired;
        expect(h.maxInFlight()).toBe(1);
    });

    it('skips a check while a press waits, and tries again a minute on', async () => {
        const h = harness([OK]);
        h.watch.start();
        h.setBusy(true);
        await h.advance(WATCH_INTERVAL_MS);
        expect(h.calls()).toBe(0);
        h.setBusy(false);
        await h.advance(WATCH_INTERVAL_MS);
        expect(h.calls()).toBe(1);
    });

    it('stops once the base moved, since only a reload shows the new ledger', async () => {
        const h = harness([{ kind: 'base-moved', live: { revisionId: `rev_${'c'.repeat(64)}`, number: 4, hash: 'cccccccc' } }]);
        h.watch.start();
        await h.advance(10 * WATCH_INTERVAL_MS);
        expect(h.calls()).toBe(1);
        expect(h.timers()).toBe(0);
        h.watch.wake();
        await h.settle();
        expect(h.calls()).toBe(1);
    });

    it('backs off on errors and stops after a few in a row', async () => {
        const h = harness([new Error('offline')]);
        h.watch.start();
        await h.advance(60 * WATCH_INTERVAL_MS);
        expect(h.calls()).toBe(WATCH_MAX_ERRORS);
        expect(h.timers()).toBe(0);
        // An unreadable answer counts as an error too.
        const u = harness([{ kind: 'unavailable' }]);
        u.watch.start();
        await u.advance(2 * WATCH_INTERVAL_MS);
        expect(u.calls()).toBe(1);
    });

    // A9 review nits.
    it('counts the start as its last check, so a focus straight after it sends nothing', async () => {
        const h = harness([OK]);
        h.watch.start();
        h.watch.wake();
        await h.settle();
        expect(h.calls()).toBe(0);
    });

    it('keeps to its backoff on refocus after an error', async () => {
        const h = harness([new Error('offline'), OK]);
        h.watch.start();
        await h.advance(WATCH_INTERVAL_MS);
        expect(h.calls()).toBe(1);
        // Long past the refocus gap, but inside the doubled wait.
        await h.advance(WATCH_INTERVAL_MS);
        h.watch.wake();
        await h.settle();
        expect(h.calls()).toBe(1);
        await h.advance(WATCH_INTERVAL_MS);
        expect(h.calls()).toBe(2);
    });

    it('says nothing once the session is gone: the refused call rejects, so it backs off and stops (A9 CI fix)', async () => {
        // proxy.ts answers the action with a plain 401, which Next's client rejects without touching the page.
        const h = harness(Array.from({ length: WATCH_MAX_ERRORS + 2 }, () => new Error('An unexpected response was received from the server.')));
        h.watch.start();
        await h.advance(2 ** (WATCH_MAX_ERRORS + 2) * WATCH_INTERVAL_MS);
        expect(h.calls()).toBe(WATCH_MAX_ERRORS);
        expect(h.timers()).toBe(0);
        expect(h.seen).toEqual([]);
    });

    it('is bounded: it stops after its last check, and stop() ends it at once', async () => {
        const h = harness([OK]);
        h.watch.start();
        await h.advance((WATCH_MAX_CHECKS + 10) * WATCH_INTERVAL_MS);
        expect(h.calls()).toBe(WATCH_MAX_CHECKS);
        const s = harness([OK]);
        s.watch.start();
        s.watch.stop();
        await s.advance(5 * WATCH_INTERVAL_MS);
        s.watch.wake();
        expect(s.calls()).toBe(0);
    });
});

const row = (id: string, summary: string, review: LedgerRow['review']): LedgerRow => ({ id, summary, review, kind: 'Changed', blocks: review === 'stale' });
const pageView = (rows: LedgerRow[]) => ({ ledger: { authored: rows, derived: [], health: [] }, active: { revisionId: `rev_${'a'.repeat(64)}`, number: 2, hash: 'aaaaaaaa' } }) as unknown as ScreenView;

describe('watchNews()', () => {
    const view = pageView([row('chg-1', 'Salt Roads: the title changes', 'reviewed'), row('chg-2', 'Pier lamps moves', 'stale'), row('chg-3', 'Harbor wall: the caption changes', 'reviewed')]);

    it('announces only rows that went stale after the page loaded, once each', () => {
        const first = watchNews(view, { kind: 'ok', stale: [{ rowId: 'chg-2', summary: 'Pier lamps moves' }, { rowId: 'chg-1', summary: 'Salt Roads: the title changes' }], draftChanged: false }, new Set());
        expect(first).toEqual({ line: '1 change went stale after this page loaded: Salt Roads: the title changes. Load the updated ledger to review it.', stale: ['chg-1'], baseMoved: null });
        const again = watchNews(view, { kind: 'ok', stale: [{ rowId: 'chg-1', summary: 'Salt Roads: the title changes' }, { rowId: 'chg-3', summary: 'Harbor wall: the caption changes' }, { rowId: 'chg-9', summary: 'Not on this page' }], draftChanged: false }, new Set(first.stale));
        expect(again).toEqual({ line: '1 change went stale after this page loaded: Harbor wall: the caption changes. Load the updated ledger to review it.', stale: ['chg-3'], baseMoved: null });
        expect(watchNews(view, { kind: 'ok', stale: [], draftChanged: false }, new Set()).line).toBe('');
    });

    it('says Base moved, and that the draft changed, in plain words', () => {
        const live = { revisionId: `rev_${'c'.repeat(64)}`, number: 3, hash: 'cccccccc' };
        expect(watchNews(view, { kind: 'base-moved', live }, new Set())).toEqual({ line: 'Base moved. Revision 3 went live after this page loaded. Load the updated ledger.', stale: [], baseMoved: live });
        expect(watchNews(view, { kind: 'ok', stale: [], draftChanged: true }, new Set()).line).toBe('The working catalog changed after this page loaded. Load the updated ledger.');
        expect(watchNews(view, { kind: 'unavailable' }, new Set()).line).toBe('');
    });
});
