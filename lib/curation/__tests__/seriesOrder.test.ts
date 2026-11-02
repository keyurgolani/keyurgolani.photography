// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { folderBytes } from '../../../test/helpers/folderBytes';
import { setDataDir } from '../../../test/helpers/tempDataRoot';
import { sequenceArgs } from '../../catalog/owner-cli';
import { FIELD_LIMITS } from '../../catalog/plain-text';
import { runSequenceCommand } from '../../catalog/sequence-commands';
import { createTestCatalog, type TestCatalog } from '../../catalog/testing';
import type { AuthoredSeries, AuthoredSite } from '../../catalog/types';
import { authoredRecordDir, readAuthoredRecord } from '../../catalog/working-layer';
import { AUTHORED_LOCK, writeAuthoredRecord } from '../../catalog/working-layer-writer';
import { withLock } from '../../storage/lock';
import { WEB_ACTOR } from '../inbox-form';
import { loadSeriesDetail, loadSeriesScreen } from '../series-form';
import { runOrderAction, type OrderActionOptions } from '../series-order';
import type { OrderActionState } from '../series-view';

// #150's 2b: a series' order, and the Work order and featured series, from the curator's Series screen, on a real
// data root. Every write goes through #8's applySequenceOp() with the version and the live revision the page showed,
// under one hold of the authored lock; every answer is in the page's words. app/curation/series/actions.ts calls
// runOrderAction() only after requireCurator() lets the request in; __tests__/seriesBoundary.test.ts and the route
// inventory cover the refusals.

const HARBOR = 'ser_fixture-00';
const DRAFT = 'ser_fixture-01';
const COAST = 'ser_fixture-02';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface World {
    catalog: TestCatalog;
    root: string;
    /** Photo IDs by the fixture's index. */
    p: string[];
    /** Approved, in no series, titled "Ferry at dusk". */
    ferry: string;
    /** Approved, in no series, named by its file, fixture-0008.jpg. */
    loose: string;
    /** Approved, in no series, its source missing from the library. */
    missing: string;
    /** In the registry, with no photo record: the Inbox hasn't approved it. */
    unapproved: string;
}

/**
 * Harbor (published, three photographs), Salt roads (a draft, two) and Coast (published, one), in that Work order with
 * Harbor featured, and four photographs in no series: two approved, one whose source is missing, and one the Inbox
 * hasn't approved, whose photo record is gone. Served as the data root.
 */
async function world(): Promise<World> {
    const photos = Array.from({ length: 10 }, (_, index) => (index === 6 ? { title: 'Ferry at dusk' } : index === 8 ? { sourceHealth: 'missing' as const } : {}));
    const catalog = await createTestCatalog({
        seed: 1505,
        photos,
        series: [
            { id: HARBOR, photos: 3, title: 'Harbor', visibility: 'published' },
            { id: DRAFT, photos: 2, title: 'Salt roads', visibility: 'draft' },
            { id: COAST, photos: 1, title: 'Coast', visibility: 'published' },
        ],
    });
    cleanups.push(() => catalog.cleanup());
    cleanups.push(setDataDir(catalog.root));
    const p = catalog.photos.map((photo) => photo.id);
    fs.rmSync(authoredRecordDir(catalog.root, 'photo', p[9]), { recursive: true, force: true });
    return { catalog, root: catalog.root, p, ferry: p[6], loose: p[7], missing: p[8], unapproved: p[9] };
}

function form(fields: Record<string, string | string[]>): FormData {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) for (const one of [value].flat()) data.append(name, one);
    return data;
}

const series = async (root: string, id: string) => (await readAuthoredRecord(root, 'series', id)) as AuthoredSeries;
const site = async (root: string) => (await readAuthoredRecord(root, 'site', 'site')) as AuthoredSite;
const authored = (root: string) => folderBytes(path.join(root, 'authored'));

/** A series' page's ordering form, as SeriesOrder sends it: the operation, the series, its version and the page's live revision. */
function orderForm(record: AuthoredSeries, op: string, fields: Record<string, string> = {}, base = 'none'): FormData {
    return form({ op, seriesId: record.id, version: String(record.version), base, ...fields });
}

/** The Series screen's Work order or featured form. */
function workForm(record: AuthoredSite | null, op: string, fields: Record<string, string | string[]> = {}, base = 'none'): FormData {
    return form({ op, version: String(record?.version ?? 0), base, ...fields });
}

const run = (data: unknown, options: OrderActionOptions = {}) => runOrderAction('series', data, options);
const work = (data: unknown, options: OrderActionOptions = {}) => runOrderAction('work', data, options);
const PUBLIC = 'Nothing is public until you publish.';

