// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson } from '../../identity/ids';
import { assetDir } from '../../media/path';
import { MANIFEST_FILE } from '../../storage/publish';
import '../asset-rules';
import { candidateFile, compileCandidate, type CompileInput, type CompileResult } from '../compile';
import { runRules } from '../rules';
import { CATALOG_SCHEMA_VERSION, revisionIdOf } from '../schema';
import { createTestCatalog, type TestCatalog, type TestCatalogOptions } from '../testing';
import type { RevisionContent, RevisionFile } from '../types';
import { readWorkingLayer } from '../working-layer';
import { addReadyProfile, NEW_PROFILE, pinnedRevision, VARIANT_BYTES } from './catalogFixtures';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(options: TestCatalogOptions = {}) {
    const catalog: TestCatalog = await createTestCatalog({ variantBytes: VARIANT_BYTES, ...options });
    cleanups.push(() => catalog.cleanup());
    const layer = await readWorkingLayer(catalog.root);
    const registry = structuredClone(catalog.registry);
    const compile = (overrides: Partial<CompileInput> = {}) => compileCandidate({ layer, registry, root: catalog.root, active: null, ...overrides });
    return { catalog, layer, registry, compile };
}

/** A compile result as the active revision it would become. */
function asRevision(result: CompileResult): RevisionFile {
    return { revisionId: result.candidateId, schemaVersion: CATALOG_SCHEMA_VERSION, baseRevisionId: null, compiledAt: '2026-02-01T00:00:00.000Z', content: result.content as RevisionContent };
}

const photo = (result: CompileResult, id: string) => result.content.photos.find((entry) => entry.id === id);

