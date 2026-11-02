// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveCatalog } from '@/lib/catalog/public-reader';
import { createCatalogReader } from '@/lib/catalog/reader';
import { createTestCatalog, type TestCatalog } from '@/lib/catalog/testing';

// /sitemap.xml and /robots.txt: the public routes the catalog serves, on the
// SITE_URL origin, and nothing of the curator.

const state = vi.hoisted(() => ({ catalog: null as unknown }));

vi.mock('@/lib/catalog/public-reader', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/catalog/public-reader')>();
    return { ...actual, getActiveCatalog: async () => state.catalog };
});

vi.mock('next/server', async (importOriginal) => ({ ...(await importOriginal<typeof import('next/server')>()), connection: async () => {} }));

const { default: sitemap, dynamic: sitemapDynamic } = await import('../sitemap');
const { default: robots, dynamic: robotsDynamic } = await import('../robots');

const ORIGIN = 'https://keyurgolani.photography';
const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let catalog: TestCatalog;

beforeAll(async () => {
    catalog = await createTestCatalog({
        seed: 7,
        photos: [{ id: id(1) }, { id: id(2) }, { id: id(3) }, { id: id(4) }],
        series: [
            { id: 'ser_map-a', slug: 'map-a', title: 'Map A', shortStatement: 'A.', photoIds: [id(1)] },
            { id: 'ser_map-draft', slug: 'sentinel-draft', title: 'Draft', shortStatement: 'D.', photoIds: [id(2)], visibility: 'draft' },
            { id: 'ser_map-hidden', slug: 'sentinel-hidden', title: 'Hidden', photoIds: [id(3)], visibility: 'hidden' },
            { id: 'ser_map-b', slug: 'map-b', title: 'Map B', shortStatement: 'B.', photoIds: [id(4)] },
        ],
        seriesOrder: ['ser_map-b', 'ser_map-draft', 'ser_map-a', 'ser_map-hidden'],
    });
});

afterAll(async () => {
    await catalog?.cleanup();
});

const served = (servedState: 'ok' | 'degraded'): ActiveCatalog =>
    ({
        mode: 'catalog',
        state: servedState,
        reader: createCatalogReader(catalog.content, { revisionId: catalog.revisionId, revisionNumber: 1 }),
        active: { revisionId: catalog.revisionId, revisionNumber: 1, activationId: 'act_fixture', activatedAt: null },
    }) as unknown as ActiveCatalog;

beforeEach(() => {
    vi.stubEnv('SITE_URL', ORIGIN);
    state.catalog = { mode: 'legacy' } satisfies ActiveCatalog;
});

afterEach(() => {
    vi.unstubAllEnvs();
});

const urls = async () => (await sitemap()).map((entry) => entry.url);

describe('/sitemap.xml', () => {
    it('renders per request, never at build', () => {
        expect(sitemapDynamic).toBe('force-dynamic');
    });

    it.each(['ok', 'degraded'] as const)('lists Home, Work, each published series in Work order, and About, with a revision served (%s)', async (servedState) => {
        state.catalog = served(servedState);
        expect(await urls()).toEqual([`${ORIGIN}/`, `${ORIGIN}/work`, `${ORIGIN}/work/map-b`, `${ORIGIN}/work/map-a`, `${ORIGIN}/about`]);
    });

    it('lists Home, the Gallery, and About in legacy mode', async () => {
        expect(await urls()).toEqual([`${ORIGIN}/`, `${ORIGIN}/gallery`, `${ORIGIN}/about`]);
    });

    it('lists only Home and About while the catalog is unavailable, and never throws', async () => {
        state.catalog = { mode: 'catalog', state: 'unavailable', reason: 'active-unreadable' } satisfies ActiveCatalog;
        expect(await urls()).toEqual([`${ORIGIN}/`, `${ORIGIN}/about`]);
    });

    it('never lists a draft or hidden series, the curator, or an API path', async () => {
        state.catalog = served('ok');
        for (const url of await urls()) expect(url).not.toMatch(/sentinel|curation|\/api\//);
    });

    it("follows the SITE_URL the server starts with, and Next's local origin without one", async () => {
        vi.stubEnv('SITE_URL', 'https://photos.example');
        expect((await urls())[0]).toBe('https://photos.example/');
        vi.stubEnv('SITE_URL', '');
        expect((await urls())[0]).toMatch(/^http:\/\/localhost:\d+\/$/);
    });
});

describe('/robots.txt', () => {
    it('renders per request, so the sitemap line follows SITE_URL', () => {
        expect(robotsDynamic).toBe('force-dynamic');
    });

    it('lets every crawler in but the API, and names the sitemap', async () => {
        expect(await robots()).toEqual({
            rules: [{ userAgent: '*', allow: '/', disallow: '/api/' }],
            sitemap: `${ORIGIN}/sitemap.xml`,
        });
    });

    // Cloudflare prepends its managed content signals to the origin's file. The owner sets those there, so this file
    // adds none of its own to contradict them, and doesn't name the curator, which 404s on the public site anyway.
    it('carries no content signal, host, or curator path', async () => {
        const text = JSON.stringify(await robots());
        expect(text).not.toMatch(/content-signal|ai-train|ai-input|curation|host/i);
    });
});
