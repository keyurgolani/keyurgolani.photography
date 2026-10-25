import type { Page, Request } from '@playwright/test';
import { publish } from '../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../lib/catalog/testing';
import { startCatalogServer, READY_TIMEOUT, type CatalogServer } from './support/catalogServer';
import { expectHoverRulesGated } from './support/hover';
import { waitForHydration } from './support/hydration';
import { expectReflow } from './support/reflow';
import { checkSurface } from './support/surface';
import { expect, test } from './support/test';
import { expectSingleTapActivates } from './support/touch';

// The Viewer (#7) on a published catalog, on both #1 projects: a direct load,
// the series and position, Previous and Next inside the series that stop at
// the ends and replace the history entry, the collapsed technical details,
// the #1 checks, keyboard and touch, share metadata on SITE_URL, the same
// dark ground under both site themes, and nothing outside the allowlist in
// the HTML or the RSC payload. Each project's worker publishes its own
// fixture and serves it from a second `next start`, so the harness server
// stays in legacy mode for every other spec. Close points at #5's series
// page, which isn't on this branch, so only its href is checked.

test.describe.configure({ mode: 'serial' });

/** Above the catalog, the publish, and a server start, so a slow start fails in startCatalogServer, which stops its child. */
const HOOK_TIMEOUT = READY_TIMEOUT + 60_000;
const SITE_URL = 'https://photos.example.test';

const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = Array.from({ length: 6 }, (_, n) => id(n + 1));

/** Strings only unpublished records and fields outside the Viewer's allowlist carry. */
const SENTINELS = [
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
    // The draft and hidden series' photos.
    P[4],
    P[5],
];

const HARBOR = [P[0], P[1], P[2]];
const href = (photoId: string, slug = 'harbor') => `/work/${slug}/photo/${photoId}`;

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
            photo(1),
            photo(2),
            photo(3),
            { ...photo(4), title: 'SENTINEL draft title' },
            { ...photo(5), title: 'SENTINEL hidden title' },
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
            { id: 'ser_e2e-draft', slug: 'draft', title: 'SENTINEL draft title', photoIds: [P[4]], visibility: 'draft' },
            { id: 'ser_e2e-hidden', slug: 'sentinel-hidden', title: 'SENTINEL hidden title', photoIds: [P[5]], visibility: 'hidden' },
        ],
    });
    const outcome = await publish({ dataRoot: catalog.root, actor: 'e2e', confirmLaunch: true, logger: { log: () => undefined } });
    expect(outcome.outcome, outcome.message).toBe('PUBLISHED');
    // E2E_CATALOG_PORT pins a port per worker, for a machine that hands out ranges.
    const base = Number(process.env.E2E_CATALOG_PORT);
    server = await startCatalogServer(catalog.root, Number.isInteger(base) && base > 0 ? base + test.info().parallelIndex : undefined, { siteUrl: SITE_URL });
});

test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await server?.stop();
    await catalog?.cleanup();
});

const origin = () => {
    if (!server) throw new Error('The catalog server did not start');
    return server.origin;
};

const header = (page: Page) => page.locator('[data-surface="viewer"] > header');
const close = (page: Page) => header(page).getByRole('link', { name: 'Close' });
const zoom = (page: Page) => header(page).getByRole('button', { name: 'Zoom' });
const previous = (page: Page) => page.getByRole('main').getByRole('link', { name: 'Previous photograph' });
const next = (page: Page) => page.getByRole('main').getByRole('link', { name: 'Next photograph' });
const technical = (page: Page) => page.getByRole('main').getByRole('button', { name: /^(Show|Hide) technical details$/ });
const photograph = (page: Page) => page.getByRole('main').locator('picture img');

async function openViewer(page: Page, photoId: string): Promise<void> {
    await page.goto(`${origin()}${href(photoId)}`);
    await waitForHydration(page);
    await expect(header(page).getByRole('heading', { level: 1 })).toHaveText('Fixture harbor');
}