describe('compileCandidate', () => {
    it('compiles a working layer to the content and revision ID the test catalog predicts', async () => {
        const { catalog, compile } = await fixture({ seed: 31 });
        const result = await compile();
        expect(result.content).toEqual(catalog.content);
        expect(result.candidateId).toBe(catalog.revisionId);
        expect(result.excluded).toEqual([]);
        expect(result.reprofiled).toBeNull();
    });

    it('gives the same working layer the same ID every time, and a changed one another', async () => {
        const { layer, compile } = await fixture({ seed: 32 });
        const first = await compile();
        const second = await compile();
        expect(second.candidateId).toBe(first.candidateId);
        expect(canonicalJson(second.content)).toBe(canonicalJson(first.content));
        expect(revisionIdOf(first.content)).toBe(first.candidateId);

        layer.photos[0].caption = 'A fixture caption added later.';
        const changed = await compile();
        expect(changed.candidateId).not.toBe(first.candidateId);
        expect(photo(changed, layer.photos[0].id)?.caption).toBe('A fixture caption added later.');
    });

    it('publishes published series with a cover, in Work order and once each, and leaves the rest out', async () => {
        const { layer, compile } = await fixture({
            seed: 33,
            photos: 8,
            series: [{ photos: 2 }, { photos: 2, visibility: 'hidden' }, { photos: 2, visibility: 'draft' }, { photos: 1, cover: null }, { photos: 1 }],
        });
        const [first, hidden, draft, coverless, last] = layer.series;
        if (!layer.site) throw new Error('The fixture has no site record.');
        layer.site.seriesOrder = [last.id, coverless.id, draft.id, hidden.id, first.id, last.id];
        const result = await compile();
        expect(result.content.series.map((series) => series.id)).toEqual([last.id, first.id]);
        expect(result.content.photos.map((entry) => entry.id)).toEqual([...last.photoIds, ...first.photoIds].sort());
    });

    it('leaves out each member that doesn\'t resolve, says why, and drops a series left with none', async () => {
        const { catalog, layer, registry, compile } = await fixture({ seed: 34, photos: 6, series: [{ photos: 5 }, { photos: 1 }] });
        const [series, lonely] = layer.series;
        const [kept, unknownPhoto, unknownRevision, notReady, noManifest] = series.photoIds;
        const noRecord = 'ph_00000000-0000-4000-8000-000000000001';
        series.photoIds = [...series.photoIds, noRecord];

        delete registry.photos[unknownPhoto];
        const otherRevision = `sha256-${'e'.repeat(64)}`;
        const pinnedAway = layer.photos.find((entry) => entry.id === unknownRevision);
        if (pinnedAway) pinnedAway.assetRevision = otherRevision;
        const notReadyRevision = pinnedRevision(registry, notReady);
        registry.photos[notReady].revisions[notReadyRevision].profiles[catalog.profileId] = { state: 'pending', attempts: 0 };
        const noManifestRevision = pinnedRevision(registry, noManifest);
        fs.rmSync(path.join(assetDir({ photoId: noManifest, assetRevision: noManifestRevision, profileId: catalog.profileId }, catalog.root), MANIFEST_FILE));
        // The other series' only member has nothing to publish either.
        delete registry.photos[lonely.photoIds[0]];

        const result = await compile();
        expect(result.excluded).toEqual([
            { seriesId: series.id, photoId: unknownPhoto, assetRevision: pinnedRevision(catalog.registry, unknownPhoto), profileId: null, reason: 'unknown-photo' },
            { seriesId: series.id, photoId: unknownRevision, assetRevision: otherRevision, profileId: null, reason: 'unknown-revision' },
            { seriesId: series.id, photoId: notReady, assetRevision: notReadyRevision, profileId: catalog.profileId, reason: 'not-ready' },
            { seriesId: series.id, photoId: noManifest, assetRevision: noManifestRevision, profileId: catalog.profileId, reason: 'no-manifest' },
            { seriesId: series.id, photoId: noRecord, assetRevision: null, profileId: null, reason: 'no-record' },
            { seriesId: lonely.id, photoId: lonely.photoIds[0], assetRevision: pinnedRevision(catalog.registry, lonely.photoIds[0]), profileId: null, reason: 'unknown-photo' },
        ]);
        expect(result.content.series.map((entry) => ({ id: entry.id, photoIds: entry.photoIds, count: entry.derived.photoCount }))).toEqual([{ id: series.id, photoIds: [kept], count: 1 }]);
        expect(result.content.photos.map((entry) => entry.id)).toEqual([kept]);
    });

    it('builds each photo once, however many series list it', async () => {
        const { layer, compile } = await fixture({ seed: 35, photos: 2, series: [{ photos: 2 }, { photos: 0 }] });
        const [first, second] = layer.series;
        second.photoIds = [first.photoIds[1]];
        second.cover = { photoId: first.photoIds[1] };
        const result = await compile();
        expect(result.content.series.map((series) => series.photoIds)).toEqual([first.photoIds, [first.photoIds[1]]]);
        expect(result.content.photos).toHaveLength(2);
    });

    it('copies authored text only when it holds something, and prefers an authored capture date', async () => {
        const { catalog, compile } = await fixture({
            seed: 36,
            photos: [{ title: '   ', caption: 'A fixture caption.', capturedAt: '2020-05-05' }, { capturedDate: null }, { location: '' }],
            series: [{ photos: 3 }],
        });
        // The working layer sorts photos by ID, so take them in spec order from the catalog.
        const [authoredDate, undated, blankLocation] = catalog.photos.map((entry) => entry.id);
        const result = await compile();
        expect(photo(result, authoredDate)).toMatchObject({ caption: 'A fixture caption.', capturedAt: '2020-05-05' });
        expect(photo(result, authoredDate)).not.toHaveProperty('title');
        expect(photo(result, undated)).not.toHaveProperty('capturedAt');
        expect(photo(result, blankLocation)).not.toHaveProperty('location');
        expect(result.content.series[0].derived).toEqual({ photoCount: 3, capturedFrom: '2020-05-05', capturedTo: '2024-01-03' });
    });

    it('turns an alt nobody wrote yet into pending, which only the description rules stop', async () => {
        const { catalog, compile } = await fixture({ seed: 37, photos: [{ alt: null }, {}], series: [{ photos: 2 }] });
        const result = await compile();
        expect(photo(result, catalog.photos[0].id)?.alt).toEqual({ kind: 'pending' });
        expect(photo(result, catalog.photos[1].id)?.alt).toEqual({ kind: 'described', text: 'Fixture description of photograph 0002.' });
    });
});

