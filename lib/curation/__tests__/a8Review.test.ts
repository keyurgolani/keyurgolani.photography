// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { setDataDir } from '../../../test/helpers/tempDataRoot';
import { readAuthoredRecord } from '../../catalog/working-layer';
import { writeAuthoredRecord } from '../../catalog/working-layer-writer';
import { readRegistry, writeRegistry } from '../../identity/registry';
import { approveEvent, deferEvent, editEvent, reopenEvent, type ActionOutcome } from '../actions';
import { EVENT_ID_RE, EVENT_STATUSES, eventIdOf, eventKey } from '../events';
import { loadInbox, loadInboxSummary } from '../inbox';
import { runInboxBulk } from '../inbox-bulk';
import { bulkChoices } from '../inbox-list';
import type { InboxBulkState, InboxView, ReadyInboxSummary } from '../inbox-view';
import { SUMMARY_EVENT_ID_RE, SUMMARY_STATUSES } from '../inbox-watch';
import { recordLibraryState } from '../library';
import { listEvents, readEvent } from '../repository';
import { createCurationSink } from '../sink';
import { createCurationFixture, DRAFT, writeRules, type CurationFixture } from './curationFixtures';

/**
 * A8's review (prs/A8-review-fixes.md): the poll's arrival cursor (4a), bulk Decide later limited to new photographs
 * and unreadable files (S1), Leave unassigned refusing a saved series (S2), the insertion recomputed at approve time
 * (S3), the concurrency mix (S6), and nits N1, N2 and N8.
 */

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };

async function served(options: Parameters<typeof createCurationFixture>[0] = {}): Promise<CurationFixture> {
    const f = await createCurationFixture(options);
    cleanups.push(() => f.cleanup());
    cleanups.push(setDataDir(f.root));
    return f;
}

const newId = (f: CurationFixture, photoId: string) => eventIdOf(eventKey('new', f.fact('new', photoId)));
const ready = (summary: Awaited<ReturnType<typeof loadInboxSummary>>): ReadyInboxSummary => {
    if (summary.state !== 'ready') throw new Error(`The summary is ${summary.state}`);
    return summary;
};
const readyView = (view: InboxView) => {
    if (view.state !== 'ready') throw new Error(`The inbox is ${view.state}`);
    return view;
};
const answers = (state: InboxBulkState) => {
    if (state.status === 'idle') throw new Error('no answer');
    return state;
};
const bulkForm = (entries: string[]) => {
    const form = new FormData();
    form.set('base', 'none');
    for (const entry of entries) form.append('items', entry);
    return form;
};

