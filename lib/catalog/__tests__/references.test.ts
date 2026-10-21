// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDataRoot } from '../../../test/helpers/tempDataRoot';
import { references, referencesTo, ReferenceScanError, type AssetReference } from '../references';
import { revisionIdOf } from '../schema';
import { createTestCatalog, type TestCatalog } from '../testing';
import type { CandidateContent } from '../types';
import { authoredRecordFile, catalogPaths } from '../working-layer';

const OTHER_ASSET = `sha256-${'b'.repeat(64)}`;
const OTHER_PROFILE = `p_${'1'.repeat(16)}`;
const CANDIDATE_PROFILE = `p_${'2'.repeat(16)}`;
const COMPILED_AT = '2026-01-02T00:00:00.000Z';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(options: Parameters<typeof createTestCatalog>[0] = {}): Promise<TestCatalog> {
    const catalog = await createTestCatalog({ seed: 21, ...options });
    cleanups.push(() => catalog.cleanup());
    return catalog;
}

function writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

/** Write `content` as a revision or a candidate, named by its ID unless `name` says otherwise. Returns the ID. */
function store(root: string, content: CandidateContent, folder: 'revisionsDir' | 'candidatesDir', name?: string): string {
    const revisionId = revisionIdOf(content);
    writeJson(path.join(catalogPaths(root)[folder], `${name ?? revisionId}.json`), { revisionId, schemaVersion: 1, baseRevisionId: null, compiledAt: COMPILED_AT, content });
    return revisionId;
}

function activate(root: string, revisionId: string): void {
    writeJson(catalogPaths(root).active, { schemaVersion: 1, revisionId, activationId: 'act_00000000-0000-4000-8000-000000000001' });
}

/** `content` with one photo moved to another asset revision or profile. */
function withPhoto(content: CandidateContent, index: number, change: { assetRevision?: string; profileId?: string }): CandidateContent {
    const copy = structuredClone(content);
    Object.assign(copy.photos[index], change);
    return copy;
}

const bySource = (list: AssetReference[], source: AssetReference['source']) => list.filter((reference) => reference.source === source);

