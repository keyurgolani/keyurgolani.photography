import type { Page } from '@playwright/test';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../lib/identity/variants';
import { publish } from '../lib/catalog/publish';
import { createTestCatalog, type TestCatalog, type VariantByteTable } from '../lib/catalog/testing';
import { startCatalogServer, READY_TIMEOUT, type CatalogServer } from './support/catalogServer';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';

// #6's continuation in the browser, on a published 250-photo series served
// from a second `next start`: Show more by keyboard keeps focus, scroll, and
// authored order with one request per press; Back to the series, after a
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

test('Show more by keyboard appends each page in order, keeping focus and scroll, with one request per press', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (request) => {
        if (new URL(request.url()).pathname.startsWith(PAGES)) requests.push(request.url());
    });
    await openSeries(page);
    await showMore(page).scrollIntoViewIfNeeded();
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await pressShowMore(page, 200);
    await expect(showMore(page)).toBeFocused();
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrollBefore)).toBeLessThanOrEqual(1);
    await expect(page.getByRole('status').filter({ hasText: 'Showing 200 of 250 photographs.' })).toBeVisible();
    // The last page: the control goes, and focus moves to the first new entry rather than the page.
    await pressShowMore(page, 250);
    await expect(entry(page, 201)).toBeFocused();
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
    await expect(page).toHaveURL(/\/work\/long$/);
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
    await expect(page).toHaveURL(/\/work\/long$/);
    await expect(entries(page)).toHaveCount(200);
    await expect(entry(page, 150)).toBeAttached();
    await expect.poll(() => page.evaluate(() => (window as unknown as { restored?: number }).restored ?? 0)).toBe(1);
    await expect(sequence(page)).not.toHaveAttribute('aria-busy', 'true');
});

test('Home ships three records and asks the records endpoint for the next window, bound to its revision', async ({ page }) => {
    const asked = page.waitForRequest((request) => new URL(request.url()).pathname.startsWith('/api/catalog/home/photos/'));
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
