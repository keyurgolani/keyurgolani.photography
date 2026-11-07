// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveCatalog } from '@/lib/catalog/public-reader';
import { createCatalogReader } from '@/lib/catalog/reader';
import { createTestCatalog, type TestCatalog } from '@/lib/catalog/testing';
import type { CandidateContent } from '@/lib/catalog/types';

// The Viewer route (#7): viewerPhotoFrom() with getActiveCatalog() and
// publicRoutes, answered as a render, a 308, the public not-found, or a throw
// to app/error.tsx, and its share metadata.

const state = vi.hoisted(() => ({ catalog: null as unknown }));

/** What Next's permanentRedirect() throws, reduced to the facts the tests read. */
class Redirected extends Error {
    constructor(readonly location: string) {
        super(`308 ${location}`);
    }
}
class NotFound extends Error {}

vi.mock('next/navigation', () => ({
    permanentRedirect: (location: string) => {
        throw new Redirected(location);
    },
    notFound: () => {
        throw new NotFound('not found');
    },
}));

vi.mock('@/lib/catalog/public-reader', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/catalog/public-reader')>();
    return { ...actual, getActiveCatalog: async () => state.catalog };
});

const route = await import('../work/[slug]/photo/[photoId]/page');
const { default: ViewerRoute, generateMetadata } = route;
const { CatalogUnavailableError } = await import('@/lib/catalog/public-reader');

const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = Array.from({ length: 6 }, (_, n) => id(n + 1));

/** Strings only unpublished records and fields outside the Viewer's allowlist carry. */
const SENTINELS = [
    'SENTINEL draft title',
    'SENTINEL hidden title',
    'SENTINEL location',
    'SENTINEL credit',
    'SENTINEL statement',
    'sentinel-old-slug',
    'private/SENTINEL-source.jpg',
    'SENTINEL chapter',
    '2019-07-08',
    // The draft and hidden series' photos, and their IDs.
    P[4],
    P[5],
    'ser_route-draft',
    'ser_route-hidden',
];

let catalog: TestCatalog;

beforeAll(async () => {
    catalog = await createTestCatalog({
        seed: 77,
        photos: [
            {
                id: P[0],
                title: 'Route title one',
                caption: 'Route caption one.',
                alt: { kind: 'described', text: 'Route description one.', reviewed: true },
                accent: '#c08040',
                location: 'SENTINEL location',
                credit: 'SENTINEL credit',
                capturedAt: '2019-07-08',
                sourcePath: 'private/SENTINEL-source.jpg',
                technical: { Make: 'Route Make', Model: 'Route Model', ISO: '400' },
            },
            { id: P[1], alt: { kind: 'decorative' } },
            { id: P[2], technical: {} },
            { id: P[3] },
            { id: P[4], title: 'SENTINEL draft title' },
            { id: P[5], title: 'SENTINEL hidden title' },
        ],
        series: [
            {
                id: 'ser_route-a',
                slug: 'route-a',
                title: 'Route A',
                statement: 'SENTINEL statement',
                slugAliases: ['sentinel-old-slug'],
                accent: '#a0b0c0',
                chapters: [{ id: 'chapter-one', title: 'SENTINEL chapter', startPhotoId: P[0] }],
                photoIds: [P[0], P[1], P[2]],
            },
            { id: 'ser_route-b', slug: 'route-b', title: 'Route B', photoIds: [P[3]] },
            { id: 'ser_route-draft', slug: 'route-draft', title: 'SENTINEL draft title', photoIds: [P[4]], visibility: 'draft' },
            { id: 'ser_route-hidden', slug: 'route-hidden', title: 'SENTINEL hidden title', photoIds: [P[5]], visibility: 'hidden' },
        ],
    });
});

afterAll(async () => {
    await catalog?.cleanup();
});

const served = (servedState: 'ok' | 'degraded', content: CandidateContent = catalog.content): ActiveCatalog =>
    ({
        state: servedState,
        reader: createCatalogReader(content, { revisionId: catalog.revisionId, revisionNumber: 1 }),
        active: { revisionId: catalog.revisionId, revisionNumber: 1, activationId: 'act_fixture', activatedAt: null },
    }) as unknown as ActiveCatalog;

type Query = Record<string, string | string[] | undefined>;
const props = (slug: string, photoId: string, query: Query = {}) => ({ params: Promise.resolve({ slug, photoId }), searchParams: Promise.resolve(query) });

async function answer(slug: string, photoId: string, query: Query = {}): Promise<{ html: string } | { redirect: string } | { notFound: true } | { thrown: unknown }> {
    try {
        return { html: renderToStaticMarkup(await ViewerRoute(props(slug, photoId, query))) };
    } catch (error) {
        if (error instanceof Redirected) return { redirect: error.location };
        if (error instanceof NotFound) return { notFound: true };
        return { thrown: error };
    }
}