describe('the profile a photo publishes on', () => {
    it('stays the active revision\'s after a recipe change, so the candidate ID doesn\'t change', async () => {
        const { compile } = await fixture({ seed: 41, photos: 3, series: 1 });
        const active = asRevision(await compile());
        const after = await compile({ active, profileId: NEW_PROFILE });
        expect(after.candidateId).toBe(active.revisionId);
        expect(after.excluded).toEqual([]);
    });

    it('is a new photo\'s newest ready profile while the current one isn\'t ready, ties going to the lower ID', async () => {
        const { catalog, layer, registry, compile } = await fixture({ seed: 42, photos: 5, series: [{ photos: 4 }] });
        const active = asRevision(await compile());
        const newcomer = layer.photos.find((entry) => !layer.series[0].photoIds.includes(entry.id));
        if (!newcomer) throw new Error('The fixture has no photo outside the series.');
        layer.series[0].photoIds.push(newcomer.id);
        const from = { fromProfileId: catalog.profileId };
        addReadyProfile(catalog.root, registry, newcomer.id, { ...from, profileId: 'p_000000000000000b', readyAt: '2026-03-01T00:00:00.000Z' });
        addReadyProfile(catalog.root, registry, newcomer.id, { ...from, profileId: 'p_000000000000000a', readyAt: '2026-03-01T00:00:00.000Z' });
        addReadyProfile(catalog.root, registry, newcomer.id, { ...from, profileId: 'p_0000000000000009', readyAt: '2026-02-01T00:00:00.000Z' });

        const result = await compile({ active, profileId: NEW_PROFILE });
        expect(photo(result, newcomer.id)?.profileId).toBe('p_000000000000000a');
        expect(photo(result, newcomer.id)?.variants.w400.webp.url).toContain('/p_000000000000000a/');
        for (const id of layer.series[0].photoIds.slice(0, 4)) expect(photo(result, id)?.profileId).toBe(catalog.profileId);

        addReadyProfile(catalog.root, registry, newcomer.id, { ...from, profileId: NEW_PROFILE, readyAt: '2026-01-15T00:00:00.000Z' });
        const current = await compile({ active, profileId: NEW_PROFILE });
        expect(photo(current, newcomer.id)?.profileId).toBe(NEW_PROFILE);
    });

    it('under reprofile is the current one for every photo the watcher can rebuild, whose asset rule fails until it is ready', async () => {
        const { catalog, layer, registry, compile } = await fixture({ seed: 43, photos: [{}, {}, { sourceHealth: 'missing' }], series: 1 });
        const [first, second, missing] = catalog.photos.map((entry) => entry.id);
        const active = asRevision(await compile());
        const reprofile = { active, profileId: NEW_PROFILE, reprofile: true };

        const waiting = await compile(reprofile);
        expect(waiting.reprofiled).toEqual({ moved: [first, second].sort(), kept: [missing] });
        expect(waiting.excluded.map(({ photoId, profileId, reason }) => ({ photoId, profileId, reason }))).toEqual([
            { photoId: first, profileId: NEW_PROFILE, reason: 'not-ready' },
            { photoId: second, profileId: NEW_PROFILE, reason: 'not-ready' },
        ]);
        expect(photo(waiting, missing)?.profileId).toBe(catalog.profileId);
        const context = { candidate: waiting.content, authored: layer, active, registry, roots: { dataRoot: catalog.root, libraryRoot: null }, excluded: waiting.excluded };
        const assetIssues = runRules(context).filter((issue) => issue.code.startsWith('assets.'));
        expect(assetIssues.map((issue) => [issue.code, issue.record.id, issue.field])).toEqual([
            ['assets.ready', first, 'profileId'],
            ['assets.ready', second, 'profileId'],
        ].sort((a, b) => (a[1] < b[1] ? -1 : 1)));

        for (const id of [first, second]) addReadyProfile(catalog.root, registry, id, { fromProfileId: catalog.profileId, profileId: NEW_PROFILE, readyAt: '2026-03-01T00:00:00.000Z' });
        const ready = await compile(reprofile);
        expect(ready.excluded).toEqual([]);
        expect([first, second, missing].map((id) => photo(ready, id)?.profileId)).toEqual([NEW_PROFILE, NEW_PROFILE, catalog.profileId]);
        const readyContext = { ...context, candidate: ready.content, excluded: ready.excluded };
        expect(runRules(readyContext).filter((issue) => issue.code.startsWith('assets.'))).toEqual([]);
    });
});

describe('candidateFile', () => {
    it('wraps a compile in a strictly parsed candidate file', async () => {
        const { compile } = await fixture({ seed: 44, photos: 2, series: 1 });
        const result = await compile();
        const file = candidateFile(result, { baseRevisionId: null, compiledAt: '2026-02-01T00:00:00.000Z' });
        expect(file).toEqual({ revisionId: result.candidateId, schemaVersion: CATALOG_SCHEMA_VERSION, baseRevisionId: null, compiledAt: '2026-02-01T00:00:00.000Z', content: result.content });
    });

    it('throws when compile built something the candidate schema refuses', async () => {
        const { compile } = await fixture({ seed: 45, photos: 2, series: 1 });
        const result = await compile();
        result.content.photos[0].width = -1;
        expect(() => candidateFile(result, { baseRevisionId: null, compiledAt: '2026-02-01T00:00:00.000Z' })).toThrow(/Compile built an invalid candidate/);
    });
});