describe('the arrival cursor (4a)', () => {
    it('counts every arrival after the cursor, two in the same millisecond included, by the order the server owns', async () => {
        const f = await served({ fresh: 3 });
        const start = ready(await loadInboxSummary(null));
        expect(start.cursor).toBe(0);
        expect(start.arrived).toBeNull();
        // Two facts with one observedAt, delivered at once.
        const at = '2026-02-01T00:00:00.000Z';
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.fresh[0], { observedAt: at }), f.fact('new', f.fresh[1], { observedAt: at })]);
        const after = ready(await loadInboxSummary(null, { since: start.cursor }));
        expect(after.arrived).toBe(2);
        expect(after.cursor).toBeGreaterThan(start.cursor);
        expect(ready(await loadInboxSummary(null, { since: after.cursor })).arrived).toBe(0);
    });

    it('never lets a clock skew hide an arrival: a fact stamped long before the cursor still counts', async () => {
        const f = await served({ fresh: 1 });
        const start = ready(await loadInboxSummary(null, { now: () => Date.parse('2030-01-01T00:00:00.000Z') }));
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.fresh[0], { observedAt: '2001-01-01T00:00:00.000Z' })]);
        expect(ready(await loadInboxSummary(null, { since: start.cursor, now: () => Date.parse('1999-01-01T00:00:00.000Z') })).arrived).toBe(1);
    });

    it('counts an arrival that coincides with a decision elsewhere, when the net count stays the same', async () => {
        const f = await served({ fresh: 2 });
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.fresh[0])]);
        const start = ready(await loadInboxSummary(null));
        expect(start.needsJudgment).toBe(1);
        expect(await deferEvent({ root: f.root, eventId: newId(f, f.fresh[0]), expectedVersion: 1, expectedBase: null, actor: 'curator:cli' })).toMatchObject({ ok: true });
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.fresh[1])]);
        const now = ready(await loadInboxSummary(null, { since: start.cursor }));
        expect(now.needsJudgment).toBe(1);
        expect(now.arrived).toBe(1);
    });

    it('counts a reopened item again, but not an edit to an open one, nor one already decided again', async () => {
        const f = await served({ fresh: 2 });
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.fresh[0]), f.fact('new', f.fresh[1])]);
        const [a, b] = f.fresh.map((photoId) => newId(f, photoId));
        expect(await deferEvent({ root: f.root, eventId: a, expectedVersion: 1, expectedBase: null, actor: 'curator:cli' })).toMatchObject({ ok: true });
        const start = ready(await loadInboxSummary(null));
        expect(await editEvent({ root: f.root, eventId: b, expectedVersion: 1, expectedBase: null, actor: 'curator:cli', choices: { seriesId: DRAFT } })).toMatchObject({ ok: true });
        expect(ready(await loadInboxSummary(null, { since: start.cursor })).arrived).toBe(0);
        expect(await reopenEvent({ root: f.root, eventId: a, expectedVersion: 2, expectedBase: null, actor: 'curator:cli' })).toMatchObject({ ok: true });
        expect(ready(await loadInboxSummary(null, { since: start.cursor })).arrived).toBe(1);
        expect(await deferEvent({ root: f.root, eventId: a, expectedVersion: 3, expectedBase: null, actor: 'curator:cli' })).toMatchObject({ ok: true });
        expect(ready(await loadInboxSummary(null, { since: start.cursor })).arrived).toBe(0);
    });

    it('refuses a cursor it did not issue: one ahead of its own, or not a whole number', async () => {
        const f = await served({ fresh: 1 });
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.fresh[0])]);
        const now = ready(await loadInboxSummary(null));
        for (const since of [now.cursor + 1, Number.MAX_SAFE_INTEGER, -1, 1.5, Number.NaN]) {
            expect(await loadInboxSummary(null, { since }), String(since)).toEqual({ state: 'bad-cursor' });
        }
        expect(ready(await loadInboxSummary(null, { since: now.cursor })).arrived).toBe(0);
        expect(ready(await loadInboxSummary(null, { since: 0 })).arrived).toBe(1);
    });

    it('starts the page from the same cursor the summary answers', async () => {
        const f = await served({ fresh: 1 });
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.fresh[0])]);
        expect(readyView(await loadInbox(null)).cursor).toBe(ready(await loadInboxSummary(null)).cursor);
    });
});

describe('bulk Decide later (S1)', () => {
    it('is offered only for new photographs and files the watcher could not process', () => {
        const row = { status: 'open' as const, group: 'judgment' as const, seriesChosen: false };
        expect(bulkChoices({ ...row, type: 'new' }).defer).toBe(true);
        expect(bulkChoices({ ...row, type: 'processing-failure', status: 'failed' }).defer).toBe(true);
        for (const type of ['missing', 'replacement', 'reappeared', 'ambiguous', 'library-unavailable'] as const) expect(bulkChoices({ ...row, type }).defer, type).toBe(false);
    });

    it('is refused on the server, item by item, for any other type, and the rest go through', async () => {
        const f = await served({ fresh: 1, published: true });
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.fresh[0]), f.fact('missing', f.catalog.series[0].photoIds[0])]);
        expect(await recordLibraryState({ available: false, cause: 'missing' }, { root: f.root, logger: quiet })).toBe('opened');
        const events = (await listEvents(f.root)).events;
        const missing = events.find((event) => event.type === 'missing')!;
        const library = events.find((event) => event.type === 'library-unavailable')!;
        const fresh = newId(f, f.fresh[0]);
        const form = bulkForm([`${fresh}:1`, `${missing.id}:${missing.version}`, `${library.id}:${library.version}`]);
        form.set('base', f.catalog.revisionId);
        const state = answers(await runInboxBulk('defer', form));
        expect(state.results.map((result) => [result.eventId, result.status])).toEqual([[fresh, 'done'], [missing.id, 'refused'], [library.id, 'refused']]);
        expect(state.results[1].message).toMatch(/new photographs and files the watcher couldn't process/);
        expect((await readEvent(f.root, missing.id))?.status).toBe('open');
        expect((await readEvent(f.root, library.id))?.status).toBe('open');
    });

    it('lists an item that went through with a note of its own', async () => {
        const f = await served({ fresh: 2 });
        await createCurationSink({ root: f.root, logger: quiet })(f.fresh.map((photoId) => f.fact('new', photoId)));
        const [a, b] = f.fresh.map((photoId) => newId(f, photoId));
        expect(await editEvent({ root: f.root, eventId: a, expectedVersion: 1, expectedBase: null, actor: 'curator:web', choices: { description: { kind: 'described', text: 'A wall.' } } })).toMatchObject({ ok: true });
        const state = answers(await runInboxBulk('unassigned', bulkForm([`${a}:2`, `${b}:1`])));
        expect(state.status).toBe('done');
        // b has no description, so its approval says publishing waits: that's a note the curator should see.
        expect(state.results.map((result) => [result.eventId, result.note ?? false])).toEqual([[a, false], [b, true]]);
        expect(state.results[1].message).toMatch(/no description/);
    });
});

