// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { setDataDir } from '../../../test/helpers/tempDataRoot';
import { readRegistry, writeRegistry } from '../../identity/registry';
import { readAuthoredRecord } from '../../catalog/working-layer';
import { writeWatcherHeartbeat } from '../../identity/heartbeat';
import { editEvent, deferEvent } from '../actions';
import { EVENT_STATUSES, EVENT_TYPES, eventIdOf, eventKey, type CurationEvent } from '../events';
import { loadInbox, loadInboxSummary } from '../inbox';
import { MAX_BULK_ITEMS, runInboxBulk } from '../inbox-bulk';
import {
    ageLabel,
    bulkChoices,
    INBOX_PAGE_SIZE,
    inboxQueryString,
    listPage,
    parseInboxQuery,
    rowLabels,
    STATUS_FILTERS,
    TYPE_FILTERS,
} from '../inbox-list';
import type { InboxItem, InboxView } from '../inbox-view';
import { LIBRARY_EVENT_ID, recordLibraryState } from '../library';
import { listEvents, readEvent } from '../repository';
import { createCurationSink } from '../sink';
import { createCurationFixture, DRAFT, writeRules, type CurationFixture } from './curationFixtures';

/**
 * #14's A8: the Inbox screen's filters, paging, age labels and bulk actions,
 * the summary its poll reads, and 50 writers at once. The page's pieces are
 * app/curation/inbox/__tests__/InboxScreen.test.tsx's; the route is
 * __tests__/inboxSummaryRoute.test.ts's.
 */

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
const NOW = Date.parse('2026-02-01T03:00:00.000Z');

async function served(options: Parameters<typeof createCurationFixture>[0] = {}): Promise<CurationFixture> {
    const f = await createCurationFixture(options);
    cleanups.push(() => f.cleanup());
    cleanups.push(setDataDir(f.root));
    return f;
}

const ready = (view: InboxView) => {
    if (view.state !== 'ready') throw new Error(`The inbox is ${view.state}`);
    return view;
};

const newId = (f: CurationFixture, photoId: string) => eventIdOf(eventKey('new', f.fact('new', photoId)));

function item(n: number, overrides: Partial<InboxItem> = {}): InboxItem {
    return {
        id: `evt_${String(n).padStart(24, '0')}`,
        version: 1,
        type: 'new',
        status: 'open',
        group: 'judgment',
        title: 'Uncurated photograph',
        photoId: null,
        shortId: 'no photo ID',
        sourcePath: `trips/photo-${n}.jpg`,
        thumbnailUrl: null,
        waiting: null,
        placedBy: null,
        unplacedSeries: null,
        observedAt: '2026-02-01T00:00:00.000Z',
        ...overrides,
    };
}

describe('the list query', () => {
    it('reads Status, Type and the page, and drops anything it does not know', () => {
        expect(parseInboxQuery({})).toEqual({ status: null, type: null, page: 1 });
        expect(parseInboxQuery({ status: 'deferred', type: 'library-unavailable', page: '3' })).toEqual({ status: 'deferred', type: 'library-unavailable', page: 3 });
        // Junk is the default, never an error page: a hand-typed URL still shows the inbox.
        for (const junk of [{ status: 'open<script>' }, { type: 'nope' }, { page: '0' }, { page: '-1' }, { page: '1e3' }, { page: '99999' }, { status: ['open', 'failed'] }]) {
            expect(parseInboxQuery(junk)).toMatchObject({ ...(Object.hasOwn(junk, 'status') ? { status: null } : {}), ...(Object.hasOwn(junk, 'type') ? { type: null } : {}), ...(Object.hasOwn(junk, 'page') ? { page: 1 } : {}) });
        }
    });

    it('writes the query back in one order, leaving out the defaults', () => {
        expect(inboxQueryString({ status: null, type: null, page: 1 })).toBe('');
        expect(inboxQueryString({ status: 'open', type: 'missing', page: 2 })).toBe('?status=open&type=missing&page=2');
        expect(inboxQueryString({ status: null, type: 'new', page: 1 }, { item: 'evt_000000000000000000000001' })).toBe('?type=new&item=evt_000000000000000000000001');
    });

    it('builds the Type filter from EVENT_TYPES, so it lists library-unavailable, and Status from EVENT_STATUSES', () => {
        expect(TYPE_FILTERS.map((option) => option.value)).toEqual([...EVENT_TYPES]);
        expect(TYPE_FILTERS.find((option) => option.value === 'library-unavailable')?.label).toBe('Library unavailable');
        expect(STATUS_FILTERS.map((option) => option.value)).toEqual([...EVENT_STATUSES]);
        expect(new Set(STATUS_FILTERS.map((option) => option.label)).size).toBe(EVENT_STATUSES.length);
    });
});

