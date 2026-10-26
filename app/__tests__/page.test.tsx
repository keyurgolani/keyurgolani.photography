import { render, screen } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { VARIANT_BYTES } from '@/lib/catalog/__tests__/catalogFixtures';
import { publishedHomeOf, type PublishedHome } from '@/lib/catalog/projections/home';
import type { ActiveCatalog } from '@/lib/catalog/public-reader';
import { createCatalogReader, createRouteBuilder } from '@/lib/catalog/reader';
import { createTestCatalog, type TestCatalog } from '@/lib/catalog/testing';
import type { RevisionContent } from '@/lib/catalog/types';

const active = vi.hoisted(() => ({ catalog: null as unknown, reads: 0 }));
const portraitSource = vi.hoisted(() => ({ view: null as unknown, names: [] as string[] }));

// About's portrait as the site config folder gives it, read once a request.
vi.mock('@/lib/siteConfig/portraitVariants', () => ({
    aboutPortraitView: async (name: string) => {
        portraitSource.names.push(name);
        return portraitSource.view;
    },
}));

vi.mock('@/lib/catalog/public-reader', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/catalog/public-reader')>();
    return {
        ...actual,
        getActiveCatalog: async () => {
            active.reads += 1;
            return active.catalog;
        },
    };
});

// Stand-ins that show which Home rendered, and with what.
vi.mock('@/components/home/LegacyHome', () => ({
    default: ({ portrait }: { portrait: unknown }) => <div data-testid="legacy-home" data-portrait={JSON.stringify(portrait)} />,
}));
vi.mock('@/components/home/CatalogHome', () => ({
    default: ({ home, portrait }: { home: PublishedHome; portrait: unknown }) => (
        <div data-testid="catalog-home" data-home={JSON.stringify(home)} data-portrait={JSON.stringify(portrait)} />
    ),
}));

const { default: HomePage, dynamic } = await import('../page');
const { CatalogUnavailableError } = await import('@/lib/catalog/public-reader');

let catalog: TestCatalog;

beforeAll(async () => {
    catalog = await createTestCatalog({ variantBytes: VARIANT_BYTES, seed: 4, photos: 4, series: [{ slug: 'fixture-a', photos: 3 }, { slug: 'fixture-b' }] });
});

afterAll(async () => {
    await catalog.cleanup();
});

beforeEach(() => {
    active.reads = 0;
    portraitSource.view = null;
    portraitSource.names.length = 0;
});

/** What `aboutPortraitView` returns for a usable portrait. The page passes it on as is. */
const PORTRAIT_VIEW = {
    asset: { width: 1600, height: 2000, variants: { w400: { avif: { url: '/about/portrait/t/w400.avif', width: 400 }, webp: { url: '/about/portrait/t/w400.webp', width: 400 } } } },
    alt: 'A stand-in portrait',
    focalPoint: { x: 50, y: 32 },
};

const REVISION = `rev_${'c'.repeat(64)}`;

const ACTIVATION = { revisionId: REVISION, revisionNumber: 2, activationId: 'act_fixture', activatedAt: null };

function served(state: 'ok' | 'degraded', content = structuredClone(catalog.content) as RevisionContent) {
    const reader = createCatalogReader(content, { revisionId: REVISION, revisionNumber: 2 });
    return { mode: 'catalog', state, reader, active: ACTIVATION } satisfies ActiveCatalog;
}

const renderedHome = () => JSON.parse(screen.getByTestId('catalog-home').getAttribute('data-home')!) as PublishedHome;

describe('app/page, the cutover gate', () => {
    it('renders per request', () => {
        expect(dynamic).toBe('force-dynamic');
    });

    it('renders today\'s Home in legacy mode, and nothing from the catalog', async () => {
        active.catalog = { mode: 'legacy' } satisfies ActiveCatalog;
        render(await HomePage());
        expect(screen.getByTestId('legacy-home')).toBeInTheDocument();
        expect(screen.queryByTestId('catalog-home')).toBeNull();
        expect(active.reads).toBe(1);
    });

    for (const state of ['ok', 'degraded'] as const) {
        it(`renders the catalog Home from the served revision when the catalog is ${state}`, async () => {
            const { reader } = (active.catalog = served(state));
            render(await HomePage());
            expect(screen.queryByTestId('legacy-home')).toBeNull();
            const home = renderedHome();
            const expected = publishedHomeOf({ revisionId: REVISION, site: reader.site, listSeries: reader.listSeries, photosOf: reader.photosOf }, createRouteBuilder());
            expect(home).toEqual(JSON.parse(JSON.stringify(expected)));
            expect(home.catalogRevision).toBe(REVISION);
            expect(home.featuredSeries?.href).toBe('/work/fixture-a');
            expect(active.reads).toBe(1);
        });
    }

    it('renders the catalog Home\'s empty state, never the legacy Home, when nothing is featured', async () => {
        const content = structuredClone(catalog.content) as RevisionContent;
        content.site.featuredSeriesIds = [];
        active.catalog = served('ok', content);
        render(await HomePage());
        expect(renderedHome()).toEqual({ catalogRevision: REVISION, featuredSeries: null });
        expect(screen.queryByTestId('legacy-home')).toBeNull();
    });

    it("gives either Home About's portrait for the intro and the badge, read on each request, or null without one", async () => {
        const { artist } = await import('@/data/artist');
        for (const catalogState of [{ mode: 'legacy' } satisfies ActiveCatalog, served('ok')]) {
            active.catalog = catalogState;
            const testId = catalogState.mode === 'legacy' ? 'legacy-home' : 'catalog-home';
            portraitSource.view = PORTRAIT_VIEW;
            const first = render(await HomePage());
            expect(JSON.parse(screen.getByTestId(testId).getAttribute('data-portrait')!)).toEqual(PORTRAIT_VIEW);
            first.unmount();
            portraitSource.view = null;
            const second = render(await HomePage());
            expect(JSON.parse(screen.getByTestId(testId).getAttribute('data-portrait')!)).toBeNull();
            second.unmount();
        }
        expect(portraitSource.names).toEqual(Array(4).fill(artist.profile.name));
    });

    it("reads no portrait for an unavailable catalog, which throws first", async () => {
        active.catalog = { mode: 'catalog', state: 'unavailable', reason: 'catalog-unreadable' } satisfies ActiveCatalog;
        await expect(HomePage()).rejects.toBeInstanceOf(CatalogUnavailableError);
        expect(portraitSource.names).toEqual([]);
    });

    for (const reason of ['catalog-unreadable', 'active-unreadable', 'revision-unreadable'] as const) {
        it(`throws CatalogUnavailableError for app/error.tsx when the catalog is unavailable (${reason}), never the legacy Home`, async () => {
            active.catalog = { mode: 'catalog', state: 'unavailable', reason } satisfies ActiveCatalog;
            const page = HomePage();
            await expect(page).rejects.toBeInstanceOf(CatalogUnavailableError);
            await expect(page).rejects.toMatchObject({ reason });
        });
    }
});
