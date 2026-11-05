import type { Page } from '@playwright/test';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../lib/identity/variants';
import { publish } from '../lib/catalog/publish';
import { createTestCatalog, type TestCatalog, type VariantByteTable } from '../lib/catalog/testing';
import { startCatalogServer, READY_TIMEOUT, type CatalogServer } from './support/catalogServer';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';

// #6's continuation in the browser, on a published 250-photo series served
// from a second `next start`: Show more by keyboard keeps scroll and
// authored order with one request per press; ?photo= deep entry and Show
// earlier, and Close to the photograph (B5); Back to the series, after a
// soft navigation or a reload on the Viewer, loads the same pages again so
// the opened photograph past the first page is there to return to; and Home
// asks the records endpoint for its next window, bound to its revision.
// Variant files are sparse, so images fail and show their missing state;
// nothing here looks at pixels.

test.describe.configure({ mode: 'serial' });

const HOOK_TIMEOUT = READY_TIMEOUT + 60_000;
const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LONG = Array.from({ length: 250 }, (_, n) => id(n + 1));
/** Sparse variant files of a small declared size: fast to write, never decoded. */
const BYTES = Object.fromEntries(VARIANT_WIDTHS.map((width) => [width, Object.fromEntries(VARIANT_FORMATS.map((format) => [format, 1_024]))])) as VariantByteTable;
const PAGES = '/api/catalog/series/long/pages/';

let catalog: TestCatalog | undefined;
let server: CatalogServer | undefined;

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    catalog = await createTestCatalog({
        seed: 68,
        variantBytes: BYTES,
        photos: LONG.map((photoId) => ({ id: photoId, width: 900, height: 600 })),
        series: [{ id: 'ser_e2e-long', slug: 'long', title: 'Fixture long series', photoIds: LONG }],
    });
    const outcome = await publish({ dataRoot: catalog.root, actor: 'e2e', confirmLaunch: true, logger: { log: () => undefined } });
    expect(outcome.outcome, outcome.message).toBe('PUBLISHED');
    // As series.spec.ts does: one port per worker above E2E_CATALOG_PORT when it's set.
    const base = Number(process.env.E2E_CATALOG_PORT);
    server = await startCatalogServer(catalog.root, Number.isInteger(base) && base > 0 ? base + 1 + test.info().parallelIndex : undefined);
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
const entries = (page: Page) => page.getByRole('main').locator('ol > li > a');
const entry = (page: Page, position: number) => page.locator(`#photo-${LONG[position - 1]}`);
const showMore = (page: Page) => page.getByRole('button', { name: 'Show more photographs' });
const sequence = (page: Page) => page.locator('section[aria-labelledby="series-sequence"]');

async function openSeries(page: Page): Promise<void> {
    await page.goto(`${origin()}/work/long`);
    await waitForHydration(page);
    await expect(entries(page)).toHaveCount(100);
}

/** Press Show more by keyboard and wait for the next page to be in the list. */
async function pressShowMore(page: Page, expected: number): Promise<void> {
    await showMore(page).focus();
    await page.keyboard.press('Enter');
    await expect(entries(page)).toHaveCount(expected);
}

test('Show more by keyboard appends each page in order, keeping scroll, with focus on the first new entry and one request per press', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (request) => {
        if (new URL(request.url()).pathname.startsWith(PAGES)) requests.push(request.url());
    });
    await openSeries(page);
    await showMore(page).scrollIntoViewIfNeeded();
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await pressShowMore(page, 200);
    // Focus moves to the first new entry after each append (B5), which sits where the control was, so nothing scrolls.
    await expect(entry(page, 101)).toBeFocused();
    await expect(entry(page, 101)).toBeInViewport();
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrollBefore)).toBeLessThanOrEqual(1);
    await expect(page.getByRole('status').filter({ hasText: 'Added photographs 101 to 200 of 250.' })).toBeVisible();
    // The last page: the control goes, and focus moves to the first new entry rather than the page.
    await pressShowMore(page, 250);
    await expect(entry(page, 201)).toBeFocused();
    await expect(page.getByRole('status').filter({ hasText: 'Added photographs 201 to 250 of 250. End of series.' })).toBeVisible();
    await expect(showMore(page)).toHaveCount(0);
    const positions = await page.locator('[data-position]').allTextContents();
    expect(positions.map(Number)).toEqual(LONG.map((_, n) => n + 1));
    expect(requests).toHaveLength(2);
});