describe("A series' sequence", { timeout: 30_000 }, () => {
    it('adds an approved photograph at the position chosen, through #8, stamped as the web curator', async () => {
        const { root, p, ferry } = await world();
        const before = await series(root, HARBOR);
        const state = await run(orderForm(before, 'insert', { photoId: ferry, position: '2' }));
        expect(state).toMatchObject({ status: 'done', action: 'insert', message: `Added Ferry at dusk at position 2 of 4. ${PUBLIC}` });
        const after = await series(root, HARBOR);
        expect(after.version).toBe(before.version + 1);
        expect(after.photoIds).toEqual([p[0], ferry, p[1], p[2]]);
        expect(after.review?.fields.photoIds).toMatchObject({ origin: 'curator', actor: WEB_ACTOR, baseRevisionId: null });
        // Named by its file when it has no title, and at the end when that's the position chosen.
        expect(await run(orderForm(after, 'insert', { photoId: p[7], position: '5' }))).toMatchObject({ status: 'done', message: `Added fixture-0008.jpg at position 5 of 5. ${PUBLIC}` });
        expect((await series(root, HARBOR)).photoIds.at(-1)).toBe(p[7]);
    });

    it('moves a photograph to a position, and says where it went', async () => {
        const { root, p } = await world();
        const before = await series(root, HARBOR);
        expect(await run(orderForm(before, 'move', { photoId: p[2], position: '1' }))).toMatchObject({ status: 'done', action: 'move', message: `Moved fixture-0003.jpg to position 1 of 3. ${PUBLIC}` });
        const after = await series(root, HARBOR);
        expect(after.photoIds).toEqual([p[2], p[0], p[1]]);
        expect(await run(orderForm(after, 'move', { photoId: p[2], position: '2' }))).toMatchObject({ status: 'done', message: `Moved fixture-0003.jpg to position 2 of 3. ${PUBLIC}` });
        expect((await series(root, HARBOR)).photoIds).toEqual([p[0], p[2], p[1]]);
        // Where it is already, and a position the series doesn't have, write nothing.
        const now = await series(root, HARBOR);
        const bytes = authored(root);
        expect(await run(orderForm(now, 'move', { photoId: p[2], position: '2' }))).toMatchObject({ status: 'invalid', message: "That's where it is already, so nothing changed." });
        expect(await run(orderForm(now, 'move', { photoId: p[2], position: '4' }))).toMatchObject({ status: 'invalid', field: 'position', message: "There's no position 4 in this series, which would hold 3 photographs. Nothing was written." });
        expect(await run(orderForm(now, 'insert', { photoId: p[6], position: '5' }))).toMatchObject({ status: 'invalid', field: 'position', message: "There's no position 5 in this series, which would hold 4 photographs. Nothing was written." });
        for (const position of ['0', '-1', '1.5', 'first', '']) {
            expect(await run(orderForm(now, 'move', { photoId: p[2], position })), position).toMatchObject({ status: 'invalid', field: 'position', message: 'Choose a position from 1. Nothing was written.' });
        }
        expect(authored(root)).toEqual(bytes);
    });

    it('takes a photograph out, and words what that cleared: the cover and its focal point, and the opening photograph', async () => {
        const { root, p } = await world();
        const harbor = await series(root, HARBOR);
        await writeAuthoredRecord({ ...harbor, cover: { photoId: p[0], focalPoint: { x: 0.4, y: 0.3 } }, openingPhotoId: p[0] }, { expectedVersion: harbor.version, root });
        const shown = await series(root, HARBOR);
        const state = await run(orderForm(shown, 'remove', { photoId: p[0] }));
        expect(state).toMatchObject({
            status: 'done',
            action: 'remove',
            message: [
                'Took fixture-0001.jpg out of the series.',
                'fixture-0001.jpg was the cover, so the series has no cover now. A published series needs one, so set another before you publish.',
                'Its focal point went with it.',
                'fixture-0001.jpg was the opening photograph, so there is none now, and the series opens on its first photograph.',
                PUBLIC,
            ].join(' '),
        });
        const after = await series(root, HARBOR);
        expect(after).toMatchObject({ photoIds: [p[1], p[2]], cover: null });
        expect(after.openingPhotoId).toBeUndefined();
    });

    it('moves a chapter to the next photograph when the one it starts at moves or goes, and refuses to empty a chapter', async () => {
        const { root, p } = await world();
        const harbor = await series(root, HARBOR);
        await writeAuthoredRecord({ ...harbor, chapters: [{ id: 'ch_dawn', title: 'Dawn', startPhotoId: p[0] }, { id: 'ch_dusk', title: 'Dusk', startPhotoId: p[2] }] }, { expectedVersion: harbor.version, root });
        let shown = await series(root, HARBOR);
        expect(await run(orderForm(shown, 'move', { photoId: p[0], position: '2' }))).toMatchObject({
            status: 'done',
            message: `Moved fixture-0001.jpg to position 2 of 3. The chapter Dawn starts at fixture-0002.jpg now, instead of fixture-0001.jpg. ${PUBLIC}`,
        });
        expect((await series(root, HARBOR)).chapters.map((chapter) => chapter.startPhotoId)).toEqual([p[1], p[2]]);
        // Dusk holds one photograph, so it can't lose it.
        shown = await series(root, HARBOR);
        const bytes = authored(root);
        expect(await run(orderForm(shown, 'remove', { photoId: p[2] }))).toMatchObject({ status: 'refused', message: 'fixture-0003.jpg is the only photograph in the chapter Dusk. Move another photograph into it, or remove the chapter, first. Nothing was written.' });
        expect(authored(root)).toEqual(bytes);
    });

    it('refuses a photograph that is malformed, unknown, unapproved, missing, already there, or in another published series, and writes nothing', async () => {
        const { root, p, missing, unapproved } = await world();
        const harbor = await series(root, HARBOR);
        const bytes = authored(root);
        expect(await run(orderForm(harbor, 'insert', { photoId: '', position: '1' }))).toMatchObject({ status: 'invalid', field: 'addPhoto', message: 'Choose a photograph to add. Nothing was written.' });
        for (const photoId of ['ph_nope', '../site', 'PH_1', `${p[6]}x`]) {
            expect(await run(orderForm(harbor, 'insert', { photoId, position: '1' })), photoId).toMatchObject({ status: 'invalid', message: 'The form names no photograph. Refresh the page.' });
        }
        expect(await run(orderForm(harbor, 'insert', { photoId: 'ph_00000000-0000-4000-8000-000000000000', position: '1' }))).toMatchObject({ status: 'refused', message: "The library doesn't know that photograph, so it can't join a series. Nothing was written." });
        expect(await run(orderForm(harbor, 'insert', { photoId: unapproved, position: '1' }))).toMatchObject({ status: 'refused', message: "fixture-0010.jpg isn't approved yet, so it can't join a series. Approve it in the Inbox first. Nothing was written." });
        expect(await run(orderForm(harbor, 'insert', { photoId: missing, position: '1' }))).toMatchObject({ status: 'refused', message: "fixture-0009.jpg's file isn't in the library now, so it can't join a series. Its Inbox item says what to do. Nothing was written." });
        expect(await run(orderForm(harbor, 'insert', { photoId: p[1], position: '1' }))).toMatchObject({ status: 'invalid', field: 'addPhoto', message: 'fixture-0002.jpg is in this series already. Move it instead. Nothing was written.' });
        // Coast's photograph is in a published series, so published Harbor can't take it. Salt roads, a draft, can.
        expect(await run(orderForm(harbor, 'insert', { photoId: p[5], position: '1' }))).toMatchObject({ status: 'refused', message: 'fixture-0006.jpg is in the published series Coast already, and a photograph belongs to one published series. Take it out of there first. Nothing was written.' });
        // A member the series doesn't hold, for a move or a remove, means the form is behind.
        expect(await run(orderForm(harbor, 'move', { photoId: p[6], position: '1' }))).toMatchObject({ status: 'invalid', message: "Ferry at dusk isn't in this series. Refresh the page." });
        expect(await run(orderForm(harbor, 'remove', { photoId: p[6] }))).toMatchObject({ status: 'invalid', message: "Ferry at dusk isn't in this series. Refresh the page." });
        expect(authored(root)).toEqual(bytes);
        expect(await run(orderForm(await series(root, DRAFT), 'insert', { photoId: p[5], position: '1' }))).toMatchObject({ status: 'done' });
    });
});