describe('Leave unassigned and a saved series (S2)', () => {
    it('is not offered for an item with a saved series, and the server refuses one under the lock', async () => {
        const f = await served({ fresh: 2 });
        await createCurationSink({ root: f.root, logger: quiet })(f.fresh.map((photoId) => f.fact('new', photoId)));
        const [a, b] = f.fresh.map((photoId) => newId(f, photoId));
        expect(await editEvent({ root: f.root, eventId: a, expectedVersion: 1, expectedBase: null, actor: 'curator:web', choices: { seriesId: DRAFT } })).toMatchObject({ ok: true });
        const view = readyView(await loadInbox(null));
        const row = view.items.find((entry) => entry.id === a)!;
        expect(row.seriesChosen).toBe(true);
        expect(bulkChoices(row).unassigned).toBe(false);
        expect(bulkChoices(view.items.find((entry) => entry.id === b)!).unassigned).toBe(true);
        const state = answers(await runInboxBulk('unassigned', bulkForm([`${a}:2`, `${b}:1`])));
        expect(state.results.map((result) => [result.eventId, result.status])).toEqual([[a, 'refused'], [b, 'done']]);
        expect(state.results[0].message).toMatch(/series saved on it/);
        expect((await readEvent(f.root, a))).toMatchObject({ status: 'open', version: 2 });
        // A saved "Leave unassigned" is the same choice, so it's offered and goes through.
        const c = await served({ fresh: 1 });
        await createCurationSink({ root: c.root, logger: quiet })([c.fact('new', c.fresh[0])]);
        const kept = newId(c, c.fresh[0]);
        expect(await editEvent({ root: c.root, eventId: kept, expectedVersion: 1, expectedBase: null, actor: 'curator:web', choices: { seriesId: null } })).toMatchObject({ ok: true });
        expect(readyView(await loadInbox(null)).items.find((entry) => entry.id === kept)?.seriesChosen).toBe(false);
        expect(answers(await runInboxBulk('unassigned', bulkForm([`${kept}:2`]))).status).toBe('done');
        cleanups.push(setDataDir(f.root));
        // The writer's own check, so a series saved after the page loaded is refused too.
        expect(await approveEvent({ root: f.root, eventId: a, expectedVersion: 2, expectedBase: null, actor: 'curator:web', choices: { seriesId: null }, keepPlaced: true, keepSavedSeries: true })).toMatchObject({ ok: false, code: 'refused' });
    });
});

describe('the insertion recomputed at approve time (S3)', () => {
    /** A draft series of X (1 June) and Y (30 June), and three new photographs of 2, 3 and 4 June the rules send there. */
    async function batch() {
        const f = await served({ fresh: 3 });
        writeRules(f.root, { schemaVersion: 1, series: [{ seriesId: DRAFT, folders: ['trips'] }] });
        const series = (await readAuthoredRecord(f.root, 'series', DRAFT))!;
        const [x, y] = series.photoIds;
        const registry = await readRegistry(f.root);
        const date = (photoId: string, value: string) => {
            const photo = registry.photos[photoId];
            photo.revisions[photo.source.observedRevision].derived.capturedDate = { value, source: 'fixture' };
        };
        date(x, '2024-06-01');
        date(y, '2024-06-30');
        f.fresh.forEach((photoId, index) => date(photoId, `2024-06-0${index + 2}`));
        await writeRegistry(f.root, registry, registry.version);
        await createCurationSink({ root: f.root, logger: quiet })(f.fresh.map((photoId) => f.fact('new', photoId)));
        return { f, x, y };
    }

    const approve = async (f: CurationFixture, photoId: string): Promise<ActionOutcome> => {
        const event = (await readEvent(f.root, newId(f, photoId)))!;
        return approveEvent({ root: f.root, eventId: event.id, expectedVersion: event.version, expectedBase: null, actor: 'curator:test', choices: {} });
    };

    it('places a batch of 2, 3 and 4 June in date order between X and Y, whatever order they were suggested in', async () => {
        const { f, x, y } = await batch();
        // Each was suggested "after X" before any was placed.
        for (const photoId of f.fresh) expect((await readEvent(f.root, newId(f, photoId)))?.suggestions.placement?.value).toEqual({ after: x });
        for (const photoId of f.fresh) expect(await approve(f, photoId)).toMatchObject({ ok: true });
        expect((await readAuthoredRecord(f.root, 'series', DRAFT))?.photoIds).toEqual([x, ...f.fresh, y]);
    });

    it('falls back to the end when the suggested anchor has left the series and nothing dated is left to place it among', async () => {
        const { f, x, y } = await batch();
        const series = (await readAuthoredRecord(f.root, 'series', DRAFT))!;
        await writeAuthoredRecord({ ...series, photoIds: [y] }, { expectedVersion: series.version, root: f.root });
        const registry = await readRegistry(f.root);
        registry.photos[y].revisions[registry.photos[y].source.observedRevision].derived.capturedDate = null;
        await writeRegistry(f.root, registry, registry.version);
        expect(await approve(f, f.fresh[0])).toMatchObject({ ok: true });
        expect((await readAuthoredRecord(f.root, 'series', DRAFT))?.photoIds).toEqual([y, f.fresh[0]]);
        expect(x).not.toBe(y);
    });

    it('keeps a position the curator picked', async () => {
        const { f, x, y } = await batch();
        const event = (await readEvent(f.root, newId(f, f.fresh[2])))!;
        expect(await approveEvent({ root: f.root, eventId: event.id, expectedVersion: 1, expectedBase: null, actor: 'curator:test', choices: { seriesId: DRAFT, placement: 'start' } })).toMatchObject({ ok: true });
        expect((await readAuthoredRecord(f.root, 'series', DRAFT))?.photoIds).toEqual([f.fresh[2], x, y]);
    });
});

