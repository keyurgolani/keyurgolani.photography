import type { Page } from '@playwright/test';
import { publish } from '../../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../../lib/catalog/testing';
import { startCatalogServer, READY_TIMEOUT, type CatalogServer } from '../support/catalogServer';
import { waitForHydration } from '../support/hydration';
import { expect, test } from '../support/test';

// The Light Takes Shape and Chromatic Chapters layers stay on their own
// surfaces. About's main and its Primary nav carry the about surface and see
// its tokens, and nothing else does. The Viewer's root carries the viewer
// surface and sees the Chromatic Chapters tokens, and nothing above it does.

test.skip(({ isMobile }) => isMobile, 'The desktop project covers it.');

/** Each token as the body, the Primary nav, and main resolve it. */
const tokensOf = (page: Page) =>
    page.evaluate(() => {
        const read = (el: Element | null) =>
            el && {
                paper: getComputedStyle(el).getPropertyValue('--lts-paper').trim(),
                ground: getComputedStyle(el).getPropertyValue('--cc-ground').trim(),
            };
        return { body: read(document.body), nav: read(document.querySelector('nav[aria-label="Primary"]')), main: read(document.querySelector('main')) };
    });

async function expectConfined(page: Page) {
    await expect(page.locator('[data-surface]')).toHaveCount(0);
    const { body, nav } = await tokensOf(page);
    expect({ body, nav }).toEqual({ body: { paper: '', ground: '' }, nav: { paper: '', ground: '' } });
}

async function expectAboutSurface(page: Page) {
    await expect(page.locator('[data-surface]')).toHaveCount(2);
    await expect(page.locator('main[data-surface="about"]')).toHaveCount(1);
    await expect(page.locator('nav[aria-label="Primary"][data-surface="about"]')).toHaveCount(1);
    expect(await tokensOf(page)).toEqual({ body: { paper: '', ground: '' }, nav: { paper: '#f4ecd7', ground: '' }, main: { paper: '#f4ecd7', ground: '' } });
}

for (const path of ['/', '/gallery', '/does-not-exist']) {
    test(`nothing on ${path} carries data-surface or a surface token`, async ({ page }) => {
        await page.goto(path);
        await waitForHydration(page);
        await expectConfined(page);
    });
}

test('on /about only main and the Primary nav carry the about surface, and neither sees a Chromatic Chapters token', async ({ page }) => {
    await page.goto('/about');
    await waitForHydration(page);
    await expectAboutSurface(page);
});

test('it holds after a client-side move from /about through /work to the legacy /gallery', async ({ page }) => {
    await page.goto('/about');
    await waitForHydration(page);
    await expectAboutSurface(page);
    const work = page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Work', exact: true });
    await expect(work).toHaveAttribute('href', '/work');
    await work.click();
    await expect(page).toHaveURL('/gallery');
    await expect(page.getByRole('heading', { level: 1, name: 'Gallery' })).toBeVisible();
    await expectConfined(page);
});

test.describe('the Viewer surface', () => {
    test.describe.configure({ mode: 'serial' });

    const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    let catalog: TestCatalog | undefined;
    let server: CatalogServer | undefined;

    test.beforeAll(async () => {
        test.setTimeout(READY_TIMEOUT + 60_000);
        catalog = await createTestCatalog({
            seed: 72,
            withAssets: true,
            photos: [{ id: id(1), width: 900, height: 600 }, { id: id(2), width: 900, height: 600 }],
            series: [{ id: 'ser_e2e-confined', slug: 'confined', title: 'Fixture confined', photoIds: [id(1), id(2)] }],
        });
        const outcome = await publish({ dataRoot: catalog.root, actor: 'e2e', confirmLaunch: true, logger: { log: () => undefined } });
        expect(outcome.outcome, outcome.message).toBe('PUBLISHED');
        const base = Number(process.env.E2E_CATALOG_PORT);
        server = await startCatalogServer(catalog.root, Number.isInteger(base) && base > 0 ? base + 8 + test.info().parallelIndex : undefined);
    });

    test.afterAll(async () => {
        test.setTimeout(READY_TIMEOUT + 60_000);
        await server?.stop();
        await catalog?.cleanup();
    });

    /** The Viewer's root sees the Chromatic Chapters tokens, html and the body above it don't, and none sees an About token. */
    async function expectViewerSurface(page: Page) {
        await expect(page.locator('[data-surface]')).toHaveCount(1);
        await expect(page.locator('[data-surface="viewer"]')).toHaveCount(1);
        const tokens = await page.evaluate(() => {
            const read = (el: Element | null) =>
                el && {
                    paper: getComputedStyle(el).getPropertyValue('--lts-paper').trim(),
                    ground: getComputedStyle(el).getPropertyValue('--cc-ground').trim(),
                };
            return { html: read(document.documentElement), body: read(document.body), viewer: read(document.querySelector('[data-surface="viewer"]')) };
        });
        expect(tokens).toEqual({ html: { paper: '', ground: '' }, body: { paper: '', ground: '' }, viewer: { paper: '', ground: '#111513' } });
    }

    test('on a Viewer URL only the Viewer root carries data-surface, and only it sees the Chromatic Chapters tokens', async ({ page }) => {
        if (!server) throw new Error('The catalog server did not start');
        await page.goto(`${server.origin}/work/confined/photo/${id(1)}`);
        await waitForHydration(page);
        await expectViewerSurface(page);
        // It holds after a client-side move to the next photograph.
        await page.getByRole('link', { name: 'Next photograph' }).click();
        await expect(page).toHaveURL(`${server.origin}/work/confined/photo/${id(2)}`);
        await expectViewerSurface(page);
    });
});