test('Back from the Viewer of a photograph past the first page finds it again', async ({ page }) => {
    await openSeries(page);
    await pressShowMore(page, 200);
    await entry(page, 150).click();
    await expect(page).toHaveURL(new RegExp(`/work/long/photo/${LONG[149]}$`));
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/work/long\\?photo=${LONG[149]}$`));
    await expect(entry(page, 150)).toBeAttached();
    await expect(sequence(page)).not.toHaveAttribute('aria-busy', 'true');
    await expect(entries(page)).toHaveCount(200);
});

test('Back after a reload on the Viewer loads the same pages again and fires the restored event', async ({ page }) => {
    await openSeries(page);
    await pressShowMore(page, 200);
    await entry(page, 150).click();
    await expect(page).toHaveURL(new RegExp(`/work/long/photo/${LONG[149]}$`));
    await page.reload();
    await waitForHydration(page);
    // The reload replaced the document for every entry pushState made, so Back to the series is a
    // same-document traversal: Next renders the series page into this document. Listen here, before Back.
    await page.evaluate(() => {
        window.addEventListener('kg:series-entries-restored', () => {
            (window as unknown as { restored: number }).restored = ((window as unknown as { restored?: number }).restored ?? 0) + 1;
        });
    });
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/work/long\\?photo=${LONG[149]}$`));
    await expect(entries(page)).toHaveCount(200);
    await expect(entry(page, 150)).toBeAttached();
    await expect.poll(() => page.evaluate(() => (window as unknown as { restored?: number }).restored ?? 0)).toBe(1);
    await expect(sequence(page)).not.toHaveAttribute('aria-busy', 'true');
});

const showEarlier = (page: Page) => page.getByRole('button', { name: 'Show earlier photographs' });
const status = (page: Page) => sequence(page).getByRole('status');

