// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveCatalog } from '@/lib/catalog/public-reader';
import { createCatalogReader } from '@/lib/catalog/reader';
import { createTestCatalog, type TestCatalog } from '@/lib/catalog/testing';

// The Work page's request-time gate: workRouteOf() with getActiveCatalog() and
// publicRoutes, answered as a render or a throw to app/error.tsx. /gallery,
// which #13's slice E removed, is proxy.ts's 308 (__tests__/originals.test.ts).

const state = vi.hoisted(() => ({ catalog: null as unknown, origin: null as URL | null, request: {} as object, reads: 0 }));

vi.mock('next/navigation', () => ({
    usePathname: () => '/work',
    // Work's entry links prefetch through the router on intent (B10).
    useRouter: () => ({ prefetch: () => undefined }),
}));

vi.mock('@/lib/catalog/public-reader', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/catalog/public-reader')>();
    return {
        ...actual,
        getActiveCatalog: async () => {
            state.reads += 1;
            return state.catalog;
        },
    };
});

// One object per request, as Next keeps the request's headers: a test is one request unless it says otherwise.
vi.mock('next/headers', () => ({ headers: async () => state.request }));

vi.mock('@/lib/site/config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/site/config')>();
    return { ...actual, getSiteOrigin: () => state.origin };
});

vi.mock('@/components/site/SiteNav', () => ({ default: () => <nav aria-label="Primary" /> }));

const { default: WorkPage, dynamic: workDynamic, generateMetadata } = await import('../work/page');
const { CatalogUnavailableError } = await import('@/lib/catalog/public-reader');

const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = Array.from({ length: 6 }, (_, n) => id(n + 1));

/** Strings only unpublished series and fields outside Work's allowlist carry. */
const SENTINELS = [
    'SENTINEL draft title',
    'SENTINEL draft short',
    'SENTINEL hidden title',
    'sentinel-hidden',
    'SENTINEL long statement',
    'sentinel-old-slug',
    'SENTINEL caption',
    'SENTINEL alt',
    'SENTINEL location',
    'SENTINEL chapter',
    'private/SENTINEL-source.jpg',
    '#5e7173',
];

let catalog: TestCatalog;

beforeAll(async () => {
    catalog = await createTestCatalog({
        seed: 5,
        photos: [
            { id: P[0], caption: 'SENTINEL caption', alt: { kind: 'described', text: 'SENTINEL alt', reviewed: true }, location: 'SENTINEL location', sourcePath: 'private/SENTINEL-source.jpg', accent: '#5e7173' },
            { id: P[1] },
            { id: P[2] },
            { id: P[3] },
            { id: P[4] },
            { id: P[5] },
        ],
        series: [
            {
                id: 'ser_route-a',
                slug: 'route-a',
                title: 'Route A',
                shortStatement: 'Short statement A.',
                statement: 'SENTINEL long statement',
                slugAliases: ['sentinel-old-slug'],
                accent: '#5e7173',
                chapters: [{ id: 'chapter-one', title: 'SENTINEL chapter', startPhotoId: P[0] }],
                photoIds: [P[0], P[1]],
            },
            { id: 'ser_route-draft', slug: 'route-draft', title: 'SENTINEL draft title', shortStatement: 'SENTINEL draft short', photoIds: [P[2]], visibility: 'draft' },
            { id: 'ser_route-hidden', slug: 'sentinel-hidden', title: 'SENTINEL hidden title', photoIds: [P[3]], visibility: 'hidden' },
            { id: 'ser_route-b', slug: 'route-b', title: 'Route B', shortStatement: 'Short statement B.', photoIds: [P[4], P[5]] },
        ],
        seriesOrder: ['ser_route-b', 'ser_route-draft', 'ser_route-a', 'ser_route-hidden'],
    });
});

afterAll(async () => {
    await catalog?.cleanup();
});

const served = (servedState: 'ok' | 'degraded'): ActiveCatalog =>
    ({
        state: servedState,
        reader: createCatalogReader(catalog.content, { revisionId: catalog.revisionId, revisionNumber: 1 }),
        active: { revisionId: catalog.revisionId, revisionNumber: 1, activationId: 'act_fixture', activatedAt: null },
    }) as unknown as ActiveCatalog;

const unavailable = (reason: 'not-published' | 'catalog-unreadable' | 'active-unreadable' | 'revision-unreadable'): ActiveCatalog => ({ state: 'unavailable', reason });

async function answer(page: () => Promise<React.ReactElement>): Promise<{ html: string } | { thrown: unknown }> {
    try {
        return { html: renderToStaticMarkup(await page()) };
    } catch (error) {
        return { thrown: error };
    }
}

beforeEach(() => {
    state.catalog = unavailable('not-published');
    state.request = {};
    state.reads = 0;
});

