// @vitest-environment node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { toPublicAsset } from '../../identity/metadata';
import { readRegistry } from '../../identity/registry';
import type { AssetManifest } from '../../identity/types';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../../identity/variants';
import { dataRootStatus } from '../../storage/config';
import { verifyDirectory } from '../../storage/publish';
import { toAssetProjection } from '../reader';
import { parseCandidateFile, parseRevisionFile, revisionIdOf } from '../schema';
import { createTestCatalog, type TestCatalog, type TestCatalogOptions } from '../testing';
import { readWorkingLayer } from '../working-layer';

const catalogs: TestCatalog[] = [];

// Removing the 5,000-photo catalog can take well over the default 10 s on a loaded machine.
afterEach(async () => {
    for (const catalog of catalogs.splice(0)) await catalog.cleanup();
}, 60_000);

async function build(options: TestCatalogOptions = {}): Promise<TestCatalog> {
    const catalog = await createTestCatalog(options);
    catalogs.push(catalog);
    return catalog;
}

/** Every file under `root` with its SHA-256, so two roots can be compared byte for byte. */
function tree(root: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const relativePath of fs.readdirSync(root, { recursive: true, encoding: 'utf8' }).sort()) {
        const absolute = path.join(root, relativePath);
        if (fs.statSync(absolute).isFile()) result[relativePath] = createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    }
    return result;
}

function manifestOf(catalog: TestCatalog, photoId: string): AssetManifest {
    const photo = catalog.photos.find((entry) => entry.id === photoId);
    if (!photo) throw new Error(`No photo ${photoId}`);
    return JSON.parse(fs.readFileSync(path.join(catalog.root, 'assets', photoId, photo.assetRevision, catalog.profileId, 'manifest.json'), 'utf8')) as AssetManifest;
}