describe('The cover and the opening photograph', { timeout: 30_000 }, () => {
    it('sets the cover with a focal point, then another, dropping the first one\'s point, and says so', async () => {
        const { root, p } = await world();
        let shown = await series(root, HARBOR);
        expect(await run(orderForm(shown, 'cover', { photoId: p[1], focal: 'set', focalX: '40', focalY: '25.5' }))).toMatchObject({ status: 'done', action: 'cover', message: `fixture-0002.jpg is the cover now, with its focal point 40% across and 25.5% down. ${PUBLIC}` });
        expect((await series(root, HARBOR)).cover).toEqual({ photoId: p[1], focalPoint: { x: 0.4, y: 0.255 } });
        expect((await series(root, HARBOR)).review?.fields.cover).toMatchObject({ origin: 'curator', actor: WEB_ACTOR });
        shown = await series(root, HARBOR);
        expect(await run(orderForm(shown, 'cover', { photoId: p[2], focal: 'none' }))).toMatchObject({ status: 'done', message: `fixture-0003.jpg is the cover now, with no focal point. The focal point set for fixture-0002.jpg, the cover before, went with it. ${PUBLIC}` });
        expect((await series(root, HARBOR)).cover).toEqual({ photoId: p[2] });
        shown = await series(root, HARBOR);
        const bytes = authored(root);
        expect(await run(orderForm(shown, 'cover', { photoId: p[2], focal: 'none' }))).toMatchObject({ status: 'invalid', message: "That's the cover already, as it stands, so nothing changed." });
        for (const [focalX, focalY] of [['101', '50'], ['-1', '50'], ['50', ''], ['fifty', '50'], ['50', '1e2']]) {
            expect(await run(orderForm(shown, 'cover', { photoId: p[2], focal: 'set', focalX, focalY })), `${focalX},${focalY}`).toMatchObject({ status: 'invalid', field: 'focal', message: 'A focal point is two numbers from 0 to 100: how far across the photograph, and how far down. Nothing was written.' });
        }
        expect(await run(orderForm(shown, 'cover', { photoId: p[6], focal: 'none' }))).toMatchObject({ status: 'invalid', message: "Ferry at dusk isn't in this series. Refresh the page." });
        expect(authored(root)).toEqual(bytes);
    });

    it('sets the opening photograph, and clears it', async () => {
        const { root, p } = await world();
        let shown = await series(root, HARBOR);
        expect(await run(orderForm(shown, 'opening', { photoId: p[2] }))).toMatchObject({ status: 'done', action: 'opening', message: `fixture-0003.jpg is the opening photograph now. ${PUBLIC}` });
        expect((await series(root, HARBOR)).openingPhotoId).toBe(p[2]);
        shown = await series(root, HARBOR);
        expect(await run(orderForm(shown, 'opening', { photoId: p[2] }))).toMatchObject({ status: 'invalid', message: "That's the opening photograph already, so nothing changed." });
        expect(await run(orderForm(shown, 'opening', { photoId: 'none' }))).toMatchObject({ status: 'done', message: `The series has no opening photograph now, so it opens on its first photograph. ${PUBLIC}` });
        expect((await series(root, HARBOR)).openingPhotoId).toBeUndefined();
    });
});

