// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { folderBytes } from '../../../test/helpers/folderBytes';
import { setDataDir } from '../../../test/helpers/tempDataRoot';
import { runEditRecord } from '../../catalog/edit-record';
import { FIELD_LIMITS } from '../../catalog/plain-text';
import { SERIES_ID_RE } from '../../catalog/schema';
import { createTestCatalog, type TestCatalog } from '../../catalog/testing';
import type { AuthoredSeries } from '../../catalog/types';
import { authoredRecordDir, readAuthoredRecord } from '../../catalog/working-layer';
import { AUTHORED_LOCK, writeAuthoredRecord } from '../../catalog/working-layer-writer';
import { withLock } from '../../storage/lock';
import { WEB_ACTOR } from '../inbox-form';
import { createCurationFixture } from './curationFixtures';
import { loadSeriesDetail, loadSeriesScreen, runSeriesAction } from '../series-form';
import type { SeriesActionState } from '../series-view';

// #150's 2a: the curator's Series screen, on a real data root. A new series opens from `photos edit`'s newSeries(),
// every field is cleaned by its checkText(), and every save goes through writeAuthoredRecord() with the version the
// page showed. app/curation/series/actions.ts calls runSeriesAction() only after requireCurator() lets the request
// in; __tests__/seriesBoundary.test.ts and the route inventory cover the refusals.

const HARBOR = 'ser_fixture-00';
const DRAFT = 'ser_fixture-01';
const GALLERY = 'ser_gallery';
const CARRY_OVER = { reason: 'Owner, 2026-01-01: carry the legacy Gallery over as it is.', at: '2026-01-01T00:00:00.000Z' };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A published series, a draft one that also answers to an old slug, and Gallery, carried over at the launch with no
 * statements, as `photos carry-over` leaves it. Served as the data root.
 */
async function world(): Promise<TestCatalog> {
    const catalog = await createTestCatalog({
        seed: 150,
        photos: 6,
        series: [
            { id: HARBOR, photos: 2, title: 'Harbor', visibility: 'published' },
            { id: DRAFT, photos: 2, title: 'Salt roads', slugAliases: ['old-roads'], visibility: 'draft' },
            { id: GALLERY, slug: 'gallery', photos: 2, title: 'Gallery', statement: '', shortStatement: '', visibility: 'published' },
        ],
    });
    cleanups.push(() => catalog.cleanup());
    cleanups.push(setDataDir(catalog.root));
    const gallery = (await readAuthoredRecord(catalog.root, 'series', GALLERY))!;
    await writeAuthoredRecord({ ...gallery, carryOver: CARRY_OVER }, { expectedVersion: gallery.version, root: catalog.root, carryOver: true });
    return catalog;
}

function form(fields: Record<string, string>): FormData {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.set(name, value);
    return data;
}

/** New series' form, with the active revision the page showed: none, in the worlds below unless a test says. */
const createForm = (fields: Record<string, string>) => form({ base: 'none', ...fields });

const series = async (root: string, id: string) => (await readAuthoredRecord(root, 'series', id)) as AuthoredSeries;

/** The series page's form for `record`, as SeriesEditForm sends it, with `change` over what it shows. */
function editForm(record: AuthoredSeries, change: Partial<Record<'title' | 'statement' | 'shortStatement' | 'visibility', string>> = {}, extra: Record<string, string> = {}): FormData {
    return form({ seriesId: record.id, version: String(record.version), base: 'none', title: record.title, statement: record.statement, shortStatement: record.shortStatement, visibility: record.visibility, ...change, ...extra });
}

const run = (kind: 'create' | 'edit', data: unknown, options: Parameters<typeof runSeriesAction>[2] = {}): Promise<SeriesActionState> => runSeriesAction(kind, data, options);

/** A series record made by another writer, as `photos edit` would make it. */
const elsewhere = (id: string, slug: string) => ({ kind: 'series' as const, id, slug, title: 'Elsewhere', statement: '', shortStatement: '', photoIds: [], chapters: [], cover: null, visibility: 'draft' as const });

const authored = (root: string) => folderBytes(path.join(root, 'authored'));