describe('references', () => {
    it('finds nothing in an empty data root', async () => {
        const data = createTempDataRoot();
        cleanups.push(() => data.cleanup());
        expect(await references(data.root)).toEqual([]);
    });

    it('reads only the working layer before the first publish', async () => {
        const catalog = await fixture();
        const found = await references(catalog.root);
        expect(new Set(found.map((reference) => reference.source))).toEqual(new Set(['working-layer-series', 'working-layer-photo']));
    });

    it('tags each reference with its source and holder, at the exact profile a revision or candidate names', async () => {
        const catalog = await fixture();
        const active = store(catalog.root, catalog.content, 'revisionsDir');
        activate(catalog.root, active);
        const older = store(catalog.root, withPhoto(catalog.content, 0, { assetRevision: OTHER_ASSET, profileId: OTHER_PROFILE }), 'revisionsDir');
        const candidate = store(catalog.root, withPhoto(catalog.content, 1, { profileId: CANDIDATE_PROFILE }), 'candidatesDir');
        const [first, second] = catalog.content.photos;

        const found = await references(catalog.root);
        expect(bySource(found, 'active-revision')).toEqual(catalog.content.photos.map((photo) => ({
            source: 'active-revision',
            holder: active,
            photoId: photo.id,
            assetRevision: photo.assetRevision,
            profileId: catalog.profileId,
        })));
        expect(bySource(found, 'revision')).toContainEqual({ source: 'revision', holder: older, photoId: first.id, assetRevision: OTHER_ASSET, profileId: OTHER_PROFILE });
        expect(bySource(found, 'revision')).toHaveLength(catalog.content.photos.length);
        expect(bySource(found, 'candidate')).toContainEqual({ source: 'candidate', holder: candidate, photoId: second.id, assetRevision: second.assetRevision, profileId: CANDIDATE_PROFILE });
    });

    it('pins every profile of the asset revision each photo record and series member names', async () => {
        const catalog = await fixture();
        const found = await references(catalog.root);
        expect(bySource(found, 'working-layer-photo')).toEqual(catalog.photos.map((photo) => ({
            source: 'working-layer-photo',
            holder: photo.id,
            photoId: photo.id,
            assetRevision: photo.assetRevision,
            profileId: null,
        })).sort((a, b) => (a.holder < b.holder ? -1 : 1)));
        const pinned = new Map(catalog.photos.map((photo) => [photo.id, photo.assetRevision]));
        for (const series of catalog.series) {
            expect(bySource(found, 'working-layer-series').filter((reference) => reference.holder === series.id)).toEqual(
                [...series.photoIds].sort().map((photoId) => ({ source: 'working-layer-series', holder: series.id, photoId, assetRevision: pinned.get(photoId), profileId: null })),
            );
        }
    });

    it('counts a cover and an opening photo outside photoIds, and a draft series', async () => {
        const ids = Array.from({ length: 4 }, (_, index) => `ph_00000000-0000-4000-8000-00000000000${index + 1}`);
        const catalog = await fixture({
            photos: ids.map((id) => ({ id })),
            series: [{ photoIds: [ids[0]], cover: { photoId: ids[1] }, openingPhotoId: ids[2], visibility: 'draft' }],
        });
        const holders = bySource(await references(catalog.root), 'working-layer-series').map((reference) => reference.photoId);
        expect(holders).toEqual([ids[0], ids[1], ids[2]]);
    });

    it('keeps every asset revision of a series member that has no photo record', async () => {
        const catalog = await fixture();
        const member = catalog.series[0].photoIds[0];
        fs.rmSync(authoredRecordFile(catalog.root, 'photo', member));
        const found = await references(catalog.root);
        expect(found).toContainEqual({ source: 'working-layer-series', holder: catalog.series[0].id, photoId: member, assetRevision: null, profileId: null });
        expect(referencesTo(found, { photoId: member, assetRevision: OTHER_ASSET, profileId: OTHER_PROFILE })).toHaveLength(1);
    });

    it('skips dot-files and files that are not JSON', async () => {
        const catalog = await fixture();
        const { revisionsDir, candidatesDir } = catalogPaths(catalog.root);
        writeJson(path.join(revisionsDir, `.${catalog.revisionId}.json.tmp-1`), 'partial');
        writeJson(path.join(revisionsDir, '.DS_Store'), 'x');
        writeJson(path.join(candidatesDir, 'notes.txt'), 'x');
        expect(new Set((await references(catalog.root)).map((reference) => reference.source))).toEqual(new Set(['working-layer-series', 'working-layer-photo']));
    });

    it('lists each reference once, in a stable order', async () => {
        const catalog = await fixture();
        store(catalog.root, catalog.content, 'revisionsDir');
        store(catalog.root, catalog.content, 'candidatesDir');
        const found = await references(catalog.root);
        const keys = found.map((reference) => JSON.stringify(reference));
        expect(new Set(keys).size).toBe(keys.length);
        expect(await references(catalog.root)).toEqual(found);
    });
});

describe('referencesTo', () => {
    it('matches a revision reference only at its profile, and a working-layer reference at any', async () => {
        const catalog = await fixture();
        activate(catalog.root, store(catalog.root, catalog.content, 'revisionsDir'));
        const found = await references(catalog.root);
        const photo = catalog.content.photos[0];
        const exact = referencesTo(found, { photoId: photo.id, assetRevision: photo.assetRevision, profileId: catalog.profileId });
        expect(exact.map((reference) => reference.source).sort()).toEqual(['active-revision', 'working-layer-photo', 'working-layer-series']);
        const otherProfile = referencesTo(found, { photoId: photo.id, assetRevision: photo.assetRevision, profileId: OTHER_PROFILE });
        expect(otherProfile.map((reference) => reference.source).sort()).toEqual(['working-layer-photo', 'working-layer-series']);
        expect(referencesTo(found, { photoId: photo.id, assetRevision: OTHER_ASSET, profileId: catalog.profileId })).toEqual([]);
    });
});