describe('writers at once (S6)', () => {
    it('mixes sink re-deliveries, edits and bulk Decide later on the same items, and keeps every change that said ok', { timeout: 120_000 }, async () => {
        const f = await served({ fresh: 10 });
        await createCurationSink({ root: f.root, logger: quiet })(f.fresh.map((photoId) => f.fact('new', photoId)));
        const ids = f.fresh.map((photoId) => newId(f, photoId));
        const sink = createCurationSink({ root: f.root, logger: quiet, waitMs: 60_000 });
        const work: Promise<unknown>[] = [];
        const edits: { id: string; text: string; result: Promise<ActionOutcome> }[] = [];
        const bulks: Promise<InboxBulkState>[] = [];
        for (const [index, eventId] of ids.entries()) {
            work.push(Promise.resolve(sink([f.fact('new', f.fresh[index])])));
            const text = `Concurrent ${index}.`;
            const result = editEvent({ root: f.root, eventId, expectedVersion: 1, expectedBase: null, actor: `curator:${index}`, waitMs: 60_000, choices: { description: { kind: 'described', text } } });
            edits.push({ id: eventId, text, result });
            work.push(result);
            const bulk = runInboxBulk('defer', bulkForm([`${eventId}:1`]), { waitMs: 60_000 });
            bulks.push(bulk);
            work.push(bulk);
        }
        await Promise.all(work);
        const after = await listEvents(f.root);
        expect(after.problems).toEqual([]);
        for (const { id, text, result } of edits) {
            const outcome = await result;
            const event = after.events.find((entry) => entry.id === id)!;
            if (outcome.ok) expect(event.edits?.description).toEqual({ kind: 'described', text });
            else expect(['stale', 'locked']).toContain(outcome.code);
        }
        for (const bulk of bulks) {
            const state = answers(await bulk);
            for (const result of state.results) {
                const event = after.events.find((entry) => entry.id === result.eventId)!;
                if (result.status === 'done') expect(event.decisions.some((decision) => decision.action === 'defer')).toBe(true);
                else expect(['stale', 'busy']).toContain(result.status);
            }
        }
        // Re-delivered facts changed no item: one event per photograph.
        expect(after.events.filter((event) => event.type === 'new')).toHaveLength(10);
    });
});

describe('the bulk headline (N1)', () => {
    it('says what went through, and leaves what was left to the summary', async () => {
        const f = await served({ fresh: 2 });
        await createCurationSink({ root: f.root, logger: quiet })(f.fresh.map((photoId) => f.fact('new', photoId)));
        const [a, b] = f.fresh.map((photoId) => newId(f, photoId));
        const state = answers(await runInboxBulk('defer', bulkForm([`${a}:1`, `${b}:9`])));
        expect(state.message).toBe('Left 1 of 2 items for later.');
        const none = answers(await runInboxBulk('defer', bulkForm([`${b}:9`])));
        expect(none.message).toBe('Nothing was left for later.');
    });
});

describe("the poll's own checks (N2)", () => {
    it('take the event ID pattern and every status the store has', () => {
        expect(SUMMARY_EVENT_ID_RE.source).toBe(EVENT_ID_RE.source);
        expect([...SUMMARY_STATUSES].sort()).toEqual([...EVENT_STATUSES].sort());
    });
});
