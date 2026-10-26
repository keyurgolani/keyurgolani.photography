import { publish } from '../../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../../lib/catalog/testing';
import { startCatalogServer, READY_TIMEOUT, type CatalogServer } from './catalogServer';
import { expect, test } from './test';

// The Viewer's published fixture (#7, shared with #9's spec): each project's
// worker publishes its own catalog and serves it from a second `next start`,
// so the harness server stays in legacy mode for every other spec.

/** Above the catalog, the publish, and a server start, so a slow start fails in startCatalogServer, which stops its child. */
export const HOOK_TIMEOUT = READY_TIMEOUT + 60_000;
export const SITE_URL = 'https://photos.example.test';

export const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const P = Array.from({ length: 6 }, (_, n) => id(n + 1));

/** Strings only unpublished records and fields outside the Viewer's allowlist carry. */
export const SENTINELS = [
    'SENTINEL draft title',
    'SENTINEL hidden title',
    'sentinel-hidden',
    'SENTINEL location',
    'SENTINEL credit',
    'SENTINEL statement',
    'sentinel-old-slug',
    'private/SENTINEL-source.jpg',
    'SENTINEL chapter',
    '2019-07-08',
    // The draft and hidden series' photos, and their IDs, which would reach the RSC payload as React keys.
    P[4],
    P[5],
    'ser_e2e-draft',
    'ser_e2e-hidden',
];

export const HARBOR = [P[0], P[1], P[2]];
/** 9a's mixed shapes, in a series of their own: a wide panorama, a tall portrait, and a 3:2 between them. */
export const SHAPES = [id(7), id(8), id(9)];
export const href = (photoId: string, slug = 'harbor') => `/work/${slug}/photo/${photoId}`;

/**
 * Registers the spec's beforeAll and afterAll, which publish the fixture and
 * serve it, and returns the server's origin once it's up.
 */
export function useViewerCatalog(): () => string {
    let catalog: TestCatalog | undefined;
    let server: CatalogServer | undefined;

    test.beforeAll(async () => {
        test.setTimeout(HOOK_TIMEOUT);
        // Small photos: the variants are never enlarged, so the fixture encodes fast.
        const photo = (n: number) => ({ id: P[n], width: 900, height: 600 });
        catalog = await createTestCatalog({
            seed: 71,
            withAssets: true,
            photos: [
                {
                    ...photo(0),
                    title: 'Fixture harbor at dusk',
                    caption: 'Fixture authored caption.',
                    alt: { kind: 'described', text: 'Fixture description of the harbor.', reviewed: true },
                    accent: '#c08040',
                    location: 'SENTINEL location',
                    credit: 'SENTINEL credit',
                    capturedAt: '2019-07-08',
                    sourcePath: 'private/SENTINEL-source.jpg',
                    technical: { Make: 'Fixture Make', Model: 'Fixture Model', FNumber: '2.8', ISO: '200' },
                },
                // The four mixes of the optional title and caption (#9b's first screen): P[0] has both, P[1] neither, P[2] a
                // title alone, and P[3] a caption alone. P[3] is also a tall photograph, so zoomed on a phone it scrolls
                // both ways (#9c's zoom to the tapped place).
                photo(1),
                { ...photo(2), title: 'Fixture harbor from the pier' },
                { ...photo(3), height: 1350, caption: 'Fixture ridge caption.' },
                { ...photo(4), title: 'SENTINEL draft title' },
                { ...photo(5), title: 'SENTINEL hidden title' },
                { id: SHAPES[0], width: 1200, height: 400, title: 'Fixture shoreline', caption: 'Fixture wide caption.', accent: '#3f7a8c' },
                { id: SHAPES[1], width: 600, height: 900, title: 'Fixture tower', caption: 'Fixture tall caption.', accent: '#a0583a' },
                { id: SHAPES[2], width: 900, height: 600, title: 'Fixture dunes', caption: 'Fixture middle caption.', accent: '#6b6fd0' },
            ],
            series: [
                {
                    id: 'ser_e2e-harbor',
                    slug: 'harbor',
                    title: 'Fixture harbor',
                    statement: 'SENTINEL statement',
                    slugAliases: ['sentinel-old-slug'],
                    accent: '#5e7173',
                    chapters: [{ id: 'chapter-one', title: 'SENTINEL chapter', startPhotoId: P[0] }],
                    photoIds: HARBOR,
                },
                { id: 'ser_e2e-ridge', slug: 'ridge', title: 'Fixture ridge', photoIds: [P[3]] },
                { id: 'ser_e2e-shapes', slug: 'shapes', title: 'Fixture shapes', photoIds: SHAPES },
                { id: 'ser_e2e-draft', slug: 'draft', title: 'SENTINEL draft title', photoIds: [P[4]], visibility: 'draft' },
                { id: 'ser_e2e-hidden', slug: 'sentinel-hidden', title: 'SENTINEL hidden title', photoIds: [P[5]], visibility: 'hidden' },
            ],
        });
        const outcome = await publish({ dataRoot: catalog.root, actor: 'e2e', confirmLaunch: true, logger: { log: () => undefined } });
        expect(outcome.outcome, outcome.message).toBe('PUBLISHED');
        // E2E_CATALOG_PORT pins a port per worker, for a machine that hands out ranges. The config's
        // catalog Home server listens on E2E_CATALOG_PORT itself, so the workers start one above it.
        const base = Number(process.env.E2E_CATALOG_PORT);
        server = await startCatalogServer(catalog.root, Number.isInteger(base) && base > 0 ? base + 1 + test.info().parallelIndex : undefined, { siteUrl: SITE_URL });
    });

    test.afterAll(async () => {
        test.setTimeout(HOOK_TIMEOUT);
        await server?.stop();
        await catalog?.cleanup();
    });

    return () => {
        if (!server) throw new Error('The catalog server did not start');
        return server.origin;
    };
}