function html(result: Awaited<ReturnType<typeof answer>>): string {
    if (!('html' in result)) throw new Error(`Expected a render, got ${JSON.stringify(result)}`);
    return result.html;
}

const SITE_URL = process.env.SITE_URL;

beforeEach(() => {
    state.catalog = served('ok');
    delete process.env.SITE_URL;
});

afterEach(() => {
    if (SITE_URL === undefined) delete process.env.SITE_URL;
    else process.env.SITE_URL = SITE_URL;
});

describe('the Viewer route', () => {
    it('renders per request, with nothing that would freeze it at build', () => {
        expect(route.dynamic).toBe('force-dynamic');
        expect(Object.keys(route).sort()).toEqual(['default', 'dynamic', 'generateMetadata']);
    });

    it('renders the canonical URL as the Viewer on its own surface, with no SiteNav', async () => {
        const page = html(await answer('route-a', P[0]));
        expect(page.match(/data-surface="viewer"/g)).toHaveLength(1);
        expect(page).not.toContain('aria-label="Primary"');
        // "{series title}, photograph 1 of 3" (#7), with the padded numbers for the eye only.
        expect(page).toMatch(/<h1[^>]*aria-label="Route A, photograph 1 of 3"[^>]*><span aria-hidden="true">Route A<\/span><\/h1>/);
        expect(page).toMatch(/<span aria-hidden="true">01 \/ 03<\/span>/);
        // With a caption the reading area shows only the caption, and the image's alt says the description.
        expect(page).toMatch(/<img[^>]*alt="Route description one\."/);
        expect(page).not.toMatch(/>Route description one\.</);
        expect(page).toMatch(/<h2[^>]*>Route title one<\/h2>/);
        expect(page).toContain('Route caption one.');
        expect(page).toContain('Route description one.');
        // Close goes back to this photograph in its series (B5): seriesHref(slug, { focusPhotoId }).
        expect(page).toContain(`href="/work/route-a?photo=${P[0]}"`);
        expect(page).not.toContain('href="/work/route-a"');
        expect(page).toContain(`href="/work/route-a/photo/${P[1]}"`);
        expect(page).toContain('--cc-accent:#c08040');
        // The camera facts ship collapsed.
        expect(page).toMatch(/aria-expanded="false"[^>]*>.*Show technical details/);
        expect(page).toMatch(/<div[^>]*hidden=""[^>]*>.*Route Model/);
        expect(page).toMatch(/<img[^>]*src="\/media\/[^"]+\/w1200\.webp"/);
    });

    it('names the photograph shown in Close\'s link at every position (B5)', async () => {
        for (const photoId of [P[1], P[2]]) expect(html(await answer('route-a', photoId)), photoId).toContain(`href="/work/route-a?photo=${photoId}"`);
    });

    it('passes the pending copy only for a pending description, never for a decorative photo', async () => {
        const decorative = html(await answer('route-a', P[1]));
        expect(decorative).toMatch(/<img[^>]*alt=""/);
        expect(decorative).not.toContain('Description pending editorial review');
        expect(decorative).not.toMatch(/>Description</);
        expect(html(await answer('route-a', P[0]))).not.toContain('Description pending editorial review');
    });

    it('serves a degraded catalog\'s revision the same way', async () => {
        state.catalog = served('degraded');
        expect(html(await answer('route-a', P[2]))).toContain('03 / 03');
    });

    it('stops at the ends of the series, with each end a focusable button marked aria-disabled', async () => {
        // The server's form, before the shell takes the controls over: a direction with a photograph is a link, an end a button (#9).
        const end = (step: string) => new RegExp(`<button(?=[^>]*aria-label="${step} photograph")(?=[^>]*aria-disabled="true")(?![^>]*disabled="")[^>]*>`);
        const link = (step: string) => new RegExp(`<a[^>]*aria-label="${step} photograph"`);
        const first = html(await answer('route-a', P[0]));
        expect(first).toMatch(end('Previous'));
        expect(first).toMatch(link('Next'));
        const last = html(await answer('route-a', P[2]));
        expect(last).toMatch(link('Previous'));
        expect(last).toMatch(end('Next'));
        const only = html(await answer('route-b', P[3]));
        expect(only).toContain('01 / 01');
        expect(only).toMatch(end('Previous'));
        expect(only).toMatch(end('Next'));
        expect(only).not.toMatch(/<a[^>]*aria-label="(Previous|Next) photograph"/);
    });

    it('keeps everything outside the Viewer\'s allowlist out of the HTML', async () => {
        const pages = await Promise.all([P[0], P[1], P[2]].map(async (photoId) => html(await answer('route-a', photoId))));
        for (const page of pages) {
            for (const sentinel of SENTINELS) expect(page, sentinel).not.toContain(sentinel);
            expect(page).not.toMatch(/_next\/image|api\/image/);
        }
    });

    it('renders a photo whose set fails the /media check without its image, never not-found', async () => {
        const broken = structuredClone(catalog.content);
        const photo = broken.photos.find((entry) => entry.id === P[1]);
        if (!photo) throw new Error('Missing fixture photo');
        photo.variants.w800.avif.url = '/library/private/SENTINEL-broken.jpg';
        photo.caption = 'Route caption two.';
        state.catalog = served('ok', broken);
        const page = html(await answer('route-a', P[1]));
        expect(page).toContain('02 / 03');
        expect(page).toContain('Route caption two.');
        expect(page).toMatch(new RegExp(`<a(?=[^>]*aria-label="Previous photograph")(?=[^>]*href="/work/route-a/photo/${P[0]}")`));
        expect(page).toMatch(new RegExp(`<a(?=[^>]*aria-label="Next photograph")(?=[^>]*href="/work/route-a/photo/${P[2]}")`));
        expect(page).toMatch(/data-photo="unavailable"[^>]*>.*Photograph unavailable/);
        // Zoom is unavailable but stays focusable (#9).
        expect(page).toMatch(/<button[^>]*aria-disabled="true"[^>]*>(?:(?!<\/button>).)*Zoom/);
        expect(page).not.toMatch(/<img|<picture|\/media\/|SENTINEL-broken/);
        // A prior slug still 308s to it, and its share metadata has no image.
        expect(await answer('sentinel-old-slug', P[1])).toEqual({ redirect: `/work/route-a/photo/${P[1]}` });
        process.env.SITE_URL = 'https://photos.example.test';
        expect(await generateMetadata(props('route-a', P[1]))).toEqual({
            title: 'Route A, photograph 2 of 3',
            description: 'Route caption two.',
            alternates: { canonical: `/work/route-a/photo/${P[1]}` },
            // The revision the page came from, for #12's freshness checks.
            other: { 'catalog-revision': catalog.revisionId },
            openGraph: { siteName: 'Keyur Golani Photography', type: 'website', url: `/work/route-a/photo/${P[1]}` },
        });
    });

    it('answers a former series slug 308 to the canonical URL', async () => {
        expect(await answer('sentinel-old-slug', P[1])).toEqual({ redirect: `/work/route-a/photo/${P[1]}` });
    });

    it.each([
        ['an uppercase slug', 'Route-A', P[0], `/work/route-a/photo/${P[0]}`],
        ['an uppercase photo ID', 'route-a', P[0].toUpperCase(), `/work/route-a/photo/${P[0]}`],
        ['an uppercase former slug', 'SENTINEL-OLD-SLUG', P[1], `/work/route-a/photo/${P[1]}`],
        ['a photo moved to another series', 'route-b', P[0], `/work/route-a/photo/${P[0]}`],
        ['a photo moved, under a former slug', 'sentinel-old-slug', P[3], `/work/route-b/photo/${P[3]}`],
        ['a photo moved, under an uppercase slug', 'Route-A', P[3], `/work/route-b/photo/${P[3]}`],
        ['a published photo, under an unknown slug', 'no-such-series', P[0], `/work/route-a/photo/${P[0]}`],
        ['a published photo, under a draft series\' slug', 'route-draft', P[0], `/work/route-a/photo/${P[0]}`],
        ['a published photo, under a hidden series\' slug', 'route-hidden', P[3], `/work/route-b/photo/${P[3]}`],
    ])('answers %s 308 to the canonical URL (#7, decided)', async (_name, slug, photoId, location) => {
        expect(await answer(slug, photoId)).toEqual({ redirect: location });
        expect(await generateMetadata(props(slug, photoId))).toEqual({});
    });

    it('keeps the query on every redirect, re-encoded after the canonical path', async () => {
        const query = { utm_source: 'mail', tag: ['one', 'two'] };
        for (const [slug, photoId, path] of [
            ['sentinel-old-slug', P[1], `/work/route-a/photo/${P[1]}`],
            ['Route-A', P[0], `/work/route-a/photo/${P[0]}`],
            ['route-b', P[0], `/work/route-a/photo/${P[0]}`],
        ]) {
            expect(await answer(slug, photoId, query), `${slug} ${photoId}`).toEqual({ redirect: `${path}?utm_source=mail&tag=one&tag=two` });
        }
    });

    it('builds the Location from the canonical path only, and it never loops', async () => {
        const result = await answer('Route-B', P[0], { next: '//evil.example/x' });
        if (!('redirect' in result)) throw new Error(`Expected a redirect, got ${JSON.stringify(result)}`);
        expect(result.redirect).toBe(`/work/route-a/photo/${P[0]}?next=%2F%2Fevil.example%2Fx`);
        const target = new URL(result.redirect, 'https://photos.example.test');
        expect(target.origin).toBe('https://photos.example.test');
        const [, , slug, , photoId] = target.pathname.split('/');
        expect('html' in (await answer(slug, photoId, Object.fromEntries(target.searchParams)))).toBe(true);
    });

    it('answers the one not-found for anything it can\'t serve', async () => {
        const cases: [string, string][] = [
            ['route-a', P[4]],
            ['route-draft', P[4]],
            ['route-hidden', P[5]],
            ['route-a', id(99)],
            ['no-such-series', P[4]],
            ['Route-Draft', P[4]],
            ['route-a', id(99).toUpperCase()],
            ['..', P[0]],
            ['route-a', 'IMG_0001.jpg'],
            ['Route--A', P[0]],
        ];
        for (const [slug, photoId] of cases) expect(await answer(slug, photoId), `${slug} ${photoId}`).toEqual({ notFound: true });
    });

    it('throws CatalogUnavailableError while the catalog is unavailable, nothing published included, so the error page answers', async () => {
        for (const reason of ['revision-unreadable', 'not-published'] as const) {
            state.catalog = { state: 'unavailable', reason } satisfies ActiveCatalog;
            const result = await answer('route-a', P[0]);
            expect('thrown' in result && result.thrown, reason).toBeInstanceOf(CatalogUnavailableError);
            expect(await generateMetadata(props('route-a', P[0]))).toEqual({});
        }
    });
});