describe('paging', () => {
    const many = Array.from({ length: 120 }, (_, index) => item(index + 1, index % 3 === 0 ? { type: 'missing', title: 'Source file missing' } : {}));

    it('shows 50 items a page, in the list order, with the count and the range', () => {
        expect(INBOX_PAGE_SIZE).toBe(50);
        const first = listPage(many, { status: null, type: null, page: 1 });
        expect(first).toMatchObject({ total: 120, page: 1, pages: 3, from: 1, to: 50 });
        expect(first.items.map((entry) => entry.id)).toEqual(many.slice(0, 50).map((entry) => entry.id));
        expect(listPage(many, { status: null, type: null, page: 3 })).toMatchObject({ page: 3, from: 101, to: 120 });
        expect(listPage(many, { status: null, type: null, page: 3 }).items).toHaveLength(20);
    });

    it('filters before it pages, and puts a page past the end on the last one', () => {
        const missing = listPage(many, { status: null, type: 'missing', page: 9 });
        expect(missing).toMatchObject({ total: 40, page: 1, pages: 1, from: 1, to: 40 });
        expect(missing.items.every((entry) => entry.type === 'missing')).toBe(true);
        const none = listPage(many, { status: 'resolved', type: null, page: 1 });
        expect(none).toMatchObject({ total: 0, page: 1, pages: 1, from: 0, to: 0, items: [] });
    });
});

describe('age labels', () => {
    it('say how long ago the item opened, in the Inbox short words, rounded down', () => {
        const at = '2026-02-01T03:00:00.000Z';
        expect(ageLabel(at, '2026-02-01T02:59:30.000Z')).toBe('Opened under a minute ago');
        expect(ageLabel(at, '2026-02-01T02:01:00.000Z')).toBe('Opened 59 min ago');
        expect(ageLabel(at, '2026-01-31T00:00:00.000Z')).toBe('Opened 27 h ago');
        expect(ageLabel(at, '2026-01-20T00:00:00.000Z')).toBe('Opened 12 days ago');
        // A stamp ahead of the server's clock is never "-3 min ago".
        expect(ageLabel(at, '2026-02-01T03:10:00.000Z')).toBe('Opened under a minute ago');
        expect(ageLabel(at, 'not a time')).toBe('');
    });
});

describe('bulk choices and row names', () => {
    it('offer Decide later to open and failed items, and Leave unassigned only to a new photograph a series does not hold', () => {
        expect(bulkChoices(item(1))).toEqual({ defer: true, unassigned: true });
        expect(bulkChoices(item(1, { status: 'deferred', group: 'deferred' }))).toEqual({ defer: false, unassigned: true });
        expect(bulkChoices(item(1, { group: 'placed', placedBy: 'Harbor' }))).toEqual({ defer: true, unassigned: false });
        expect(bulkChoices(item(1, { type: 'missing' }))).toEqual({ defer: true, unassigned: false });
        expect(bulkChoices(item(1, { type: 'processing-failure', status: 'failed' }))).toEqual({ defer: true, unassigned: false });
        expect(bulkChoices(item(1, { status: 'approved', group: 'settled' }))).toEqual({ defer: false, unassigned: false });
    });

    it('name every row by its file, and tell two alike apart by folder, then photo ID, then place', () => {
        const rows = [
            item(1, { sourcePath: 'a/harbor.jpg' }),
            item(2, { sourcePath: 'b/harbor.jpg' }),
            item(3, { sourcePath: 'c/dawn.jpg', shortId: 'ph_0000…0003' }),
            item(4, { sourcePath: 'c/dawn.jpg', type: 'missing', title: 'Source file missing', shortId: 'ph_0000…0004' }),
            item(5, { sourcePath: 'pier.jpg' }),
            item(6, { sourcePath: 'pier.jpg' }),
            item(7, { sourcePath: '.', type: 'library-unavailable', title: 'Library unavailable' }),
        ];
        const labels = rowLabels(rows);
        expect([...labels.values()]).toHaveLength(new Set(labels.values()).size);
        expect(labels.get(rows[0].id)).toBe('harbor.jpg in a');
        expect(labels.get(rows[2].id)).toBe('dawn.jpg, Uncurated photograph');
        expect(labels.get(rows[3].id)).toBe('dawn.jpg, Source file missing');
        expect(labels.get(rows[4].id)).toMatch(/^pier\.jpg, /);
        expect(labels.get(rows[6].id)).toBe('The photo library');
    });
});