test.describe('deep entry (?photo=, B5)', () => {
    test('a direct load of ?photo= renders the page that holds it, with that entry focused and in view, and both controls', async ({ page }) => {
        await page.goto(`${origin()}/work/long?photo=${LONG[149]}`);
        await waitForHydration(page);
        await expect(entries(page)).toHaveCount(100);
        const positions = await page.locator('[data-position]').allTextContents();
        expect(positions.map(Number)).toEqual(LONG.slice(100, 200).map((_, n) => n + 101));
        await expect(entry(page, 150)).toBeFocused();
        await expect(entry(page, 150)).toBeInViewport();
        await expect(showEarlier(page)).toBeVisible();
        await expect(showMore(page)).toBeVisible();
        await expect(status(page)).toHaveText('Showing photographs 101 to 200 of 250.');
        // Show earlier comes before the entries, Show more after them.
        const order = await page.evaluate(() => [...document.querySelectorAll('main button, main ol > li > a')].map((node) => node.tagName));
        expect(order[0]).toBe('BUTTON');
        expect(order.at(-1)).toBe('BUTTON');
    });

    test('Show earlier by keyboard loads the page before, keeping the old first entry where it was, and ends at the start', async ({ page }) => {
        await page.goto(`${origin()}/work/long?photo=${LONG[149]}`);
        await waitForHydration(page);
        await showEarlier(page).scrollIntoViewIfNeeded();
        const before = await entry(page, 101).evaluate((node) => node.getBoundingClientRect().top);
        await showEarlier(page).focus();
        await page.keyboard.press('Enter');
        await expect(entries(page)).toHaveCount(200);
        const after = await entry(page, 101).evaluate((node) => node.getBoundingClientRect().top);
        expect(Math.abs(after - before), 'the old first entry keeps its offset in the view').toBeLessThanOrEqual(1);
        // The last new entry, the one nearest the old ones.
        await expect(entry(page, 100)).toBeFocused();
        await expect(entry(page, 100)).toBeInViewport();
        await expect(showEarlier(page)).toHaveCount(0);
        await expect(status(page)).toHaveText('Added photographs 1 to 100 of 250. Start of series.');
        const positions = await page.locator('[data-position]').allTextContents();
        expect(positions.map(Number)).toEqual(LONG.slice(0, 200).map((_, n) => n + 1));
    });

    test('an unknown or malformed ?photo= gets the plain series page, a 200 with no focus moved and the value nowhere in the HTML', async ({ page, request }) => {
        for (const value of [id(999), 'not-a-photo', '"><img src=x onerror=alert(1)>']) {
            const response = await request.get(`${origin()}/work/long?photo=${encodeURIComponent(value)}`, { maxRedirects: 0 });
            expect(response.status(), value).toBe(200);
            const html = await response.text();
            expect(html, value).not.toContain('onerror');
            expect(html, value).not.toContain(id(999));
            expect(html, value).not.toContain('Show earlier photographs');
        }
        await page.goto(`${origin()}/work/long?photo=${id(999)}`);
        await waitForHydration(page);
        await expect(entries(page)).toHaveCount(100);
        await expect(entry(page, 1)).toBeAttached();
        expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
        await expect(showEarlier(page)).toHaveCount(0);
    });

    test('Close from a directly loaded photograph goes to its page of the series, focused on its entry', async ({ page }) => {
        await page.goto(`${origin()}/work/long/photo/${LONG[249]}`);
        await waitForHydration(page);
        const close = page.locator('[data-surface="viewer"]').getByRole('link', { name: 'Close' });
        await expect(close).toHaveAttribute('href', `/work/long?photo=${LONG[249]}`);
        await close.click();
        await expect(page).toHaveURL(`${origin()}/work/long?photo=${LONG[249]}`);
        await expect(entry(page, 250)).toBeFocused();
        await expect(entry(page, 250)).toBeInViewport();
        await expect(entries(page)).toHaveCount(50);
        await expect(showEarlier(page)).toBeVisible();
    });

    test('activation writes ?photo=, so a reload of the series opens on the page that holds the photograph', async ({ page }) => {
        await openSeries(page);
        await pressShowMore(page, 200);
        await entry(page, 150).click();
        await expect(page).toHaveURL(new RegExp(`/work/long/photo/${LONG[149]}$`));
        await page.goBack();
        await expect(page).toHaveURL(`${origin()}/work/long?photo=${LONG[149]}`);
        await expect(entry(page, 150)).toBeFocused();
        await page.reload();
        await waitForHydration(page);
        await expect(entry(page, 150)).toBeAttached();
        await expect(entry(page, 101)).toBeAttached();
    });
});

test('Home ships three records and asks the records endpoint for the next window, bound to its revision', async ({ page }) => {
    // v1.5.0: the loop's route, which names the series the photograph plays in.
    const asked = page.waitForRequest((request) => /^\/api\/catalog\/home\/series\/ser_[^/]+\/photos\//.test(new URL(request.url()).pathname));
    await page.goto(`${origin()}/`);
    const request = await asked;
    const url = new URL(request.url());
    expect(url.searchParams.get('revision')).toMatch(/^rev_[0-9a-f]{64}$/);
    const response = await request.response();
    expect(response?.status()).toBe(200);
    const body = await response?.json();
    expect(body.revisionId).toBe(url.searchParams.get('revision'));
    expect(body.photos).toHaveLength(3);
});
