// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../../identity/variants';
import { mediaUrl } from '../../media/url';
import { LEGACY_GALLERY_PATH, photoCountLabel, workCatalogOf, workRouteOf, type WorkActiveCatalog, type WorkCatalog, type WorkSeriesSummary } from '../projections/work';
import { publish } from '../publish';
import { createCatalogReader, createRouteBuilder } from '../reader';
import { createTestCatalog, type TestCatalog } from '../testing';
import type { CandidateContent, RevisionContent } from '../types';
import { readWorkingLayer } from '../working-layer';
import { writeAuthoredRecord } from '../working-layer-writer';
import { VARIANT_BYTES } from './catalogFixtures';

const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = Array.from({ length: 10 }, (_, n) => id(n + 1));
const routes = createRouteBuilder();

/** Strings planted where Work must never read: unpublished series, and fields outside the allowlist. */
const SENTINELS = {
    draftTitle: 'SENTINEL draft series title',
    draftShort: 'SENTINEL draft short statement',
    hiddenTitle: 'SENTINEL hidden series title',
    hiddenSlug: 'sentinel-hidden',
    statement: 'SENTINEL long statement',
    alias: 'sentinel-old-slug',
    chapter: 'SENTINEL chapter title',
    caption: 'SENTINEL caption',
    alt: 'SENTINEL alt description',
    location: 'SENTINEL location',
    credit: 'SENTINEL credit',
    photoTitle: 'SENTINEL photo title',
    sourcePath: 'private/SENTINEL-source.jpg',
    accent: '#5e7173',
} as const;

/**
 * Work order is C, A, B: `seriesOrder` puts the draft and hidden series
 * between them, so neither spec order nor ID order gives it. A holds P[0]
 * to P[2] with P[1] as its cover at an authored focal point; B holds P[3]
 * and P[4], its cover P[3] carrying the photo's own focal point and a
 * contain crop; C holds only P[5] and has neither. The draft series holds
 * P[6], the hidden one P[7], and P[8] is in no series.
 */
let catalog: TestCatalog;

beforeAll(async () => {
    catalog = await createTestCatalog({
        seed: 3,
        photos: [
            { id: P[0], title: SENTINELS.photoTitle, caption: SENTINELS.caption, alt: { kind: 'described', text: SENTINELS.alt, reviewed: true }, location: SENTINELS.location, credit: SENTINELS.credit, sourcePath: SENTINELS.sourcePath, accent: SENTINELS.accent },
            { id: P[1], focalPoint: { x: 0.9, y: 0.9 } },
            { id: P[2] },
            { id: P[3], focalPoint: { x: 0.7, y: 0.6 }, crop: 'contain' },
            { id: P[4] },
            { id: P[5] },
            { id: P[6] },
            { id: P[7] },
            { id: P[8] },
        ],
        series: [
            {
                id: 'ser_fixture-a',
                slug: 'fixture-a',
                slugAliases: [SENTINELS.alias],
                statement: SENTINELS.statement,
                accent: SENTINELS.accent,
                chapters: [{ id: 'chapter-one', title: SENTINELS.chapter, startPhotoId: P[0] }],
                photoIds: P.slice(0, 3),
                cover: { photoId: P[1], focalPoint: { x: 0.2, y: 0.3 } },
            },
            { id: 'ser_fixture-b', slug: 'fixture-b', photoIds: [P[3], P[4]] },
            { id: 'ser_fixture-c', slug: 'fixture-c', photoIds: [P[5]] },
            { id: 'ser_fixture-draft', slug: 'fixture-draft', title: SENTINELS.draftTitle, shortStatement: SENTINELS.draftShort, photoIds: [P[6]], visibility: 'draft' },
            { id: 'ser_fixture-hidden', slug: SENTINELS.hiddenSlug, title: SENTINELS.hiddenTitle, photoIds: [P[7]], visibility: 'hidden' },
        ],
        seriesOrder: ['ser_fixture-c', 'ser_fixture-draft', 'ser_fixture-a', 'ser_fixture-hidden', 'ser_fixture-b'],
    });
});

