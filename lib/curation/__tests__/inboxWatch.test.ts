// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
    createInboxWatch,
    fetchInboxSummary,
    INBOX_WATCH_INTERVAL_MS,
    INBOX_WATCH_MAX_CHECKS,
    INBOX_WATCH_MAX_ERRORS,
    INBOX_WATCH_MIN_GAP_MS,
    INBOX_WATCH_ONLINE_GAP_MS,
    inboxNews,
    OFFLINE_TEXT,
    type InboxWatchAnswer,
    type InboxWatchDeps,
} from '../inbox-watch';
import type { ReadyInboxSummary } from '../inbox-view';

// #14's A8: the Inbox's poll of /api/curation/inbox/summary, on A9's model. One check at a time, none while the tab is
// hidden or the browser is offline, a 15 s gap on refocus, a check at once on coming back online (2 s apart at most),
// errors backing off to 10 minutes, five in a row or 120 checks and it stops, and quietly once the server says the
// session is gone.

const ID = `evt_${'a'.repeat(24)}`;

function summary(overrides: Partial<ReadyInboxSummary> = {}): ReadyInboxSummary {
    return { state: 'ready', readAt: '2026-02-01T03:00:00.000Z', cursor: 7, arrived: 0, needsJudgment: 2, waiting: 0, placed: 0, unplaced: 0, total: 2, unreadable: 0, watcher: { state: 'running' }, item: { id: ID, version: 3, status: 'open' }, ...overrides };
}

/** A fake clock and timer queue, and a check that answers what the test queues. */
function harness(answers: (InboxWatchAnswer | Error)[] = [], options: { hidden?: boolean; offline?: boolean } = {}) {
    let now = 0;
    const timers: { at: number; run: () => void; id: number }[] = [];
    let next = 1;
    const state = { hidden: options.hidden ?? false, offline: options.offline ?? false, checks: 0, inFlight: 0, maxInFlight: 0 };
    const heard: InboxWatchAnswer[] = [];
    const states: string[] = [];
    let release: (() => void) | null = null;
    let holdNext = false;
    const deps: InboxWatchDeps = {
        check: async () => {
            state.checks += 1;
            state.inFlight += 1;
            state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
            if (holdNext) await new Promise<void>((resolve) => (release = resolve));
            state.inFlight -= 1;
            const answer = answers.shift() ?? { kind: 'summary', summary: summary() };
            if (answer instanceof Error) throw answer;
            return answer;
        },
        onAnswer: (answer) => heard.push(answer),
        now: () => now,
        setTimer: (run, ms) => {
            const id = next++;
            timers.push({ at: now + ms, run, id });
            return id;
        },
        clearTimer: (id) => {
            const at = timers.findIndex((timer) => timer.id === id);
            if (at >= 0) timers.splice(at, 1);
        },
        hidden: () => state.hidden,
        offline: () => state.offline,
        onState: (watchState) => states.push(watchState),
    };
    const watch = createInboxWatch(deps);
    /** Move the clock on by `ms`, running each timer that falls due, and let its check settle. */
    async function advance(ms: number) {
        const until = now + ms;
        for (;;) {
            timers.sort((a, b) => a.at - b.at);
            const due = timers[0];
            if (!due || due.at > until) break;
            timers.shift();
            now = due.at;
            due.run();
            await vi.waitFor(() => undefined);
            await Promise.resolve();
            await Promise.resolve();
        }
        now = until;
    }
    return {
        watch,
        state,
        heard,
        states,
        timers,
        advance,
        hold: () => (holdNext = true),
        release: async () => {
            holdNext = false;
            release?.();
            await Promise.resolve();
            await Promise.resolve();
        },
        set now(value: number) {
            now = value;
        },
        get now() {
            return now;
        },
    };
}