describe('the /work gate', () => {
    it('renders per request', () => {
        expect(workDynamic).toBe('force-dynamic');
    });

    it.each(['ok', 'degraded'] as const)('with a revision served (%s) renders Work', async (servedState) => {
        state.catalog = served(servedState);
        const work = await answer(WorkPage);
        expect('html' in work).toBe(true);
        const html = (work as { html: string }).html;
        expect(html).toContain('<h1');
        expect(html).toContain('Bodies of work');
    });

    // not-published: no data root, or nothing published yet, where #13's slice E left no legacy Gallery to send it to.
    it.each(['not-published', 'catalog-unreadable', 'active-unreadable', 'revision-unreadable'] as const)(
        'while the catalog is unavailable (%s) throws CatalogUnavailableError, with no redirect',
        async (reason) => {
            state.catalog = unavailable(reason);
            const result = await answer(WorkPage);
            expect(result).toEqual({ thrown: expect.any(CatalogUnavailableError) });
            expect((result as { thrown: InstanceType<typeof CatalogUnavailableError> }).thrown.reason).toBe(reason);
        },
    );
});

describe('Work on a served revision', () => {
    beforeEach(() => {
        state.catalog = served('ok');
    });

    async function workHtml(): Promise<string> {
        const result = await answer(WorkPage);
        if (!('html' in result)) throw new Error('Work did not render');
        return result.html;
    }

    it('lists only the published series, in authored Work order, each as one link to its canonical slug', async () => {
        const html = await workHtml();
        const links = [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map(([, href]) => href);
        expect(links).toEqual(['/work/route-b', '/work/route-a']);
        // Each link is its h2's only child, named by the title (#171, B3).
        const titles = [...html.matchAll(/<h2[^>]*><a [^>]*>([^<]*)<\/a><\/h2>/g)].map(([, title]) => title);
        expect(titles).toEqual(['Route B', 'Route A']);
        expect(html).toContain('Short statement A.');
        expect(html).toContain('Short statement B.');
        expect(html.match(/>2 photographs</g)).toHaveLength(2);
    });

    // Work's revision marker (#171, B3), as Home's main and the series page's main carry theirs, for B12's freshness rows.
    it('marks the series list with the served revision', async () => {
        const html = await workHtml();
        expect(html.match(/data-catalog-revision="[^"]*"/g)).toEqual([`data-catalog-revision="${catalog.revisionId}"`]);
        expect(html).toMatch(new RegExp(`<ul [^>]*data-catalog-revision="${catalog.revisionId}"`));
    });

    it('leaves every unpublished and non-allowlisted string out of the server HTML', async () => {
        const html = await workHtml();
        for (const sentinel of SENTINELS) expect(html, sentinel).not.toContain(sentinel);
        // The draft and hidden series' photos, and their IDs, never reach Work.
        for (const photoId of [P[2], P[3]]) expect(html).not.toContain(photoId);
    });

    it('serves each cover from /media with an empty alt, since the entry text names the link', async () => {
        const html = await workHtml();
        const images = [...html.matchAll(/<img [^>]*>/g)].map(([tag]) => tag);
        expect(images).toHaveLength(2);
        for (const tag of images) {
            expect(tag).toMatch(/ alt=""/);
            expect(tag).toMatch(/ src="\/media\/ph_[^"]+\/w1200\.webp"/);
        }
    });
});

describe('the /work metadata', () => {
    beforeEach(() => {
        state.origin = null;
        state.catalog = served('ok');
    });

    it('with SITE_URL set gives the title, the description, and the canonical path /work', async () => {
        state.origin = new URL('https://photos.example.test');
        expect(await generateMetadata()).toEqual({
            title: 'Work',
            description: 'Photographic series by Keyur Golani.',
            alternates: { canonical: '/work' },
        });
    });

    it('leaves the canonical link out without a valid SITE_URL, instead of pointing it at localhost', async () => {
        const metadata = await generateMetadata();
        expect(metadata).toEqual({ title: 'Work', description: 'Photographic series by Keyur Golani.' });
        expect(JSON.stringify(metadata)).not.toMatch(/localhost|https?:/);
    });

    // As the series pages: an unavailable catalog gets {}, so #21's error page keeps the site's defaults with its 500.
    it.each(['not-published', 'catalog-unreadable', 'active-unreadable', 'revision-unreadable'] as const)('is empty while the catalog is unavailable (%s)', async (reason) => {
        state.catalog = unavailable(reason);
        state.origin = new URL('https://photos.example.test');
        expect(await generateMetadata()).toEqual({});
    });

    // When the page throws, Next renders the error page's head in a second render of the same request, after the
    // shell. A fresh read there lands the metadata late, and Next streams the title into the body (Dark parity's
    // no-JavaScript error page, B1's CI). One read per request keeps it there at once, and the same answer.
    it("reads the catalog once per request, for the page, its metadata, and the error page's head after a throw", async () => {
        state.catalog = unavailable('active-unreadable');
        expect(await answer(WorkPage)).toEqual({ thrown: expect.any(CatalogUnavailableError) });
        expect(await generateMetadata()).toEqual({});
        // The error page's render, with the catalog readable by then: it still answers for this request's read.
        state.catalog = served('ok');
        expect(await generateMetadata()).toEqual({});
        expect(state.reads).toBe(1);

        state.request = {};
        expect(await generateMetadata()).toEqual({ title: 'Work', description: 'Photographic series by Keyur Golani.' });
        expect(state.reads).toBe(2);
    });
});