describe('Chapters', { timeout: 30_000 }, () => {
    it('adds a chapter at its start, moves the start, and removes it, each through #8', async () => {
        const { root, p } = await world();
        let shown = await series(root, HARBOR);
        expect(await run(orderForm(shown, 'chapter-add', { title: 'Dawn', startPhotoId: p[1] }))).toMatchObject({ status: 'done', action: 'chapter-add', message: `Added the chapter Dawn, starting at fixture-0002.jpg. ${PUBLIC}` });
        const [dawn] = (await series(root, HARBOR)).chapters;
        expect(dawn).toMatchObject({ title: 'Dawn', startPhotoId: p[1], id: expect.stringMatching(/^ch_/) });
        shown = await series(root, HARBOR);
        expect(await run(orderForm(shown, 'chapter-move', { chapterId: dawn.id, startPhotoId: p[2] }))).toMatchObject({ status: 'done', action: 'chapter-move', message: `The chapter Dawn starts at fixture-0003.jpg now. ${PUBLIC}` });
        shown = await series(root, HARBOR);
        expect(await run(orderForm(shown, 'chapter-move', { chapterId: dawn.id, startPhotoId: p[2] }))).toMatchObject({ status: 'invalid', message: 'The chapter starts there already, so nothing changed.' });
        expect(await run(orderForm(shown, 'chapter-remove', { chapterId: dawn.id }))).toMatchObject({ status: 'done', action: 'chapter-remove', message: `Removed the chapter Dawn. Its photographs stay where they are. ${PUBLIC}` });
        const after = await series(root, HARBOR);
        expect(after.chapters).toEqual([]);
        expect(after.photoIds).toEqual([p[0], p[1], p[2]]);
    });

    it('refuses a start another chapter has, one out of order, and a chapter the series lacks, writing nothing', async () => {
        const { root, p } = await world();
        const harbor = await series(root, HARBOR);
        await writeAuthoredRecord({ ...harbor, chapters: [{ id: 'ch_dawn', title: 'Dawn', startPhotoId: p[0] }, { id: 'ch_dusk', title: 'Dusk', startPhotoId: p[2] }] }, { expectedVersion: harbor.version, root });
        const shown = await series(root, HARBOR);
        const bytes = authored(root);
        expect(await run(orderForm(shown, 'chapter-add', { title: 'Noon', startPhotoId: p[2] }))).toMatchObject({ status: 'invalid', field: 'chapterStart', message: 'fixture-0003.jpg starts the chapter Dusk already. Choose another photograph. Nothing was written.' });
        expect(await run(orderForm(shown, 'chapter-move', { chapterId: 'ch_dawn', startPhotoId: p[2] }))).toMatchObject({ status: 'invalid', field: 'chapterStart', message: 'fixture-0003.jpg starts the chapter Dusk already. Choose another photograph. Nothing was written.' });
        // Dusk can't start above Dawn.
        const moved = await series(root, HARBOR);
        await writeAuthoredRecord({ ...moved, chapters: [{ id: 'ch_dawn', title: 'Dawn', startPhotoId: p[1] }, { id: 'ch_dusk', title: 'Dusk', startPhotoId: p[2] }] }, { expectedVersion: moved.version, root });
        const now = await series(root, HARBOR);
        const later = authored(root);
        expect(await run(orderForm(now, 'chapter-move', { chapterId: 'ch_dusk', startPhotoId: p[0] }))).toMatchObject({ status: 'invalid', field: 'chapterStart', message: 'The chapter Dusk would start out of order: each chapter starts after the one above it. Nothing was written.' });
        expect(await run(orderForm(now, 'chapter-remove', { chapterId: 'ch_noon' }))).toMatchObject({ status: 'invalid', message: "That chapter isn't in this series. Refresh the page." });
        expect(await run(orderForm(now, 'chapter-add', { title: 'Noon', startPhotoId: '' }))).toMatchObject({ status: 'invalid', field: 'chapterStart', message: 'Choose the photograph the chapter starts at. Nothing was written.' });
        expect(await run(orderForm(now, 'chapter-move', { chapterId: '', startPhotoId: p[1] }))).toMatchObject({ status: 'invalid', message: 'The form names no chapter. Refresh the page.' });
        expect(authored(root)).toEqual(later);
        expect(later).not.toEqual(bytes);
    });

    it("cleans a chapter title as photos sequence chapter add does, and refuses one its rules refuse, by the field", async () => {
        const { root, p } = await world();
        expect(await run(orderForm(await series(root, HARBOR), 'chapter-add', { title: '  Dawn on the water  ', startPhotoId: p[1] }))).toMatchObject({ status: 'done', message: `Added the chapter Dawn on the water, starting at fixture-0002.jpg. ${PUBLIC}` });
        // The same title through the CLI's own parse and command, on the draft series.
        const draft = await series(root, DRAFT);
        const cli = await runSequenceCommand({ dataRoot: root }, sequenceArgs(['chapter', 'add', DRAFT, '  Dawn on the water  ', '--start', draft.photoIds[1]]));
        expect(cli.exitCode).toBe(0);
        expect((await series(root, HARBOR)).chapters[0].title).toBe((await series(root, DRAFT)).chapters[0].title);
        expect((await series(root, HARBOR)).chapters[0].title).toBe('Dawn on the water');

        const shown = await series(root, HARBOR);
        const bytes = authored(root);
        const refuse = (title: string) => run(orderForm(shown, 'chapter-add', { title, startPhotoId: p[2] }));
        expect(await refuse('   ')).toMatchObject({ status: 'invalid', field: 'chapterTitle', message: 'A chapter needs a title. Nothing was written.' });
        expect(await refuse('Dawn\nDusk')).toMatchObject({ status: 'invalid', field: 'chapterTitle', message: "The chapter title has a line break, which it can't hold. Nothing was written." });
        expect(await refuse('x'.repeat(FIELD_LIMITS.title + 1))).toMatchObject({ status: 'invalid', field: 'chapterTitle', message: `The chapter title is ${FIELD_LIMITS.title + 1} characters long, over its limit of ${FIELD_LIMITS.title}. Nothing was written.` });
        expect(await refuse('Zero\u200bwidth')).toMatchObject({ status: 'invalid', field: 'chapterTitle', message: expect.stringMatching(/^The chapter title has U\+200B, .* at character 5\. Nothing was written\.$/) });
        // The CLI refuses the same three.
        for (const title of ['Dawn\nDusk', 'x'.repeat(FIELD_LIMITS.title + 1), 'Zero\u200bwidth']) expect(() => sequenceArgs(['chapter', 'add', HARBOR, title, '--start', p[2]])).toThrow();
        expect(authored(root)).toEqual(bytes);
    });
});