describe('New series', { timeout: 30_000 }, () => {
    it('opens a draft from newSeries(), with an ID and a slug made from the title, stamped as the web curator', async () => {
        const { root } = await world();
        const state = await run('create', createForm({ title: 'Night ferries' }));
        expect(state).toMatchObject({ status: 'done', action: 'create', seriesId: 'ser_night-ferries', href: '/curation/series/ser_night-ferries' });
        if (state.status === 'idle') throw new Error('no answer');
        expect(state.message).toBe('Made Night ferries, a draft. Nothing is public until you publish.');
        const made = await series(root, 'ser_night-ferries');
        // newSeries()'s draft, with the title the curator typed and nothing else filled in.
        expect(made).toMatchObject({ version: 1, kind: 'series', id: 'ser_night-ferries', slug: 'night-ferries', slugAliases: [], title: 'Night ferries', statement: '', shortStatement: '', photoIds: [], chapters: [], cover: null, visibility: 'draft' });
        expect(made.carryOver).toBeUndefined();
        expect(made.review?.fields.title).toMatchObject({ origin: 'curator', actor: WEB_ACTOR });
    });

    it('takes the web address the curator typed', async () => {
        const { root } = await world();
        expect(await run('create', createForm({ title: 'Night ferries', slug: 'ferries-at-night' }))).toMatchObject({ status: 'done', seriesId: 'ser_ferries-at-night' });
        expect((await series(root, 'ser_ferries-at-night')).slug).toBe('ferries-at-night');
    });

    it('makes a generated slug unique: a second series of the same title gets the next free one', async () => {
        const { root } = await world();
        await run('create', createForm({ title: 'Night ferries' }));
        expect(await run('create', createForm({ title: 'Night ferries' }))).toMatchObject({ status: 'done', seriesId: 'ser_night-ferries-2' });
        expect((await series(root, 'ser_night-ferries-2')).slug).toBe('night-ferries-2');
        // Another series' slug alias, and a route the site keeps for itself, are taken too.
        expect(await run('create', createForm({ title: 'Old roads' }))).toMatchObject({ status: 'done', seriesId: 'ser_old-roads-2' });
        expect((await series(root, 'ser_old-roads-2')).slug).toBe('old-roads-2');
        expect(await run('create', createForm({ title: 'Work' }))).toMatchObject({ status: 'done', seriesId: 'ser_work-2' });
        expect((await series(root, 'ser_work-2')).slug).toBe('work-2');
    });

    it("gives the series an ID of its own when the slug is free but its ID isn't, keeping the slug", async () => {
        const { root } = await world();
        // A series whose ID reads `harbor-light` but whose slug moved on, as a rename with photos edit leaves it.
        const moved = { ...(await series(root, HARBOR)) };
        await writeAuthoredRecord({ ...moved, id: 'ser_harbor-light', slug: 'harbor-at-dusk', review: undefined, version: 0 } as never, { expectedVersion: 0, root });
        const state = await run('create', createForm({ title: 'Harbor light' }));
        expect(state).toMatchObject({ status: 'done', seriesId: 'ser_harbor-light-2' });
        expect((await series(root, 'ser_harbor-light-2')).slug).toBe('harbor-light');
        expect((await series(root, 'ser_harbor-light')).slug).toBe('harbor-at-dusk');
    });

    it('makes every ID it generates one SERIES_ID_RE takes, however long or short the title', async () => {
        const { root } = await world();
        const long = `${'Long exposure '.repeat(8)}harbor`;
        const made = await run('create', createForm({ title: long.slice(0, FIELD_LIMITS.title) }));
        expect(made.status).toBe('done');
        const short = await run('create', createForm({ title: 'A' }));
        expect(short.status).toBe('done');
        for (const state of [made, short]) {
            if (state.status === 'idle' || state.seriesId === null) throw new Error('no series');
            expect(state.seriesId).toMatch(SERIES_ID_RE);
            expect((await series(root, state.seriesId)).slug.length).toBeLessThanOrEqual(64);
        }
    });

    it('refuses a title it would have to clean away, with the CLI\'s rules, and writes nothing', async () => {
        const { root } = await world();
        const before = authored(root);
        expect(await run('create', createForm({ title: '   ' }))).toMatchObject({ status: 'invalid', field: 'title', message: 'A new series needs a title. Nothing was written.' });
        expect(await run('create', createForm({ title: 'x'.repeat(FIELD_LIMITS.title + 1) }))).toMatchObject({ status: 'invalid', field: 'title', message: `The title is ${FIELD_LIMITS.title + 1} characters long, over its limit of ${FIELD_LIMITS.title}. Nothing was written.` });
        expect(await run('create', createForm({ title: 'Night\u0007ferries' }))).toMatchObject({ status: 'invalid', field: 'title', message: expect.stringMatching(/^The title has U\+0007, .* at character 6\. Nothing was written\.$/) });
        expect(await run('create', createForm({ title: 'Night\nferries' }))).toMatchObject({ status: 'invalid', field: 'title', message: "The title has a line break, which it can't hold. Nothing was written." });
        expect(authored(root)).toEqual(before);
    });

    it('refuses a bad, reserved or taken web address, and a title with nothing to make one from, writing nothing', async () => {
        const { root } = await world();
        const before = authored(root);
        const format = 'A web address is lowercase letters and digits in words joined by single hyphens, at most 64 characters. Nothing was written.';
        for (const slug of ['Night Ferries', 'night--ferries', '-ferries', 'night_ferries', 'n'.repeat(65)]) {
            expect(await run('create', createForm({ title: 'Night ferries', slug })), slug).toMatchObject({ status: 'invalid', field: 'slug', message: format });
        }
        expect(await run('create', createForm({ title: 'Night ferries', slug: 'work' }))).toMatchObject({ status: 'invalid', field: 'slug', message: 'The site keeps /work for its own pages. Choose another web address. Nothing was written.' });
        // Another series' slug, and another's old slug, which still leads to it.
        for (const slug of ['fixture-00', 'old-roads']) {
            expect(await run('create', createForm({ title: 'Night ferries', slug })), slug).toMatchObject({ status: 'invalid', field: 'slug', message: 'Another series has that web address already. Choose another. Nothing was written.' });
        }
        expect(await run('create', createForm({ title: '—' }))).toMatchObject({ status: 'invalid', field: 'slug', message: 'The title has no letters or digits to make a web address from. Type one. Nothing was written.' });
        expect(authored(root)).toEqual(before);
    });

    it('spells the letters NFKD keeps whole in the slug, and asks for a web address when the title has letters it can\'t hold', async () => {
        const { root } = await world();
        for (const [title, slug] of [['Łódź', 'lodz'], ['Straße', 'strasse'], ['Ærø', 'aero'], ['Þingvellir', 'thingvellir'], ['Œuvre', 'oeuvre'], ['Đakovo', 'dakovo'], ['Café Øresund', 'cafe-oresund']]) {
            const state = await run('create', createForm({ title }));
            if (state.status === 'idle' || state.seriesId === null) throw new Error(title);
            expect((await series(root, state.seriesId)).slug, title).toBe(slug);
        }
        const before = authored(root);
        for (const title of ['港の朝', 'Harbor 港']) {
            expect(await run('create', createForm({ title })), title).toMatchObject({ status: 'invalid', field: 'slug', message: "Some of the title's letters can't go in a web address. Type one. Nothing was written." });
        }
        // With a web address typed, such a title is fine.
        expect(authored(root)).toEqual(before);
        expect(await run('create', createForm({ title: '港の朝', slug: 'harbor-morning' }))).toMatchObject({ status: 'done', seriesId: 'ser_harbor-morning' });
    });

    it("refuses New series while a series can't be read, since its web address can't be checked, and writes nothing", async () => {
        const { root } = await world();
        fs.writeFileSync(path.join(authoredRecordDir(root, 'series', DRAFT), 'v1.json'), '{ not json');
        const before = authored(root);
        const unreadable = "A series can't be read, so a new one's web address can't be checked against it. Nothing was written. The server log names it.";
        expect(await run('create', createForm({ title: 'Night ferries' }))).toMatchObject({ status: 'refused', message: unreadable });
        expect(await run('create', createForm({ title: 'Night ferries', slug: 'night-ferries' }))).toMatchObject({ status: 'refused', message: unreadable });
        expect(authored(root)).toEqual(before);
    });

    it('checks the web address under the same hold of the authored lock as the write', async () => {
        const { root } = await world();
        let pending: Promise<SeriesActionState> | null = null;
        await withLock(AUTHORED_LOCK, { root, leaseMs: 60_000 }, async (lock) => {
            pending = run('create', createForm({ title: 'Night ferries' }), { waitMs: 20_000 });
            await new Promise((resolve) => setTimeout(resolve, 300));
            // `photos edit` makes a series with the slug the title gives while New series waits for the lock.
            await writeAuthoredRecord(elsewhere('ser_ferries-elsewhere', 'night-ferries'), { expectedVersion: 0, root, lock });
        });
        expect(await pending).toMatchObject({ status: 'done', seriesId: 'ser_night-ferries-2' });
        expect((await series(root, 'ser_night-ferries-2')).slug).toBe('night-ferries-2');
    });

    it('cleans the title the way photos edit does', async () => {
        const { root } = await world();
        await run('create', createForm({ title: '  Night ferries  ' }));
        const made = await series(root, 'ser_night-ferries');
        // The same text through `photos edit --file` on a twin series.
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'series-form-')), 'edit.json');
        cleanups.push(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
        fs.writeFileSync(file, JSON.stringify({ kind: 'series', id: 'ser_night-ferries-cli', slug: 'night-ferries-cli', title: '  Night ferries  ', statement: '', shortStatement: '', photoIds: [], chapters: [], cover: null, visibility: 'draft' }));
        expect((await runEditRecord({ dataRoot: root }, { kind: 'series', id: 'ser_night-ferries-cli' }, { file })).exitCode).toBe(0);
        expect(made.title).toBe((await series(root, 'ser_night-ferries-cli')).title);
        expect(made.title).toBe('Night ferries');
    });
});

