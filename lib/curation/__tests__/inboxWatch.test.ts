// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
    createInboxWatch,
    fetchInboxSummary,
    INBOX_WATCH_INTERVAL_MS,
    INBOX_WATCH_MAX_CHECKS,
    INBOX_WATCH_MAX_ERRORS,
    INBOX_WATCH_MIN_GAP_MS,
    inboxNews,
    type InboxWatchAnswer,
    type InboxWatchDeps,
} from '../inbox-watch';
import type { ReadyInboxSummary } from '../inbox-view';

// #14's A8: the Inbox's poll of /api/curation/inbox/summary, on A9's model. One check at a time, none while the tab is
// hidden or the browser is offline, a 15 s gap on refocus, errors backing off to 10 minutes, five in a row or 120
// checks and it stops, and quietly once the server says the session is gone.

const ID = `evt_${'a'.repeat(24)}`;

function summary(overrides: Partial<ReadyInboxSummary> = {}): ReadyInboxSummary {
    return { state: 'ready', readAt: '2026-02-01T03:00:00.000Z', needsJudgment: 2, waiting: 0, placed: 0, unplaced: 0, total: 2, unreadable: 0, watcher: { state: 'running' }, item: { id: ID, version: 3, status: 'open' }, ...overrides };
}

/** A fake clock and timer queue, and a check that answers what the test queues. */
function harness(answers: (InboxWatchAnswer | Error)[] = [], options: { hidden?: boolean; offline?: boolean } = {}) {
    let now = 0;
    const timers: { at: number; run: () => void; id: number }[] = [];
    let next = 1;
    const state = { hidden: options.hidden ?? false, offline: options.offline ?? false, checks: 0, inFlight: 0, maxInFlight: 0 };
    const heard: InboxWatchAnswer[] = [];
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

    it('comes back with resume() once the browser is online again, with the backoff reset', async () => {
        const h = harness([new Error('down'), new Error('down')]);
        h.watch.start();
        await h.advance(INBOX_WATCH_INTERVAL_MS);
        await h.advance(2 * INBOX_WATCH_INTERVAL_MS);
        expect(h.state.checks).toBe(2);
        h.watch.resume();
        await h.advance(0);
        expect(h.state.checks).toBe(3);
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
        expect(await fetchInboxSummary(ID, fetcher)).toEqual({ kind: 'summary', summary: summary() });
        expect(fetcher).toHaveBeenCalledWith(`/api/curation/inbox/summary?item=${ID}`, expect.objectContaining({ cache: 'no-store', redirect: 'manual', credentials: 'same-origin' }));
        await fetchInboxSummary(null, fetcher);
        expect(fetcher).toHaveBeenLastCalledWith('/api/curation/inbox/summary', expect.anything());
    });

    it('reads a 401, a 404 or a redirect as signed out, a server error as unavailable, and a network failure as offline', async () => {
        expect(await fetchInboxSummary(null, respond(401, {}))).toEqual({ kind: 'signed-out' });
        expect(await fetchInboxSummary(null, respond(404, {}))).toEqual({ kind: 'signed-out' });
        expect(await fetchInboxSummary(null, respond(0, {}, { type: 'opaqueredirect' }))).toEqual({ kind: 'signed-out' });
        expect(await fetchInboxSummary(null, respond(503, { state: 'not-ready' }))).toEqual({ kind: 'unavailable' });
        expect(await fetchInboxSummary(null, respond(500, {}))).toEqual({ kind: 'unavailable' });
        expect(await fetchInboxSummary(null, async () => Promise.reject(new TypeError('Failed to fetch')))).toEqual({ kind: 'offline' });
    });

    it('takes only a summary of the shape the route answers', async () => {
        for (const junk of [null, 'x', { state: 'ready' }, { ...summary(), needsJudgment: '2' }, { ...summary(), watcher: { state: 'odd' } }, { ...summary(), item: { id: 'nope', version: 1, status: 'open' } }]) {
            expect(await fetchInboxSummary(null, respond(200, junk))).toEqual({ kind: 'unavailable' });
        }
    });
});

describe('what the watch says', () => {
    const page = { needsJudgment: 2, watcher: { state: 'running' } as const, item: { id: ID, version: 3 } };

    it('says nothing when nothing changed', () => {
        expect(inboxNews(page, { kind: 'summary', summary: summary() }, new Set())).toEqual({ line: '', keys: [], forget: [], itemChanged: false, offline: false, watcher: { state: 'running' } });
    });

    it('says new items need judgment once per count, and points to Refresh', () => {
        const news = inboxNews(page, { kind: 'summary', summary: summary({ needsJudgment: 5 }) }, new Set());
        expect(news.line).toBe('3 new items need judgment. Refresh the inbox to see them.');
        expect(inboxNews(page, { kind: 'summary', summary: summary({ needsJudgment: 3 }) }, new Set()).line).toBe('1 new item needs judgment. Refresh the inbox to see it.');
        expect(inboxNews(page, { kind: 'summary', summary: summary({ needsJudgment: 5 }) }, new Set(news.keys)).line).toBe('');
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
        expect(moved).toMatchObject({ itemChanged: true, line: '' });
        expect(inboxNews(page, { kind: 'summary', summary: summary({ item: null }) }, new Set()).itemChanged).toBe(true);
        expect(inboxNews(page, { kind: 'summary', summary: summary({ item: { id: ID, version: 4, status: 'open' } }) }, new Set(moved.keys)).itemChanged).toBe(false);
        expect(inboxNews({ ...page, item: null }, { kind: 'summary', summary: summary({ item: null }) }, new Set()).itemChanged).toBe(false);
    });

    it('says offline once, and back online once, and nothing for a server error', () => {
        const offline = inboxNews(page, { kind: 'offline' }, new Set());
        expect(offline).toMatchObject({ offline: true, line: expect.stringMatching(/^You're offline/) });
        expect(inboxNews(page, { kind: 'offline' }, new Set(offline.keys)).line).toBe('');
        expect(inboxNews(page, { kind: 'summary', summary: summary() }, new Set(offline.keys))).toMatchObject({ offline: false, line: 'Back online. The inbox is checking for changes again.' });
        expect(inboxNews(page, { kind: 'unavailable' }, new Set())).toMatchObject({ line: '', offline: false, watcher: null });
    });
});