describe('A form the draft has moved past', { timeout: 30_000 }, () => {
    it('answers refresh to an older series version, and writes nothing', async () => {
        const { root, p, ferry } = await world();
        const shown = await series(root, HARBOR);
        // `photos sequence` moves a photograph while the page is open.
        expect((await runSequenceCommand({ dataRoot: root }, sequenceArgs(['move', HARBOR, p[2], '--start']))).exitCode).toBe(0);
        const bytes = authored(root);
        for (const data of [orderForm(shown, 'move', { photoId: p[0], position: '3' }), orderForm(shown, 'insert', { photoId: ferry, position: '1' }), orderForm(shown, 'chapter-add', { title: 'Dawn', startPhotoId: p[0] })]) {
            expect(await run(data)).toMatchObject({ status: 'stale', message: 'This series changed since the page loaded, so nothing was written. Refresh to see what it holds now, and edit it again.' });
        }
        expect(authored(root)).toEqual(bytes);
        expect(await run(orderForm({ ...shown, id: 'ser_nowhere' }, 'remove', { photoId: p[0] }))).toMatchObject({ status: 'stale', message: "This series isn't in the working layer any more, so nothing was written. Refresh the list." });
    });

    it("answers refresh from #8's own check when the series moves after the early one, so a position never lands on the wrong anchor", async () => {
        const { root, p } = await world();
        const shown = await series(root, HARBOR);
        const afterCheck = async () => {
            expect((await runSequenceCommand({ dataRoot: root }, sequenceArgs(['move', HARBOR, p[2], '--start']))).exitCode).toBe(0);
        };
        expect(await run(orderForm(shown, 'move', { photoId: p[0], position: '3' }), { afterCheck })).toMatchObject({ status: 'stale', message: expect.stringMatching(/^This series changed since the page loaded/) });
        expect((await series(root, HARBOR)).photoIds).toEqual([p[2], p[0], p[1]]);
    });

    it('answers refresh when the live revision moved since the page loaded, for a series and a site form, and writes nothing', async () => {
        const { root, p } = await world();
        const base = `rev_${'a'.repeat(64)}`;
        const bytes = authored(root);
        const moved = 'A publish or rollback happened since the page loaded, so nothing was written. Refresh the page and try again.';
        expect(await run(orderForm(await series(root, HARBOR), 'move', { photoId: p[0], position: '2' }, base))).toMatchObject({ status: 'stale', message: moved });
        expect(await work(workForm(await site(root), 'work-order', { seriesId: COAST, move: 'up' }, base))).toMatchObject({ status: 'stale', message: moved });
        for (const bad of ['', 'rev_1', 'latest']) {
            expect(await run(orderForm(await series(root, HARBOR), 'move', { photoId: p[0], position: '2' }, bad)), bad).toMatchObject({ status: 'invalid', message: 'The form carries no live revision. Refresh the page.' });
        }
        expect(authored(root)).toEqual(bytes);
    });

    it('answers busy while the authored lock is held, and writes nothing', async () => {
        const { root, p } = await world();
        const shown = await series(root, HARBOR);
        const shownSite = await site(root);
        const bytes = authored(root);
        const busy = 'Another change is being written right now, so nothing was written. Try again in a moment.';
        await withLock(AUTHORED_LOCK, { root, leaseMs: 60_000 }, async () => {
            expect(await run(orderForm(shown, 'move', { photoId: p[0], position: '2' }), { waitMs: 200 })).toMatchObject({ status: 'busy', message: busy });
            expect(await work(workForm(shownSite, 'work-order', { seriesId: COAST, move: 'up' }), { waitMs: 200 })).toMatchObject({ status: 'busy', message: busy });
            expect(authored(root)).toEqual(bytes);
        });
    });

    it('refuses a form that names no change, no series, or no version, and writes nothing', async () => {
        const { root, p } = await world();
        const shown = await series(root, HARBOR);
        const bytes = authored(root);
        expect(await run('not a form')).toMatchObject({ status: 'invalid', message: 'The form was empty. Refresh the page.' });
        for (const op of ['', 'set', 'work-order', 'delete']) expect(await run(orderForm(shown, op, { photoId: p[0] })), op).toMatchObject({ status: 'invalid', message: 'The form names no change. Refresh the page.' });
        expect(await work(workForm(null, 'move'))).toMatchObject({ status: 'invalid', message: 'The form names no change. Refresh the page.' });
        expect(await run(orderForm({ ...shown, id: '../site' }, 'remove', { photoId: p[0] }))).toMatchObject({ status: 'invalid', message: 'The form names no series. Refresh the page.' });
        expect(await run(orderForm({ ...shown, version: 0 }, 'remove', { photoId: p[0] }))).toMatchObject({ status: 'invalid', message: 'The form carries no series version. Refresh the page.' });
        const blob = orderForm(shown, 'remove');
        blob.set('photoId', new Blob(['a file']), 'photo.txt');
        expect(await run(blob)).toMatchObject({ status: 'invalid', message: "The form sent something that isn't text. Refresh the page." });
        expect(authored(root)).toEqual(bytes);
    });
});