describe('the Viewer\'s share metadata', () => {
    it('titles and describes the photo from authored copy, with the canonical URL and the 1200 px WebP on SITE_URL', async () => {
        process.env.SITE_URL = 'https://photos.example.test';
        const metadata = await generateMetadata(props('route-a', P[0]));
        const record = catalog.content.photos.find((photo) => photo.id === P[0]);
        const share = record?.variants.w1200.webp;
        expect(metadata).toEqual({
            title: 'Route title one, Route A',
            description: 'Route caption one.',
            alternates: { canonical: `/work/route-a/photo/${P[0]}` },
            // The revision the page came from, for #12's freshness checks.
            other: { 'catalog-revision': catalog.revisionId },
            openGraph: {
                siteName: 'Keyur Golani Photography',
                type: 'website',
                url: `/work/route-a/photo/${P[0]}`,
                images: [{ url: share?.url, width: share?.width, height: share?.height, alt: 'Route description one.' }],
            },
        });
        expect(share?.url).toMatch(/^\/media\/.+\/w1200\.webp$/);
    });

    it('falls back to the series and position, and leaves out an empty alt', async () => {
        process.env.SITE_URL = 'https://photos.example.test';
        const metadata = await generateMetadata(props('route-a', P[1]));
        expect(metadata.title).toBe('Route A, photograph 2 of 3');
        expect(metadata).not.toHaveProperty('description');
        const images = (metadata.openGraph as { images: Record<string, unknown>[] }).images;
        expect(images[0]).not.toHaveProperty('alt');
    });

    it('leaves out the canonical URL, og:url, and the share image without a valid SITE_URL', async () => {
        for (const value of [undefined, 'not a url', 'https://photos.example.test/path']) {
            if (value === undefined) delete process.env.SITE_URL;
            else process.env.SITE_URL = value;
            const metadata = await generateMetadata(props('route-a', P[0]));
            expect(metadata, String(value)).toEqual({
                title: 'Route title one, Route A',
                description: 'Route caption one.',
                // The revision the page came from, for #12's freshness checks.
                other: { 'catalog-revision': catalog.revisionId },
                openGraph: { siteName: 'Keyur Golani Photography', type: 'website' },
            });
        }
    });

    it('gives every answer but a render no metadata of its own', async () => {
        process.env.SITE_URL = 'https://photos.example.test';
        for (const [slug, photoId] of [['route-a', P[3]], ['sentinel-old-slug', P[1]], ['route-draft', P[4]], ['Route-A', P[0]]]) {
            expect(await generateMetadata(props(slug, photoId)), `${slug} ${photoId}`).toEqual({});
        }
        state.catalog = { state: 'unavailable', reason: 'not-published' } satisfies ActiveCatalog;
        expect(await generateMetadata(props('route-a', P[0]))).toEqual({});
    });
});
