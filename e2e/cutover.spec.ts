import { expect, test, type APIRequestContext } from '@playwright/test';
import { CATALOG_ORIGIN } from './support/catalog-home';

// #13's slice E: legacy mode is gone from the visitor side. playwright.config.ts
// starts two servers from one build: the harness server, with no data root,
// and the catalog server, on a data root with a published revision. Neither
// lists the library, serves a legacy derivative, or renders the legacy
// Gallery, and the server with nothing published answers the unavailable
// state, the one #21's error page renders.

/** A legacy basename derivative the removed legacy pages loaded. */
const DERIVATIVE = '/assets/photos/optimized/landscape.webp';

const SERVERS = [
    ['with no data root', undefined],
    ['with a catalog', CATALOG_ORIGIN],
] as const;

/** `path` on `origin`, or on the harness server's own baseURL. */
const at = (origin: string | undefined, path: string) => (origin ? `${origin}${path}` : path);

async function get(request: APIRequestContext, url: string) {
    return request.get(url, { maxRedirects: 0 });
}

for (const [name, origin] of SERVERS) {
    test.describe(`the server ${name}`, () => {
        test('answers 404 for /api/photos', async ({ request }) => {
            const response = await get(request, at(origin, '/api/photos'));
            expect(response.status()).toBe(404);
        });

        test('sends /gallery on to /work with a 308', async ({ request }) => {
            for (const path of ['/gallery', '/gallery?photo=3']) {
                const response = await get(request, at(origin, path));
                expect(response.status(), path).toBe(308);
                expect(response.headers()['location'], path).toBe('/work');
            }
        });

        test('answers 404 for a legacy basename derivative, and 400 for it through /_next/image', async ({ request }) => {
            const direct = await get(request, at(origin, DERIVATIVE));
            expect(direct.status()).toBe(404);
            const optimized = await get(request, at(origin, `/_next/image?url=${encodeURIComponent(DERIVATIVE)}&w=400&q=75`));
            expect(optimized.status()).toBe(400);
        });
    });
}

test.describe('the server with no data root', () => {
    test('answers /api/ready with 503 and not-published', async ({ request }) => {
        const response = await get(request, '/api/ready');
        expect(response.status()).toBe(503);
        expect(response.headers()['cache-control']).toBe('no-store');
        expect(await response.json()).toEqual({ mode: 'catalog', state: 'unavailable', revisionId: null, revisionNumber: null, activatedAt: null, reason: 'not-published' });
    });

    for (const path of ['/', '/work']) {
        test(`renders the unavailable state at ${path}, never a photo list`, async ({ page }) => {
            const photoRequests: string[] = [];
            page.on('request', (request) => {
                const { pathname } = new URL(request.url());
                if (pathname.startsWith('/api/photos') || pathname.startsWith('/assets/photos/') || pathname === '/_next/image') photoRequests.push(pathname);
            });
            await page.goto(path);
            // #21's error page: its heading and its Try again, and nothing from the catalog or the library.
            await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
            await expect(page.locator('main img')).toHaveCount(0);
            await expect(page).toHaveURL(path);
            expect(photoRequests).toEqual([]);
        });
    }
});

test.describe('the server with a catalog', () => {
    test('answers /api/ready with the revision it serves', async ({ request }) => {
        const response = await get(request, `${CATALOG_ORIGIN}/api/ready`);
        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body).toMatchObject({ mode: 'catalog', state: 'ok', revisionNumber: 1 });
        expect(body.revisionId).toMatch(/^rev_[0-9a-f]{64}$/);
        expect(response.headers()['x-catalog-revision']).toBe(body.revisionId);
    });
});
