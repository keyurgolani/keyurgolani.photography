// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordDirectorySyncs } from '../../../test/helpers/directorySyncs';
import { importGraph } from '../../../test/helpers/importGraph';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { MAX_VERSION_DIGITS } from '../../storage/document';
import { withLock } from '../../storage/lock';
import type { AuthoredPhoto, AuthoredSeries, ManagedField } from '../types';
import { authoredPaths, catalogPaths, readActivePointer, readAuthoredRecord, readWorkingLayer } from '../working-layer';
import { AuthoredWriteError, MANAGED_FIELDS, writeAuthoredRecord } from '../working-layer-writer';

const PHOTO_A = 'ph_00000000-0000-4000-8000-00000000000a';
const PHOTO_B = 'ph_00000000-0000-4000-8000-00000000000b';
const PHOTO_C = 'ph_00000000-0000-4000-8000-00000000000c';
const PHOTO_D = 'ph_00000000-0000-4000-8000-00000000000d';
const ASSET = `sha256-${'a'.repeat(64)}`;
const ACTIVE = `rev_${'1'.repeat(64)}`;
const LATER = `rev_${'2'.repeat(64)}`;

const roots: TempDataRoot[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    // Newest first, so each cleanup puts back the PHOTOGRAPHY_DATA_DIR from before its own root
    for (const root of roots.splice(0).reverse()) await root.cleanup();
});

function dataRoot(state: 'ready' | 'uninitialized' = 'ready'): TempDataRoot {
    const data = createTempDataRoot({ state });
    roots.push(data);
    return data;
}

function writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

/** A record's version file, written by hand: no stamp, so it reads as a hand-made version. */
function writeVersion(dir: string, version: number, value: unknown): void {
    writeJson(path.join(dir, `v${version}.json`), value);
}

/** Edit a record's newest version in place, which the stamp check refuses. */
function editInPlace(file: string, edit: (text: string) => string): void {
    fs.writeFileSync(file, edit(fs.readFileSync(file, 'utf8')));
}

function activate(root: string, revisionId: string): void {
    writeJson(catalogPaths(root).active, { schemaVersion: 1, revisionId, activationId: 'act_00000000-0000-4000-8000-000000000001' });
}

const photo = (id: string, extra: Partial<AuthoredPhoto> = {}) => ({ kind: 'photo' as const, id, assetRevision: ASSET, alt: null, ...extra });
const series = (id: string, extra: Partial<AuthoredSeries> = {}) => ({ kind: 'series' as const, id, slug: id.slice(4), visibility: 'draft' as const, ...extra });

/** Whether the disk under `root` treats names that differ only in case as one, as macOS does by default. */
function caseInsensitive(root: string): boolean {
    fs.writeFileSync(path.join(root, 'Case-Probe'), '');
    try {
        return fs.existsSync(path.join(root, 'case-probe'));
    } finally {
        fs.unlinkSync(path.join(root, 'Case-Probe'));
    }
}

async function rejection(promise: Promise<unknown>): Promise<AuthoredWriteError> {
    const error = await promise.then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuthoredWriteError);
    return error as AuthoredWriteError;
}

