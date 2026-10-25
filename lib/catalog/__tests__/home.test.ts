// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../../identity/variants';
import { mediaUrl } from '../../media/url';
import { homeRouteOf, publishedHomeOf, type HomeActiveCatalog, type HomeSeries, type HomeSource, type PublishedHome } from '../projections/home';
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

/** Strings planted where Home must never read: unpublished and unfeatured series, and fields outside the allowlist. */
const SENTINELS = {
    draftTitle: 'SENTINEL draft series title',
    hiddenTitle: 'SENTINEL hidden series title',
    otherTitle: 'SENTINEL unfeatured series title',
    statement: 'SENTINEL long statement',
    alias: 'sentinel-old-slug',
    chapter: 'SENTINEL chapter title',
    caption: 'SENTINEL caption',
    location: 'SENTINEL location',
    credit: 'SENTINEL credit',
    photoTitle: 'SENTINEL photo title',
    sourcePath: 'private/SENTINEL-source.jpg',
    lens: 'SENTINEL lens',
    accent: '#5e7173',
} as const;

/** Series A's authored order. ID order, capture dates, and file names each say otherwise. */
const ORDER_A = [P[4], P[1], P[3], P[0], P[2]];

/**
 * Featured series A (fixture-a, once old-fixture-a) holds ORDER_A and opens
 * on P[3]. Its capture dates run P[0] to P[4] ascending and its file names
 * run the other way, so neither agrees with the authored order. P[4]
 * carries every field Home must drop and an authored focal point; P[1] is
 * decorative. B is published but not featured and comes first in Work
 * order. The draft series holds P[7], the hidden one P[8], and P[9] is in
 * no series, so none of those three is in the content.
 */
let catalog: TestCatalog;

