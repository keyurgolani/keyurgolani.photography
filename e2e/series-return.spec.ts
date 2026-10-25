import type { Locator, Page } from '@playwright/test';
import { publish } from '../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../lib/catalog/testing';
import { startCatalogServer, READY_TIMEOUT, type CatalogServer } from './support/catalogServer';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';
import { expectSingleTapActivates } from './support/touch';

// #5 PR 2: Viewer entry from a series page and the return to it, on a
// published series long enough to scroll, on both #1 projects. Enter on the
// cover or an entry opens the intercepted Viewer (#9), and so does one tap.
// Closing it by Close, Escape, or one Back, after moves or none, lands on the
// series at the same scroll position with focus on the link that opened it.
// After a reload on the Viewer, which makes it a page, one Back loads the
// series again and puts the scroll position and focus back from the series'
// own history entry. A reload of the series page itself moves no focus.

test.describe.configure({ mode: 'serial' });

/** Above the catalog, the publish, and a server start, so a slow start fails in startCatalogServer, which stops its child. */
const HOOK_TIMEOUT = READY_TIMEOUT + 60_000;
const COUNT = 18;

const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = Array.from({ length: COUNT }, (_, n) => id(n + 1));
/** The cover, third in the sequence. */
const COVER = P[2];
/** An entry far enough down that it's below the first screen on both projects. */
const DEEP = P[COUNT - 3];
const SERIES = '/work/long';
const viewerPath = (photoId: string) => `${SERIES}/photo/${photoId}`;

let catalog: TestCatalog | undefined;
let server: CatalogServer | undefined;

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    // Small photos: the variants are never enlarged, so the fixture encodes fast.
    catalog = await createTestCatalog({
        seed: 52,
        withAssets: true,
        photos: P.map((photoId) => ({ id: photoId, width: 900, height: 600 })),
        series: [{ id: 'ser_e2e-long', slug: 'long', title: 'Fixture long', statement: 'A series long enough to scroll.', photoIds: P, cover: { photoId: COVER } }],
    });
    const outcome = await publish({ dataRoot: catalog.root, actor: 'e2e', confirmLaunch: true, logger: { log: () => undefined } });
    expect(outcome.outcome, outcome.message).toBe('PUBLISHED');
    // E2E_CATALOG_PORT pins a port per worker, for a machine that hands out ranges. The config's
    // catalog Home server listens on E2E_CATALOG_PORT itself, so the workers start one above it.
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
const entry = (page: Page, photoId: string) => page.locator(`[id="photo-${photoId}"]`);
const cover = (page: Page) => page.locator('#series-cover');
const dialog = (page: Page) => page.getByRole('dialog', { name: /^Fixture long/ });
const scrollY = (page: Page) => page.evaluate(() => window.scrollY);

async function openSeries(page: Page): Promise<void> {
    await page.goto(`${origin()}${SERIES}`);
    await waitForHydration(page);
    await expect(page.getByRole('main').locator('ol > li > a')).toHaveCount(COUNT);
}

/** Whether `link` is at least partly in the viewport. */
const inView = (link: Locator) => link.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.bottom > 0 && box.top < window.innerHeight;
});

/** Scrolls `link` into view and returns the page's offset, which has to be past the first screen for the check to mean anything. */
async function scrollTo(page: Page, link: Locator): Promise<number> {
    await link.scrollIntoViewIfNeeded();
    const offset = await scrollY(page);
    expect(offset, 'the entry sits below the first screen').toBeGreaterThan(200);
    return offset;
}

/** Back on the series, with focus on `opener`, at `offset` within a pixel, and `opener` in view. */
async function expectReturned(page: Page, opener: Locator, offset: number): Promise<void> {
    await expect(page).toHaveURL(`${origin()}${SERIES}`);
    await expect(page.locator('dialog')).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect.poll(async () => Math.abs((await scrollY(page)) - offset), { message: `scroll offset near ${offset}` }).toBeLessThanOrEqual(1);
    expect(await inView(opener)).toBe(true);
}