describe('readWorkingLayer', () => {
    it('reads nothing from a data root with no authored records', async () => {
        const data = dataRoot();
        expect(await readWorkingLayer(data.root)).toEqual({ site: null, series: [], photos: [], problems: [] });
    });

    it('reads the site, series, and photos, each sorted by ID, with defaults applied', async () => {
        const data = dataRoot();
        const paths = authoredPaths(data.root);
        writeVersion(paths.site, 2, { schemaVersion: 1, version: 2, baseRevisionId: null, kind: 'site', featuredSeriesIds: ['ser_fixture-b'], seriesOrder: ['ser_fixture-b', 'ser_fixture-a'] });
        for (const id of ['ser_fixture-b', 'ser_fixture-a']) {
            writeVersion(path.join(paths.seriesDir, id), 1, { schemaVersion: 1, version: 1, baseRevisionId: null, ...series(id) });
        }
        for (const id of [PHOTO_B, PHOTO_A]) {
            writeVersion(path.join(paths.photosDir, id), 1, { schemaVersion: 1, version: 1, baseRevisionId: ACTIVE, ...photo(id) });
        }
        // Only the newest version of a record is read.
        writeVersion(path.join(paths.photosDir, PHOTO_A), 3, { schemaVersion: 1, version: 3, baseRevisionId: ACTIVE, ...photo(PHOTO_A), title: 'Newest' });

        const layer = await readWorkingLayer(data.root);
        expect(layer.site).toMatchObject({ featuredSeriesIds: ['ser_fixture-b'], version: 2 });
        expect(layer.series.map((record) => record.id)).toEqual(['ser_fixture-a', 'ser_fixture-b']);
        expect(layer.series[0]).toMatchObject({ publicationPolicy: 'review-required', photoIds: [], cover: null, title: '' });
        expect(layer.photos.map((record) => record.id)).toEqual([PHOTO_A, PHOTO_B]);
        expect(layer.photos[0]).toMatchObject({ version: 3, title: 'Newest' });
        expect(layer.problems).toEqual([]);
    });

    it('reports each record it cannot use by record, never by path, and leaves it out', async () => {
        const data = dataRoot();
        const { seriesDir, photosDir } = authoredPaths(data.root);
        writeVersion(path.join(seriesDir, 'ser_broken'), 1, '{"kind": "series"');
        writeVersion(path.join(seriesDir, 'ser_future'), 1, { schemaVersion: 4, version: 1, baseRevisionId: null, ...series('ser_future') });
        writeVersion(path.join(photosDir, PHOTO_A), 1, { schemaVersion: 1, version: 1, baseRevisionId: null, ...photo(PHOTO_A), sourcePath: '/library/IMG_0001.jpg' });
        writeVersion(path.join(photosDir, PHOTO_B), 1, { schemaVersion: 1, version: 1, baseRevisionId: null, ...photo(PHOTO_A) });
        await writeAuthoredRecord(photo(PHOTO_C), { expectedVersion: 0, root: data.root });
        editInPlace(path.join(photosDir, PHOTO_C, 'v1.json'), (text) => text.replace('"alt": null', '"alt": { "kind": "decorative" }'));
        // A file in the old one-file layout, and names a case-insensitive disk would hand a writer, are named, not passed over.
        writeJson(path.join(photosDir, `${PHOTO_D}.json`), { schemaVersion: 1, version: 1, baseRevisionId: null, ...photo(PHOTO_D) });
        const upper = PHOTO_D.toUpperCase();
        writeVersion(path.join(photosDir, upper), 1, { schemaVersion: 1, version: 1, baseRevisionId: null, ...photo(PHOTO_D) });
        writeJson(path.join(seriesDir, 'ser_misnamed', 'V1.JSON'), { schemaVersion: 1, version: 1, baseRevisionId: null, ...series('ser_misnamed') });
        // A temp file from an interrupted write, OS metadata, and anything else are not records.
        writeJson(path.join(photosDir, PHOTO_B, '.v2.42.abcd.tmp'), '{');
        writeJson(path.join(photosDir, '.DS_Store'), '');
        writeJson(path.join(photosDir, 'notes.txt'), 'not a record');

        const layer = await readWorkingLayer(data.root);
        expect(layer.series).toEqual([]);
        expect(layer.photos).toEqual([]);
        expect(layer.problems.map(({ kind, id, reason }) => ({ kind, id, reason }))).toEqual([
            { kind: 'photo', id: upper, reason: 'file-name' },
            { kind: 'photo', id: PHOTO_A, reason: 'invalid' },
            { kind: 'photo', id: PHOTO_B, reason: 'file-name' },
            { kind: 'photo', id: PHOTO_C, reason: 'edited-in-place' },
            { kind: 'photo', id: `${PHOTO_D}.json`, reason: 'file-name' },
            { kind: 'series', id: 'ser_broken', reason: 'invalid-json' },
            { kind: 'series', id: 'ser_future', reason: 'unknown-schema-version' },
            { kind: 'series', id: 'ser_misnamed', reason: 'file-name' },
        ]);
        expect(layer.problems.find((problem) => problem.id === PHOTO_C)?.issues[0].message).toContain('cp -n v1.json v2.json');
        expect(JSON.stringify(layer.problems)).not.toContain(data.root);
        expect(JSON.stringify(layer.problems)).not.toContain('IMG_0001');
    });

    it('refuses a site.json in the old layout, naming it, rather than read no site record', async () => {
        const data = dataRoot();
        const paths = authoredPaths(data.root);
        const site = { schemaVersion: 1, version: 1, baseRevisionId: null, kind: 'site', featuredSeriesIds: [], seriesOrder: [] };
        writeJson(`${paths.site}.json`, site);
        const refused = { kind: 'site', id: 'site', reason: 'file-name', issues: [{ path: '', message: expect.stringMatching(/^authored\/site\.json .*layout changed/) }] };
        expect(await readWorkingLayer(data.root)).toEqual({ site: null, series: [], photos: [], problems: [refused] });
        await expect(readAuthoredRecord(data.root, 'site', 'site')).rejects.toThrow('authored/site.json');

        // Beside the new folder too, since nothing says which one is current.
        writeVersion(paths.site, 1, site);
        expect(await readWorkingLayer(data.root)).toMatchObject({ site: null, problems: [refused] });
        fs.rmSync(`${paths.site}.json`);
        expect((await readWorkingLayer(data.root)).site).toMatchObject({ version: 1 });
    });

    it('refuses to read a photo or series record whose file in the old layout is still there, naming the file', async () => {
        const data = dataRoot();
        const { seriesDir, photosDir } = authoredPaths(data.root);
        await writeAuthoredRecord(photo(PHOTO_A), { expectedVersion: 0, root: data.root });
        await writeAuthoredRecord(series('ser_fixture'), { expectedVersion: 0, root: data.root });
        writeJson(path.join(photosDir, `${PHOTO_A}.json`), { schemaVersion: 1, version: 1, baseRevisionId: null, ...photo(PHOTO_A) });
        writeJson(path.join(seriesDir, 'ser_fixture.json'), { schemaVersion: 1, version: 1, baseRevisionId: null, ...series('ser_fixture') });
        await expect(readAuthoredRecord(data.root, 'photo', PHOTO_A)).rejects.toThrow(`authored/photos/${PHOTO_A}.json is in the old layout`);
        await expect(readAuthoredRecord(data.root, 'series', 'ser_fixture')).rejects.toThrow('authored/series/ser_fixture.json is in the old layout');

        fs.rmSync(path.join(photosDir, `${PHOTO_A}.json`));
        fs.rmSync(path.join(seriesDir, 'ser_fixture.json'));
        expect(await readAuthoredRecord(data.root, 'photo', PHOTO_A)).toMatchObject({ version: 1 });
        expect(await readAuthoredRecord(data.root, 'series', 'ser_fixture')).toMatchObject({ version: 1 });
    });

    it('reads one record by kind and ID, or null', async () => {
        const data = dataRoot();
        writeVersion(path.join(authoredPaths(data.root).photosDir, PHOTO_A), 3, { schemaVersion: 1, version: 3, baseRevisionId: null, ...photo(PHOTO_A) });
        expect(await readAuthoredRecord(data.root, 'photo', PHOTO_A)).toMatchObject({ id: PHOTO_A, version: 3 });
        expect(await readAuthoredRecord(data.root, 'photo', PHOTO_B)).toBeNull();
        expect(await readAuthoredRecord(data.root, 'site', 'site')).toBeNull();
    });

    it('reads the active pointer, or null before the first activation', async () => {
        const data = dataRoot();
        expect(await readActivePointer(data.root)).toBeNull();
        activate(data.root, ACTIVE);
        expect(await readActivePointer(data.root)).toMatchObject({ revisionId: ACTIVE });
    });
});

