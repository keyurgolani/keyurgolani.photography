// @vitest-environment node
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { homePhotosFrom, homeRouteOf, type HomeActiveCatalog } from '../projections/home';
import { createCatalogReader, createRouteBuilder, type CatalogContent, type CatalogReader, type RouteBuilder } from '../reader';
import { buildTestCatalog, type TestCatalogContent } from '../testing';
import type { RevisionContent } from '../types';

// The bytes every screen projection serializes, pinned. Visitors get these
// objects as JSON (props and API bodies), so key order and every value
// count, not only what toEqual() compares. The fixture walks each guard:
// canonical and former slugs, a continuation page, chapters, covers, a
// pending description, and hand-written revisions with a broken set, a bad
// LQIP or focal point, a repeated series ID, a zero count, and a slug the
// route refuses. A pure refactor of lib/catalog/projections keeps every hash.
// A change that means to move a screen's output updates the hash here, and
// its PR says which screen moved and why.

const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LONG = Array.from({ length: 103 }, (_, n) => id(n + 1));
const SHORT = Array.from({ length: 4 }, (_, n) => id(n + 201));
const DRAFT = [id(301)];
const REVISION = `rev_${'c'.repeat(64)}`;
const PROFILE = 'p_00000000000000a1';
const publicRoutes = createRouteBuilder();
const previewRoutes = createRouteBuilder({ basePath: '/preview/fixture' });

let fixture: TestCatalogContent;

beforeAll(async () => {
    fixture = await buildTestCatalog({
        seed: 91,
        profileId: PROFILE,
        photos: [
            {
                id: LONG[0],
                title: 'Pinned title one',
                caption: 'Pinned caption one.',
                accent: '#c08040',
                location: 'Pinned location one',
                capturedAt: '2022-05-06',
                focalPoint: { x: 0.25, y: 0.75 },
                crop: 'contain',
                technical: { ISO: '200', Model: 'Pinned Model', FNumber: '2.8', Make: 'Pinned Make' },
            },
            { id: LONG[1], alt: { kind: 'decorative' }, location: '  Pinned location two  ' },
            { id: LONG[2], alt: null },
            { id: LONG[3], capturedDate: null, technical: {} },
            ...LONG.slice(4).map((photoId) => ({ id: photoId })),
            ...SHORT.map((photoId, n) => ({ id: photoId, title: `Pinned short ${n + 1}` })),
            { id: DRAFT[0] },
        ],
        series: [
            {
                id: 'ser_pinned-long',
                slug: 'pinned-long',
                slugAliases: ['old-pinned-long'],
                title: 'Pinned long series',
                shortStatement: 'Pinned short statement.',
                statement: 'Pinned statement, first.\n\n  Second <b>paragraph</b>.  ',
                accent: '#a0b0c0',
                photoIds: [LONG[3], LONG[0], LONG[2], LONG[1], ...LONG.slice(4)],
                openingPhotoId: LONG[2],
                cover: { photoId: LONG[0], focalPoint: { x: 0.4, y: 0.6 } },
                chapters: [
                    { id: 'ch-one', title: 'Pinned chapter one', startPhotoId: LONG[2] },
                    { id: 'ch-two', title: 'Pinned chapter two', startPhotoId: LONG[101] },
                ],
            },
            { id: 'ser_pinned-short', slug: 'pinned-short', title: 'Pinned short series', photoIds: SHORT, cover: { photoId: SHORT[1] } },
            { id: 'ser_pinned-draft', slug: 'pinned-draft', photoIds: DRAFT, visibility: 'draft' },
        ],
        featuredSeriesIds: ['ser_pinned-long', 'ser_pinned-short'],
    });
}, 60_000);

/** The candidate as a published revision holds it: the pending photo described. */
function revisionContent(): RevisionContent {
    const content = structuredClone(fixture.content);
    for (const photo of content.photos) if (photo.alt.kind === 'pending') photo.alt = { kind: 'described', text: 'Pinned description, reviewed.' };
    return content as RevisionContent;
}

function photoIn(content: CatalogContent, photoId: string) {
    const photo = content.photos.find((entry) => entry.id === photoId);
    if (!photo) throw new Error(`No ${photoId}`);
    return photo;
}

/** Hand-written revisions, each reaching a guard compile never trips. */
const HAND_WRITTEN: Record<string, (content: CatalogContent) => void> = {
    'broken sets and bad fields': (content) => {
        photoIn(content, LONG[0]).lqip = 'data:image/png;base64,AAAA';
        photoIn(content, LONG[2]).variants.w800.webp.url = '/assets/photos/elsewhere.webp';
        photoIn(content, LONG[3]).width = 0;
        (photoIn(content, LONG[1]) as { focalPoint: unknown }).focalPoint = { x: 2, y: 0.5 };
        (photoIn(content, SHORT[0]).variants.w1200.avif as { bytes: unknown }).bytes = 1.5;
        content.series[1].cover = { photoId: LONG[5] };
    },
    'a repeated series ID': (content) => {
        content.series.push({ ...structuredClone(content.series[0]), slug: 'pinned-long-again', slugAliases: [] });
    },
    'a zero count': (content) => {
        content.series[0].derived.photoCount = 0;
    },
    'a slug the route refuses': (content) => {
        content.series[0].slug = 'Pinned-Long';
    },
    'no member that resolves': (content) => {
        content.series[1].photoIds = [DRAFT[0]];
    },
};

function contents(): [string, CatalogContent][] {
    const cases: [string, CatalogContent][] = [['revision', revisionContent()], ['candidate', structuredClone(fixture.content)]];
    for (const [name, edit] of Object.entries(HAND_WRITTEN)) {
        const content = revisionContent();
        edit(content);
        cases.push([name, content]);
    }
    return cases;
}