describe('loadInbox for the screen', () => {
    it('stamps when it read the inbox and when each item opened', async () => {
        const f = await served();
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.fresh[0])]);
        const view = ready(await loadInbox(null, { now: () => NOW }));
        expect(view.readAt).toBe(new Date(NOW).toISOString());
        expect(view.items[0].observedAt).toBe('2026-02-01T00:00:00.000Z');
    });

    it('selects the first item a filter keeps, when the URL names none', async () => {
        const f = await served({ fresh: 2 });
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.fresh[0]), f.fact('missing', f.catalog.series[0].photoIds[0])]);
        const missing = ready(await loadInbox(null, { query: { status: null, type: 'missing', page: 1 } }));
        expect(missing.selected?.type).toBe('missing');
        const everything = ready(await loadInbox(null));
        expect(everything.selected?.type).toBe('new');
    });

    it('lists A6 library-unavailable item, under its Type filter, and shows it in full', async () => {
        const f = await served({ published: true });
        expect(await recordLibraryState({ available: false, cause: 'missing' }, { root: f.root, clock: () => NOW, logger: quiet })).toBe('opened');
        const view = ready(await loadInbox(null, { query: { status: null, type: 'library-unavailable', page: 1 } }));
        const row = view.items.find((entry) => entry.id === LIBRARY_EVENT_ID);
        expect(row).toMatchObject({ type: 'library-unavailable', title: 'Library unavailable', group: 'judgment' });
        expect(listPage(view.items, { status: null, type: 'library-unavailable', page: 1 }).items.map((entry) => entry.id)).toEqual([LIBRARY_EVENT_ID]);
        expect(view.selected).toMatchObject({ id: LIBRARY_EVENT_ID, type: 'library-unavailable' });
        expect(view.selected?.facts).toEqual(expect.arrayContaining([{ label: 'Cause', value: 'The library root is missing' }]));
        expect(JSON.stringify(view)).not.toContain(f.root);
    });
});

describe('the insertion suggestion the watcher writes', () => {
    it('places a dated new photograph among the series dated photographs, from the registry capture dates', async () => {
        const f = await served({ fresh: 1 });
        writeRules(f.root, { schemaVersion: 1, series: [{ seriesId: DRAFT, folders: ['trips'] }] });
        const members = f.catalog.series.find((entry) => entry.id === DRAFT)?.photoIds ?? [];
        expect(members.length).toBeGreaterThanOrEqual(2);
        const registry = await readRegistry(f.root);
        // The fresh photograph is captured 2024-06-01: after the first member, before the second.
        for (const [index, photoId] of members.entries()) {
            const photo = registry.photos[photoId];
            photo.revisions[photo.source.observedRevision].derived.capturedDate = { value: index === 0 ? '2024-05-01' : '2024-07-01', source: 'fixture' };
        }
        await writeRegistry(f.root, registry, registry.version);
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.fresh[0])]);
        const event = await readEvent(f.root, newId(f, f.fresh[0]));
        expect(event?.suggestions.series?.value).toBe(DRAFT);
        expect(event?.suggestions.placement).toMatchObject({ value: { after: members[0] }, confidence: 'medium', producedBy: 'placement@2' });
    });
});