describe('Work order and the featured series', { timeout: 30_000 }, () => {
    it('moves a series up and down Work order, takes one off and puts it back last, through #8, stamped as the web curator', async () => {
        const { root } = await world();
        expect(await work(workForm(await site(root), 'work-order', { seriesId: COAST, move: 'up' }))).toMatchObject({ status: 'done', action: 'work-order', message: `Moved Coast to place 2 of 3 in Work order. ${PUBLIC}` });
        expect((await site(root)).seriesOrder).toEqual([HARBOR, COAST, DRAFT]);
        expect((await site(root)).review?.fields.seriesOrder).toMatchObject({ origin: 'curator', actor: WEB_ACTOR });
        expect(await work(workForm(await site(root), 'work-order', { seriesId: HARBOR, move: 'down' }))).toMatchObject({ status: 'done', message: `Moved Harbor to place 2 of 3 in Work order. ${PUBLIC}` });
        expect((await site(root)).seriesOrder).toEqual([COAST, HARBOR, DRAFT]);
        expect(await work(workForm(await site(root), 'work-order', { seriesId: DRAFT, move: 'off' }))).toMatchObject({ status: 'done', message: `Took Salt roads off Work. ${PUBLIC}` });
        expect(await work(workForm(await site(root), 'work-order', { seriesId: HARBOR, move: 'off' }))).toMatchObject({
            status: 'done',
            message: `Took Harbor off Work. A published series needs a place in Work order, so a publish waits until it has one again, or is a draft. ${PUBLIC}`,
        });
        expect((await site(root)).seriesOrder).toEqual([COAST]);
        const bytes = authored(root);
        expect(await work(workForm(await site(root), 'work-order', { seriesId: COAST, move: 'off' }))).toMatchObject({ status: 'invalid', message: 'Work order needs at least one series, so Coast stays. Nothing was written.' });
        expect(await work(workForm(await site(root), 'work-order', { seriesId: COAST, move: 'up' }))).toMatchObject({ status: 'invalid', message: 'Coast is first in Work order already, so nothing changed.' });
        expect(await work(workForm(await site(root), 'work-order', { seriesId: COAST, move: 'on' }))).toMatchObject({ status: 'invalid', message: 'Coast is in Work order already, so nothing changed.' });
        expect(authored(root)).toEqual(bytes);
        expect(await work(workForm(await site(root), 'work-order', { seriesId: HARBOR, move: 'on' }))).toMatchObject({ status: 'done', message: `Put Harbor on Work, last. ${PUBLIC}` });
        expect((await site(root)).seriesOrder).toEqual([COAST, HARBOR]);
    });

    it("keeps a series it can't read in its place, and moves past it", async () => {
        const { root } = await world();
        fs.writeFileSync(path.join(authoredRecordDir(root, 'series', DRAFT), 'v1.json'), '{ not json');
        expect(await work(workForm(await site(root), 'work-order', { seriesId: COAST, move: 'up' }))).toMatchObject({ status: 'done', message: `Moved Coast to place 1 of 2 in Work order. ${PUBLIC}` });
        expect((await site(root)).seriesOrder).toEqual([COAST, HARBOR, DRAFT]);
        // It isn't offered, so the screen never moves it.
        const bytes = authored(root);
        expect(await work(workForm(await site(root), 'work-order', { seriesId: DRAFT, move: 'up' }))).toMatchObject({ status: 'stale' });
        expect(authored(root)).toEqual(bytes);
    });

    it("drops a Work order or featured entry for a series the draft no longer holds, and says so, so the screen can fix it", async () => {
        const { root } = await world();
        const shown = await site(root);
        // A hand edit, or a series folder removed by hand, leaves IDs no series answers to.
        await writeAuthoredRecord({ ...shown, seriesOrder: [HARBOR, 'ser_gone', DRAFT, COAST], featuredSeriesIds: [HARBOR, 'ser_gone'] }, { expectedVersion: shown.version, root });
        expect(await work(workForm(await site(root), 'work-order', { seriesId: COAST, move: 'up' }))).toMatchObject({
            status: 'done',
            message: `Moved Coast to place 2 of 3 in Work order. Work order also named a series the draft no longer holds, so that's gone from it. ${PUBLIC}`,
        });
        expect((await site(root)).seriesOrder).toEqual([HARBOR, COAST, DRAFT]);
        // A move that changes nothing still mends the list, and says only that.
        const again = await site(root);
        await writeAuthoredRecord({ ...again, seriesOrder: ['ser_gone', 'ser_lost', ...again.seriesOrder] }, { expectedVersion: again.version, root });
        expect(await work(workForm(await site(root), 'work-order', { seriesId: HARBOR, move: 'up' }))).toMatchObject({ status: 'done', message: `Work order also named 2 series the draft no longer holds, so they're gone from it. ${PUBLIC}` });
        expect((await site(root)).seriesOrder).toEqual([HARBOR, COAST, DRAFT]);
        expect(await work(workForm(await site(root), 'featured', { featured: [HARBOR] }))).toMatchObject({
            status: 'done',
            message: `Harbor is featured now, so Home opens on it. The featured series also named a series the draft no longer holds, so that's gone from them. ${PUBLIC}`,
        });
        expect((await site(root)).featuredSeriesIds).toEqual([HARBOR]);
        // One that exists but can't be read stays, as before.
        fs.writeFileSync(path.join(authoredRecordDir(root, 'series', DRAFT), 'v1.json'), '{ not json');
        expect(await work(workForm(await site(root), 'work-order', { seriesId: HARBOR, move: 'down' }))).toMatchObject({ status: 'done' });
        expect((await site(root)).seriesOrder).toEqual([COAST, HARBOR, DRAFT]);
    });

    it("says so when only a series it can't read is still featured", async () => {
        const { root } = await world();
        const shown = await site(root);
        await writeAuthoredRecord({ ...shown, featuredSeriesIds: [DRAFT, HARBOR] }, { expectedVersion: shown.version, root });
        fs.writeFileSync(path.join(authoredRecordDir(root, 'series', DRAFT), 'v1.json'), '{ not json');
        expect(await work(workForm(await site(root), 'featured', {}))).toMatchObject({
            status: 'done',
            message: `None of the series shown here is featured now. Only one the screen can't read still is, so fix that series or feature a published one before you publish. The server log names it. ${PUBLIC}`,
        });
        expect((await site(root)).featuredSeriesIds).toEqual([DRAFT]);
    });

    it("words Off Work's warning from the series as the write found it, under the lock", async () => {
        const { root } = await world();
        // Harbor is published when the page posts, and a draft by the time the write holds the lock.
        const afterCheck = async () => {
            const harbor = await series(root, HARBOR);
            await writeAuthoredRecord({ ...harbor, visibility: 'draft' }, { expectedVersion: harbor.version, root });
        };
        expect(await work(workForm(await site(root), 'work-order', { seriesId: HARBOR, move: 'off' }), { afterCheck })).toMatchObject({ status: 'done', message: `Took Harbor off Work. ${PUBLIC}` });
        // And the other way: Salt roads is published by then, so the warning shows.
        const roads = async () => {
            const draft = await series(root, DRAFT);
            await writeAuthoredRecord({ ...draft, visibility: 'published' }, { expectedVersion: draft.version, root });
        };
        expect(await work(workForm(await site(root), 'work-order', { seriesId: DRAFT, move: 'off' }), { afterCheck: roads })).toMatchObject({
            status: 'done',
            message: `Took Salt roads off Work. A published series needs a place in Work order, so a publish waits until it has one again, or is a draft. ${PUBLIC}`,
        });
    });

    it('sets the featured series, keeping their order, warns of one not published, and clears them', async () => {
        const { root } = await world();
        expect(await work(workForm(await site(root), 'featured', { featured: [COAST, HARBOR] }))).toMatchObject({ status: 'done', action: 'featured', message: `Featured now: Harbor, then Coast. Home opens on the first of them a publish holds. ${PUBLIC}` });
        expect((await site(root)).featuredSeriesIds).toEqual([HARBOR, COAST]);
        expect((await site(root)).review?.fields.featuredSeriesIds).toMatchObject({ origin: 'curator', actor: WEB_ACTOR });
        expect(await work(workForm(await site(root), 'featured', { featured: [COAST] }))).toMatchObject({ status: 'done', message: `Coast is featured now, so Home opens on it. ${PUBLIC}` });
        expect(await work(workForm(await site(root), 'featured', { featured: [COAST, DRAFT] }))).toMatchObject({
            status: 'done',
            message: `Featured now: Coast, then Salt roads. Home opens on the first of them a publish holds. Only a published series can be featured, so a publish waits until Salt roads is published or not featured. ${PUBLIC}`,
        });
        expect(await work(workForm(await site(root), 'featured', {}))).toMatchObject({ status: 'done', message: `No series is featured now, so Home has nothing to open on, and a publish waits until a published series is featured again. ${PUBLIC}` });
        expect((await site(root)).featuredSeriesIds).toEqual([]);
        const bytes = authored(root);
        expect(await work(workForm(await site(root), 'featured', {}))).toMatchObject({ status: 'invalid', message: 'Nothing changed.' });
        expect(await work(workForm(await site(root), 'featured', { featured: ['harbor'] }))).toMatchObject({ status: 'invalid', message: 'The form names no series. Refresh the page.' });
        expect(authored(root)).toEqual(bytes);
    });

    it('answers refresh to an older site version, and writes nothing', async () => {
        const { root } = await world();
        const shown = await site(root);
        expect((await runSequenceCommand({ dataRoot: root }, sequenceArgs(['chapter', 'add', HARBOR, 'x', '--start', (await series(root, HARBOR)).photoIds[0]]))).exitCode).toBe(0);
        await writeAuthoredRecord({ ...shown, seriesOrder: [COAST, HARBOR, DRAFT] }, { expectedVersion: shown.version, root });
        const bytes = authored(root);
        const stale = 'Work order or the featured series changed since the page loaded, so nothing was written. Refresh to see them as they are now, and try again.';
        expect(await work(workForm(shown, 'work-order', { seriesId: DRAFT, move: 'up' }))).toMatchObject({ status: 'stale', message: stale });
        expect(await work(workForm(shown, 'featured', { featured: [COAST] }))).toMatchObject({ status: 'stale', message: stale });
        expect(await work(workForm(shown, 'featured', { featured: [COAST] }), { afterCheck: () => undefined })).toMatchObject({ status: 'stale' });
        expect(authored(root)).toEqual(bytes);
    });
});