describe("A series' page", { timeout: 30_000 }, () => {
    it('saves each field as the next version, through the writer, stamped as the web curator', async () => {
        const { root } = await world();
        let record = await series(root, HARBOR);
        const steps: ['title' | 'statement' | 'shortStatement' | 'visibility', string, string][] = [
            ['title', 'Harbor at first light', 'Harbor at first light'],
            ['statement', 'The harbor before the ferries.\n\nA second paragraph.', 'The harbor before the ferries.\n\nA second paragraph.'],
            ['shortStatement', 'The harbor before the ferries.', 'The harbor before the ferries.'],
            ['visibility', 'hidden', 'hidden'],
            ['visibility', 'draft', 'draft'],
            ['visibility', 'published', 'published'],
        ];
        for (const [field, value, stored] of steps) {
            const state = await run('edit', editForm(record, { [field]: value }));
            expect(state, field).toMatchObject({ status: 'done', action: 'edit', seriesId: HARBOR, message: 'Saved to the draft. Nothing is public until you publish.' });
            const next = await series(root, HARBOR);
            expect(next.version).toBe(record.version + 1);
            expect(next[field]).toBe(stored);
            expect(next.review?.fields[field]).toMatchObject({ origin: 'curator', actor: WEB_ACTOR });
            record = next;
        }
    });

    it('says nothing changed when nothing did, and writes nothing', async () => {
        const { root } = await world();
        const before = authored(root);
        expect(await run('edit', editForm(await series(root, HARBOR)))).toMatchObject({ status: 'invalid', message: 'Nothing changed, so there is nothing to save.' });
        // Text the cleaning would store as it is already counts as no change too.
        expect(await run('edit', editForm(await series(root, HARBOR), { title: '  Harbor ' }))).toMatchObject({ status: 'invalid', message: 'Nothing changed, so there is nothing to save.' });
        expect(authored(root)).toEqual(before);
    });

    it('answers refresh to a form made against an older version, and writes nothing', async () => {
        const { root } = await world();
        const shown = await series(root, HARBOR);
        // Someone else saves it first, as `photos edit` would.
        await writeAuthoredRecord({ ...shown, title: 'Harbor, renamed elsewhere' }, { expectedVersion: shown.version, root });
        const before = authored(root);
        const state = await run('edit', editForm(shown, { title: 'Harbor at first light' }));
        expect(state).toMatchObject({ status: 'stale', seriesId: HARBOR, message: 'This series changed since the page loaded, so nothing was written. Refresh to see what it holds now, and edit it again.' });
        expect(authored(root)).toEqual(before);
        expect((await series(root, HARBOR)).title).toBe('Harbor, renamed elsewhere');
    });

    it("answers refresh from the writer's own check when the series moves after the early one, and writes nothing of the form's", async () => {
        const { root } = await world();
        const shown = await series(root, HARBOR);
        let moved = false;
        // The early check passes, then `photos edit` saves the series before the save takes the lock.
        const afterCheck = async () => {
            await writeAuthoredRecord({ ...shown, title: 'Harbor, renamed elsewhere' }, { expectedVersion: shown.version, root });
            moved = true;
        };
        expect(await run('edit', editForm(shown, { title: 'Harbor at first light' }), { afterCheck })).toMatchObject({ status: 'stale', message: expect.stringMatching(/^This series changed since the page loaded/) });
        // So the refusal is the writer's VERSION_CONFLICT under the lock: the early check saw the version the form carried.
        expect(moved).toBe(true);
        expect(await series(root, HARBOR)).toMatchObject({ version: shown.version + 1, title: 'Harbor, renamed elsewhere' });
    });

    it('leaves the chapters as photos sequence stored them, untrimmed or past the title rules, and still saves the rest', async () => {
        const { root } = await world();
        const harbor = await series(root, HARBOR);
        const chapters = [
            { id: 'ch_dawn', title: ' Dawn ', startPhotoId: harbor.photoIds[0] },
            { id: 'ch_dusk', title: 'Dusk\u200b', startPhotoId: harbor.photoIds[1] },
            { id: 'ch_long', title: 'x'.repeat(FIELD_LIMITS.title + 1), startPhotoId: harbor.photoIds[1] },
        ];
        await writeAuthoredRecord({ ...harbor, chapters }, { expectedVersion: harbor.version, root });
        const shown = await series(root, HARBOR);
        const before = authored(root);
        // Nothing the form shows changed, so nothing is saved, chapters and all.
        expect(await run('edit', editForm(shown))).toMatchObject({ status: 'invalid', message: 'Nothing changed, so there is nothing to save.' });
        expect(authored(root)).toEqual(before);
        // A rename saves, and the chapters stay as they were, with their stamps.
        expect(await run('edit', editForm(shown, { title: 'Harbor at first light' }))).toMatchObject({ status: 'done' });
        const saved = await series(root, HARBOR);
        expect(saved.title).toBe('Harbor at first light');
        expect(saved.chapters).toEqual(chapters);
        expect(saved.review?.fields.chapters).toEqual(shown.review?.fields.chapters);
    });

    it("refuses a form part that isn't text without naming the field, and writes nothing", async () => {
        const { root } = await world();
        const shown = await series(root, HARBOR);
        const before = authored(root);
        const data = editForm(shown, { title: 'Harbor at first light' });
        data.set('shortStatement', new Blob(['a file']), 'short.txt');
        expect(await run('edit', data)).toMatchObject({ status: 'invalid', message: "The form sent something that isn't text. Refresh the page." });
        const made = createForm({});
        made.set('title', new Blob(['a file']), 'title.txt');
        expect(await run('create', made)).toMatchObject({ status: 'invalid', message: "The form sent something that isn't text. Refresh the page." });
        expect(authored(root)).toEqual(before);
    });

    it('answers refresh when the live revision moved since the page loaded, for a save and a New series, and writes nothing', async () => {
        const { root } = await world();
        const shown = await series(root, HARBOR);
        const before = authored(root);
        const moved = 'A publish or rollback happened since the page loaded, so nothing was written. Refresh the page and try again.';
        // The page showed a live revision, and there is none now.
        const base = `rev_${'a'.repeat(64)}`;
        expect(await run('edit', editForm(shown, { title: 'Harbor at first light' }, { base }))).toMatchObject({ status: 'stale', message: moved });
        expect(await run('create', createForm({ title: 'Night ferries', base }))).toMatchObject({ status: 'stale', message: moved });
        for (const bad of ['', 'rev_1', 'latest']) {
            expect(await run('edit', editForm(shown, { title: 'Harbor at first light' }, { base: bad })), bad).toMatchObject({ status: 'invalid', message: 'The form carries no live revision. Refresh the page.' });
            expect(await run('create', createForm({ title: 'Night ferries', base: bad })), bad).toMatchObject({ status: 'invalid', message: 'The form carries no live revision. Refresh the page.' });
        }
        expect(authored(root)).toEqual(before);
    });

    it("stamps a save against the live revision the page showed", async () => {
        const f = await createCurationFixture({ published: true, fresh: 0, seed: 1504 });
        cleanups.push(() => f.cleanup());
        cleanups.push(setDataDir(f.root));
        const live = f.catalog.revisionId;
        const shown = await series(f.root, 'ser_fixture-00');
        // A page loaded before the launch publish, with no live revision, is behind it.
        expect(await run('edit', editForm(shown, { title: 'Harbor at first light' }, { base: 'none' }))).toMatchObject({ status: 'stale' });
        expect(await run('edit', editForm(shown, { title: 'Harbor at first light' }, { base: live }))).toMatchObject({ status: 'done' });
        expect((await series(f.root, 'ser_fixture-00')).review?.fields.title).toMatchObject({ baseRevisionId: live, actor: WEB_ACTOR });
        expect(await run('create', createForm({ title: 'Night ferries', base: live }))).toMatchObject({ status: 'done', seriesId: 'ser_night-ferries' });
        expect((await series(f.root, 'ser_night-ferries')).review?.fields.title).toMatchObject({ baseRevisionId: live });
        expect(await loadSeriesScreen()).toMatchObject({ state: 'ready', activeRevisionId: live });
        expect(await loadSeriesDetail('ser_fixture-00')).toMatchObject({ state: 'ready', activeRevisionId: live });
    });

    it('refuses text over its limit, or a line break where the field takes none, by the field, and writes nothing', async () => {
        const { root } = await world();
        const record = await series(root, HARBOR);
        const before = authored(root);
        const over = (n: number) => 'x'.repeat(n + 1);
        expect(await run('edit', editForm(record, { title: over(FIELD_LIMITS.title) }))).toMatchObject({ status: 'invalid', field: 'title', message: `The title is ${FIELD_LIMITS.title + 1} characters long, over its limit of ${FIELD_LIMITS.title}. Nothing was written.` });
        expect(await run('edit', editForm(record, { statement: over(FIELD_LIMITS.statement) }))).toMatchObject({ status: 'invalid', field: 'statement', message: `The statement is ${FIELD_LIMITS.statement + 1} characters long, over its limit of ${FIELD_LIMITS.statement}. Nothing was written.` });
        expect(await run('edit', editForm(record, { shortStatement: over(FIELD_LIMITS.shortStatement) }))).toMatchObject({ status: 'invalid', field: 'shortStatement', message: `The short statement is ${FIELD_LIMITS.shortStatement + 1} characters long, over its limit of ${FIELD_LIMITS.shortStatement}. Nothing was written.` });
        expect(await run('edit', editForm(record, { shortStatement: 'One line.\nTwo lines.' }))).toMatchObject({ status: 'invalid', field: 'shortStatement', message: "The short statement has a line break, which it can't hold. Nothing was written." });
        expect(await run('edit', editForm(record, { statement: 'Zero\u200bwidth' }))).toMatchObject({ status: 'invalid', field: 'statement', message: expect.stringMatching(/^The statement has U\+200B, .* at character 5\. Nothing was written\.$/) });
        expect(await run('edit', editForm(record, { visibility: 'public' }))).toMatchObject({ status: 'invalid', field: 'visibility', message: 'Choose Published, Draft or Hidden. Nothing was written.' });
        expect(authored(root)).toEqual(before);
    });

    it('cleans its text the way photos edit does', async () => {
        const { root } = await world();
        const raw = { title: '  Harbor at first light ', statement: '  The harbor.\r\n\r\nBefore the ferries.  ', shortStatement: ' The harbor. ' };
        expect(await run('edit', editForm(await series(root, HARBOR), raw))).toMatchObject({ status: 'done' });
        const saved = await series(root, HARBOR);
        // The same edit of the draft series, through `photos edit --file`.
        const draft = await series(root, DRAFT);
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'series-form-')), 'edit.json');
        cleanups.push(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
        // What photos edit opens: the record without the fields the writer manages.
        const open = Object.fromEntries(Object.entries(draft).filter(([key]) => !['schemaVersion', 'version', 'baseRevisionId', 'review'].includes(key)));
        fs.writeFileSync(file, JSON.stringify({ ...open, ...raw }));
        expect((await runEditRecord({ dataRoot: root }, { kind: 'series', id: DRAFT }, { file, expectVersion: draft.version })).exitCode).toBe(0);
        const cli = await series(root, DRAFT);
        for (const field of ['title', 'statement', 'shortStatement'] as const) expect(saved[field], field).toBe(cli[field]);
        expect(saved.statement).toBe('The harbor.\n\nBefore the ferries.');
    });

    it("never changes the photographs or the carry-over marker, whatever the form sends", async () => {
        const { root } = await world();
        const gallery = await series(root, GALLERY);
        expect(gallery.carryOver).toEqual(CARRY_OVER);
        const harbor = await series(root, HARBOR);
        // A form that adds fields the page never sends: the series' photographs, a marker, another kind or ID.
        const extra = { photoIds: JSON.stringify(harbor.photoIds), 'photoIds[]': harbor.photoIds[0], carryOver: 'true', cover: 'null', kind: 'photo', id: HARBOR, slug: 'elsewhere' };
        expect(await run('edit', editForm(gallery, { title: 'Gallery, as it was' }, extra))).toMatchObject({ status: 'done' });
        const renamed = await series(root, GALLERY);
        expect(renamed).toMatchObject({ title: 'Gallery, as it was', photoIds: gallery.photoIds, cover: gallery.cover, slug: gallery.slug, chapters: gallery.chapters, carryOver: CARRY_OVER });
        // A statement is what the marker stood in for, so the writer drops it then (carryOverMarker()), as it does for
        // `photos edit`. The form still leaves the photographs as they are.
        expect(await run('edit', editForm(renamed, { statement: 'The legacy Gallery, carried over.' }))).toMatchObject({ status: 'done' });
        const written = await series(root, GALLERY);
        expect(written.carryOver).toBeUndefined();
        expect(written.photoIds).toEqual(gallery.photoIds);
    });

    it('answers busy while the authored lock is held, and writes nothing', async () => {
        const { root } = await world();
        const record = await series(root, HARBOR);
        const before = authored(root);
        const busy = 'Another change is being written right now, so nothing was written. Try again in a moment.';
        await withLock(AUTHORED_LOCK, { root, leaseMs: 60_000 }, async () => {
            expect(await run('edit', editForm(record, { title: 'Harbor at first light' }), { waitMs: 200 })).toMatchObject({ status: 'busy', seriesId: HARBOR, message: busy });
            expect(await run('create', createForm({ title: 'Night ferries' }), { waitMs: 200 })).toMatchObject({ status: 'busy', message: busy });
            expect(authored(root)).toEqual(before);
        });
    });

    it('refuses a form that names no series, a bad ID, or one the working layer lacks, and writes nothing', async () => {
        const { root } = await world();
        const record = await series(root, HARBOR);
        const before = authored(root);
        expect(await run('edit', 'not a form')).toMatchObject({ status: 'invalid', message: 'The form was empty. Refresh the page.' });
        for (const seriesId of ['', 'harbor', 'ser_', 'ser_../site', 'SER_HARBOR', `ser_${'a'.repeat(64)}`]) {
            expect(await run('edit', editForm({ ...record, id: seriesId })), seriesId).toMatchObject({ status: 'invalid', message: 'The form names no series. Refresh the page.' });
        }
        for (const version of ['', '0', '-1', '1.5', 'one']) {
            expect(await run('edit', editForm(record, {}, { version })), version).toMatchObject({ status: 'invalid', message: 'The form carries no series version. Refresh the page.' });
        }
        expect(await run('edit', editForm({ ...record, id: 'ser_nowhere' }, { title: 'Nowhere' }))).toMatchObject({ status: 'stale', message: "This series isn't in the working layer any more, so nothing was written. Refresh the list." });
        expect(authored(root)).toEqual(before);
    });

    it("answers failed, and says only that, when the record can't be read or the data root isn't ready", async () => {
        const { root } = await world();
        const record = await series(root, HARBOR);
        // A version file damaged by hand.
        fs.writeFileSync(path.join(authoredRecordDir(root, 'series', HARBOR), `v${record.version}.json`), '{ not json');
        const damaged = await run('edit', editForm(record, { title: 'Harbor at first light' }));
        expect(damaged).toMatchObject({ status: 'failed', message: "This series can't be read, so nothing was written. The server log names the problem." });
        cleanups.push(setDataDir(path.join(root, 'nowhere')));
        expect(await run('create', createForm({ title: 'Night ferries' }))).toMatchObject({ status: 'failed', message: expect.stringMatching(/^The data root is unavailable\. Nothing was written\.$/) });
    });
});