describe('references fails closed', () => {
    const cases: [string, (catalog: TestCatalog) => string, ReferenceScanError['reason']][] = [
        ['a revision that is not JSON', (catalog) => {
            writeJson(path.join(catalogPaths(catalog.root).revisionsDir, `${catalog.revisionId}.json`), '{"revisionId":');
            return `catalog/revisions/${catalog.revisionId}.json`;
        }, 'invalid-json'],
        ['a revision from a newer schema', (catalog) => {
            writeJson(path.join(catalogPaths(catalog.root).revisionsDir, `${catalog.revisionId}.json`), { schemaVersion: 9, revisionId: catalog.revisionId });
            return `catalog/revisions/${catalog.revisionId}.json`;
        }, 'unknown-schema-version'],
        ['a candidate that fails the schema', (catalog) => {
            writeJson(path.join(catalogPaths(catalog.root).candidatesDir, `${catalog.revisionId}.json`), { schemaVersion: 1, revisionId: catalog.revisionId });
            return `catalog/candidates/${catalog.revisionId}.json`;
        }, 'invalid'],
        ['a revision named for another ID', (catalog) => {
            const name = `rev_${'9'.repeat(64)}`;
            store(catalog.root, catalog.content, 'revisionsDir', name);
            return `catalog/revisions/${name}.json`;
        }, 'file-name'],
        ['an active pointer naming a revision with no file', (catalog) => {
            activate(catalog.root, catalog.revisionId);
            return `catalog/revisions/${catalog.revisionId}.json`;
        }, 'missing'],
        ['an active pointer that is not valid', (catalog) => {
            writeJson(catalogPaths(catalog.root).active, { schemaVersion: 1 });
            return 'catalog/active.json';
        }, 'invalid'],
        ['a photo record that is not JSON', (catalog) => {
            const photo = catalog.photos[2];
            writeJson(authoredRecordFile(catalog.root, 'photo', photo.id), 'not json');
            return `authored/photos/${photo.id}.json`;
        }, 'invalid-json'],
        ['a series record that fails the schema', (catalog) => {
            const series = catalog.series[1];
            writeJson(authoredRecordFile(catalog.root, 'series', series.id), { ...series, visibility: 'public' });
            return `authored/series/${series.id}.json`;
        }, 'invalid'],
    ];

    it.each(cases)('on %s', async (_label, breakIt, reason) => {
        const catalog = await fixture();
        const file = breakIt(catalog);
        const error = await references(catalog.root).then(() => null, (caught: unknown) => caught);
        expect(error).toBeInstanceOf(ReferenceScanError);
        expect(error).toMatchObject({ file, reason });
        expect((error as Error).message).toContain(file);
        expect((error as Error).message).not.toContain(catalog.root);
    });

    it.each(['uninitialized', 'missing'] as const)('on a data root that is %s', async (state) => {
        const data = createTempDataRoot({ state });
        cleanups.push(() => data.cleanup());
        await expect(references(data.root)).rejects.toMatchObject({ name: 'ReferenceScanError', file: '.', reason: 'not-ready' });
    });

    it.skipIf(process.getuid?.() === 0)('on a folder it cannot list', async () => {
        const catalog = await fixture();
        const { revisionsDir } = catalogPaths(catalog.root);
        fs.mkdirSync(revisionsDir, { recursive: true });
        fs.chmodSync(revisionsDir, 0o000);
        try {
            await expect(references(catalog.root)).rejects.toMatchObject({ file: 'catalog/revisions', reason: 'unreadable' });
        } finally {
            fs.chmodSync(revisionsDir, 0o700);
        }
    });
});