/** Opens the Viewer from `opener` with Enter, as the modal over the series. */
async function enter(page: Page, opener: Locator, photoId: string): Promise<void> {
    await opener.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${origin()}${viewerPath(photoId)}`);
    await expect(dialog(page)).toBeVisible();
}

test.describe('the intercepted Viewer over the series page', () => {
    test('Enter on the cover opens its photograph, and Escape puts focus back on the cover, not its entry', async ({ page }) => {
        await openSeries(page);
        await expect(cover(page)).toHaveAttribute('href', viewerPath(COVER));
        await enter(page, cover(page), COVER);
        await expect(dialog(page)).toHaveAccessibleName(new RegExp(`Photograph 3 of ${COUNT}$`));
        await page.keyboard.press('Escape');
        await expectReturned(page, cover(page), 0);
    });

    test('Enter on an entry far down opens its photograph, and Close lands on the series at the same place with focus on that entry', async ({ page }) => {
        await openSeries(page);
        const offset = await scrollTo(page, entry(page, DEEP));
        await enter(page, entry(page, DEEP), DEEP);
        await dialog(page).getByRole('button', { name: 'Close' }).click();
        await expectReturned(page, entry(page, DEEP), offset);
    });

    test('Back after moves inside the modal is one step to the series, at the same place, with focus on the original opener', async ({ page }) => {
        await openSeries(page);
        const offset = await scrollTo(page, entry(page, DEEP));
        await enter(page, entry(page, DEEP), DEEP);
        const length = await page.evaluate(() => history.length);
        await page.keyboard.press('ArrowRight');
        await expect(page).toHaveURL(`${origin()}${viewerPath(P[COUNT - 2])}`);
        await page.keyboard.press('ArrowRight');
        await expect(page).toHaveURL(`${origin()}${viewerPath(P[COUNT - 1])}`);
        // Previous and Next replace the Viewer's entry, so one Back still reaches the series (#7's history note).
        expect(await page.evaluate(() => history.length)).toBe(length);
        await page.goBack();
        await expectReturned(page, entry(page, DEEP), offset);
    });

    test('the page moved under the modal comes back to where it was when the modal closes', async ({ page }) => {
        await openSeries(page);
        const offset = await scrollTo(page, entry(page, DEEP));
        await enter(page, entry(page, DEEP), DEEP);
        // The document behind a modal dialog still scrolls (a wheel over the backdrop, or a script). Move it to the top.
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        expect(await scrollY(page)).toBe(0);
        await page.keyboard.press('Escape');
        await expectReturned(page, entry(page, DEEP), offset);
    });

    test('the series\' history entry keeps Next\'s router keys beside the return record', async ({ page }) => {
        await openSeries(page);
        await scrollTo(page, entry(page, DEEP));
        await enter(page, entry(page, DEEP), DEEP);
        await page.goBack();
        await expect(entry(page, DEEP)).toBeFocused();
        const state = await page.evaluate(() => history.state as { __NA?: unknown; __PRIVATE_NEXTJS_INTERNALS_TREE?: unknown; kgSeriesReturn?: { photoId?: unknown; opener?: unknown } });
        expect(state.__NA).toBe(true);
        expect(state.__PRIVATE_NEXTJS_INTERNALS_TREE).toBeTruthy();
        expect(state.kgSeriesReturn).toEqual(expect.objectContaining({ photoId: DEEP, opener: 'entry' }));
    });
});

test.describe('Back to the series from a Viewer page', () => {
    test('a reload on the Viewer, a move, then Back loads the series at the same place with focus on the entry that opened it', async ({ page }) => {
        await openSeries(page);
        const offset = await scrollTo(page, entry(page, DEEP));
        await enter(page, entry(page, DEEP), DEEP);
        await page.reload();
        await waitForHydration(page);
        // A reload makes the Viewer a page (#9).
        await expect(page.locator('[data-surface="viewer"]')).toHaveAttribute('data-viewer-mode', 'page');
        await page.getByRole('button', { name: 'Next photograph' }).click();
        await expect(page).toHaveURL(`${origin()}${viewerPath(P[COUNT - 2])}`);
        await page.goBack();
        await waitForHydration(page);
        await expectReturned(page, entry(page, DEEP), offset);
    });

    test('opened from the cover, a reload on the Viewer and Back put focus back on the cover', async ({ page }) => {
        await openSeries(page);
        await enter(page, cover(page), COVER);
        await page.reload();
        await waitForHydration(page);
        await page.goBack();
        await waitForHydration(page);
        await expectReturned(page, cover(page), 0);
    });

    test('a reload of the series page itself moves no focus, even with a return record in its entry', async ({ page }) => {
        await openSeries(page);
        await scrollTo(page, entry(page, DEEP));
        await enter(page, entry(page, DEEP), DEEP);
        await page.goBack();
        await expect(entry(page, DEEP)).toBeFocused();
        await page.reload();
        await waitForHydration(page);
        expect(await page.evaluate(() => (history.state as { kgSeriesReturn?: unknown } | null)?.kgSeriesReturn)).toBeTruthy();
        // Give a restore that shouldn't happen time to run.
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    });
});

test.describe('touch', () => {
    test.skip(({ hasTouch }) => !hasTouch, 'Touch runs on the mobile project.');

    test('one tap on the cover opens its photograph, and Back returns focus to the cover', async ({ page }) => {
        await openSeries(page);
        await expectSingleTapActivates(cover(page), () => expect(dialog(page)).toBeVisible());
        await expect(page).toHaveURL(`${origin()}${viewerPath(COVER)}`);
        await page.goBack();
        await expectReturned(page, cover(page), 0);
    });

    test('one tap on an entry far down opens its photograph, and a tap on Close lands at the same place on that entry', async ({ page }) => {
        await openSeries(page);
        const offset = await scrollTo(page, entry(page, DEEP));
        await expectSingleTapActivates(entry(page, DEEP), () => expect(dialog(page)).toBeVisible());
        await expect(page).toHaveURL(`${origin()}${viewerPath(DEEP)}`);
        await dialog(page).getByRole('button', { name: 'Close' }).tap();
        await expectReturned(page, entry(page, DEEP), offset);
    });
});