beforeAll(async () => {
    catalog = await createTestCatalog({
        seed: 4,
        photos: [
            { id: P[0], capturedAt: '2021-01-01', sourcePath: 'e-last.jpg' },
            { id: P[1], capturedAt: '2021-01-02', sourcePath: 'd.jpg', alt: { kind: 'decorative' } },
            { id: P[2], capturedAt: '2021-01-03', sourcePath: 'c.jpg' },
            { id: P[3], capturedAt: '2021-01-04', sourcePath: 'b.jpg' },
            {
                id: P[4],
                capturedAt: '2021-01-05',
                sourcePath: SENTINELS.sourcePath,
                title: SENTINELS.photoTitle,
                caption: SENTINELS.caption,
                location: SENTINELS.location,
                credit: SENTINELS.credit,
                accent: SENTINELS.accent,
                technical: { LensModel: SENTINELS.lens },
                focalPoint: { x: 0.2, y: 0.8 },
                crop: 'contain',
            },
            { id: P[5] },
            { id: P[6] },
            { id: P[7] },
            { id: P[8] },
            { id: P[9] },
        ],
        series: [
            {
                id: 'ser_fixture-a',
                slug: 'fixture-a',
                slugAliases: [SENTINELS.alias],
                title: 'Fixture series A',
                shortStatement: 'Fixture short statement A.',
                statement: SENTINELS.statement,
                accent: SENTINELS.accent,
                chapters: [{ id: 'chapter-one', title: SENTINELS.chapter, startPhotoId: P[4] }],
                photoIds: ORDER_A,
                openingPhotoId: P[3],
            },
            { id: 'ser_fixture-b', slug: 'fixture-b', title: SENTINELS.otherTitle, photoIds: [P[5], P[6]] },
            { id: 'ser_fixture-draft', slug: 'fixture-draft', title: SENTINELS.draftTitle, photoIds: [P[7]], visibility: 'draft' },
            { id: 'ser_fixture-hidden', slug: 'fixture-hidden', title: SENTINELS.hiddenTitle, photoIds: [P[8]], visibility: 'hidden' },
        ],
        featuredSeriesIds: ['ser_fixture-a', 'ser_fixture-b'],
        seriesOrder: ['ser_fixture-b', 'ser_fixture-draft', 'ser_fixture-a', 'ser_fixture-hidden'],
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

function source(from: CandidateContent = content(), revisionId = REVISION_A): HomeSource {
    const reader = createCatalogReader(from, { revisionId, revisionNumber: 3 });
    return { revisionId, site: reader.site, listSeries: reader.listSeries, photosOf: (seriesId) => reader.photosOf(seriesId) };
}

function homeOf(from: CandidateContent = content(), revisionId = REVISION_A): PublishedHome {
    return publishedHomeOf(source(from, revisionId), routes);
}

function featured(home: PublishedHome): HomeSeries {
    if (home.featuredSeries === null) throw new Error('Expected a featured series');
    return home.featuredSeries;
}

function ladder(photoId: string) {
    const photo = catalog.content.photos.find((record) => record.id === photoId);
    if (!photo) throw new Error(`No photo ${photoId}`);
    return photo.variants;
}

describe('order', () => {
    it('follows the series\' photoIds, never ID order, capture dates, or file names', () => {
        const held = content();
        // The precondition: every other order disagrees with the authored one.
        const members = held.photos.filter((photo) => ORDER_A.includes(photo.id));
        expect(members.map((photo) => photo.id)).not.toEqual(ORDER_A);
        expect([...members].sort((a, b) => (a.capturedAt ?? '').localeCompare(b.capturedAt ?? '')).map((photo) => photo.id)).not.toEqual(ORDER_A);
        // File names never reach a revision at all.
        expect(JSON.stringify(held)).not.toMatch(/e-last\.jpg|SENTINEL-source/);

        expect(featured(homeOf(held)).photos.map((photo) => photo.id)).toEqual(ORDER_A);
    });

    it('gives the same sequence and opening photograph every time for one revision', () => {
        const held = content();
        const first = homeOf(held);
        expect(homeOf(held)).toEqual(first);
        expect(homeOf(content())).toEqual(first);
    });

    it('ignores content.photos order and record fields a new file or EXIF change could move', () => {
        const held = content();
        held.photos.reverse();
        for (const [n, photo] of held.photos.entries()) photo.capturedAt = `2030-01-${String(n + 1).padStart(2, '0')}`;
        expect(featured(homeOf(held)).photos.map((photo) => photo.id)).toEqual(ORDER_A);
    });

    it('opens on the authored opening photograph, keeping the authored order around it', () => {
        const series = featured(homeOf());
        expect(series.openingPhotoId).toBe(P[3]);
        expect(series.photos.map((photo) => photo.id)).toEqual(ORDER_A);
    });

    it('opens on the first photograph when no opening is stored, or the stored one doesn\'t resolve, and gives it the LQIP', () => {
        const none = content();
        delete none.series[1].openingPhotoId;
        expect(none.series[1].id).toBe('ser_fixture-a');

        const unresolved = content();
        unresolved.series[1].openingPhotoId = P[9];

        const outside = content();
        outside.series[1].openingPhotoId = P[5];

        for (const [name, held] of [['none stored', none], ['unresolved', unresolved], ['outside the series', outside]] as const) {
            const series = featured(homeOf(held));
            expect(series.openingPhotoId, name).toBe(P[4]);
            const lqip = held.photos.find((photo) => photo.id === P[4])?.lqip;
            expect(lqip, name).toMatch(/^data:image\/webp;base64,/);
            expect(series.photos[0].image?.lqip, name).toBe(lqip);
            expect(series.photos.slice(1).filter((photo) => photo.image !== null && 'lqip' in photo.image), name).toEqual([]);
        }
    });

    it('skips members that resolve to nothing, as the series page counts them', () => {
        const held = content();
        held.series[1].photoIds = [P[9], ...ORDER_A.slice(0, 2), P[7]];
        expect(featured(homeOf(held)).photos.map((photo) => photo.id)).toEqual(ORDER_A.slice(0, 2));
    });
});

describe('the featured series', () => {
    it('is the first featured entry, not the first series in Work order', () => {
        const home = homeOf();
        expect(home.catalogRevision).toBe(REVISION_A);
        expect(featured(home).id).toBe('ser_fixture-a');
    });

    it('never rotates: the second featured entry shows only when the first isn\'t held', () => {
        const held = content();
        held.site.featuredSeriesIds = ['ser_fixture-draft', 'ser_fixture-hidden', 'ser_fixture-b', 'ser_fixture-a'];
        const series = featured(homeOf(held));
        expect(series.id).toBe('ser_fixture-b');
        expect(series.photos.map((photo) => photo.id)).toEqual([P[5], P[6]]);
    });

    it('holds nothing unpublished or unfeatured', () => {
        const serialized = JSON.stringify(homeOf());
        for (const unpublished of [P[5], P[6], P[7], P[8], P[9], SENTINELS.draftTitle, SENTINELS.hiddenTitle, SENTINELS.otherTitle, 'fixture-draft', 'fixture-hidden']) {
            expect(serialized).not.toContain(unpublished);
        }
    });

    it('links to the series by its canonical slug through the route builder', () => {
        expect(featured(homeOf()).href).toBe('/work/fixture-a');
        const preview = createRouteBuilder({ basePath: '/curation/preview' });
        expect(featured(publishedHomeOf(source(), preview)).href).toBe('/curation/preview/work/fixture-a');
        expect(JSON.stringify(homeOf())).not.toContain(SENTINELS.alias);
    });

    it('carries the short statement as authored, and null when blank', () => {
        expect(featured(homeOf()).shortStatement).toBe('Fixture short statement A.');
        const blank = content();
        blank.series[1].shortStatement = '  ';
        expect(featured(homeOf(blank)).shortStatement).toBeNull();
    });
});

describe('the Home projection', () => {
    it('returns only the approved fields', () => {
        const series = featured(homeOf());
        expect(Object.keys(series).sort()).toEqual(['href', 'id', 'openingPhotoId', 'photos', 'shortStatement', 'slug', 'title']);
        for (const photo of series.photos) {
            expect(Object.keys(photo).sort()).toEqual(['alt', 'focalPoint', 'id', 'image']);
            expect(Object.keys(photo.image ?? {}).sort()).toEqual(photo.id === series.openingPhotoId ? ['height', 'lqip', 'variants', 'width'] : ['height', 'variants', 'width']);
        }
        const serialized = JSON.stringify(series);
        for (const sentinel of Object.values(SENTINELS)) expect(serialized).not.toContain(sentinel);
        expect(serialized).not.toMatch(/accent|caption|credit|location|technical|capturedAt|assetRevision|profileId|crop/);
    });

    it('takes the alt from the alt union: described text, else empty', () => {
        const held = content();
        const byId = new Map(featured(homeOf(held)).photos.map((photo) => [photo.id, photo.alt]));
        const described = held.photos.find((photo) => photo.id === P[0])?.alt;
        expect(described?.kind).toBe('described');
        expect(byId.get(P[0])).toBe(described?.kind === 'described' ? described.text : null);
        expect(byId.get(P[1])).toBe('');
    });

    it('never names a draft\'s pending or blank description', () => {
        const draft = structuredClone(catalog.content);
        const pending = draft.photos.find((photo) => photo.id === P[0]);
        const blank = draft.photos.find((photo) => photo.id === P[2]);
        if (!pending || !blank) throw new Error('Missing fixture photos');
        pending.alt = { kind: 'pending' };
        blank.alt = { kind: 'described', text: '   ' };
        const byId = new Map(featured(homeOf(draft)).photos.map((photo) => [photo.id, photo.alt]));
        expect([byId.get(P[0]), byId.get(P[2])]).toEqual(['', '']);
    });

    it('gives each photograph its #10 set, oriented, and the LQIP only to the opening one', () => {
        const held = content();
        for (const photo of featured(homeOf(held)).photos) {
            const record = held.photos.find((entry) => entry.id === photo.id);
            expect(photo.image).toEqual({ width: record?.width, height: record?.height, variants: ladder(photo.id), ...(photo.id === P[3] ? { lqip: record?.lqip } : {}) });
            for (const width of VARIANT_WIDTHS) for (const format of VARIANT_FORMATS) expect(photo.image?.variants[width][format].url).toMatch(new RegExp(`^/media/${photo.id}/`));
        }
    });

    it('copies the set and focal point, so a caller can\'t edit the revision through them', () => {
        const held = content();
        const series = featured(homeOf(held));
        const first = series.photos[0];
        if (!first.image) throw new Error('Expected an image');
        first.image.variants.w400.webp.url = '/elsewhere.webp';
        first.focalPoint.x = 0;
        expect(held.photos.find((photo) => photo.id === P[4])?.variants.w400.webp.url).not.toBe('/elsewhere.webp');
        expect(held.photos.find((photo) => photo.id === P[4])?.focalPoint).toEqual({ x: 0.2, y: 0.8 });
        expect(featured(homeOf(held)).photos[0].image?.variants.w400.webp.url).not.toBe('/elsewhere.webp');
    });

    it('takes the authored focal point, else the center', () => {
        const held = content();
        const bad = held.photos.find((photo) => photo.id === P[0]);
        if (!bad) throw new Error('Missing fixture photo');
        (bad as { focalPoint: unknown }).focalPoint = { x: 2, y: 0.5 };
        const byId = new Map(featured(homeOf(held)).photos.map((photo) => [photo.id, photo.focalPoint]));
        expect(byId.get(P[4])).toEqual({ x: 0.2, y: 0.8 });
        expect(byId.get(P[1])).toEqual({ x: 0.5, y: 0.5 });
        expect(byId.get(P[0])).toEqual({ x: 0.5, y: 0.5 });
    });

    it('keeps a focal point on either bound of either axis and centers one outside them', () => {
        const focalOf = (value: unknown) => {
            const held = content();
            const target = held.photos.find((photo) => photo.id === P[0]);
            if (!target) throw new Error('Missing fixture photo');
            (target as { focalPoint: unknown }).focalPoint = value;
            const photos = featured(homeOf(held)).photos;
            expect(photos.map((photo) => photo.id)).toEqual(ORDER_A);
            expect(photos.find((photo) => photo.id === P[4])?.focalPoint).toEqual({ x: 0.2, y: 0.8 });
            return photos.find((photo) => photo.id === P[0])?.focalPoint;
        };
        // The bounds are inclusive.
        expect(focalOf({ x: 0, y: 1 })).toEqual({ x: 0, y: 1 });
        expect(focalOf({ x: 1, y: 0 })).toEqual({ x: 1, y: 0 });
        const outside: [string, unknown][] = [
            ['x above 1', { x: 1.01, y: 0.5 }],
            ['x below 0', { x: -1, y: 0.5 }],
            ['y above 1', { x: 0.5, y: 7 }],
            ['y below 0', { x: 0.5, y: -0.1 }],
            ['x a numeric string', { x: '0.3', y: 0.5 }],
            ['y a numeric string', { x: 0.5, y: '0.3' }],
            ['x not finite', { x: Number.NaN, y: 0.5 }],
            ['null', null],
        ];
        for (const [name, value] of outside) expect(focalOf(value), name).toEqual({ x: 0.5, y: 0.5 });
    });

    it('shows a missing image, never another file, when a set isn\'t the photo\'s own /media set', () => {
        const cases: [string, (photo: RevisionContent['photos'][number]) => void][] = [
            ['an original', (photo) => (photo.variants.w1920.avif.url = '/photos/original.jpg')],
            ['another photo\'s set', (photo) => (photo.variants.w800.webp.url = ladder(P[5]).w800.webp.url)],
            ['a missing file', (photo) => delete (photo.variants.w1200 as Partial<typeof photo.variants.w1200>).avif],
            ['a missing width', (photo) => delete (photo.variants as Partial<typeof photo.variants>).w400],
            ['a bad file size', (photo) => (photo.variants.w400.webp.bytes = 0)],
            ['a bad asset revision', (photo) => (photo.assetRevision = 'sha256-nope')],
            ['a bad photo size', (photo) => (photo.width = 0)],
            ['a bad photo height', (photo) => (photo.height = 0)],
            ['a bad file width', (photo) => (photo.variants.w1200.webp.width = 0)],
            ['a bad file height', (photo) => (photo.variants.w1200.avif.height = 0)],
            ['a fractional file size', (photo) => (photo.variants.w400.avif.bytes = 1.5)],
            ['a fractional file width', (photo) => (photo.variants.w800.webp.width = 799.5)],
            ['its own file under another asset revision', (photo) => (photo.variants.w800.webp.url = mediaUrl({ photoId: photo.id, assetRevision: `sha256-${'f'.repeat(64)}`, profileId: photo.profileId }, 'w800', 'webp'))],
            ['its own file under another profile', (photo) => (photo.variants.w800.webp.url = mediaUrl({ photoId: photo.id, assetRevision: photo.assetRevision, profileId: `p_${'f'.repeat(16)}` }, 'w800', 'webp'))],
        ];
        for (const [name, damage] of cases) {
            const held = content();
            const target = held.photos.find((photo) => photo.id === P[1]);
            if (!target) throw new Error('Missing fixture photo');
            damage(target);
            const photos = featured(homeOf(held)).photos;
            expect(photos.map((photo) => photo.id), name).toEqual(ORDER_A);
            expect(photos.find((photo) => photo.id === P[1])?.image, name).toBeNull();
            expect(photos.filter((photo) => photo.image === null), name).toHaveLength(1);
        }
    });

    it('shows the opening photograph\'s set without an LQIP that isn\'t a WebP data URI', () => {
        const values: [string, string][] = [
            ['a trailing CSS injection', 'data:image/webp;base64,AAAA");background:url("/x'],
            ['a prefix before a valid data URI', '/x.png"),url("data:image/webp;base64,AAAA'],
            ['another image type', 'data:image/png;base64,AAAA'],
            ['a parenthesis in the base64', 'data:image/webp;base64,AA)AA'],
            ['a quote in the base64', "data:image/webp;base64,AA'AA"],
        ];
        for (const [name, lqip] of values) {
            const held = content();
            const opening = held.photos.find((photo) => photo.id === P[3]);
            if (!opening) throw new Error('Missing fixture photo');
            opening.lqip = lqip;
            const image = featured(homeOf(held)).photos.find((photo) => photo.id === P[3])?.image;
            expect(image?.variants, name).toEqual(ladder(P[3]));
            expect(image, name).not.toHaveProperty('lqip');
        }
    });
});

describe('the empty state', () => {
    it('is a null featured series on the served revision when nothing is featured', () => {
        const held = content();
        held.site.featuredSeriesIds = [];
        expect(homeOf(held, REVISION_B)).toEqual({ catalogRevision: REVISION_B, featuredSeries: null });
    });

    it('is a null featured series when no featured entry is held', () => {
        const held = content();
        held.site.featuredSeriesIds = ['ser_fixture-draft', 'ser_unknown'];
        expect(homeOf(held)).toEqual({ catalogRevision: REVISION_A, featuredSeries: null });
    });

    it('is a null featured series when the featured series has no photograph that resolves, without falling through to the next', () => {
        const held = content();
        held.series[1].photoIds = [P[9], P[7]];
        expect(homeOf(held)).toEqual({ catalogRevision: REVISION_A, featuredSeries: null });
    });

    it('is a null featured series for a revision with no series', () => {
        const held = content();
        held.series = [];
        held.photos = [];
        expect(homeOf(held)).toEqual({ catalogRevision: REVISION_A, featuredSeries: null });
    });
});

describe('catalog revision consistency', () => {
    it('answers from one reader\'s content, so two revisions never mix', () => {
        const a = content();
        const b = structuredClone(a);
        // Revision B reorders A, opens it elsewhere, renames it, and moves P[1] to series B.
        b.series[1].photoIds = [P[0], P[2], P[3], P[4]];
        b.series[1].openingPhotoId = P[2];
        b.series[1].title = 'Fixture series A, renamed';
        b.series[0].photoIds = [P[5], P[6], P[1]];
        const readerA = createCatalogReader(a, { revisionId: REVISION_A, revisionNumber: 3 });
        const readerB = createCatalogReader(b, { revisionId: REVISION_B, revisionNumber: 4 });
        const at = (reader: typeof readerA) => {
            const result = homeRouteOf({ mode: 'catalog', state: 'ok', reader }, routes);
            if (result.kind !== 'home') throw new Error(`Expected Home, got ${result.kind}`);
            return result.home;
        };

        const fromA = at(readerA);
        const fromB = at(readerB);
        expect([fromA.catalogRevision, featured(fromA).title, featured(fromA).openingPhotoId, featured(fromA).photos.map((photo) => photo.id)]).toEqual([REVISION_A, 'Fixture series A', P[3], ORDER_A]);
        expect([fromB.catalogRevision, featured(fromB).title, featured(fromB).openingPhotoId, featured(fromB).photos.map((photo) => photo.id)]).toEqual([REVISION_B, 'Fixture series A, renamed', P[2], [P[0], P[2], P[3], P[4]]]);
        // Reading B didn't change what A answers.
        expect(at(readerA)).toEqual(fromA);
    });
});

describe('homeRouteOf, the cutover gate', () => {
    /** A reader that fails the test if anything reads it. */
    const trap = (): HomeActiveCatalog & { mode: 'catalog'; state: 'ok' } => {
        const fail = () => {
            throw new Error('The catalog was read');
        };
        return { mode: 'catalog', state: 'ok', reader: { revision: fail, site: fail, listSeries: fail, photosOf: fail } };
    };

    it('renders today\'s Home only in legacy mode', () => {
        expect(homeRouteOf({ mode: 'legacy' }, routes)).toEqual({ kind: 'legacy' });
    });

    it('reports an unavailable catalog for the page to throw, never the legacy Home', () => {
        for (const reason of ['catalog-unreadable', 'active-unreadable', 'revision-unreadable'] as const) {
            const catalog: HomeActiveCatalog<typeof reason> = { mode: 'catalog', state: 'unavailable', reason };
            expect(homeRouteOf(catalog, routes)).toEqual({ kind: 'unavailable', reason });
        }
    });

    it('renders the catalog Home from the served revision, ok or degraded', () => {
        const reader = createCatalogReader(content(), { revisionId: REVISION_A, revisionNumber: 3 });
        for (const state of ['ok', 'degraded'] as const) {
            const result = homeRouteOf({ mode: 'catalog', state, reader }, routes);
            expect(result).toEqual({ kind: 'home', home: homeOf() });
        }
    });

    it('renders the catalog Home\'s empty state, not the legacy one, when nothing is featured', () => {
        const held = content();
        held.site.featuredSeriesIds = [];
        const reader = createCatalogReader(held, { revisionId: REVISION_A, revisionNumber: 3 });
        expect(homeRouteOf({ mode: 'catalog', state: 'ok', reader }, routes)).toEqual({ kind: 'home', home: { catalogRevision: REVISION_A, featuredSeries: null } });
    });

    it('reads the revision ID from the reader itself', () => {
        const reader = createCatalogReader(content(), { revisionId: REVISION_B, revisionNumber: 9 });
        const result = homeRouteOf({ mode: 'catalog', state: 'degraded', reader }, routes);
        expect(result.kind === 'home' && result.home.catalogRevision).toBe(REVISION_B);
    });

    it('reads a reader whose methods need their this', () => {
        const inner = createCatalogReader(content(), { revisionId: REVISION_A, revisionNumber: 3 });
        class Reader {
            constructor(private readonly of: typeof inner) {}
            revision() {
                return this.of.revision();
            }
            site() {
                return this.of.site();
            }
            listSeries() {
                return this.of.listSeries();
            }
            photosOf(seriesId: string) {
                return this.of.photosOf(seriesId);
            }
        }
        expect(homeRouteOf({ mode: 'catalog', state: 'ok', reader: new Reader(inner) }, routes)).toEqual({ kind: 'home', home: homeOf() });
    });

    it('builds the link with the routes it\'s handed', () => {
        const reader = createCatalogReader(content(), { revisionId: REVISION_A, revisionNumber: 3 });
        const result = homeRouteOf({ mode: 'catalog', state: 'ok', reader }, createRouteBuilder({ basePath: '/curation/preview' }));
        expect(result.kind === 'home' && result.home.featuredSeries?.href).toBe('/curation/preview/work/fixture-a');
    });

    it('reads no reader in legacy mode or while the catalog is unavailable', () => {
        const { reader } = trap();
        expect(() => homeRouteOf(trap(), routes)).toThrow('The catalog was read');
        expect(homeRouteOf({ mode: 'legacy', reader } as unknown as HomeActiveCatalog, routes)).toEqual({ kind: 'legacy' });
        const unavailable = { mode: 'catalog', state: 'unavailable', reason: 'revision-unreadable', reader } as unknown as HomeActiveCatalog;
        expect(homeRouteOf(unavailable, routes)).toEqual({ kind: 'unavailable', reason: 'revision-unreadable' });
    });
});

describe('Home on published revisions', { timeout: 60_000 }, () => {
    it('stays on the active revision until a publish replaces it, whatever the working layer does', async () => {
        const published = await createTestCatalog({ variantBytes: VARIANT_BYTES, seed: 14, photos: 4, series: [{ slug: 'fixture-a', photos: 3 }, { slug: 'fixture-b' }] });
        cleanups.push(() => published.cleanup());
        const root = published.root;
        const logger = { log: () => undefined };
        vi.resetModules();
        const { loadActiveCatalog } = await import('../public-reader');
        const homeAt = async () => homeRouteOf(await loadActiveCatalog(root), routes);
        const authored = published.series[0].photoIds;

        expect(await homeAt()).toEqual({ kind: 'legacy' });

        const one = await publish({ dataRoot: root, actor: 'test', confirmLaunch: true, logger });
        expect(one.outcome).toBe('PUBLISHED');
        const atOne = await homeAt();
        if (atOne.kind !== 'home') throw new Error(`Expected Home, got ${atOne.kind}`);
        expect([atOne.home.catalogRevision, featured(atOne.home).photos.map((photo) => photo.id), featured(atOne.home).openingPhotoId]).toEqual([one.revisionId, authored, authored[0]]);

        // A new order in the working layer changes nothing until it's published.
        const record = (await readWorkingLayer(root)).series.find((series) => series.id === published.series[0].id);
        if (!record) throw new Error('The featured series has no record');
        const reordered = [...authored].reverse();
        await writeAuthoredRecord({ ...structuredClone(record), photoIds: reordered, openingPhotoId: reordered[1] }, { expectedVersion: record.version, root });
        expect(await homeAt()).toEqual(atOne);

        const two = await publish({ dataRoot: root, actor: 'test', confirmLaunch: true, logger });
        expect(two.outcome).toBe('PUBLISHED');
        expect(two.revisionId).not.toBe(one.revisionId);
        const atTwo = await homeAt();
        if (atTwo.kind !== 'home') throw new Error(`Expected Home, got ${atTwo.kind}`);
        expect([atTwo.home.catalogRevision, featured(atTwo.home).photos.map((photo) => photo.id), featured(atTwo.home).openingPhotoId]).toEqual([two.revisionId, reordered, reordered[1]]);
    });
});
