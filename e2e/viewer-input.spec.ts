import type { Page, TestInfo } from '@playwright/test';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';
import { HARBOR, SHAPES, href, useViewerCatalog } from './support/viewerCatalog';

// #178, #174: the Viewer's input, on #7's published fixture. A mouse drag never swipes (bug 4), held keys move
// once, Escape while zoomed only resets the zoom, a move is busy until it lands, an offline move stays and says so,
// saveData skips the idle prefetch, Back then Forward reopens the modal, and the controls hold at five named
// viewports. Bug 3's end message is in viewer-touch.spec.ts, on all three projects; the publish mid-visit (bug 5) and
// the unavailable photograph are in viewer-revision.spec.ts, which publishes its own catalog.

test.describe.configure({ mode: 'serial' });

const origin = useViewerCatalog();

const viewer = (page: Page) => page.locator('[data-surface="viewer"]');
const header = (page: Page) => viewer(page).locator('header');
const button = (page: Page, name: string) => viewer(page).getByRole('button', { name, exact: true });
const stage = (page: Page) => viewer(page).locator('[data-viewer-stage]');
const announcer = (page: Page) => viewer(page).locator('[data-viewer-announcer]');
const dialog = (page: Page) => page.getByRole('dialog', { name: /^Fixture harbor/ });
const entry = (page: Page, photoId: string) => page.locator(`[id="photo-${photoId}"]`);

function runsOn(testInfo: TestInfo, ...projects: string[]): void {
    test.skip(!projects.includes(testInfo.project.name), `Runs on ${projects.join(' and ')}.`);
}

async function openPage(page: Page, photoId: string, slug = 'harbor'): Promise<void> {
    await page.goto(`${origin()}${href(photoId, slug)}`);
    await waitForHydration(page);
    await expect(header(page).getByRole('heading', { level: 1 })).toBeVisible();
}