function slugsOf(content: CatalogContent): string[] {
    return [...content.series.flatMap((series) => [series.slug, ...series.slugAliases]), 'pinned-unknown', 'Pinned-Long', 'pinned-long-again'];
}

function photoIdsOf(content: CatalogContent): string[] {
    return [...content.photos.map((photo) => photo.id), DRAFT[0], id(999)];
}

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function served(reader: CatalogReader): HomeActiveCatalog & { mode: 'catalog' } {
    return { mode: 'catalog', state: 'ok', reader };
}

async function screens(routes: RouteBuilder): Promise<Record<string, unknown[]>> {
    const out: Record<string, unknown[]> = { home: [], homePhotos: [], work: [], series: [], continuation: [], viewer: [] };
    for (const [name, content] of contents()) {
        const reader = createCatalogReader(content, { revisionId: REVISION, revisionNumber: 4 });
        out.home.push([name, homeRouteOf(served(reader), routes)]);
        for (const photoId of photoIdsOf(content)) out.homePhotos.push([name, photoId, await homePhotosFrom(async () => served(reader), photoId, REVISION)]);
        out.work.push([name, reader.getWorkSummaries(routes)]);
        for (const slug of slugsOf(content)) {
            const page = reader.getSeriesPage(slug, routes);
            out.series.push([name, slug, page]);
            let next = page.kind === 'ok' ? page.page.nextHref : null;
            while (next !== null) {
                const cursor = next.slice(next.lastIndexOf('/') + 1);
                const continued = reader.getSeriesContinuation(slug, cursor, routes);
                out.continuation.push([name, slug, cursor, continued]);
                next = continued.kind === 'ok' ? continued.page.nextHref : null;
            }
            for (const photoId of photoIdsOf(content)) out.viewer.push([name, slug, photoId, reader.getViewerPhoto(slug, photoId)]);
        }
    }
    return out;
}

describe('every screen projection serializes byte for byte as pinned', () => {
    it('on the public routes', async () => {
        const out = await screens(publicRoutes);
        expect(Object.fromEntries(Object.entries(out).map(([screen, values]) => [screen, sha256(values)]))).toEqual({
            home: '189b7bb2eba044af63dff21f590c52634b08b3b0179b3beb568eee1586439ca9',
            homePhotos: '8f69315859b0700845222df618546e45c05d7be6c5c7e909af128a184f377a67',
            work: 'e87f9f9531d894505ef0d31df859b27a0bc38e95d7aa86a7d3b711199b637be3',
            series: 'f4d331e31151bd9c2fe789acea02a746c5fcb026309e762287396071c0627123',
            continuation: '85b8afb6bc10a95477fff9b2cbb7c938de4b1a1ab793d2dc402754f4ddb237b0',
            viewer: '1136163489bec2b4359e954545cbf835bb912d34314de30d0a8bba15239be96b',
        });
    });

    it('on a preview route builder', async () => {
        const out = await screens(previewRoutes);
        expect(Object.fromEntries(Object.entries(out).map(([screen, values]) => [screen, sha256(values)]))).toEqual({
            home: 'f845063265e99c501e1b34aec4a5a11bf328956c557309bddd3efc3ec49f0abc',
            homePhotos: '8f69315859b0700845222df618546e45c05d7be6c5c7e909af128a184f377a67',
            work: '97961e986a7d4bea8bc005f8681ac88436337e467112928a0c29e0185c23a569',
            // 16-2: a series page's continuation path comes from the route builder, so a preview's points at its own mirror.
            series: '1e5733d2c9fd8d57a584d21e0eb63cb8fd73f8733a39380e4915b02ce3a88dde',
            continuation: '6abcadfe8b9f3d40f2e35a6aa155a069cee65838c5447d499904cbc68bf09b6f',
            viewer: '1136163489bec2b4359e954545cbf835bb912d34314de30d0a8bba15239be96b',
        });
    });

    // 16-2: a public page's continuation names the public endpoint, a preview's names the preview's mirror of it.
    it("points a series page's continuation at the builder's own catalog endpoint", async () => {
        const nextOf = (out: Record<string, unknown[]>) =>
            out.series.map((entry) => ((entry as unknown[]).at(-1) as { kind: string; page?: { nextHref: string | null } }).page?.nextHref ?? null).filter((href): href is string => href !== null);
        const [pub, pre] = [nextOf(await screens(publicRoutes)), nextOf(await screens(previewRoutes))];
        expect(pub.length).toBeGreaterThan(0);
        expect(pub.every((href) => href.startsWith('/api/catalog/series/'))).toBe(true);
        expect(pre).toEqual(pub.map((href) => `/preview/fixture${href}`));
    });

    it('walks every kind of answer, so the pins cover each guard', async () => {
        const out = await screens(publicRoutes);
        const kinds = (values: unknown[]) => new Set(values.map((entry) => ((entry as unknown[]).at(-1) as { kind: string }).kind));
        expect(kinds(out.home)).toEqual(new Set(['home']));
        expect(out.home.some((entry) => ((entry as unknown[])[1] as { home: { featuredSeries: unknown } }).home.featuredSeries === null)).toBe(true);
        expect(kinds(out.homePhotos)).toEqual(new Set(['ok', 'not-found']));
        expect(kinds(out.series)).toEqual(new Set(['ok', 'redirect', 'not-found']));
        expect(kinds(out.continuation)).toEqual(new Set(['ok']));
        expect(kinds(out.viewer)).toEqual(new Set(['ok', 'redirect', 'not-found']));
        const json = JSON.stringify(out);
        for (const fragment of ['"image":null', '"cover":null', '"lqip":"data:image/webp', '"descriptionPending":true', '"startPosition":102', '"featuredSeries":null']) {
            expect(json, fragment).toContain(fragment);
        }
    });
});