describe("The screens' reads", { timeout: 30_000 }, () => {
    it("read a series' order for its page: its photographs by name, its cover, opening and chapters, and what it can take", async () => {
        const { root, p, ferry, loose } = await world();
        const harbor = await series(root, HARBOR);
        await writeAuthoredRecord({ ...harbor, cover: { photoId: p[1], focalPoint: { x: 0.5, y: 0.2 } }, openingPhotoId: p[2], chapters: [{ id: 'ch_dawn', title: 'Dawn', startPhotoId: p[0] }] }, { expectedVersion: harbor.version, root });
        const loaded = await loadSeriesDetail(HARBOR);
        if (loaded.state !== 'ready') throw new Error(loaded.state);
        const { order } = loaded;
        expect(order).toMatchObject({
            version: harbor.version + 1,
            published: true,
            cover: { photoId: p[1], focalPoint: { x: 0.5, y: 0.2 } },
            openingPhotoId: p[2],
            chapters: [{ id: 'ch_dawn', title: 'Dawn', startPhotoId: p[0] }],
        });
        expect(order.photos.map(({ id, name }) => ({ id, name }))).toEqual([0, 1, 2].map((n) => ({ id: p[n], name: `fixture-000${n + 1}.jpg` })));
        // Approved photographs in no series first, by name; Coast's is in a published series, so published Harbor isn't offered it.
        // Salt roads is a draft, so its photographs are offered, with where they are now.
        expect(order.addable.map(({ id, name, heldBy }) => ({ id, name, heldBy }))).toEqual([
            { id: ferry, name: 'Ferry at dusk', heldBy: null },
            { id: loose, name: 'fixture-0008.jpg', heldBy: null },
            { id: p[3], name: 'fixture-0004.jpg', heldBy: 'Salt roads' },
            { id: p[4], name: 'fixture-0005.jpg', heldBy: 'Salt roads' },
        ]);
        // No set is ready in this fixture, so no thumbnail; the next test has one.
        expect(order.photos.every((photo) => photo.thumbnailUrl === null)).toBe(true);
        // The draft series is offered every approved photograph it doesn't hold, a published series' too.
        const draft = await loadSeriesDetail(DRAFT);
        if (draft.state !== 'ready') throw new Error(draft.state);
        expect(draft.order.addable.map((photo) => photo.id)).toEqual(expect.arrayContaining([p[0], p[5], ferry, loose]));
    });

    it("gives each photograph the curator-only route's thumbnail of the set it pins, once one is ready", async () => {
        const catalog = await createTestCatalog({ seed: 1506, photos: 2, withAssets: true, series: [{ id: HARBOR, photos: 2, title: 'Harbor' }] });
        cleanups.push(() => catalog.cleanup());
        cleanups.push(setDataDir(catalog.root));
        const loaded = await loadSeriesDetail(HARBOR);
        if (loaded.state !== 'ready') throw new Error(loaded.state);
        const [first] = catalog.photos;
        expect(loaded.order.photos[0].thumbnailUrl).toBe(`/api/curation/media/${first.id}/${first.assetRevision}/${catalog.profileId}/w400.webp`);
    });

    it('read the Work order and the featured series for the Series screen, with the site version', async () => {
        const { root } = await world();
        const screen = await loadSeriesScreen();
        if (screen.state !== 'ready') throw new Error(screen.state);
        expect(screen.work).toEqual({
            version: (await site(root)).version,
            order: [
                { id: HARBOR, title: 'Harbor', visibility: 'published' },
                { id: DRAFT, title: 'Salt roads', visibility: 'draft' },
                { id: COAST, title: 'Coast', visibility: 'published' },
            ],
            offWork: [],
            all: [
                { id: HARBOR, title: 'Harbor', visibility: 'published' },
                { id: DRAFT, title: 'Salt roads', visibility: 'draft' },
                { id: COAST, title: 'Coast', visibility: 'published' },
            ],
            featured: [HARBOR],
        });
        await work(workForm(await site(root), 'work-order', { seriesId: DRAFT, move: 'off' }));
        const again = await loadSeriesScreen();
        if (again.state !== 'ready' || again.work === null) throw new Error('not ready');
        expect(again.work.offWork.map((entry) => entry.id)).toEqual([DRAFT]);
        expect(again.work.order.map((entry) => entry.id)).toEqual([HARBOR, COAST]);
        // A site record that can't be read offers neither.
        const folder = authoredRecordDir(root, 'site', 'site');
        for (const name of fs.readdirSync(folder)) fs.writeFileSync(path.join(folder, name), '{ not json');
        const broken = await loadSeriesScreen();
        expect(broken).toMatchObject({ state: 'ready', work: null });
    });
});