afterAll(async () => {
    await catalog.cleanup();
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const REVISION_A = `rev_${'a'.repeat(64)}`;
const REVISION_B = `rev_${'b'.repeat(64)}`;

function content(): RevisionContent {
    return structuredClone(catalog.content) as RevisionContent;
}

function workOf(source: CandidateContent = content(), revisionId = REVISION_A): WorkCatalog {
    return createCatalogReader(source, { revisionId, revisionNumber: 3 }).getWorkSummaries();
}

function entry(work: WorkCatalog, slug: string): WorkSeriesSummary {
    const found = work.series.find((summary) => summary.slug === slug);
    if (!found) throw new Error(`No entry for ${slug}`);
    return found;
}

function ladder(photoId: string) {
    const photo = catalog.content.photos.find((record) => record.id === photoId);
    if (!photo) throw new Error(`No photo ${photoId}`);
    return photo.variants;
}

describe('visibility and order', () => {
    it('lists only the published series, in authored Work order', () => {
        const work = workOf();
        expect(work.catalogRevision).toBe(REVISION_A);
        expect(work.series.map((summary) => summary.id)).toEqual(['ser_fixture-c', 'ser_fixture-a', 'ser_fixture-b']);
    });

    it('leaves draft and hidden series out entirely', () => {
        const json = JSON.stringify(workOf());
        for (const planted of [SENTINELS.draftTitle, SENTINELS.draftShort, SENTINELS.hiddenTitle, SENTINELS.hiddenSlug, 'ser_fixture-draft', 'ser_fixture-hidden', 'fixture-draft', P[6], P[7], P[8]]) {
            expect(json).not.toContain(planted);
        }
    });

    it('follows the content\'s order, so a reordered revision reorders Work', () => {
        const reordered = content();
        reordered.series.reverse();
        expect(workOf(reordered).series.map((summary) => summary.slug)).toEqual(['fixture-b', 'fixture-a', 'fixture-c']);
    });

    it('lists a series once, where it first appears', () => {
        const repeated = content();
        repeated.series.push(structuredClone(repeated.series[0]));
        expect(workOf(repeated).series.map((summary) => summary.slug)).toEqual(['fixture-c', 'fixture-a', 'fixture-b']);
    });
});

describe('the Work summary', () => {
    it('holds the authored copy, the derived count apart from it, the link, and the cover', () => {
        const variants = ladder(P[1]);
        expect(entry(workOf(), 'fixture-a')).toEqual({
            id: 'ser_fixture-a',
            slug: 'fixture-a',
            href: '/work/fixture-a',
            title: 'Fixture series 01',
            shortStatement: 'Fixture short statement for series 01.',
            derived: { photoCount: 3 },
            cover: {
                photoId: P[1],
                width: 1600,
                height: 2400,
                variants: Object.fromEntries(VARIANT_WIDTHS.map((width) => [width, Object.fromEntries(VARIANT_FORMATS.map((format) => [format, {
                    url: variants[width][format].url,
                    width: variants[width][format].width,
                    height: variants[width][format].height,
                    bytes: variants[width][format].bytes,
                }]))])),
                focalPoint: { x: 0.2, y: 0.3 },
                crop: 'cover',
            },
        });
    });

    it('takes the count from compile\'s derived count, not from the copy', () => {
        const edited = content();
        edited.series[1].derived.photoCount = 7;
        expect(entry(workOf(edited), 'fixture-a').derived).toEqual({ photoCount: 7 });
        expect(entry(workOf(), 'fixture-b').derived).toEqual({ photoCount: 2 });
        expect(entry(workOf(), 'fixture-c').derived).toEqual({ photoCount: 1 });
    });

    it('resolves the focal point from the series cover, then the photo, then the center, and the crop from the photo', () => {
        const work = workOf();
        expect([entry(work, 'fixture-a').cover?.focalPoint, entry(work, 'fixture-a').cover?.crop]).toEqual([{ x: 0.2, y: 0.3 }, 'cover']);
        expect([entry(work, 'fixture-b').cover?.focalPoint, entry(work, 'fixture-b').cover?.crop]).toEqual([{ x: 0.7, y: 0.6 }, 'contain']);
        expect([entry(work, 'fixture-c').cover?.focalPoint, entry(work, 'fixture-c').cover?.crop]).toEqual([{ x: 0.5, y: 0.5 }, 'cover']);
    });

    it('never cuts a short statement out of the statement: a blank one stays null', () => {
        const blank = content();
        blank.series[1].shortStatement = '   ';
        const summary = entry(workOf(blank), 'fixture-a');
        expect(summary.shortStatement).toBeNull();
        expect(JSON.stringify(summary)).not.toContain(SENTINELS.statement);
    });

    it('builds every cover file\'s URL as #10\'s /media URL for that photo\'s set', () => {
        for (const summary of workOf().series) {
            const photo = catalog.content.photos.find((record) => record.id === summary.cover?.photoId);
            if (!photo || !summary.cover) throw new Error(`No cover for ${summary.slug}`);
            for (const width of VARIANT_WIDTHS) {
                for (const format of VARIANT_FORMATS) {
                    expect(summary.cover.variants[width][format].url).toBe(mediaUrl({ photoId: photo.id, assetRevision: photo.assetRevision, profileId: photo.profileId }, width, format));
                }
            }
        }
    });

    it('copies the cover, so a caller can\'t edit the revision through it', () => {
        const source = content();
        const reader = createCatalogReader(source, { revisionId: REVISION_A, revisionNumber: 3 });
        const cover = entry(reader.getWorkSummaries(), 'fixture-a').cover;
        if (!cover) throw new Error('No cover');
        cover.variants.w400.webp.url = '/elsewhere';
        cover.focalPoint.x = 0;
        expect(entry(reader.getWorkSummaries(), 'fixture-a').cover?.variants.w400.webp.url).toBe(ladder(P[1]).w400.webp.url);
        expect(source.series[1].cover.focalPoint).toEqual({ x: 0.2, y: 0.3 });
    });
});

describe('serialization', () => {
    it('sends only the allowlisted fields', () => {
        const work = workOf();
        expect(Object.keys(work).sort()).toEqual(['catalogRevision', 'series']);
        for (const summary of work.series) {
            expect(Object.keys(summary).sort()).toEqual(['cover', 'derived', 'href', 'id', 'shortStatement', 'slug', 'title']);
            expect(Object.keys(summary.derived)).toEqual(['photoCount']);
            expect(Object.keys(summary.cover ?? {}).sort()).toEqual(['crop', 'focalPoint', 'height', 'photoId', 'variants', 'width']);
            for (const width of VARIANT_WIDTHS) {
                for (const format of VARIANT_FORMATS) expect(Object.keys(summary.cover?.variants[width][format] ?? {}).sort()).toEqual(['bytes', 'height', 'url', 'width']);
            }
        }
    });

    it('carries no statement, alias, chapter, accent, photo copy, alt, LQIP, camera fact, or source path', () => {
        const json = JSON.stringify(workOf());
        for (const planted of Object.values(SENTINELS)) expect(json).not.toContain(planted);
        for (const field of ['statement"', 'slugAliases', 'chapters', 'accent', 'photoIds', 'lqip', 'alt', 'technical', 'assetRevision', 'profileId', 'capturedAt', 'data:image', 'Fixture Make']) {
            expect(json).not.toContain(field);
        }
    });

    it('keeps record fields out even when a hand-written record holds extra ones', () => {
        const extra = content() as unknown as { series: Record<string, unknown>[]; photos: Record<string, unknown>[] };
        extra.series[1].visibility = 'SENTINEL visibility';
        extra.series[1].curatorNote = 'SENTINEL curator note';
        const cover = extra.photos.find((photo) => photo.id === P[1]);
        if (!cover) throw new Error('No cover');
        cover.sourcePath = SENTINELS.sourcePath;
        const json = JSON.stringify(workOf(extra as unknown as CandidateContent));
        expect(json).not.toContain('SENTINEL');
    });
});

describe('links', () => {
    it('links each entry to its canonical slug, never a former one', () => {
        const work = workOf();
        expect(work.series.map((summary) => summary.href)).toEqual(['/work/fixture-c', '/work/fixture-a', '/work/fixture-b']);
        expect(JSON.stringify(work)).not.toContain(SENTINELS.alias);
    });

    it('keeps the link when the title or cover changes, and moves it only with the slug', () => {
        const edited = content();
        edited.series[1].title = 'Fixture series 01, retitled';
        edited.series[1].cover = { photoId: P[2] };
        expect(entry(workOf(edited, REVISION_B), 'fixture-a').href).toBe('/work/fixture-a');
        edited.series[1].slug = 'fixture-a-renamed';
        edited.series[1].slugAliases = ['fixture-a'];
        expect(workOf(edited, REVISION_B).series[1].href).toBe('/work/fixture-a-renamed');
    });

    it('takes a preview\'s route builder', () => {
        const reader = createCatalogReader(content(), { revisionId: REVISION_A, revisionNumber: null });
        expect(reader.getWorkSummaries(createRouteBuilder({ basePath: '/preview/token' })).series[0].href).toBe('/preview/token/work/fixture-c');
    });
});

describe('cover fallback', () => {
    it('gives no cover, but keeps the entry and its link, when the cover photo didn\'t resolve', () => {
        const missing = content();
        missing.photos = missing.photos.filter((photo) => photo.id !== P[1]);
        const summary = entry(workOf(missing), 'fixture-a');
        expect(summary.cover).toBeNull();
        expect([summary.title, summary.href, summary.derived.photoCount]).toEqual(['Fixture series 01', '/work/fixture-a', 3]);
    });

    it('gives no cover for a cover outside the series, even a published photo of another series', () => {
        const foreign = content();
        foreign.series[1].cover = { photoId: P[3] };
        expect(entry(workOf(foreign), 'fixture-a').cover).toBeNull();
        expect(entry(workOf(foreign), 'fixture-b').cover?.photoId).toBe(P[3]);
    });

    it('gives no cover for a series with none', () => {
        const none = content() as unknown as { series: Record<string, unknown>[] };
        delete none.series[1].cover;
        expect(entry(workOf(none as unknown as CandidateContent), 'fixture-a').cover).toBeNull();
    });

    it.each([
        ['a missing variant width', (variants: Record<string, Record<string, Record<string, unknown>>>) => { delete variants.w800; }],
        ['a missing format', (variants: Record<string, Record<string, Record<string, unknown>>>) => { delete variants.w1920.avif; }],
        ['a file outside /media', (variants: Record<string, Record<string, Record<string, unknown>>>) => { variants.w400.webp.url = '/fixture-cover.webp'; }],
        ['another photo\'s file', (variants: Record<string, Record<string, Record<string, unknown>>>) => { variants.w1200.webp.url = ladder(P[0]).w1200.webp.url; }],
        ['an absolute URL', (variants: Record<string, Record<string, Record<string, unknown>>>) => { variants.w800.avif.url = `https://example.invalid${ladder(P[1]).w800.avif.url}`; }],
        ['a file with no width', (variants: Record<string, Record<string, Record<string, unknown>>>) => { variants.w400.avif.width = 0; }],
    ])('gives no cover for %s, so the entry falls back instead of pointing anywhere else', (_name, damage) => {
        const damaged = content();
        const cover = damaged.photos.find((photo) => photo.id === P[1]);
        if (!cover) throw new Error('No cover');
        damage(cover.variants as unknown as Record<string, Record<string, Record<string, unknown>>>);
        expect(entry(workOf(damaged), 'fixture-a').cover).toBeNull();
        expect(entry(workOf(damaged), 'fixture-b').cover).not.toBeNull();
    });

    it('ignores a focal point outside 0 to 1 and falls back along the chain', () => {
        const odd = content();
        odd.series[1].cover = { photoId: P[1], focalPoint: { x: 2, y: 0.5 } };
        expect(entry(workOf(odd), 'fixture-a').cover?.focalPoint).toEqual({ x: 0.9, y: 0.9 });
    });
});

describe('empty states', () => {
    it('leaves out a series with nothing to open, as compile does', () => {
        const empty = content();
        empty.series[1].photoIds = [];
        empty.series[1].derived.photoCount = 0;
        expect(workOf(empty).series.map((summary) => summary.slug)).toEqual(['fixture-c', 'fixture-b']);

        const unresolved = content();
        unresolved.photos = unresolved.photos.filter((photo) => photo.id !== P[5]);
        expect(workOf(unresolved).series.map((summary) => summary.slug)).toEqual(['fixture-a', 'fixture-b']);

        const uncounted = content();
        uncounted.series[0].derived.photoCount = 0;
        expect(workOf(uncounted).series.map((summary) => summary.slug)).toEqual(['fixture-a', 'fixture-b']);
    });

    it('answers a content with no series as an empty catalog of that revision', () => {
        const none = content();
        none.series = [];
        expect(workOf(none)).toEqual({ catalogRevision: REVISION_A, series: [] });
    });

    it('counts in interface copy', () => {
        expect([photoCountLabel(1), photoCountLabel(2), photoCountLabel(14)]).toEqual(['1 photograph', '2 photographs', '14 photographs']);
    });
});

describe('catalog revision consistency', () => {
    it('answers from the reader\'s own content, so two revisions never mix', () => {
        const b = content();
        b.series[1].title = 'Fixture series 01, renamed';
        b.series = [b.series[1], b.series[2]];
        const fromA = workOf(content(), REVISION_A);
        const fromB = workOf(b, REVISION_B);
        expect([fromA.catalogRevision, fromA.series.map((summary) => summary.title)]).toEqual([REVISION_A, ['Fixture series 03', 'Fixture series 01', 'Fixture series 02']]);
        expect([fromB.catalogRevision, fromB.series.map((summary) => summary.title)]).toEqual([REVISION_B, ['Fixture series 01, renamed', 'Fixture series 02']]);
    });

    it('works from any source with the reader\'s shape', () => {
        const reader = createCatalogReader(content(), { revisionId: REVISION_A, revisionNumber: 3 });
        expect(workCatalogOf({ revisionId: REVISION_B, listSeries: reader.listSeries, photosOf: reader.photosOf }, routes).catalogRevision).toBe(REVISION_B);
    });
});

describe('workRouteOf, the /work and /gallery matrix', () => {
    const okCatalog = (state: 'ok' | 'degraded' = 'ok'): WorkActiveCatalog => ({
        mode: 'catalog',
        state,
        reader: createCatalogReader(content(), { revisionId: REVISION_A, revisionNumber: 3 }),
    });
    /** A reader that fails the test if anything reads it. */
    const trap: WorkActiveCatalog = {
        mode: 'catalog',
        state: 'ok',
        reader: { getWorkSummaries: () => { throw new Error('The catalog was read'); } },
    };

    it('sends /work to the legacy /gallery with a 307 before the cutover, and leaves /gallery as it is', () => {
        expect(workRouteOf('work', { mode: 'legacy' }, routes)).toEqual({ kind: 'redirect', location: LEGACY_GALLERY_PATH, status: 307 });
        expect(LEGACY_GALLERY_PATH).toBe('/gallery');
        expect(workRouteOf('gallery', { mode: 'legacy' }, routes)).toEqual({ kind: 'legacy-gallery' });
    });

    it('renders Work and sends /gallery to bare /work with a 308 once a revision is served', () => {
        for (const state of ['ok', 'degraded'] as const) {
            const work = workRouteOf('work', okCatalog(state), routes);
            expect(work.kind === 'work' && work.work.catalogRevision).toBe(REVISION_A);
            expect(work.kind === 'work' && work.work.series.map((summary) => summary.slug)).toEqual(['fixture-c', 'fixture-a', 'fixture-b']);
            expect(workRouteOf('gallery', okCatalog(state), routes)).toEqual({ kind: 'redirect', location: '/work', status: 308 });
        }
    });

    it('never sends a permanent redirect while the catalog is unavailable', () => {
        for (const reason of ['catalog-unreadable', 'active-unreadable', 'revision-unreadable'] as const) {
            const unavailable: WorkActiveCatalog<typeof reason> = { mode: 'catalog', state: 'unavailable', reason };
            expect(workRouteOf('work', unavailable, routes)).toEqual({ kind: 'unavailable', reason });
            expect(workRouteOf('gallery', unavailable, routes)).toEqual({ kind: 'unavailable', reason });
        }
    });

    it('reads the catalog only to render Work', () => {
        expect(workRouteOf('gallery', trap, routes)).toEqual({ kind: 'redirect', location: '/work', status: 308 });
        expect(() => workRouteOf('work', trap, routes)).toThrow('The catalog was read');
    });
});

describe('Work on published revisions', { timeout: 60_000 }, () => {
    it('serves the active revision\'s published series, which a publish replaces, and never a draft one', async () => {
        const published = await createTestCatalog({
            variantBytes: VARIANT_BYTES,
            seed: 13,
            photos: 4,
            series: [
                { slug: 'fixture-a', photos: 2 },
                { slug: 'fixture-draft', title: SENTINELS.draftTitle, shortStatement: SENTINELS.draftShort, photos: 1, visibility: 'draft' },
                { slug: 'fixture-b', photos: 1 },
            ],
        });
        cleanups.push(() => published.cleanup());
        const root = published.root;
        const logger = { log: () => undefined };
        vi.resetModules();
        const { loadActiveCatalog, publicRoutes } = await import('../public-reader');

        expect(workRouteOf('work', await loadActiveCatalog(root), publicRoutes)).toEqual({ kind: 'redirect', location: '/gallery', status: 307 });
        expect(workRouteOf('gallery', await loadActiveCatalog(root), publicRoutes)).toEqual({ kind: 'legacy-gallery' });

        const one = await publish({ dataRoot: root, actor: 'test', confirmLaunch: true, logger });
        expect(one.outcome).toBe('PUBLISHED');
        const atOne = workRouteOf('work', await loadActiveCatalog(root), publicRoutes);
        if (atOne.kind !== 'work') throw new Error(`Expected Work, got ${JSON.stringify(atOne)}`);
        expect(atOne.work.catalogRevision).toBe(one.revisionId);
        expect(atOne.work.series.map((summary) => [summary.slug, summary.href, summary.derived.photoCount])).toEqual([['fixture-a', '/work/fixture-a', 2], ['fixture-b', '/work/fixture-b', 1]]);
        expect(atOne.work.series.every((summary) => summary.cover !== null)).toBe(true);
        const json = JSON.stringify(atOne);
        for (const planted of [SENTINELS.draftTitle, SENTINELS.draftShort, 'fixture-draft', 'Fixture statement', 'fixture-0001.jpg', 'data:image']) expect(json).not.toContain(planted);
        expect(workRouteOf('gallery', await loadActiveCatalog(root), publicRoutes)).toEqual({ kind: 'redirect', location: '/work', status: 308 });

        const record = (await readWorkingLayer(root)).series.find((series) => series.slug === 'fixture-a');
        if (!record) throw new Error('No fixture-a record');
        await writeAuthoredRecord({ ...structuredClone(record), shortStatement: 'A fixture short statement for revision two.' }, { expectedVersion: record.version, root });
        const two = await publish({ dataRoot: root, actor: 'test', confirmLaunch: true, logger });
        expect(two.outcome).toBe('PUBLISHED');
        expect(two.revisionId).not.toBe(one.revisionId);
        const atTwo = workRouteOf('work', await loadActiveCatalog(root), publicRoutes);
        if (atTwo.kind !== 'work') throw new Error(`Expected Work, got ${JSON.stringify(atTwo)}`);
        expect([atTwo.work.catalogRevision, atTwo.work.series[0].shortStatement, atTwo.work.series[0].href]).toEqual([two.revisionId, 'A fixture short statement for revision two.', '/work/fixture-a']);
    });
});
