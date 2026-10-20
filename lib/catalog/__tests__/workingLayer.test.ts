// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { REPO_ROOT } from '../../../test/helpers/runTsx';
import { withLock } from '../../storage/lock';
import type { AuthoredPhoto, AuthoredSeries } from '../types';
import { authoredPaths, catalogPaths, readActivePointer, readAuthoredRecord, readWorkingLayer } from '../working-layer';
import { AuthoredWriteError, writeAuthoredRecord } from '../working-layer-writer';

const PHOTO_A = 'ph_00000000-0000-4000-8000-00000000000a';
const PHOTO_B = 'ph_00000000-0000-4000-8000-00000000000b';
const ASSET = `sha256-${'a'.repeat(64)}`;
const ACTIVE = `rev_${'1'.repeat(64)}`;
const LATER = `rev_${'2'.repeat(64)}`;

const roots: TempDataRoot[] = [];

afterEach(async () => {
    for (const root of roots.splice(0)) await root.cleanup();
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

function activate(root: string, revisionId: string): void {
    writeJson(catalogPaths(root).active, { schemaVersion: 1, revisionId, activationId: 'act_00000000-0000-4000-8000-000000000001' });
}

const photo = (id: string, extra: Partial<AuthoredPhoto> = {}) => ({ kind: 'photo' as const, id, assetRevision: ASSET, alt: null, ...extra });
const series = (id: string, extra: Partial<AuthoredSeries> = {}) => ({ kind: 'series' as const, id, slug: id.slice(4), visibility: 'draft' as const, ...extra });

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
        writeJson(paths.site, { schemaVersion: 1, version: 2, baseRevisionId: null, kind: 'site', featuredSeriesIds: ['ser_fixture-b'], seriesOrder: ['ser_fixture-b', 'ser_fixture-a'] });
        for (const id of ['ser_fixture-b', 'ser_fixture-a']) {
            writeJson(path.join(paths.seriesDir, `${id}.json`), { schemaVersion: 1, version: 1, baseRevisionId: null, ...series(id) });
        }
        for (const id of [PHOTO_B, PHOTO_A]) {
            writeJson(path.join(paths.photosDir, `${id}.json`), { schemaVersion: 1, version: 1, baseRevisionId: ACTIVE, ...photo(id) });
        }

        const layer = await readWorkingLayer(data.root);
        expect(layer.site).toMatchObject({ featuredSeriesIds: ['ser_fixture-b'], version: 2 });
        expect(layer.series.map((record) => record.id)).toEqual(['ser_fixture-a', 'ser_fixture-b']);
        expect(layer.series[0]).toMatchObject({ publicationPolicy: 'review-required', photoIds: [], cover: null, title: '' });
        expect(layer.photos.map((record) => record.id)).toEqual([PHOTO_A, PHOTO_B]);
        expect(layer.problems).toEqual([]);
    });

    it('reports each file it cannot use by record, never by path, and leaves it out', async () => {
        const data = dataRoot();
        const { seriesDir, photosDir } = authoredPaths(data.root);
        writeJson(path.join(seriesDir, 'ser_broken.json'), '{"kind": "series"');
        writeJson(path.join(seriesDir, 'ser_future.json'), { schemaVersion: 4, version: 1, baseRevisionId: null, ...series('ser_future') });
        writeJson(path.join(photosDir, `${PHOTO_A}.json`), { schemaVersion: 1, version: 1, baseRevisionId: null, ...photo(PHOTO_A), sourcePath: '/library/IMG_0001.jpg' });
        writeJson(path.join(photosDir, `${PHOTO_B}.json`), { schemaVersion: 1, version: 1, baseRevisionId: null, ...photo(PHOTO_A) });
        // Temp files from an interrupted atomic write, and anything that isn't JSON, are not records.
        writeJson(path.join(photosDir, `.${PHOTO_A}.json.42.tmp`), '{');
        writeJson(path.join(photosDir, 'notes.txt'), 'not a record');

        const layer = await readWorkingLayer(data.root);
        expect(layer.series).toEqual([]);
        expect(layer.photos).toEqual([]);
        expect(layer.problems.map(({ kind, id, reason }) => ({ kind, id, reason }))).toEqual([
            { kind: 'photo', id: PHOTO_A, reason: 'invalid' },
            { kind: 'photo', id: PHOTO_B, reason: 'file-name' },
            { kind: 'series', id: 'ser_broken', reason: 'invalid-json' },
            { kind: 'series', id: 'ser_future', reason: 'unknown-schema-version' },
        ]);
        expect(JSON.stringify(layer.problems)).not.toContain(data.root);
        expect(JSON.stringify(layer.problems)).not.toContain('IMG_0001');
    });

    it('reads one record by kind and ID, or null', async () => {
        const data = dataRoot();
        writeJson(path.join(authoredPaths(data.root).photosDir, `${PHOTO_A}.json`), { schemaVersion: 1, version: 3, baseRevisionId: null, ...photo(PHOTO_A) });
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

    it.each([
        ['an existing record expected at version 0', 0],
        ['an existing record expected at an old version', 1],
        ['an existing record expected at a future version', 5],
    ])('fails with VERSION_CONFLICT on %s and leaves the file alone', async (_label, expectedVersion) => {
        const data = dataRoot();
        await writeAuthoredRecord(photo(PHOTO_A), { expectedVersion: 0, root: data.root });
        await writeAuthoredRecord(photo(PHOTO_A, { title: 'Fixture title' }), { expectedVersion: 1, root: data.root });
        const file = path.join(authoredPaths(data.root).photosDir, `${PHOTO_A}.json`);
        const before = fs.readFileSync(file);

        const error = await rejection(writeAuthoredRecord(photo(PHOTO_A, { title: 'Other' }), { expectedVersion, root: data.root }));
        expect(error).toMatchObject({ code: 'VERSION_CONFLICT', record: { kind: 'photo', id: PHOTO_A }, expectedVersion, foundVersion: 2 });
        expect(fs.readFileSync(file).equals(before)).toBe(true);
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
        expect([mode(paths.dir), mode(paths.photosDir), mode(path.join(paths.photosDir, `${PHOTO_A}.json`))]).toEqual([0o700, 0o700, 0o600]);
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

/** Every module `entry` reaches through relative imports. */
function importGraph(entry: string): Set<string> {
    const seen = new Set<string>();
    const visit = (file: string) => {
        if (seen.has(file)) return;
        seen.add(file);
        const source = fs.readFileSync(file, 'utf8');
        for (const match of source.matchAll(/(?:from|import)\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
            const base = path.resolve(path.dirname(file), match[1]);
            const resolved = [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find((candidate) => fs.existsSync(candidate));
            if (resolved) visit(resolved);
        }
    };
    visit(entry);
    return seen;
}

describe('the read path', () => {
    it.each([
        'lib/catalog/working-layer.ts',
        'lib/catalog/reader.ts',
        'lib/catalog/request.ts',
        'lib/catalog/rules.ts',
        'lib/catalog/references.ts',
    ])('never reaches the writer from %s', (entry) => {
        const graph = [...importGraph(path.join(REPO_ROOT, entry))].map((file) => path.relative(REPO_ROOT, file));
        expect(graph).toContain(entry);
        expect(graph.filter((file) => file.includes('working-layer-writer'))).toEqual([]);
    });
});