describe('The screens\' reads', { timeout: 30_000 }, () => {
    it('list every series: its title, visibility, photographs, and whether it was carried over, in Work order first', async () => {
        const { root } = await world();
        await run('create', createForm({ title: 'Night ferries' }));
        const screen = await loadSeriesScreen();
        if (screen.state !== 'ready') throw new Error(screen.state);
        expect(screen.rows.map(({ id, title, visibility, photoCount, carriedOver }) => ({ id, title, visibility, photoCount, carriedOver }))).toEqual([
            { id: HARBOR, title: 'Harbor', visibility: 'published', photoCount: 2, carriedOver: false },
            { id: DRAFT, title: 'Salt roads', visibility: 'draft', photoCount: 2, carriedOver: false },
            { id: GALLERY, title: 'Gallery', visibility: 'published', photoCount: 2, carriedOver: true },
            { id: 'ser_night-ferries', title: 'Night ferries', visibility: 'draft', photoCount: 0, carriedOver: false },
        ]);
        expect(screen.rows[0]).toMatchObject({ slug: 'fixture-00', href: `/curation/series/${HARBOR}`, inWorkOrder: true });
        expect(screen.rows[3].inWorkOrder).toBe(false);
        expect(screen.unreadable).toBe(0);
        expect(screen.activeRevisionId).toBeNull();
        // A series that can't be read is counted, not shown.
        fs.writeFileSync(path.join(authoredRecordDir(root, 'series', DRAFT), 'v1.json'), '{ not json');
        fs.rmSync(path.join(authoredRecordDir(root, 'series', DRAFT), 'v2.json'), { force: true });
        const again = await loadSeriesScreen();
        if (again.state !== 'ready') throw new Error(again.state);
        expect(again.unreadable).toBe(1);
        expect(again.rows.map((row) => row.id)).not.toContain(DRAFT);
    });

    it("read one series for its page, with the version its form carries", async () => {
        const { root } = await world();
        const record = await series(root, GALLERY);
        expect(await loadSeriesDetail(GALLERY)).toEqual({
            state: 'ready',
            activeRevisionId: null,
            detail: { id: GALLERY, version: record.version, title: 'Gallery', slug: 'gallery', statement: '', shortStatement: '', visibility: 'published', photoCount: 2, carriedOver: true, inWorkOrder: true },
        });
        expect(await loadSeriesDetail('ser_nowhere')).toEqual({ state: 'not-found' });
        expect(await loadSeriesDetail('../site')).toEqual({ state: 'not-found' });
    });
});