describe('loadInboxSummary', () => {
    it('counts as the page counts, with the watcher, and names one item only by its ID, version and status', async () => {
        const f = await served({ fresh: 3 });
        await writeWatcherHeartbeat(f.root, { pid: 1, hostname: 'fixture', lastPassAt: null, lastPassResult: null, passStartedAt: null, heartbeatAt: new Date(NOW - 30_000).toISOString(), legacyDerivatives: false });
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.fresh[0]), f.fact('new', f.fresh[1]), f.fact('missing', f.catalog.series[0].photoIds[0])]);
        const page = ready(await loadInbox(null, { now: () => NOW }));
        const id = newId(f, f.fresh[0]);
        const summary = await loadInboxSummary(id, { now: () => NOW });
        expect(summary).toEqual({
            state: 'ready',
            readAt: new Date(NOW).toISOString(),
            needsJudgment: page.needsJudgment,
            waiting: page.waiting,
            placed: page.placed,
            unplaced: page.unplaced,
            total: page.items.length,
            unreadable: 0,
            watcher: { state: 'running' },
            item: { id, version: 1, status: 'open' },
        });
        expect(await loadInboxSummary(`evt_${'f'.repeat(24)}`)).toMatchObject({ item: null });
        expect(await loadInboxSummary(null)).toMatchObject({ item: null });
        const text = JSON.stringify(summary);
        for (const leak of [f.root, 'trips/', f.fresh[0], 'sha256-']) expect(text).not.toContain(leak);
    });

    it('is not-ready, and reads nothing, when the data root is not set up', async () => {
        const f = await served();
        cleanups.push(setDataDir(`${f.root}-missing`));
        expect(await loadInboxSummary(null)).toEqual({ state: 'not-ready' });
    });
});

describe('the bulk actions', () => {
    const bulkForm = (base: string | null, entries: string[], extra: Record<string, string> = {}) => {
        const form = new FormData();
        form.set('base', base ?? 'none');
        for (const entry of entries) form.append('items', entry);
        for (const [name, value] of Object.entries(extra)) form.set(name, value);
        return form;
    };

    it('Decide later sends one expectedVersion per item, and the server leaves a moved one alone while the rest go through', async () => {
        const f = await served({ fresh: 3 });
        await createCurationSink({ root: f.root, logger: quiet })(f.fresh.map((photoId) => f.fact('new', photoId)));
        const [a, b, c] = f.fresh.map((photoId) => newId(f, photoId));
        // b moves behind the page's back, so the version the page sent is stale.
        expect(await editEvent({ root: f.root, eventId: b, expectedVersion: 1, expectedBase: null, actor: 'curator:other', choices: { seriesId: DRAFT } })).toMatchObject({ ok: true });
        const state = await runInboxBulk('defer', bulkForm(null, [`${a}:1`, `${b}:1`, `${c}:1`]));
        expect(state).toMatchObject({ status: 'partial', kind: 'defer', message: 'Left 2 of 3 items for later. 1 was left as it is.' });
        if (state.status === 'idle') throw new Error('no answer');
        expect(state.results.map((result) => [result.eventId, result.status])).toEqual([[a, 'done'], [b, 'stale'], [c, 'done']]);
        expect(state.results[1].message).toMatch(/changed since the page loaded/);
        expect((await readEvent(f.root, a))?.status).toBe('deferred');
        expect((await readEvent(f.root, b))).toMatchObject({ status: 'open', version: 2 });
        expect((await readEvent(f.root, c))?.status).toBe('deferred');
    });

    it('Leave unassigned approves each new photograph into the draft with no series, and keeps its saved description', async () => {
        const f = await served({ fresh: 2 });
        await createCurationSink({ root: f.root, logger: quiet })(f.fresh.map((photoId) => f.fact('new', photoId)));
        const [a, b] = f.fresh.map((photoId) => newId(f, photoId));
        expect(await editEvent({ root: f.root, eventId: a, expectedVersion: 1, expectedBase: null, actor: 'curator:web', choices: { description: { kind: 'described', text: 'Harbor wall at dawn.' } } })).toMatchObject({ ok: true });
        const state = await runInboxBulk('unassigned', bulkForm(null, [`${a}:2`, `${b}:1`]));
        expect(state).toMatchObject({ status: 'done', kind: 'unassigned', message: 'Approved 2 new photographs into the draft, unassigned. Nothing is published until you publish.' });
        for (const id of [a, b]) expect((await readEvent(f.root, id))?.status).toBe('approved');
        expect((await readAuthoredRecord(f.root, 'photo', f.fresh[0]))?.alt).toMatchObject({ kind: 'described', text: 'Harbor wall at dawn.', reviewed: true });
        const series = await readAuthoredRecord(f.root, 'series', DRAFT);
        expect(series?.photoIds).not.toContain(f.fresh[0]);
    });

    it('lets the server refuse an item Leave unassigned cannot take, in the page words', async () => {
        const f = await served({ fresh: 2 });
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.fresh[0]), f.fact('missing', f.catalog.series[0].photoIds[0])]);
        const missing = eventIdOf(eventKey('missing', f.fact('missing', f.catalog.series[0].photoIds[0])));
        const state = await runInboxBulk('unassigned', bulkForm(null, [`${missing}:1`]));
        expect(state).toMatchObject({ status: 'refused' });
        if (state.status === 'idle') throw new Error('no answer');
        expect(state.results[0].status).not.toBe('done');
        expect(state.results[0].message).not.toMatch(/evt_|ph_|--/);
        expect((await readEvent(f.root, missing))?.status).toBe('open');
    });

    it('checks and caps its input before it runs anything', async () => {
        const f = await served({ fresh: 1 });
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.fresh[0])]);
        const id = newId(f, f.fresh[0]);
        const before = await listEvents(f.root);
        const cases: [FormData | null, RegExp][] = [
            [null, /form/i],
            [bulkForm(null, []), /Select at least one item/],
            [bulkForm(null, [`${id}`]), /Refresh the inbox/],
            [bulkForm(null, [`${id}:0`]), /Refresh the inbox/],
            [bulkForm(null, [`${id}:1`, `${id}:1`]), /more than once/],
            [bulkForm(null, [`evt_nope:1`]), /Refresh the inbox/],
            [bulkForm('rev_bad', [`${id}:1`]), /active revision/],
            [bulkForm(null, Array.from({ length: MAX_BULK_ITEMS + 1 }, (_, n) => `evt_${String(n).padStart(24, '0')}:1`)), /at most 50/],
        ];
        expect(MAX_BULK_ITEMS).toBe(50);
        for (const [form, message] of cases) {
            const state = await runInboxBulk('defer', form);
            expect(state).toMatchObject({ status: 'invalid', field: 'items', message: expect.stringMatching(message) });
            if (state.status !== 'idle') expect(state.results).toEqual([]);
        }
        expect(await runInboxBulk('nope' as 'defer', bulkForm(null, [`${id}:1`]))).toMatchObject({ status: 'invalid' });
        expect(await listEvents(f.root)).toEqual(before);
    });
});