it('never puts a host path, an internal ID, a field key, a CLI flag or a command in an answer', { timeout: 60_000 }, async () => {
    const { root, p, ferry, missing, unapproved } = await world();
    const harbor = await series(root, HARBOR);
    await writeAuthoredRecord({ ...harbor, cover: { photoId: p[0], focalPoint: { x: 0.4, y: 0.3 } }, openingPhotoId: p[0], chapters: [{ id: 'ch_dawn', title: 'Dawn', startPhotoId: p[0] }, { id: 'ch_dusk', title: 'Dusk', startPhotoId: p[2] }] }, { expectedVersion: harbor.version, root });
    const answers: OrderActionState[] = [];
    const take = async (state: Promise<OrderActionState>) => answers.push(await state);
    const now = () => series(root, HARBOR);
    await take(run(orderForm(await now(), 'insert', { photoId: ferry, position: '2' })));
    await take(run(orderForm(await now(), 'move', { photoId: p[0], position: '3' })));
    await take(run(orderForm(await now(), 'remove', { photoId: p[0] })));
    await take(run(orderForm(await now(), 'remove', { photoId: p[2] })));
    await take(run(orderForm(await now(), 'insert', { photoId: p[5], position: '1' })));
    await take(run(orderForm(await now(), 'insert', { photoId: unapproved, position: '1' })));
    await take(run(orderForm(await now(), 'insert', { photoId: missing, position: '1' })));
    await take(run(orderForm(await now(), 'insert', { photoId: 'ph_00000000-0000-4000-8000-000000000000', position: '1' })));
    await take(run(orderForm(await now(), 'insert', { photoId: 'ph_bad', position: '1' })));
    await take(run(orderForm(await now(), 'insert', { photoId: p[6], position: '9' })));
    await take(run(orderForm(await now(), 'cover', { photoId: p[1], focal: 'set', focalX: '20', focalY: '80' })));
    await take(run(orderForm(await now(), 'cover', { photoId: p[1], focal: 'set', focalX: '200', focalY: '80' })));
    await take(run(orderForm(await now(), 'opening', { photoId: 'none' })));
    await take(run(orderForm(await now(), 'chapter-add', { title: 'Dusk\u200b', startPhotoId: p[1] })));
    await take(run(orderForm(await now(), 'chapter-add', { title: 'Noon', startPhotoId: p[2] })));
    await take(run(orderForm(await now(), 'chapter-move', { chapterId: 'ch_dusk', startPhotoId: p[1] })));
    await take(run(orderForm(await now(), 'chapter-move', { chapterId: 'ch_nowhere', startPhotoId: p[1] })));
    await take(run(orderForm(await now(), 'chapter-remove', { chapterId: 'ch_dusk' })));
    await take(run(orderForm({ ...(await now()), version: 1 }, 'move', { photoId: p[1], position: '1' })));
    await take(run(orderForm(await now(), 'move', { photoId: p[1], position: '1' }, `rev_${'a'.repeat(64)}`)));
    await take(run('not a form'));
    await take(work(workForm(await site(root), 'work-order', { seriesId: COAST, move: 'up' })));
    await take(work(workForm(await site(root), 'featured', { featured: [COAST, DRAFT] })));
    await take(work(workForm(await site(root), 'featured', {})));
    await take(work(workForm({ ...(await site(root)), version: 1 }, 'featured', {})));
    await withLock(AUTHORED_LOCK, { root, leaseMs: 60_000 }, async () => {
        await take(run(orderForm(await now(), 'move', { photoId: p[1], position: '1' }), { waitMs: 200 }));
    });
    // A Work order naming a series the draft lost, as a hand edit leaves it.
    const shownSite = await site(root);
    await writeAuthoredRecord({ ...shownSite, seriesOrder: [...shownSite.seriesOrder, 'ser_gone'] }, { expectedVersion: shownSite.version, root });
    await take(work(workForm(await site(root), 'work-order', { seriesId: COAST, move: 'down' })));
    fs.writeFileSync(path.join(authoredRecordDir(root, 'series', HARBOR), `v${(await now()).version}.json`), '{ not json');
    await take(run(orderForm({ ...harbor, version: 9 }, 'move', { photoId: p[1], position: '1' })));
    cleanups.push(setDataDir(path.join(root, 'nowhere')));
    await take(run(orderForm(harbor, 'move', { photoId: p[1], position: '1' })));
    expect(new Set(answers.map((state) => state.status))).toEqual(new Set(['invalid', 'done', 'stale', 'busy', 'refused', 'failed']));
    const tmp = [root, os.tmpdir(), fs.realpathSync(os.tmpdir())];
    for (const state of answers) {
        if (state.status === 'idle') continue;
        for (const dir of tmp) expect(state.message).not.toContain(dir);
        expect(state.message).not.toMatch(/\/(?:private|var|tmp|Users|home)\//);
        expect(state.message, state.message).not.toMatch(/\b(evt|ph|rev|ser|act|p|ch)_[0-9a-z]|sha256-|(^|\s)--[a-z]|\bphotos (edit|validate|carry-over|sequence|series)\b|VERSION_CONFLICT|AUTHORED_LOCKED|INVALID_RECORD|photoIds|seriesOrder|featuredSeriesIds|openingPhotoId|startPhotoId|chapterId|focalPoint|\bcover\b\.|not-a-member|membership-conflict|anchor-/);
    }
});