it('never puts a host path, an internal ID, a field key, a CLI flag or a command in an answer', { timeout: 30_000 }, async () => {
    const { root } = await world();
    const harbor = await series(root, HARBOR);
    // Chapters past the title rules, which only a CLI write leaves, so a check that reached them would name their key.
    await writeAuthoredRecord({ ...harbor, chapters: [{ id: 'ch_dusk', title: 'Dusk\u200b', startPhotoId: harbor.photoIds[0] }] }, { expectedVersion: harbor.version, root });
    const shown = await series(root, HARBOR);
    const answers: SeriesActionState[] = [];
    const take = async (kind: 'create' | 'edit', data: unknown, options: Parameters<typeof runSeriesAction>[2] = {}) => answers.push(await run(kind, data, options));
    const blob = (data: FormData, name: string) => {
        data.set(name, new Blob(['a file']), `${name}.txt`);
        return data;
    };
    await take('edit', editForm(shown));
    await take('edit', editForm(shown, { title: 'Harbor at first light' }));
    await take('edit', blob(editForm(shown), 'shortStatement'));
    await take('edit', blob(editForm(shown), 'visibility'));
    await take('create', blob(createForm({}), 'slug'));
    await take('edit', editForm(shown, { shortStatement: 'One.\nTwo.', statement: 'x'.repeat(FIELD_LIMITS.statement + 1), title: 'Zero\u200bwidth' }));
    await take('edit', editForm(shown, { visibility: 'public' }));
    await take('edit', editForm({ ...shown, id: 'ser_nowhere' }));
    await take('edit', editForm(shown, {}, { base: `rev_${'a'.repeat(64)}` }));
    await take('edit', editForm(shown, { title: 'Again' }));
    await take('create', createForm({ title: 'Night ferries', slug: 'fixture-00' }));
    await take('create', createForm({ title: 'Night ferries', slug: 'work' }));
    await take('create', createForm({ title: '港の朝' }));
    await take('create', 'not a form');
    await withLock(AUTHORED_LOCK, { root, leaseMs: 60_000 }, async () => {
        await take('edit', editForm(await series(root, HARBOR), { title: 'Busy' }), { waitMs: 200 });
        await take('create', createForm({ title: 'Busy' }), { waitMs: 200 });
    });
    fs.writeFileSync(path.join(authoredRecordDir(root, 'series', DRAFT), 'v1.json'), '{ not json');
    await take('create', createForm({ title: 'Night ferries' }));
    await take('edit', editForm(await series(root, GALLERY), {}, { seriesId: DRAFT, title: 'Salt roads, again' }));
    cleanups.push(setDataDir(path.join(root, 'nowhere')));
    await take('create', createForm({ title: 'Night ferries' }));
    expect(new Set(answers.map((state) => state.status))).toEqual(new Set(['invalid', 'done', 'stale', 'busy', 'refused', 'failed']));
    const tmp = [root, os.tmpdir(), fs.realpathSync(os.tmpdir())];
    for (const state of answers) {
        if (state.status === 'idle') continue;
        for (const dir of tmp) expect(state.message).not.toContain(dir);
        expect(state.message).not.toMatch(/\/(?:private|var|tmp|Users|home)\//);
        expect(state.message).not.toMatch(/\b(evt|ph|rev|ser|act|p|ch)_[0-9a-z]|sha256-|(^|\s)--[a-z]|\bphotos (edit|validate|carry-over|sequence)\b|VERSION_CONFLICT|AUTHORED_LOCKED|INVALID_RECORD|shortStatement|visibility|chapters|\bslug\b/);
    }
});