describe('the Inbox watch', () => {
    it('checks once a minute, and counts the page load as the first check', async () => {
        const h = harness();
        h.watch.start();
        h.watch.wake();
        expect(h.state.checks).toBe(0);
        await h.advance(INBOX_WATCH_INTERVAL_MS - 1);
        expect(h.state.checks).toBe(0);
        await h.advance(1);
        expect(h.state.checks).toBe(1);
        await h.advance(INBOX_WATCH_INTERVAL_MS);
        expect(h.state.checks).toBe(2);
        expect(h.heard).toHaveLength(2);
    });

    it('sleeps while the tab is hidden or the browser is offline, and wakes once on return', async () => {
        const h = harness([], { hidden: true });
        h.watch.start();
        await h.advance(5 * INBOX_WATCH_INTERVAL_MS);
        expect(h.state.checks).toBe(0);
        h.state.hidden = false;
        h.watch.wake();
        await h.advance(0);
        expect(h.state.checks).toBe(1);
        h.state.offline = true;
        await h.advance(3 * INBOX_WATCH_INTERVAL_MS);
        expect(h.state.checks).toBe(1);
    });

    it('takes at most one check per refocus in 15 s, and never two at once', async () => {
        const h = harness();
        h.watch.start();
        await h.advance(INBOX_WATCH_MIN_GAP_MS);
        h.hold();
        h.watch.wake();
        h.watch.wake();
        expect(h.state.checks).toBe(1);
        await h.release();
        await h.advance(1_000);
        h.watch.wake();
        expect(h.state.checks).toBe(1);
        expect(h.state.maxInFlight).toBe(1);
    });

    it('backs off on errors, doubling to 10 minutes, and stops after five in a row', async () => {
        const errors = Array.from({ length: INBOX_WATCH_MAX_ERRORS }, () => new Error('down'));
        const h = harness(errors);
        h.watch.start();
        await h.advance(INBOX_WATCH_INTERVAL_MS);
        expect(h.state.checks).toBe(1);
        expect(h.timers[0].at - h.now).toBe(2 * INBOX_WATCH_INTERVAL_MS);
        await h.advance(2 * INBOX_WATCH_INTERVAL_MS);
        expect(h.timers[0].at - h.now).toBe(4 * INBOX_WATCH_INTERVAL_MS);
        await h.advance(4 * INBOX_WATCH_INTERVAL_MS);
        await h.advance(8 * INBOX_WATCH_INTERVAL_MS);
        expect(h.timers[0].at - h.now).toBe(10 * INBOX_WATCH_INTERVAL_MS);
        await h.advance(10 * INBOX_WATCH_INTERVAL_MS);
        expect(h.state.checks).toBe(INBOX_WATCH_MAX_ERRORS);
        expect(h.timers).toEqual([]);
        // A thrown check is the network: the page hears it as offline.
        expect(h.heard.every((answer) => answer.kind === 'offline')).toBe(true);
    });

    it('comes back with resume() once the browser is online again: one check at once, the backoff reset, then the minute', async () => {
        const h = harness([new Error('down'), new Error('down')]);
        h.watch.start();
        await h.advance(INBOX_WATCH_INTERVAL_MS);
        await h.advance(2 * INBOX_WATCH_INTERVAL_MS);
        expect(h.state.checks).toBe(2);
        // Back online 3 s after the last check, well inside the 15 s a refocus keeps: it checks at once, so the offline
        // state can clear as soon as the server answers.
        await h.advance(3_000);
        h.watch.resume();
        await h.advance(0);
        expect(h.state.checks).toBe(3);
        expect(h.timers).toHaveLength(1);
        expect(h.timers[0].at - h.now).toBe(INBOX_WATCH_INTERVAL_MS);
        // Long after the last check: at once too.
        await h.advance(INBOX_WATCH_INTERVAL_MS - 1);
        h.watch.resume();
        await h.advance(0);
        expect(h.state.checks).toBe(4);
    });

    it('waits out 2 s when the browser comes back online within 2 s of a check, then checks once', async () => {
        const h = harness([new Error('down')]);
        h.watch.start();
        await h.advance(INBOX_WATCH_INTERVAL_MS);
        expect(h.state.checks).toBe(1);
        await h.advance(500);
        h.watch.resume();
        await h.advance(INBOX_WATCH_ONLINE_GAP_MS - 500 - 1);
        expect(h.state.checks).toBe(1);
        await h.advance(1);
        expect(h.state.checks).toBe(2);
        // Flapping on and offline sends no more than one check per 2 s.
        h.watch.resume();
        h.watch.resume();
        await h.advance(INBOX_WATCH_ONLINE_GAP_MS - 1);
        expect(h.state.checks).toBe(2);
        await h.advance(1);
        expect(h.state.checks).toBe(3);
        expect(INBOX_WATCH_ONLINE_GAP_MS).toBe(2_000);
    });

    it('keeps an online event that comes while the tab is hidden, and checks at once when the tab comes back, not at the backoff', async () => {
        const h = harness([new Error('down')]);
        h.watch.start();
        await h.advance(INBOX_WATCH_INTERVAL_MS);
        expect(h.state.checks).toBe(1);
        // Offline after the failed check, then online again while the tab is hidden.
        h.state.offline = true;
        await h.advance(1_000);
        h.state.offline = false;
        h.state.hidden = true;
        h.watch.resume();
        await h.advance(2_000);
        expect(h.state.checks).toBe(1);
        h.state.hidden = false;
        h.watch.wake();
        await h.advance(0);
        expect(h.state.checks).toBe(2);
        expect(h.heard.at(-1)?.kind).toBe('summary');
        expect(h.timers).toHaveLength(1);
        expect(h.timers[0].at - h.now).toBe(INBOX_WATCH_INTERVAL_MS);
    });

    it('keeps an online event that comes while a check is in flight, and checks 2 s after that check started, with the backoff forgotten', async () => {
        const h = harness([new Error('down')]);
        h.watch.start();
        h.hold();
        await h.advance(INBOX_WATCH_INTERVAL_MS);
        expect(h.state.inFlight).toBe(1);
        h.watch.resume();
        await h.release();
        await h.advance(0);
        expect(h.state.checks).toBe(1);
        expect(h.timers).toHaveLength(1);
        expect(h.timers[0].at - h.now).toBe(INBOX_WATCH_ONLINE_GAP_MS);
        await h.advance(INBOX_WATCH_ONLINE_GAP_MS);
        expect(h.state.checks).toBe(2);
        expect(h.timers).toHaveLength(1);
        expect(h.timers[0].at - h.now).toBe(INBOX_WATCH_INTERVAL_MS);
        await h.advance(INBOX_WATCH_INTERVAL_MS - 1);
        expect(h.state.checks).toBe(2);
        expect(h.state.maxInFlight).toBe(1);
    });

    it('runs one check for an online event kept while hidden, by the 2 s rule from the last check, once the tab is back', async () => {
        const h = harness([new Error('down')]);
        h.watch.start();
        await h.advance(INBOX_WATCH_INTERVAL_MS);
        await h.advance(500);
        h.state.hidden = true;
        h.watch.resume();
        await h.advance(500);
        h.state.hidden = false;
        h.watch.wake();
        await h.advance(0);
        expect(h.state.checks).toBe(1);
        // The last check started 1 s ago, so the kept online event checks 1 s from now, once.
        await h.advance(INBOX_WATCH_ONLINE_GAP_MS - 1_000 - 1);
        expect(h.state.checks).toBe(1);
        await h.advance(1);
        expect(h.state.checks).toBe(2);
        h.watch.wake();
        await h.advance(INBOX_WATCH_INTERVAL_MS - 1);
        expect(h.state.checks).toBe(2);
        expect(h.timers).toHaveLength(1);
    });

    it('never starts again from an online event once the session has ended, with the tab visible or hidden', async () => {
        const h = harness([{ kind: 'signed-out' }]);
        h.watch.start();
        await h.advance(INBOX_WATCH_INTERVAL_MS);
        expect(h.states).toEqual(['armed', 'stopped']);
        await h.advance(3_000);
        h.watch.resume();
        await h.advance(10 * INBOX_WATCH_INTERVAL_MS);
        h.state.hidden = true;
        h.watch.resume();
        h.state.hidden = false;
        h.watch.wake();
        await h.advance(10 * INBOX_WATCH_INTERVAL_MS);
        expect(h.state.checks).toBe(1);
        expect(h.timers).toEqual([]);
        expect(h.states).toEqual(['armed', 'stopped']);
    });

    it('starts again from resume() after five errors stopped it: the check is heard, then the minute', async () => {
        const h = harness(Array.from({ length: INBOX_WATCH_MAX_ERRORS }, () => new Error('down')));
        h.watch.start();
        for (const ms of [1, 2, 4, 8, 10]) await h.advance(ms * INBOX_WATCH_INTERVAL_MS);
        expect(h.timers).toEqual([]);
        await h.advance(3_000);
        h.watch.resume();
        await h.advance(0);
        expect(h.state.checks).toBe(INBOX_WATCH_MAX_ERRORS + 1);
        expect(h.heard.at(-1)?.kind).toBe('summary');
        expect(h.timers).toHaveLength(1);
        expect(h.timers[0].at - h.now).toBe(INBOX_WATCH_INTERVAL_MS);
    });

    it('counts the backoff from nothing after resume(), so a resumed check that fails waits 2 minutes and the watch goes on', async () => {
        const h = harness([new Error('down'), new Error('down')]);
        h.watch.start();
        await h.advance(INBOX_WATCH_INTERVAL_MS);
        await h.advance(3_000);
        h.watch.resume();
        await h.advance(0);
        expect(h.state.checks).toBe(2);
        expect(h.timers).toHaveLength(1);
        expect(h.timers[0].at - h.now).toBe(2 * INBOX_WATCH_INTERVAL_MS);
        expect(h.states).toEqual(['armed']);
    });

    it('sends nothing from resume() while the tab is hidden', async () => {
        const h = harness();
        h.watch.start();
        await h.advance(3_000);
        h.state.hidden = true;
        h.watch.resume();
        await h.advance(0);
        expect(h.state.checks).toBe(0);
    });

    it('never has two checks in flight, whatever wake() and resume() do while one is out', async () => {
        const h = harness();
        h.watch.start();
        h.hold();
        await h.advance(INBOX_WATCH_INTERVAL_MS);
        // Out for 3 s, past the 2 s an online check waits, so neither may start another.
        await h.advance(3_000);
        h.watch.wake();
        h.watch.resume();
        await h.advance(0);
        expect(h.state.maxInFlight).toBe(1);
        await h.release();
        expect(h.state.maxInFlight).toBe(1);
    });

    it('starts again from wake() after errors stopped it, at the backoff cap (A8 review S5)', async () => {
        const errors = Array.from({ length: INBOX_WATCH_MAX_ERRORS }, () => new Error('down'));
        const h = harness(errors);
        h.watch.start();
        for (const ms of [1, 2, 4, 8, 10]) await h.advance(ms * INBOX_WATCH_INTERVAL_MS);
        expect(h.state.checks).toBe(INBOX_WATCH_MAX_ERRORS);
        expect(h.timers).toEqual([]);
        h.watch.wake();
        expect(h.timers).toHaveLength(1);
        expect(h.timers[0].at - h.now).toBe(10 * INBOX_WATCH_INTERVAL_MS);
        await h.advance(10 * INBOX_WATCH_INTERVAL_MS);
        expect(h.state.checks).toBe(INBOX_WATCH_MAX_ERRORS + 1);
        expect(h.timers[0].at - h.now).toBe(INBOX_WATCH_INTERVAL_MS);
    });

    it('stops quietly, saying nothing, once the session is gone', async () => {
        const h = harness([{ kind: 'signed-out' }]);
        h.watch.start();
        await h.advance(INBOX_WATCH_INTERVAL_MS);
        expect(h.heard).toEqual([]);
        expect(h.timers).toEqual([]);
        h.watch.wake();
        h.watch.resume();
        await h.advance(10 * INBOX_WATCH_INTERVAL_MS);
        expect(h.state.checks).toBe(1);
    });

    it('says armed once it schedules its first check, and stopped once it stops for good: the session ending, or stop()', async () => {
        const h = harness([{ kind: 'signed-out' }]);
        expect(h.states).toEqual([]);
        h.watch.start();
        expect(h.states).toEqual(['armed']);
        expect(h.timers).toHaveLength(1);
        await h.advance(INBOX_WATCH_INTERVAL_MS);
        expect(h.states).toEqual(['armed', 'stopped']);
        const left = harness();
        left.watch.start();
        left.watch.stop();
        expect(left.states).toEqual(['armed', 'stopped']);
    });

    it('stays armed when errors stop it, since the tab or the network coming back starts it again', async () => {
        const h = harness(Array.from({ length: INBOX_WATCH_MAX_ERRORS }, () => new Error('down')));
        h.watch.start();
        for (const ms of [1, 2, 4, 8, 10]) await h.advance(ms * INBOX_WATCH_INTERVAL_MS);
        expect(h.timers).toEqual([]);
        expect(h.states).toEqual(['armed']);
    });

    it('stops after 120 checks, about two hours', async () => {
        const h = harness();
        h.watch.start();
        for (let n = 0; n < INBOX_WATCH_MAX_CHECKS + 5; n++) await h.advance(INBOX_WATCH_INTERVAL_MS);
        expect(INBOX_WATCH_MAX_CHECKS).toBe(120);
        expect(h.state.checks).toBe(INBOX_WATCH_MAX_CHECKS);
        expect(h.timers).toEqual([]);
    });

    it('does nothing after stop()', async () => {
        const h = harness();
        h.watch.start();
        h.watch.stop();
        h.watch.wake();
        await h.advance(5 * INBOX_WATCH_INTERVAL_MS);
        expect(h.state.checks).toBe(0);
    });
});

