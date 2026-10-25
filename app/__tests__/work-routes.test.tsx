// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveCatalog } from '@/lib/catalog/public-reader';
import { createTestCatalog, type TestCatalog } from '@/lib/catalog/testing';

// The two pages' request-time gate: workRouteOf() with getActiveCatalog() and
// publicRoutes, answered as a render, a redirect, or a throw to app/error.tsx.

const state = vi.hoisted(() => ({ catalog: null as unknown }));

/** What Next's redirect() and permanentRedirect() throw, reduced to the facts the tests read. */
class Redirected extends Error {
    constructor(readonly location: string, readonly status: 307 | 308) {
        super(`${status} ${location}`);
    }
}

vi.mock('next/navigation', () => ({
    redirect: (location: string) => {
        throw new Redirected(location, 307);
    },
    permanentRedirect: (location: string) => {
        throw new Redirected(location, 308);
    },
    usePathname: () => '/work',
}));

vi.mock('@/lib/catalog/public-reader', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/catalog/public-reader')>();
    return { ...actual, getActiveCatalog: async () => state.catalog };
});

vi.mock('@/components/site/SiteNav', () => ({ default: () => <nav aria-label="Primary" /> }));
vi.mock('@/components/DynamicGallery', () => ({ default: () => <div data-legacy-gallery="" /> }));

const { default: WorkPage, dynamic: workDynamic } = await import('../work/page');
const { default: GalleryPage, dynamic: galleryDynamic } = await import('../gallery/page');
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
        mode: 'catalog',
        state: servedState,
        reader: catalog.reader({ revisionId: catalog.revisionId, revisionNumber: 1 }),
        active: { revisionId: catalog.revisionId, revisionNumber: 1, activationId: 'act_fixture', activatedAt: null },
    }) as unknown as ActiveCatalog;

const unavailable = (reason: 'catalog-unreadable' | 'active-unreadable' | 'revision-unreadable'): ActiveCatalog => ({ mode: 'catalog', state: 'unavailable', reason });

async function answer(page: () => Promise<React.ReactElement>): Promise<{ html: string } | { redirect: Redirected } | { thrown: unknown }> {
    try {
        return { html: renderToStaticMarkup(await page()) };
    } catch (error) {
        if (error instanceof Redirected) return { redirect: error };
        return { thrown: error };
    }
}

beforeEach(() => {
    state.catalog = { mode: 'legacy' } satisfies ActiveCatalog;
});

describe('the /work and /gallery gate', () => {
    it('renders both per request', () => {
        expect(workDynamic).toBe('force-dynamic');
        expect(galleryDynamic).toBe('force-dynamic');
    });

    it('in legacy mode sends /work to /gallery with a 307 and serves the legacy Gallery unchanged', async () => {
        const work = await answer(WorkPage);
        expect(work).toEqual({ redirect: expect.objectContaining({ location: '/gallery', status: 307 }) });
        const gallery = await answer(GalleryPage);
        expect('html' in gallery && gallery.html).toContain('<h1 class="text-4xl font-bold text-center mb-10 font-primary">Gallery</h1>');
        expect('html' in gallery && gallery.html).toContain('data-legacy-gallery');
    });

    it.each(['ok', 'degraded'] as const)('with a revision served (%s) renders Work and sends /gallery to bare /work with a 308', async (servedState) => {
        state.catalog = served(servedState);
        const gallery = await answer(GalleryPage);
        expect(gallery).toEqual({ redirect: expect.objectContaining({ location: '/work', status: 308 }) });
        const work = await answer(WorkPage);
        expect('html' in work).toBe(true);
        const html = (work as { html: string }).html;
        expect(html).toContain('<h1');
        expect(html).toContain('Bodies of work');
        expect(html).not.toContain('data-legacy-gallery');
    });

    it.each(['catalog-unreadable', 'active-unreadable', 'revision-unreadable'] as const)(
        'while the catalog is unavailable (%s) throws CatalogUnavailableError on both, with no redirect',
        async (reason) => {
            state.catalog = unavailable(reason);
            for (const page of [WorkPage, GalleryPage]) {
                const result = await answer(page);
                expect(result).toEqual({ thrown: expect.any(CatalogUnavailableError) });
                expect((result as { thrown: InstanceType<typeof CatalogUnavailableError> }).thrown.reason).toBe(reason);
            }
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
        const titles = [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map(([, title]) => title);
        expect(titles).toEqual(['Route B', 'Route A']);
        expect(html).toContain('Short statement A.');
        expect(html).toContain('Short statement B.');
        expect(html.match(/>2 photographs</g)).toHaveLength(2);
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