describe('50 concurrent writers', () => {
    it('leave every event readable and none lost', { timeout: 120_000 }, async () => {
        const f = await served({ fresh: 50 });
        // 50 watcher deliveries at once, one new photograph each.
        await Promise.all(f.fresh.map((photoId) => createCurationSink({ root: f.root, logger: quiet, waitMs: 60_000 })([f.fact('new', photoId)])));
        const opened = await listEvents(f.root);
        expect(opened.problems).toEqual([]);
        expect(opened.events.filter((event) => event.type === 'new')).toHaveLength(50);
        const ids = f.fresh.map((photoId) => newId(f, photoId));
        // 50 curators at once, one edit each, every one at the version it saw.
        const edits = await Promise.all(ids.map((eventId, index) => editEvent({ root: f.root, eventId, expectedVersion: 1, expectedBase: null, actor: `curator:${index}`, waitMs: 60_000, choices: { description: { kind: 'described', text: `Edit ${index}.` } } })));
        expect(edits.filter((result) => !result.ok)).toEqual([]);
        // And 50 at once on one item at one version: exactly one goes through.
        const raced = await Promise.all(Array.from({ length: 50 }, () => deferEvent({ root: f.root, eventId: ids[0], expectedVersion: 2, expectedBase: null, actor: 'curator:race', waitMs: 60_000 })));
        expect(raced.filter((result) => result.ok)).toHaveLength(1);
        expect(raced.filter((result) => !result.ok).every((result) => !result.ok && result.code === 'stale')).toBe(true);
        const after = await listEvents(f.root);
        expect(after.problems).toEqual([]);
        expect(after.events).toHaveLength(opened.events.length);
        for (const [index, eventId] of ids.entries()) {
            const event = after.events.find((entry) => entry.id === eventId) as CurationEvent;
            expect(event.edits?.description).toEqual({ kind: 'described', text: `Edit ${index}.` });
            expect(event.version).toBe(index === 0 ? 3 : 2);
        }
    });
});