describe('fetchInboxSummary', () => {
    const respond = (status: number, body: unknown, init: Partial<Response> = {}) => async () => ({ status, ok: status >= 200 && status < 300, type: 'basic', json: async () => body, ...init }) as Response;

    it('asks for the summary with no cache and no redirect, naming the open item', async () => {
        const fetcher = vi.fn(respond(200, summary()));
        expect(await fetchInboxSummary(ID, null, fetcher)).toEqual({ kind: 'summary', summary: summary() });
        expect(fetcher).toHaveBeenCalledWith(`/api/curation/inbox/summary?item=${ID}`, expect.objectContaining({ cache: 'no-store', redirect: 'manual', credentials: 'same-origin' }));
        await fetchInboxSummary(null, null, fetcher);
        expect(fetcher).toHaveBeenLastCalledWith('/api/curation/inbox/summary', expect.anything());
        await fetchInboxSummary(ID, 4, fetcher);
        expect(fetcher).toHaveBeenLastCalledWith(`/api/curation/inbox/summary?item=${ID}&since=4`, expect.anything());
    });

    it('reads again without the cursor when the server refuses it, and says the cursor moved (4a)', async () => {
        const fetcher = vi.fn(async (url: string) => (url.includes('since=') ? ({ status: 400, ok: false, type: 'basic', json: async () => ({ error: 'bad-cursor' }) } as Response) : ({ status: 200, ok: true, type: 'basic', json: async () => summary({ cursor: 3, arrived: null }) } as Response)));
        expect(await fetchInboxSummary(null, 99, fetcher as unknown as typeof fetch)).toEqual({ kind: 'summary', summary: summary({ cursor: 3, arrived: null }), rebased: true });
        expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/curation/inbox/summary?since=99', '/api/curation/inbox/summary']);
    });

    it('reads a 401, a 404 or a redirect as signed out, a server error as unavailable, and a network failure as offline', async () => {
        expect(await fetchInboxSummary(null, null, respond(401, {}))).toEqual({ kind: 'signed-out' });
        expect(await fetchInboxSummary(null, null, respond(404, {}))).toEqual({ kind: 'signed-out' });
        expect(await fetchInboxSummary(null, null, respond(0, {}, { type: 'opaqueredirect' }))).toEqual({ kind: 'signed-out' });
        expect(await fetchInboxSummary(null, null, respond(503, { state: 'not-ready' }))).toEqual({ kind: 'unavailable' });
        expect(await fetchInboxSummary(null, null, respond(500, {}))).toEqual({ kind: 'unavailable' });
        expect(await fetchInboxSummary(null, null, async () => Promise.reject(new TypeError('Failed to fetch')))).toEqual({ kind: 'offline' });
    });

    it('takes only a summary of the shape the route answers', async () => {
        for (const junk of [null, 'x', { state: 'ready' }, { ...summary(), needsJudgment: '2' }, { ...summary(), watcher: { state: 'odd' } }, { ...summary(), item: { id: 'nope', version: 1, status: 'open' } }]) {
            expect(await fetchInboxSummary(null, null, respond(200, junk))).toEqual({ kind: 'unavailable' });
        }
    });
});