describe('createTestCatalog', () => {
    it('writes a ready data root with a working layer, a registry, and no problems', async () => {
        const catalog = await build();
        expect(dataRootStatus({ root: catalog.root }).state).toBe('ready');
        const layer = await readWorkingLayer(catalog.root);
        expect(layer.problems).toEqual([]);
        const byId = <T extends { id: string }>(records: T[]) => [...records].sort((a, b) => (a.id < b.id ? -1 : 1));
        expect(layer.site).toEqual(catalog.site);
        expect(layer.series).toEqual(byId(catalog.series));
        expect(layer.photos).toEqual(byId(catalog.photos));
        expect(await readRegistry(catalog.root)).toEqual(catalog.registry);
        expect(catalog.root.startsWith(os.tmpdir()) || catalog.root.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    });

    it('defaults to six photos in two published series, the first featured', async () => {
        const catalog = await build();
        expect(catalog.photos).toHaveLength(6);
        expect(catalog.series.map((series) => [series.id, series.visibility, series.photoIds.length])).toEqual([
            ['ser_fixture-01', 'published', 3],
            ['ser_fixture-02', 'published', 3],
        ]);
        expect(catalog.site).toMatchObject({ featuredSeriesIds: ['ser_fixture-01'], seriesOrder: ['ser_fixture-01', 'ser_fixture-02'] });
        expect(catalog.content.series.map((series) => series.id)).toEqual(['ser_fixture-01', 'ser_fixture-02']);
        expect(catalog.content.photos.map((photo) => photo.id)).toEqual(catalog.photos.map((photo) => photo.id).sort());
    });

    it('produces content that is a valid revision with the ID compile would give it', async () => {
        const catalog = await build();
        expect(catalog.revisionId).toBe(revisionIdOf(catalog.content));
        const file = { revisionId: catalog.revisionId, schemaVersion: 1, baseRevisionId: null, compiledAt: '2026-01-01T00:00:00.000Z', content: catalog.content };
        expect(parseRevisionFile(file).ok).toBe(true);
        expect(catalog.reader().photosOf('ser_fixture-02').map((photo) => photo.id)).toEqual(catalog.series[1].photoIds);
        expect(catalog.reader().revision()).toEqual({ revisionId: catalog.revisionId, revisionNumber: null });
    });

    it('reads as an obvious fixture, with no copy that could pass for the owner\'s', async () => {
        const catalog = await build();
        const text = JSON.stringify({ site: catalog.site, series: catalog.series, photos: catalog.photos });
        for (const series of catalog.series) {
            for (const field of [series.title, series.statement, series.shortStatement]) expect(field).toMatch(/fixture/i);
        }
        for (const photo of catalog.photos) expect(photo.alt).toMatchObject({ kind: 'described', reviewed: true, text: expect.stringMatching(/fixture/i) });
        expect(text).not.toMatch(/"location"/);
    });

    it('builds the same bytes and IDs from the same seed and options, and other IDs from another seed', async () => {
        const [a, b, c] = await Promise.all([build({ seed: 7 }), build({ seed: 7 }), build({ seed: 8 })]);
        expect(tree(a.root)).toEqual(tree(b.root));
        expect(a.revisionId).toBe(b.revisionId);
        expect(c.photos.map((photo) => photo.id)).not.toEqual(a.photos.map((photo) => photo.id));
    });

    it('takes explicit photos and series, and leaves draft and hidden series and their members out of the content', async () => {
        const catalog = await build({
            photos: [{ alt: null }, { width: 1200, height: 1800, title: 'Fixture title' }, {}, {}, {}],
            series: [
                { photos: 2, slug: 'fixture-first', slugAliases: ['fixture-old'] },
                { photos: 1, visibility: 'draft' },
                { photos: 1, visibility: 'hidden' },
            ],
        });
        expect(catalog.content.series.map((series) => series.slug)).toEqual(['fixture-first']);
        expect(catalog.content.photos.map((photo) => photo.id)).toEqual(catalog.series[0].photoIds.slice().sort());
        const [first, second] = catalog.series[0].photoIds.map((id) => catalog.reader().photo(id));
        expect(first?.alt).toEqual({ kind: 'pending' });
        expect(second).toMatchObject({ width: 1200, height: 1800, aspectRatio: 0.6667, title: 'Fixture title' });
        expect(second?.variants.w400.webp).toMatchObject({ width: 400, height: 600 });
        expect(second?.variants.w1920.avif).toMatchObject({ width: 1200, height: 1800 });
        // The fifth photo is in no series: it has an authored record but no place in the content.
        expect(catalog.photos).toHaveLength(5);
        const file = { revisionId: catalog.revisionId, schemaVersion: 1, baseRevisionId: null, compiledAt: '2026-01-01T00:00:00.000Z', content: catalog.content };
        expect(parseRevisionFile(file).ok).toBe(false);
        expect(parseCandidateFile(file).ok).toBe(true);
    });

    it('marks the profile pending and writes no assets by default', async () => {
        const catalog = await build({ photos: 2, series: 1 });
        for (const photo of Object.values(catalog.registry.photos)) {
            const revision = photo.revisions[photo.source.observedRevision];
            expect(revision.profiles[catalog.profileId].state).toBe('pending');
        }
        expect(fs.existsSync(path.join(catalog.root, 'assets'))).toBe(false);
    });

    it('with variantBytes, writes manifests and sparse variant files of those sizes, and marks the profile ready', async () => {
        const variantBytes = {
            w400: { avif: 30 * 1024, webp: 42 * 1024 },
            w800: { avif: 90 * 1024, webp: 126 * 1024 },
            w1200: { avif: 170 * 1024, webp: 238 * 1024 },
            w1920: { avif: 350 * 1024, webp: 490 * 1024 },
        };
        const catalog = await build({ photos: 3, series: 1, variantBytes });
        for (const photo of catalog.content.photos) {
            const manifest = manifestOf(catalog, photo.id);
            const dir = path.join(catalog.root, 'assets', photo.id, photo.assetRevision, catalog.profileId);
            expect(await verifyDirectory(dir, { photoId: photo.id, assetRevision: photo.assetRevision, profileId: catalog.profileId })).toEqual([]);
            for (const width of VARIANT_WIDTHS) {
                for (const format of VARIANT_FORMATS) {
                    expect(manifest.variants[width][format].bytes).toBe(variantBytes[width][format]);
                    expect(fs.statSync(path.join(dir, `${width}.${format}`)).size).toBe(variantBytes[width][format]);
                    expect(photo.variants[width][format].bytes).toBe(variantBytes[width][format]);
                }
            }
            const registered = catalog.registry.photos[photo.id];
            expect(registered.revisions[photo.assetRevision].profiles[catalog.profileId].state).toBe('ready');
            // The record carries exactly what #10's projection of that manifest gives.
            expect(toAssetProjection(photo)).toEqual(toPublicAsset(registered, photo.assetRevision, catalog.profileId, manifest));
        }
    });

    it('with withAssets, writes decodable WebP and AVIF at each variant\'s recorded size', { timeout: 60_000 }, async () => {
        const catalog = await build({ photos: [{ width: 2400, height: 1600 }, { width: 900, height: 1350 }], series: 1, withAssets: true });
        for (const photo of catalog.content.photos) {
            const manifest = manifestOf(catalog, photo.id);
            const dir = path.join(catalog.root, 'assets', photo.id, photo.assetRevision, catalog.profileId);
            expect(await verifyDirectory(dir, { photoId: photo.id, assetRevision: photo.assetRevision, profileId: catalog.profileId })).toEqual([]);
            for (const width of VARIANT_WIDTHS) {
                for (const format of VARIANT_FORMATS) {
                    const decoded = await sharp(path.join(dir, `${width}.${format}`)).metadata();
                    expect(decoded.format).toBe(format === 'avif' ? 'heif' : 'webp');
                    expect([decoded.width, decoded.height]).toEqual([manifest.variants[width][format].width, manifest.variants[width][format].height]);
                }
            }
            const lqip = await sharp(Buffer.from(photo.lqip.replace(/^data:image\/webp;base64,/, ''), 'base64')).metadata();
            expect(lqip.format).toBe('webp');
            expect(toAssetProjection(photo)).toEqual(toPublicAsset(catalog.registry.photos[photo.id], photo.assetRevision, catalog.profileId, manifest));
        }
        expect(catalog.content.photos.find((photo) => photo.width === 900)?.variants.w1920.webp).toMatchObject({ width: 900, height: 1350 });
    });

    it('writes into a root the caller names and leaves it in place on cleanup', async () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-named-'));
        try {
            const root = path.join(parent, 'data');
            const catalog = await createTestCatalog({ root, photos: 1, series: 1 });
            expect(catalog.root).toBe(root);
            await catalog.cleanup();
            expect(fs.existsSync(path.join(root, 'authored', 'site', 'v1.json'))).toBe(true);
        } finally {
            fs.rmSync(parent, { recursive: true, force: true });
        }
    });

    it('refuses a root inside this repository', async () => {
        await expect(createTestCatalog({ root: path.join(process.cwd(), 'portfolio-data') })).rejects.toThrow(/outside/);
    });

    it('builds 5,000 photos in 100 series', { timeout: 120_000 }, async () => {
        const catalog = await build({ photos: 5_000, series: 100 });
        expect(catalog.content.series).toHaveLength(100);
        expect(catalog.content.photos).toHaveLength(5_000);
        expect(new Set(catalog.content.photos.map((photo) => photo.id)).size).toBe(5_000);
    });
});