async function openFromSeries(page: Page, photoId: string): Promise<void> {
    await page.goto(`${origin()}/work/harbor`);
    await waitForHydration(page);
    await entry(page, photoId).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${origin()}${href(photoId)}`);
    await expect(dialog(page)).toBeVisible();
}

/** Turns `navigator.connection.saveData` on before the page's own scripts, so the Viewer prefetches nothing (#174). */
async function saveData(page: Page): Promise<void> {
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true, addEventListener() {}, removeEventListener() {} } });
    });
}

/** The RSC requests for a Viewer page of `photoIds`: a move's, or the idle prefetch's. */
function rscRequests(page: Page, photoIds: readonly string[]): () => string[] {
    const seen: string[] = [];
    const paths = new Set(photoIds.map((photoId) => href(photoId)));
    page.on('request', (request) => {
        const url = new URL(request.url());
        if (paths.has(url.pathname) && request.resourceType() !== 'document') seen.push(url.pathname);
    });
    return () => seen;
}

/** Nothing moved for a beat: a negative check has to give the move time to have started. */
async function holdsStill(page: Page, photoId: string, counter: string, slug = 'harbor'): Promise<void> {
    await page.waitForTimeout(600);
    await expect(page).toHaveURL(`${origin()}${href(photoId, slug)}`);
    await expect(header(page)).toContainText(counter);
}

test.describe('a mouse drag never swipes (bug 4)', () => {
    test.beforeEach(() => runsOn(test.info(), 'desktop'));

    test('a mouse drag across the stage, started off the photograph, leaves the Viewer where it was', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await openPage(page, SHAPES[1], 'shapes');
        // Off the <img>: the image is draggable, so a drag from it could become the browser's own image drag and pass
        // before the fix. Halfway between the stage's left edge and the photograph, where the stage itself is hit.
        const stageBox = await stage(page).boundingBox();
        const current = await viewer(page).locator('[data-viewer-current]').boundingBox();
        if (!stageBox || !current) throw new Error('The stage and the photograph have boxes');
        const at = { x: (stageBox.x + current.x) / 2, y: current.y + current.height / 2 };
        expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.hasAttribute('data-viewer-stage') ?? false, at)).toBe(true);
        await page.mouse.move(at.x, at.y);
        await page.mouse.down();
        await page.mouse.move(at.x - 150, at.y, { steps: 8 });
        await page.mouse.up();
        await holdsStill(page, SHAPES[1], '02 / 03', 'shapes');
        await expect(viewer(page)).toHaveAttribute('data-gesture', 'idle');
    });
});

test.describe('keys (#178)', () => {
    test.beforeEach(() => runsOn(test.info(), 'desktop', 'mobile'));

    test('holding an arrow moves once: its auto-repeats do nothing', async ({ page }) => {
        await openPage(page, HARBOR[0]);
        await page.keyboard.down('ArrowRight');
        await expect(page).toHaveURL(`${origin()}${href(HARBOR[1])}`);
        // Playwright marks every later down of a held key as a repeat, as the browser's own auto-repeat is.
        for (let i = 0; i < 3; i++) await page.keyboard.down('ArrowRight');
        await page.keyboard.up('ArrowRight');
        await holdsStill(page, HARBOR[1], '02 / 03');
    });

    test('on a page, Escape while zoomed resets the zoom and never leaves', async ({ page }) => {
        await openPage(page, HARBOR[0]);
        await button(page, 'Zoom').click();
        await stage(page).focus();
        await page.keyboard.press('Escape');
        await expect(stage(page)).not.toHaveAttribute('data-zoomed');
        await expect(button(page, 'Zoom')).toBeFocused();
        await holdsStill(page, HARBOR[0], '01 / 03');
    });
});

test.describe('Escape while zoomed in the modal (#178)', () => {
    // WebKit too: its dialog sends its own cancel for Escape, so there the modal could close instead of the zoom resetting.
    test.beforeEach(() => runsOn(test.info(), 'desktop', 'mobile', 'mobile-webkit'));

    test('in the modal, Escape while zoomed only resets the zoom, with focus from the zoomed region onto Zoom; the next Escape closes', async ({ page }) => {
        await openFromSeries(page, HARBOR[0]);
        await button(page, 'Zoom').focus();
        await page.keyboard.press('Enter');
        await expect(stage(page)).toHaveAttribute('data-zoomed', 'true');
        await stage(page).focus();
        await page.keyboard.press('Escape');
        await expect(stage(page)).not.toHaveAttribute('data-zoomed');
        await expect(dialog(page)).toBeVisible();
        await expect(page).toHaveURL(`${origin()}${href(HARBOR[0])}`);
        await expect(button(page, 'Zoom')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(page).toHaveURL(`${origin()}/work/harbor`);
        await expect(entry(page, HARBOR[0])).toBeFocused();
    });
});

test.describe('a move (#178)', () => {
    test.beforeEach(() => runsOn(test.info(), 'desktop', 'mobile'));

    test('the stage is aria-busy from the press until the photograph lands, and the move is announced in full', async ({ page }) => {
        // Nothing prefetched, so the move waits for its page, and every aria-busy change on the stage is recorded as it
        // happens, so the check doesn't depend on how long the page takes to arrive.
        await saveData(page);
        await openPage(page, HARBOR[1]);
        await expect(stage(page)).not.toHaveAttribute('aria-busy');
        await viewer(page).evaluate((root) => {
            const seen: string[] = [];
            (window as unknown as { kgBusy: string[] }).kgBusy = seen;
            new MutationObserver((records) => {
                for (const record of records) {
                    const target = record.target as Element;
                    if (record.attributeName === 'aria-busy' && target.hasAttribute('data-viewer-stage')) seen.push(target.getAttribute('aria-busy') ?? 'none');
                }
            }).observe(root, { attributes: true, attributeFilter: ['aria-busy'], subtree: true });
        });
        await button(page, 'Previous photograph').click();
        await expect(page).toHaveURL(`${origin()}${href(HARBOR[0])}`);
        await expect(header(page)).toContainText('01 / 03');
        await expect(stage(page)).not.toHaveAttribute('aria-busy');
        expect(await page.evaluate(() => (window as unknown as { kgBusy: string[] }).kgBusy[0])).toBe('true');
        // The fixture's first photograph has a title and a description, so the whole message is pinned here.
        await expect(announcer(page)).toHaveText('Photograph 1 of 3. Fixture harbor at dusk. Fixture description of the harbor.');
    });

    test('offline, a move says so by the controls and in the region, and doesn\'t navigate; back online it moves', async ({ page, context }) => {
        await openPage(page, HARBOR[1]);
        await context.setOffline(true);
        await button(page, 'Next photograph').click();
        const notice = viewer(page).locator('[data-viewer-offline]');
        await expect(notice).toHaveText("You're offline. The next photograph couldn't load.");
        await expect(notice).toBeInViewport();
        await expect(announcer(page)).toHaveText("You're offline. The next photograph couldn't load.");
        await page.keyboard.press('ArrowLeft');
        await expect(notice).toHaveText("You're offline. The previous photograph couldn't load.");
        await holdsStill(page, HARBOR[1], '02 / 03');
        await context.setOffline(false);
        await expect(notice).toHaveCount(0);
        await button(page, 'Next photograph').click();
        await expect(page).toHaveURL(`${origin()}${href(HARBOR[2])}`);
    });
});

test.describe('saveData (#174)', () => {
    test.beforeEach(() => runsOn(test.info(), 'desktop', 'mobile'));

    test('with saveData on, the Viewer prefetches no neighbour page; with it off, it does', async ({ page, browser }) => {
        await saveData(page);
        const saving = rscRequests(page, [HARBOR[0], HARBOR[2]]);
        await openPage(page, HARBOR[1]);
        // The idle prefetch runs within the idle callback's 2 s timeout, or 200 ms where there's none.
        await page.waitForTimeout(3000);
        expect(saving()).toEqual([]);

        const plain = await browser.newPage();
        try {
            const prefetched = rscRequests(plain, [HARBOR[0], HARBOR[2]]);
            await plain.goto(`${origin()}${href(HARBOR[1])}`);
            await waitForHydration(plain);
            await expect.poll(() => new Set(prefetched()).size, { timeout: 10_000 }).toBe(2);
        } finally {
            await plain.close();
        }
    });
});

test.describe('history (#178)', () => {
    test('Back then Forward reopens the modal, named, over the series', async ({ page }) => {
        await openFromSeries(page, HARBOR[0]);
        await page.goBack();
        await expect(page).toHaveURL(`${origin()}/work/harbor`);
        await expect(page.locator('dialog[open]')).toHaveCount(0);
        await page.goForward();
        await expect(page).toHaveURL(`${origin()}${href(HARBOR[0])}`);
        await expect(dialog(page)).toBeVisible();
        await expect(dialog(page)).toHaveAccessibleName(/photograph 1 of 3$/);
        // The series stays under it, inert.
        await expect(page.locator('main h1#series-title')).toHaveCount(1);
    });
});

test.describe('five named viewports (#178)', () => {
    test.beforeEach(() => runsOn(test.info(), 'desktop'));

    const VIEWPORTS = [
        { name: 'small phone', width: 320, height: 568 },
        { name: 'phone', width: 390, height: 844 },
        { name: 'phone landscape', width: 844, height: 390 },
        { name: 'tablet', width: 768, height: 1024 },
        { name: 'laptop', width: 1280, height: 800 },
    ] as const;

    for (const size of VIEWPORTS) {
        test(`at ${size.name} (${size.width} by ${size.height}), Close, Zoom, Previous and Next are in view, nothing scrolls sideways, and a move works`, async ({ page }) => {
            await page.setViewportSize({ width: size.width, height: size.height });
            await openPage(page, HARBOR[1]);
            for (const name of ['Zoom', 'Previous photograph', 'Next photograph']) await expect(button(page, name)).toBeInViewport();
            await expect(viewer(page).getByRole('link', { name: 'Close' })).toBeInViewport();
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
            await button(page, 'Next photograph').click();
            await expect(page).toHaveURL(`${origin()}${href(HARBOR[2])}`);
            await expect(button(page, 'Next photograph')).toBeInViewport();
        });
    }
});