describe('what the watch says', () => {
    const page = { needsJudgment: 2, watcher: { state: 'running' } as const, item: { id: ID, version: 3 } };

    it('says nothing when nothing changed', () => {
        expect(inboxNews(page, { kind: 'summary', summary: summary() }, new Set())).toEqual({ line: '', keys: [], forget: [], itemChanged: false, changedFrom: null, offline: false, refresh: false, watcher: { state: 'running' } });
    });

    it('says new items need judgment once per count, and points to Refresh', () => {
        const news = inboxNews(page, { kind: 'summary', summary: summary({ arrived: 3 }) }, new Set());
        expect(news.line).toBe('3 new items need judgment.');
        expect(news.refresh).toBe(true);
        expect(inboxNews(page, { kind: 'summary', summary: summary({ arrived: 1 }) }, new Set()).line).toBe('1 new item needs judgment.');
        expect(inboxNews(page, { kind: 'summary', summary: summary({ arrived: 3 }) }, new Set(news.keys)).line).toBe('');
        // Arrivals, not the net count (A8 review B4): one came in while another was decided elsewhere.
        expect(inboxNews(page, { kind: 'summary', summary: summary({ needsJudgment: 2, arrived: 1 }) }, new Set()).line).toBe('1 new item needs judgment.');
        // And a count that went up only because the page's own count was out of date says nothing.
        expect(inboxNews(page, { kind: 'summary', summary: summary({ needsJudgment: 9, arrived: 0 }) }, new Set()).line).toBe('');
    });

    it('says when the watcher stops checking in and when it is back, each once', () => {
        const stopped = inboxNews(page, { kind: 'summary', summary: summary({ watcher: { state: 'missing' } }) }, new Set());
        expect(stopped).toMatchObject({ line: expect.stringMatching(/watcher stopped checking in/), watcher: { state: 'missing' } });
        expect(inboxNews(page, { kind: 'summary', summary: summary({ watcher: { state: 'missing' } }) }, new Set(stopped.keys)).line).toBe('');
        const back = inboxNews({ ...page, watcher: { state: 'missing' } }, { kind: 'summary', summary: summary() }, new Set(stopped.keys));
        expect(back.line).toMatch(/watcher is checking in again/);
    });

    it('flags the open item once it changed or left, for the alert, never in the polite line', () => {
        const moved = inboxNews(page, { kind: 'summary', summary: summary({ item: { id: ID, version: 4, status: 'deferred' } }) }, new Set());
        // With the version the page showed, so the item raises its alert only while it still shows that one (S4).
        expect(moved).toMatchObject({ itemChanged: true, line: '', changedFrom: 3 });
        expect(inboxNews(page, { kind: 'summary', summary: summary({ item: null }) }, new Set()).itemChanged).toBe(true);
        expect(inboxNews(page, { kind: 'summary', summary: summary({ item: { id: ID, version: 4, status: 'open' } }) }, new Set(moved.keys)).itemChanged).toBe(false);
        expect(inboxNews({ ...page, item: null }, { kind: 'summary', summary: summary({ item: null }) }, new Set()).itemChanged).toBe(false);
    });

    it('says offline once, and back online once, and nothing for a server error', () => {
        const offline = inboxNews(page, { kind: 'offline' }, new Set());
        // One wording for the line and the notice (N6).
        expect(offline).toMatchObject({ offline: true, line: OFFLINE_TEXT });
        expect(inboxNews(page, { kind: 'offline' }, new Set(offline.keys)).line).toBe('');
        expect(inboxNews(page, { kind: 'summary', summary: summary() }, new Set(offline.keys))).toMatchObject({ offline: false, line: 'Back online. The inbox is checking for changes again.' });
        expect(inboxNews(page, { kind: 'unavailable' }, new Set())).toMatchObject({ line: '', offline: false, watcher: null });
    });
});