describe('writeAuthoredRecord', () => {
    it('creates a record at version 1, based on the active revision or on none', async () => {
        const data = dataRoot();
        expect(await writeAuthoredRecord(photo(PHOTO_A), { expectedVersion: 0, root: data.root }))
            .toMatchObject({ schemaVersion: 1, version: 1, baseRevisionId: null, id: PHOTO_A });
        activate(data.root, ACTIVE);
        expect(await writeAuthoredRecord(photo(PHOTO_B), { expectedVersion: 0, root: data.root })).toMatchObject({ version: 1, baseRevisionId: ACTIVE });
        expect(await readAuthoredRecord(data.root, 'photo', PHOTO_B)).toMatchObject({ version: 1, baseRevisionId: ACTIVE });
    });

    it('bumps the version and never moves an existing record off its base', async () => {
        const data = dataRoot();
        activate(data.root, ACTIVE);
        const created = await writeAuthoredRecord(series('ser_fixture'), { expectedVersion: 0, root: data.root });
        activate(data.root, LATER);
        const updated = await writeAuthoredRecord({ ...created, title: 'Fixture title', baseRevisionId: LATER }, { expectedVersion: 1, root: data.root });
        expect(updated).toMatchObject({ version: 2, baseRevisionId: ACTIVE, title: 'Fixture title' });
        expect(await readAuthoredRecord(data.root, 'series', 'ser_fixture')).toEqual(updated);
    });

    it('keeps the site record\'s baseSeriesOrder, which only a rebase sets, and starts a new one at null', async () => {
        const data = dataRoot();
        const site = { kind: 'site' as const, featuredSeriesIds: [], seriesOrder: ['ser_fixture-a', 'ser_fixture-b'] };
        const created = await writeAuthoredRecord({ ...site, baseSeriesOrder: ['ser_fixture-b'] }, { expectedVersion: 0, root: data.root });
        expect(created).toMatchObject({ version: 1, baseSeriesOrder: null });

        // A record written before the field reads as unknown.
        const dir = authoredPaths(data.root).site;
        writeVersion(dir, 2, { schemaVersion: 1, version: 2, baseRevisionId: null, ...site });
        expect(await readAuthoredRecord(data.root, 'site', 'site')).toMatchObject({ version: 2, baseSeriesOrder: null });

        // One a rebase wrote keeps it through an owner's write that names another.
        writeVersion(dir, 3, { schemaVersion: 1, version: 3, baseRevisionId: ACTIVE, ...site, baseSeriesOrder: ['ser_fixture-a', 'ser_fixture-b'] });
        const updated = await writeAuthoredRecord({ ...site, seriesOrder: ['ser_fixture-b', 'ser_fixture-a'], baseSeriesOrder: ['ser_fixture-b', 'ser_fixture-a'] }, { expectedVersion: 3, root: data.root });
        expect(updated).toMatchObject({ version: 4, baseRevisionId: ACTIVE, seriesOrder: ['ser_fixture-b', 'ser_fixture-a'], baseSeriesOrder: ['ser_fixture-a', 'ser_fixture-b'] });
        expect(await readAuthoredRecord(data.root, 'site', 'site')).toEqual(updated);
    });

    it('types as managed exactly the fields the writer manages', () => {
        // Checked by tsc: the assignment fails to compile when ManagedField and MANAGED_FIELDS differ either way.
        type Managed = (typeof MANAGED_FIELDS)[number];
        const same: [ManagedField] extends [Managed] ? ([Managed] extends [ManagedField] ? true : false) : false = true;
        expect(same).toBe(true);
        expect([...MANAGED_FIELDS].sort()).toEqual(['baseRevisionId', 'baseSeriesOrder', 'schemaVersion', 'version']);
    });

    it.each([
        ['an existing record expected at version 0', 0],
        ['an existing record expected at an old version', 1],
        ['an existing record expected at a future version', 5],
    ])('fails with VERSION_CONFLICT on %s and leaves the file alone', async (_label, expectedVersion) => {
        const data = dataRoot();
        await writeAuthoredRecord(photo(PHOTO_A), { expectedVersion: 0, root: data.root });
        await writeAuthoredRecord(photo(PHOTO_A, { title: 'Fixture title' }), { expectedVersion: 1, root: data.root });
        const dir = path.join(authoredPaths(data.root).photosDir, PHOTO_A);
        const before = fs.readFileSync(path.join(dir, 'v2.json'));

        const error = await rejection(writeAuthoredRecord(photo(PHOTO_A, { title: 'Other' }), { expectedVersion, root: data.root }));
        expect(error).toMatchObject({ code: 'VERSION_CONFLICT', record: { kind: 'photo', id: PHOTO_A }, expectedVersion, foundVersion: 2 });
        expect(fs.readdirSync(dir)).toEqual(['v1.json', 'v2.json']);
        expect(fs.readFileSync(path.join(dir, 'v2.json')).equals(before)).toBe(true);
    });

    it('fails with VERSION_CONFLICT when a new record is expected to exist', async () => {
        const data = dataRoot();
        const error = await rejection(writeAuthoredRecord(photo(PHOTO_A), { expectedVersion: 1, root: data.root }));
        expect(error).toMatchObject({ code: 'VERSION_CONFLICT', foundVersion: 0 });
        expect(data.files()).toEqual(['data-root.json']);
    });

    it.each([
        ['a series ID outside the pattern', series('Series 1')],
        ['an unknown field', { ...photo(PHOTO_A), sourcePath: 'IMG_0001.jpg' }],
        ['a malformed photo ID', photo('ph_1')],
        ['an unknown visibility', series('ser_fixture', { visibility: 'public' as unknown as 'draft' })],
    ])('refuses %s and writes nothing', async (_label, record) => {
        const data = dataRoot();
        const error = await rejection(writeAuthoredRecord(record as Parameters<typeof writeAuthoredRecord>[0], { expectedVersion: 0, root: data.root }));
        expect(error.code).toBe('INVALID_RECORD');
        expect(data.files()).toEqual(['data-root.json']);
    });

    it('takes the authored lock, and fails fast naming the holder when someone else has it', async () => {
        const data = dataRoot();
        const error = await withLock('authored', { root: data.root }, () => rejection(writeAuthoredRecord(photo(PHOTO_A), { expectedVersion: 0, root: data.root, waitMs: 0 })));
        expect(error).toMatchObject({ code: 'AUTHORED_LOCKED', holder: { pid: process.pid } });
        expect(await readAuthoredRecord(data.root, 'photo', PHOTO_A)).toBeNull();
    });

    it('reuses a held authored lock instead of waiting on itself', async () => {
        const data = dataRoot();
        const written = await withLock('authored', { root: data.root }, async (hold) => {
            const first = await writeAuthoredRecord(photo(PHOTO_A), { expectedVersion: 0, root: data.root, lock: hold, waitMs: 0 });
            return writeAuthoredRecord({ ...first, title: 'Fixture title' }, { expectedVersion: first.version, root: data.root, lock: hold, waitMs: 0 });
        });
        expect(written).toMatchObject({ version: 2, title: 'Fixture title' });
    });

    it('stores only one of two writes that read one version, even when both think they hold the lock', async () => {
        const data = dataRoot();
        const first = await writeAuthoredRecord(photo(PHOTO_A), { expectedVersion: 0, root: data.root });
        // Two writers on one hold, as when one is past its lease and hasn't noticed: the second commits between
        // the first one's read and its commit.
        const { stale, fresh } = await withLock('authored', { root: data.root }, async (hold) => {
            let other: Promise<AuthoredPhoto> | undefined;
            const error = await rejection(writeAuthoredRecord({ ...first, title: 'Stale' }, {
                expectedVersion: first.version,
                root: data.root,
                lock: hold,
                hooks: {
                    afterStage: async () => {
                        other = writeAuthoredRecord({ ...first, title: 'Fresh' }, { expectedVersion: first.version, root: data.root, lock: hold });
                        await other;
                    },
                },
            }));
            return { stale: error, fresh: await other };
        });

        expect(stale).toMatchObject({ code: 'VERSION_CONFLICT', expectedVersion: 1, foundVersion: 2 });
        expect(fresh).toMatchObject({ version: 2, title: 'Fresh' });
        expect(await readAuthoredRecord(data.root, 'photo', PHOTO_A)).toMatchObject({ version: 2, title: 'Fresh' });
        // No temp is left beside the versions
        expect(fs.readdirSync(path.join(authoredPaths(data.root).photosDir, PHOTO_A))).toEqual(['v1.json', 'v2.json']);
    });

    it('refuses to write on top of a record edited in place, says how to keep the edit, and writes once it is copied', async () => {
        const data = dataRoot();
        const first = await writeAuthoredRecord(photo(PHOTO_A), { expectedVersion: 0, root: data.root });
        const dir = path.join(authoredPaths(data.root).photosDir, PHOTO_A);
        editInPlace(path.join(dir, 'v1.json'), (text) => text.replace('"alt": null', '"alt": { "kind": "decorative" }'));

        const error = await rejection(writeAuthoredRecord({ ...first, title: 'Retry' }, { expectedVersion: 1, root: data.root }));
        expect(error).toMatchObject({ code: 'INVALID_RECORD', message: expect.stringContaining('was edited in place (v1.json)') });
        expect(error.message).toContain('cp -n v1.json v2.json');
        expect(fs.readdirSync(dir)).toEqual(['v1.json']);

        // The recovery the message names: the edited file becomes a hand-made version 2, and the next write is stamped again.
        fs.copyFileSync(path.join(dir, 'v1.json'), path.join(dir, 'v2.json'), fs.constants.COPYFILE_EXCL);
        expect(await readAuthoredRecord(data.root, 'photo', PHOTO_A)).toMatchObject({ version: 2, alt: { kind: 'decorative' } });
        const written = await writeAuthoredRecord({ ...first, alt: { kind: 'decorative' }, title: 'Retry' }, { expectedVersion: 2, root: data.root });
        expect(written).toMatchObject({ version: 3, title: 'Retry' });
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'v3.json'), 'utf8'))).toMatchObject({ stamp: { version: 3 } });
    });

    it('refuses to write a record whose file in the old layout is still there, and writes nothing', async () => {
        const data = dataRoot();
        const paths = authoredPaths(data.root);
        writeJson(`${paths.site}.json`, { schemaVersion: 1, version: 1, baseRevisionId: null, kind: 'site', featuredSeriesIds: [], seriesOrder: [] });
        writeJson(path.join(paths.photosDir, `${PHOTO_A}.json`), { schemaVersion: 1, version: 1, baseRevisionId: null, ...photo(PHOTO_A) });
        const site = await rejection(writeAuthoredRecord({ kind: 'site', featuredSeriesIds: [], seriesOrder: [] }, { expectedVersion: 0, root: data.root }));
        expect(site).toMatchObject({ code: 'INVALID_RECORD', message: expect.stringContaining('authored/site.json') });
        const photoError = await rejection(writeAuthoredRecord(photo(PHOTO_A), { expectedVersion: 0, root: data.root }));
        expect(photoError).toMatchObject({ code: 'INVALID_RECORD', message: expect.stringContaining(`authored/photos/${PHOTO_A}.json`) });
        expect(data.files().filter((file) => file.startsWith('authored'))).toEqual([`authored/photos/${PHOTO_A}.json`, 'authored/site.json']);
    });

    it('refuses to read or extend a record folder the disk spells in another case, which the working layer reports as misnamed', async (context) => {
        const data = dataRoot();
        if (!caseInsensitive(data.root)) context.skip();
        const paths = authoredPaths(data.root);
        await writeAuthoredRecord(photo(PHOTO_A), { expectedVersion: 0, root: data.root });
        await writeAuthoredRecord({ kind: 'site', featuredSeriesIds: [], seriesOrder: [] }, { expectedVersion: 0, root: data.root });
        const upper = PHOTO_A.toUpperCase();
        fs.renameSync(path.join(paths.photosDir, PHOTO_A), path.join(paths.photosDir, upper));
        fs.renameSync(paths.site, path.join(paths.dir, 'Site'));
        // This disk finds both under their own names, but the working layer reads neither.
        expect(fs.existsSync(path.join(paths.photosDir, PHOTO_A, 'v1.json'))).toBe(true);
        const layer = await readWorkingLayer(data.root);
        expect(layer).toMatchObject({ site: null, photos: [] });
        expect(layer.problems.map(({ kind, id, reason }) => ({ kind, id, reason }))).toEqual([
            { kind: 'photo', id: upper, reason: 'file-name' },
            { kind: 'site', id: 'site', reason: 'file-name' },
        ]);

        await expect(readAuthoredRecord(data.root, 'photo', PHOTO_A)).rejects.toThrow(upper);
        for (const expectedVersion of [1, 0]) {
            const error = await rejection(writeAuthoredRecord(photo(PHOTO_A, { title: 'Fixture title' }), { expectedVersion, root: data.root }));
            expect(error).toMatchObject({ code: 'INVALID_RECORD', message: expect.stringContaining(upper) });
        }
        const site = await rejection(writeAuthoredRecord({ kind: 'site', featuredSeriesIds: [], seriesOrder: [] }, { expectedVersion: 1, root: data.root }));
        expect(site).toMatchObject({ code: 'INVALID_RECORD', message: expect.stringContaining('Site') });
        expect(fs.readdirSync(path.join(paths.photosDir, upper))).toEqual(['v1.json']);
        expect(fs.readdirSync(path.join(paths.dir, 'Site'))).toEqual(['v1.json']);
    });

    it('reads and extends a record or site folder that is itself a symlink, as the working layer reads it', async () => {
        const data = dataRoot();
        const paths = authoredPaths(data.root);
        await writeAuthoredRecord(photo(PHOTO_A), { expectedVersion: 0, root: data.root });
        await writeAuthoredRecord({ kind: 'site', featuredSeriesIds: [], seriesOrder: [] }, { expectedVersion: 0, root: data.root });
        // Moved elsewhere, as a restore or a reorganisation might, and linked back under their own names.
        const elsewhere = path.join(data.root, 'elsewhere');
        fs.mkdirSync(elsewhere);
        fs.renameSync(path.join(paths.photosDir, PHOTO_A), path.join(elsewhere, 'photo-target'));
        fs.renameSync(paths.site, path.join(elsewhere, 'site-target'));
        fs.symlinkSync(path.join(elsewhere, 'photo-target'), path.join(paths.photosDir, PHOTO_A), 'dir');
        fs.symlinkSync(path.join(elsewhere, 'site-target'), paths.site, 'dir');

        const layer = await readWorkingLayer(data.root);
        expect(layer).toMatchObject({ site: { version: 1 }, photos: [{ id: PHOTO_A, version: 1 }], problems: [] });
        expect(await readAuthoredRecord(data.root, 'photo', PHOTO_A)).toMatchObject({ version: 1 });
        expect(await readAuthoredRecord(data.root, 'site', 'site')).toMatchObject({ version: 1 });
        await expect(writeAuthoredRecord(photo(PHOTO_A, { title: 'Fixture title' }), { expectedVersion: 1, root: data.root })).resolves.toMatchObject({ version: 2 });
        await expect(writeAuthoredRecord({ kind: 'site', featuredSeriesIds: [], seriesOrder: [] }, { expectedVersion: 1, root: data.root }))
            .resolves.toMatchObject({ version: 2 });
        expect(fs.readdirSync(path.join(elsewhere, 'photo-target')).sort()).toEqual(['v1.json', 'v2.json']);
        expect(fs.readdirSync(path.join(elsewhere, 'site-target')).sort()).toEqual(['v1.json', 'v2.json']);
        expect(fs.lstatSync(path.join(paths.photosDir, PHOTO_A)).isSymbolicLink()).toBe(true);
    });

    it('refuses a symlinked record folder named in another case, naming the link, not its target', async (context) => {
        const data = dataRoot();
        if (!caseInsensitive(data.root)) context.skip();
        const paths = authoredPaths(data.root);
        await writeAuthoredRecord(photo(PHOTO_A), { expectedVersion: 0, root: data.root });
        const upper = PHOTO_A.toUpperCase();
        fs.renameSync(path.join(paths.photosDir, PHOTO_A), path.join(data.root, 'photo-target'));
        fs.symlinkSync(path.join(data.root, 'photo-target'), path.join(paths.photosDir, upper), 'dir');
        expect((await readWorkingLayer(data.root)).problems).toEqual([expect.objectContaining({ kind: 'photo', id: upper, reason: 'file-name' })]);
        await expect(readAuthoredRecord(data.root, 'photo', PHOTO_A)).rejects.toThrow(`is "${upper}" on disk`);
        const error = await rejection(writeAuthoredRecord(photo(PHOTO_A, { title: 'Fixture title' }), { expectedVersion: 1, root: data.root }));
        expect(error).toMatchObject({ code: 'INVALID_RECORD', message: expect.stringContaining(upper) });
        expect(error.message).not.toContain('photo-target');
    });

    it('refuses to write past the highest version as INVALID_RECORD, with no path in the message', async () => {
        const data = dataRoot();
        const longest = Number('9'.repeat(MAX_VERSION_DIGITS));
        writeVersion(path.join(authoredPaths(data.root).photosDir, PHOTO_A), longest, { schemaVersion: 1, version: longest, baseRevisionId: null, ...photo(PHOTO_A) });
        expect(await readAuthoredRecord(data.root, 'photo', PHOTO_A)).toMatchObject({ version: longest });
        const error = await rejection(writeAuthoredRecord(photo(PHOTO_A, { title: 'Fixture title' }), { expectedVersion: longest, root: data.root }));
        expect(error).toMatchObject({ code: 'INVALID_RECORD', message: expect.stringContaining(`at version ${longest}, the highest a version can be`) });
        expect(error.message).not.toContain(data.root);
    });

    it('tells a stored record from a newer build apart from one to fix by hand', async () => {
        const data = dataRoot();
        const dir = path.join(authoredPaths(data.root).photosDir, PHOTO_A);
        writeVersion(dir, 1, { schemaVersion: 2, version: 1, baseRevisionId: null, ...photo(PHOTO_A) });
        const newer = await rejection(writeAuthoredRecord(photo(PHOTO_A), { expectedVersion: 1, root: data.root }));
        expect(newer).toMatchObject({ code: 'INVALID_RECORD', message: `The stored photo record ${PHOTO_A} comes from a newer build, which this one can't read.` });

        writeVersion(dir, 1, { schemaVersion: 1, version: 1, baseRevisionId: null, ...photo(PHOTO_A), title: 7 });
        const broken = await rejection(writeAuthoredRecord(photo(PHOTO_A), { expectedVersion: 1, root: data.root }));
        expect(broken).toMatchObject({ code: 'INVALID_RECORD', message: `The stored photo record ${PHOTO_A} can't be read. Fix it by hand first.` });
    });

    it('refuses to extend a folder holding another record\'s versions, as the reader refuses to read it', async () => {
        const data = dataRoot();
        const dir = path.join(authoredPaths(data.root).photosDir, PHOTO_A);
        writeVersion(dir, 1, { schemaVersion: 1, version: 1, baseRevisionId: null, ...photo(PHOTO_B) });
        await expect(readAuthoredRecord(data.root, 'photo', PHOTO_A)).rejects.toThrow(PHOTO_B);
        for (const expectedVersion of [1, 0]) {
            const error = await rejection(writeAuthoredRecord(photo(PHOTO_A, { title: 'Fixture title' }), { expectedVersion, root: data.root }));
            expect(error).toMatchObject({ code: 'INVALID_RECORD', message: expect.stringContaining(`its folder holds the record "${PHOTO_B}"`), issues: [{ path: 'id' }] });
        }
        expect(fs.readdirSync(dir)).toEqual(['v1.json']);
    });

    it('sorts records by ID, not by file name', async () => {
        const data = dataRoot();
        for (const id of ['ser_ab-c', 'ser_ab']) await writeAuthoredRecord(series(id), { expectedVersion: 0, root: data.root });
        expect((await readWorkingLayer(data.root)).series.map((record) => record.id)).toEqual(['ser_ab', 'ser_ab-c']);
    });

    it('refuses a hold that is not this data root\'s authored lock, or that was lost', async () => {
        const data = dataRoot();
        const other = dataRoot();
        const wrongName = await withLock('catalog', { root: data.root }, (hold) => rejection(writeAuthoredRecord(photo(PHOTO_A), { expectedVersion: 0, root: data.root, lock: hold })));
        const wrongRoot = await withLock('authored', { root: other.root }, (hold) => rejection(writeAuthoredRecord(photo(PHOTO_A), { expectedVersion: 0, root: data.root, lock: hold })));
        const lost = await withLock('authored', { root: data.root }, (hold) => {
            const aborted = new AbortController();
            aborted.abort(new Error('lost'));
            return rejection(writeAuthoredRecord(photo(PHOTO_A), { expectedVersion: 0, root: data.root, lock: { ...hold, signal: aborted.signal } }));
        });
        for (const error of [wrongName, wrongRoot, lost]) expect(error.code).toBe('LOCK_NOT_HELD');
        expect(await readAuthoredRecord(data.root, 'photo', PHOTO_A)).toBeNull();
    });

    it('refuses a data root that is not ready, and creates nothing in it', async () => {
        const data = dataRoot('uninitialized');
        const error = await rejection(writeAuthoredRecord(photo(PHOTO_A), { expectedVersion: 0, root: data.root }));
        expect(error.code).toBe('DATA_ROOT_NOT_READY');
        expect(fs.readdirSync(data.root)).toEqual([]);
    });

    it('defaults to PHOTOGRAPHY_DATA_DIR, and creates files 0600 in 0700 folders', async () => {
        const data = dataRoot();
        await writeAuthoredRecord(photo(PHOTO_A), { expectedVersion: 0 });
        const mode = (target: string) => fs.statSync(target).mode & 0o777;
        const paths = authoredPaths(data.root);
        const dir = path.join(paths.photosDir, PHOTO_A);
        expect([mode(paths.dir), mode(paths.photosDir), mode(dir), mode(path.join(dir, 'v1.json'))]).toEqual([0o700, 0o700, 0o700, 0o600]);
    });

    it('fsyncs every folder a first write needs up to the data root, though another writer made them, and only the record folder after', async () => {
        const data = dataRoot();
        const paths = authoredPaths(data.root);
        const dir = path.join(paths.photosDir, PHOTO_A);
        // Another writer's mkdirs, which it never synced: it lost, or crashed.
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        await withLock('authored', { root: data.root }, async (hold) => {
            const synced = recordDirectorySyncs();
            const first = await writeAuthoredRecord(photo(PHOTO_A), { expectedVersion: 0, root: data.root, lock: hold });
            expect(synced).toEqual([data.root, paths.dir, dir, paths.photosDir]);
            synced.length = 0;
            await writeAuthoredRecord({ ...first, title: 'Fixture title' }, { expectedVersion: 1, root: data.root, lock: hold });
            expect(synced).toEqual([dir]);
        });
        // The site record's folder sits right under authored/.
        await withLock('authored', { root: data.root }, async (hold) => {
            const synced = recordDirectorySyncs();
            await writeAuthoredRecord({ kind: 'site', featuredSeriesIds: [], seriesOrder: [] }, { expectedVersion: 0, root: data.root, lock: hold });
            expect(synced).toEqual([data.root, paths.site, paths.dir]);
        });
    });

    it('lets exactly one of two writers with the same expectedVersion through', async () => {
        const data = dataRoot();
        await writeAuthoredRecord(series('ser_fixture'), { expectedVersion: 0, root: data.root });
        const outcomes = await Promise.allSettled(['Fixture A', 'Fixture B'].map((title) =>
            writeAuthoredRecord(series('ser_fixture', { title }), { expectedVersion: 1, root: data.root })));
        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
        const [rejected] = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
        expect(rejected.reason).toMatchObject({ code: 'VERSION_CONFLICT' });
        expect(await readAuthoredRecord(data.root, 'series', 'ser_fixture')).toMatchObject({ version: 2 });
    });
});

describe('the read path', () => {
    it.each([
        'lib/catalog/working-layer.ts',
        'lib/catalog/reader.ts',
        'lib/catalog/request.ts',
        'lib/catalog/rules.ts',
        'lib/catalog/references.ts',
        'lib/catalog/order.ts',
    ])('never reaches the writer from %s', (entry) => {
        const { files } = importGraph(entry);
        expect(files).toContain(entry);
        expect(files.filter((file) => file.includes('working-layer-writer'))).toEqual([]);
    });
});