/** The image URLs a page asked for, so a test can see none went past /media. */
function imageRequests(page: Page): string[] {
    const urls: string[] = [];
    page.on('request', (request: Request) => {
        if (request.resourceType() === 'image') urls.push(new URL(request.url()).pathname);
    });
    return urls;
}

test('a direct load renders the whole Viewer: series, position, photograph, authored copy, and Close, with no SiteNav', async ({ page, request }) => {
    const response = await request.get(`${origin()}${href(P[0])}`, { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/<h1[^>]*>Fixture harbor<\/h1>/);
    expect(html).toContain('01 / 03');
    expect(html).toContain('Fixture authored caption.');

    const images = imageRequests(page);
    await openViewer(page, P[0]);
    await expect(header(page)).toContainText('01 / 03');
    await expect(close(page)).toHaveAttribute('href', '/work/harbor');
    await expect(page.getByRole('heading', { level: 2 })).toHaveText('Fixture harbor at dusk');
    await expect(page.getByText('Fixture authored caption.')).toBeVisible();
    await expect(page.getByText('Fixture description of the harbor.', { exact: true })).toBeVisible();
    await expect(page.locator('nav[aria-label="Primary"]')).toHaveCount(0);
    await expect(page.locator('[data-surface="viewer"]')).toHaveCount(1);
    await expect(photograph(page)).toHaveAttribute('alt', 'Fixture description of the harbor.');
    await expect.poll(() => photograph(page).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    // The photograph is the largest object on the first screen.
    const box = await photograph(page).boundingBox();
    const viewport = page.viewportSize();
    expect(box && viewport && box.width * box.height).toBeGreaterThan((viewport?.width ?? 0) * (viewport?.height ?? 0) * 0.2);
    expect(images.length).toBeGreaterThan(0);
    for (const url of images) expect(url).toMatch(/^\/media\//);
});

test('a former series slug answers 308 to the canonical URL, and nothing it can\'t serve tells one case from another', async ({ request }) => {
    const moved = await request.get(`${origin()}${href(P[1], 'sentinel-old-slug')}`, { maxRedirects: 0 });
    expect(moved.status()).toBe(308);
    expect(moved.headers()['location']).toBe(href(P[1]));
    const missing = [href(P[3]), href(P[0], 'ridge'), href(P[4], 'draft'), href(P[5], 'sentinel-hidden'), href(id(99)), href(P[0], 'Harbor'), href(P[0].toUpperCase()), '/work/harbor/photo/IMG_0001.jpg'];
    for (const path of missing) {
        const response = await request.get(`${origin()}${path}`, { maxRedirects: 0 });
        expect(response.status(), path).toBe(404);
        const html = await response.text();
        // A notFound() inside a nested segment sends Next's error shell, with the not-found title, and the page in its payload.
        expect(html, path).toContain('<title>Page not found · Keyur Golani Photography</title>');
        // The payload echoes the requested path, so a segment the visitor sent isn't a leak.
        const leaks = ['Fixture harbor', 'Fixture ridge', 'data-surface="viewer"', ...SENTINELS].filter((text) => !path.includes(text));
        for (const text of leaks) expect(html, `${path}: ${text}`).not.toContain(text);
    }
});

test('a visitor on a photo the Viewer can\'t serve sees the not-found page', async ({ page }) => {
    const response = await page.goto(`${origin()}${href(P[4], 'draft')}`);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
    await expect(page.locator('[data-surface]')).toHaveCount(0);
});

test('nothing outside the allowlist reaches the served HTML or the RSC payload of a move', async ({ page, request }) => {
    for (const photoId of HARBOR) {
        const html = await (await request.get(`${origin()}${href(photoId)}`)).text();
        expect(html, 'the check reads a rendered Viewer').toContain('Fixture harbor');
        for (const sentinel of SENTINELS) expect(html, `${photoId}: ${sentinel}`).not.toContain(sentinel);
        expect(html).not.toMatch(/_next\/image|api\/image/);
    }

    // Each RSC fetch of a Viewer URL passes through here, so its body is read before the navigation drops it.
    const payloads: string[] = [];
    await page.route(
        (url) => url.pathname.startsWith('/work/harbor/photo/'),
        async (route) => {
            if (route.request().headers()['rsc'] !== '1') return route.fallback();
            const response = await route.fetch();
            const body = await response.text();
            payloads.push(body);
            await route.fulfill({ response, body });
        },
    );
    await openViewer(page, P[1]);
    await previous(page).click();
    await expect(page).toHaveURL(`${origin()}${href(P[0])}`);
    await expect(page.getByRole('heading', { level: 2 })).toHaveText('Fixture harbor at dusk');
    expect(payloads.length, 'the move fetched the Viewer as an RSC payload').toBeGreaterThan(0);
    const rsc = payloads.join('\n');
    expect(rsc, 'the payload holds the Viewer').toContain('Fixture authored caption.');
    for (const sentinel of SENTINELS) expect(rsc, sentinel).not.toContain(sentinel);
    expect(rsc).not.toMatch(/_next\/image|api\/image/);
});

test('Previous and Next stay inside the series and stop at the ends', async ({ page }) => {
    await openViewer(page, P[0]);
    await expect(page.getByRole('button', { name: 'Previous photograph' })).toBeDisabled();
    await next(page).click();
    await expect(page).toHaveURL(`${origin()}${href(P[1])}`);
    await expect(header(page)).toContainText('02 / 03');
    await next(page).click();
    await expect(page).toHaveURL(`${origin()}${href(P[2])}`);
    await expect(header(page)).toContainText('03 / 03');
    await expect(page.getByRole('button', { name: 'Next photograph' })).toBeDisabled();
    await expect(next(page)).toHaveCount(0);
    // The one-photo series has neither.
    await page.goto(`${origin()}${href(P[3], 'ridge')}`);
    await waitForHydration(page);
    await expect(page.getByRole('main').getByRole('link')).toHaveCount(0);
});

test('moves replace the history entry, so one Back leaves the Viewer for the page that opened it', async ({ page }) => {
    await page.goto(`${origin()}/`);
    await waitForHydration(page);
    await openViewer(page, P[0]);
    const length = await page.evaluate(() => history.length);
    await next(page).click();
    await expect(page).toHaveURL(`${origin()}${href(P[1])}`);
    await next(page).click();
    await expect(page).toHaveURL(`${origin()}${href(P[2])}`);
    await previous(page).click();
    await expect(page).toHaveURL(`${origin()}${href(P[1])}`);
    expect(await page.evaluate(() => history.length)).toBe(length);
    await page.goBack();
    await expect(page).toHaveURL(`${origin()}/`);
    // And Forward comes back to where the visitor left it.
    await page.goForward();
    await expect(page).toHaveURL(`${origin()}${href(P[1])}`);
    await expect(header(page)).toContainText('02 / 03');
});

test('the Viewer passes the #1 checks, and its controls reflow', async ({ page }) => {
    await openViewer(page, P[1]);
    const controls = [close(page), zoom(page), previous(page), next(page), technical(page)];
    await checkSurface(page, { controls });
    await expectHoverRulesGated(page);
    await expectReflow(page.locator('[data-surface="viewer"] a, [data-surface="viewer"] button:not([disabled])'));
});

test('Tab runs Close, Zoom, Previous, Next, and the technical toggle, and Enter and Space work on each', async ({ page }) => {
    await openViewer(page, P[1]);
    const names: string[] = [];
    for (let press = 0; press < 5; press++) {
        await page.keyboard.press('Tab');
        names.push(await page.evaluate(() => {
            const active = document.activeElement as HTMLElement | null;
            return active?.getAttribute('aria-label') ?? active?.textContent?.trim() ?? '';
        }));
    }
    expect(names).toEqual(['Close', 'Zoom', 'Previous photograph', 'Next photograph', 'Show technical details']);

    // The toggle keeps focus and opens with Enter, closes with Space.
    const toggle = technical(page);
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();

    await zoom(page).focus();
    await page.keyboard.press('Enter');
    await expect(zoom(page)).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Space');
    await expect(zoom(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(zoom(page)).toBeFocused();

    await next(page).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${origin()}${href(P[2])}`);
    await close(page).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${origin()}/work/harbor`);
});

test('the technical details open apart from the photograph, and the first photograph\'s facts are its allowlisted ones', async ({ page }) => {
    await openViewer(page, P[0]);
    const toggle = technical(page);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const panel = page.locator(`[id="${await toggle.getAttribute('aria-controls')}"]`);
    await expect(panel).toBeHidden();
    await toggle.click();
    await expect(panel).toBeVisible();
    await expect(panel.locator('dt')).toHaveText(['Camera make', 'Camera', 'Aperture', 'ISO']);
    await expect(panel.locator('dd')).toHaveText(['Fixture Make', 'Fixture Model', '2.8', '200']);
    const [image, facts] = await Promise.all([photograph(page).boundingBox(), panel.boundingBox()]);
    if (!image || !facts) throw new Error('No box');
    const overlap = Math.min(image.y + image.height, facts.y + facts.height) - Math.max(image.y, facts.y);
    expect(overlap, 'the panel never covers the photograph').toBeLessThanOrEqual(0);
});

test('one tap moves to the next photograph, and one tap opens the technical details', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch, 'Touch runs on the mobile project.');
    await openViewer(page, P[0]);
    await expectSingleTapActivates(next(page), () => expect(page).toHaveURL(`${origin()}${href(P[1])}`));
    await expect(header(page)).toContainText('02 / 03');
    await waitForHydration(page);
    await expectSingleTapActivates(technical(page), () => expect(technical(page)).toHaveAttribute('aria-expanded', 'true'));
});

test('share metadata names the photo and its series, on SITE_URL, with a /media share image', async ({ page }) => {
    await openViewer(page, P[0]);
    await expect(page).toHaveTitle('Fixture harbor at dusk, Fixture harbor · Keyur Golani Photography');
    const meta = (property: string) => page.locator(`meta[property="${property}"]`).getAttribute('content');
    expect(await page.locator('link[rel="canonical"]').getAttribute('href')).toBe(`${SITE_URL}${href(P[0])}`);
    expect(await meta('og:url')).toBe(`${SITE_URL}${href(P[0])}`);
    expect(await meta('og:title')).toBe('Fixture harbor at dusk, Fixture harbor');
    expect(await page.locator('meta[name="description"]').getAttribute('content')).toBe('Fixture authored caption.');
    expect(await meta('og:image')).toMatch(new RegExp(`^${SITE_URL}/media/${P[0]}/sha256-[0-9a-f]{64}/p_[0-9a-f]+/w1200\\.webp$`));
    expect(await meta('og:image:alt')).toBe('Fixture description of the harbor.');
});

for (const theme of ['dark', 'light'] as const) {
    test(`the Viewer keeps its own dark ground under the ${theme} site theme`, async ({ page }) => {
        if (theme === 'light') await page.addInitScript(() => localStorage.setItem('theme', 'light'));
        await openViewer(page, P[0]);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        const colors = await page.locator('[data-surface="viewer"]').evaluate((root) => {
            const style = getComputedStyle(root);
            return { ground: style.backgroundColor, ink: style.color, accent: style.getPropertyValue('--cc-accent').trim() };
        });
        expect(colors).toEqual({ ground: 'rgb(17, 21, 19)', ink: 'rgb(246, 244, 238)', accent: '#c08040' });
        // No theme toggle: the Viewer renders no SiteNav.
        await expect(page.getByRole('button', { name: /^Switch to (dark|light) mode$/ })).toHaveCount(0);
    });
}
