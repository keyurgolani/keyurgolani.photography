import type { Page } from '@playwright/test';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';
import { HARBOR, P, href, useViewerCatalog } from './support/viewerCatalog';

// #9 PR 1: the Viewer's semantics, keys, and focus, on #7's published
// fixture, on both #1 projects. A directly loaded Viewer is a page: no
// dialog, nothing inert, focus left alone, Escape never leaves, and
// Previous and Next keep focus on the same element across moves, with each
// move and each end announced politely. Opened from #5's series page, the
// Viewer is a native modal dialog with a name: focus moves in, Tab stays
// inside, and Close, Escape, and Back each leave it in one step, with focus
// back on the exact link that opened it, however many moves came between.

test.describe.configure({ mode: 'serial' });

const origin = useViewerCatalog();

const viewer = (page: Page) => page.locator('[data-surface="viewer"]');
const control = (page: Page, name: string) => viewer(page).getByRole('button', { name, exact: true });
const announcer = (page: Page) => viewer(page).locator('[data-viewer-announcer]');
const position = (page: Page) => viewer(page).locator('header');

/** Marks the focused element, so a later check can tell it's the same node, not a copy focused again. */
async function markFocused(page: Page): Promise<void> {
    await page.evaluate(() => {
        (window as unknown as { kgFocused: Element | null }).kgFocused = document.activeElement;
    });
}

async function focusIsMarked(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        const marked = (window as unknown as { kgFocused: Element | null }).kgFocused;
        return marked !== null && marked.isConnected && document.activeElement === marked;
    });
}

/** What holds focus: inside the Viewer, on the body, or somewhere else on the page. */
async function focusPlace(page: Page): Promise<'viewer' | 'body' | string> {
    return page.evaluate(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) return 'body';
        if (active.closest('[data-surface="viewer"]')) return 'viewer';
        return active.outerHTML.slice(0, 120);
    });
}

test.describe('a directly loaded Viewer is a page', () => {
    test('page semantics: a main with one h1 and a visible series link, no dialog, nothing inert, and focus left alone', async ({ page }) => {
        await page.goto(`${origin()}${href(P[1])}`);
        await waitForHydration(page);
        await expect(viewer(page)).toHaveCount(1);
        expect(await viewer(page).evaluate((root) => root.tagName)).toBe('MAIN');
        await expect(viewer(page)).toHaveAttribute('data-viewer-mode', 'page');
        await expect(page.locator('dialog, [role="dialog"], [aria-modal]')).toHaveCount(0);
        await expect(page.locator('[inert]')).toHaveCount(0);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(['Fixture harbor']);
        await expect(viewer(page).getByRole('link', { name: 'Close' })).toBeVisible();
        await expect(viewer(page).getByRole('link', { name: 'Close' })).toHaveAttribute('href', '/work/harbor');
        // A page moves no focus on load.
        expect(await focusPlace(page)).toBe('body');
        // The region is there and empty, so the first move is a change it announces.
        await expect(announcer(page)).toHaveAttribute('aria-live', 'polite');
        await expect(announcer(page)).toHaveText('');
    });

    test('Escape never leaves a page, from the document or from a control', async ({ page }) => {
        await page.goto(`${origin()}/`);
        await page.goto(`${origin()}${href(P[1])}`);
        await waitForHydration(page);
        await page.keyboard.press('Escape');
        await control(page, 'Next photograph').focus();
        await page.keyboard.press('Escape');
        await expect(page).toHaveURL(`${origin()}${href(P[1])}`);
        await expect(control(page, 'Next photograph')).toBeFocused();
    });

    test('Next keeps focus on the same button across moves and announces each one, and the end announces itself and stays', async ({ page }) => {
        await page.goto(`${origin()}${href(P[0])}`);
        await waitForHydration(page);
        const length = await page.evaluate(() => history.length);
        await control(page, 'Next photograph').focus();
        await markFocused(page);
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(`${origin()}${href(P[1])}`);
        await expect(position(page)).toContainText('02 / 03');
        await expect(announcer(page)).toHaveText('Photograph 2 of 3');
        expect(await focusIsMarked(page), 'focus stays on the same Next, never a copy').toBe(true);
        await page.keyboard.press('Enter');
        await expect(position(page)).toContainText('03 / 03');
        await expect(announcer(page)).toHaveText('Photograph 3 of 3');
        expect(await focusIsMarked(page)).toBe(true);
        // The end: focusable, aria-disabled, and pressing it moves nothing.
        await expect(control(page, 'Next photograph')).toHaveAttribute('aria-disabled', 'true');
        await page.keyboard.press('Enter');
        await expect(announcer(page)).toHaveText('Last photograph in Fixture harbor.');
        await expect(page).toHaveURL(`${origin()}${href(P[2])}`);
        expect(await focusIsMarked(page)).toBe(true);
        // Moves on a page stay a page: no dialog, and no history entries.
        await expect(page.locator('dialog')).toHaveCount(0);
        await expect(viewer(page)).toHaveAttribute('data-viewer-mode', 'page');
        expect(await page.evaluate(() => history.length)).toBe(length);
    });

    test('Left and Right move, an end announces itself, and modified arrows and a zoomed photograph never move', async ({ page }) => {
        await page.goto(`${origin()}${href(P[0])}`);
        await waitForHydration(page);
        await page.keyboard.press('ArrowLeft');
        await expect(announcer(page)).toHaveText('First photograph in Fixture harbor.');
        await expect(page).toHaveURL(`${origin()}${href(P[0])}`);
        await page.keyboard.press('ArrowRight');
        await expect(page).toHaveURL(`${origin()}${href(P[1])}`);
        await expect(announcer(page)).toHaveText('Photograph 2 of 3');
        for (const chord of ['Alt+ArrowRight', 'Shift+ArrowRight', 'Control+ArrowRight', 'Meta+ArrowRight', 'Shift+ArrowLeft']) {
            await page.keyboard.press(chord);
            await expect(position(page), chord).toContainText('02 / 03');
        }
        await expect(page).toHaveURL(`${origin()}${href(P[1])}`);
        // Focus on Zoom stays on Zoom across an arrow move, since Zoom outlives the photograph too.
        const zoom = control(page, 'Zoom');
        await zoom.focus();
        await markFocused(page);
        await page.keyboard.press('ArrowLeft');
        await expect(page).toHaveURL(`${origin()}${href(P[0])}`);
        expect(await focusIsMarked(page)).toBe(true);
        // Zoomed, the arrows belong to the photograph's scroll region.
        await page.keyboard.press('Enter');
        await expect(zoom).toHaveAttribute('aria-pressed', 'true');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await expect(page).toHaveURL(`${origin()}${href(P[0])}`);
        await expect(zoom).toHaveAttribute('aria-pressed', 'true');
        // Next resets zoom and moves in one press.
        await control(page, 'Next photograph').click();
        await expect(page).toHaveURL(`${origin()}${href(P[1])}`);
        await expect(zoom).toHaveAttribute('aria-pressed', 'false');
    });

    test('a refresh after moves loads the same photograph as a page', async ({ page }) => {
        await page.goto(`${origin()}${href(P[0])}`);
        await waitForHydration(page);
        await control(page, 'Next photograph').click();
        await expect(page).toHaveURL(`${origin()}${href(P[1])}`);
        await page.reload();
        await waitForHydration(page);
        await expect(position(page)).toContainText('02 / 03');
        await expect(viewer(page)).toHaveAttribute('data-viewer-mode', 'page');
        await expect(page.locator('dialog')).toHaveCount(0);
    });
});

test.describe('opened from the series page, the Viewer is a modal dialog', () => {
    const seriesUrl = () => `${origin()}/work/harbor`;
    const entry = (page: Page, photoId: string) => page.locator(`[id="photo-${photoId}"]`);
    const dialog = (page: Page) => page.getByRole('dialog', { name: /^Fixture harbor/ });

    async function openFromSeries(page: Page, photoId: string): Promise<void> {
        await page.goto(seriesUrl());
        await waitForHydration(page);
        await entry(page, photoId).click();
        await expect(page).toHaveURL(`${origin()}${href(photoId)}`);
        await expect(dialog(page)).toBeVisible();
    }

    test('opens as a named modal dialog over the series, with focus moved inside onto Close', async ({ page }) => {
        await openFromSeries(page, P[1]);
        await expect(dialog(page)).toHaveAccessibleName(/^Fixture harbor\s*Photograph 2 of 3$/);
        expect(await dialog(page).evaluate((element) => element.matches('dialog:modal'))).toBe(true);
        await expect(dialog(page)).toHaveAttribute('data-surface', 'viewer');
        await expect(dialog(page).getByRole('button', { name: 'Close' })).toBeFocused();
        // The series page is still there, under the dialog, so focus can return to it.
        await expect(entry(page, P[1])).toBeAttached();
    });

    test('Tab and Shift+Tab never leave the dialog for the series page behind it', async ({ page }) => {
        await openFromSeries(page, P[1]);
        // Close, Zoom, Previous, Next, the technical toggle: one more than twice the count wraps every way out.
        for (const key of ['Tab', 'Shift+Tab']) {
            for (let press = 0; press < 11; press++) {
                await page.keyboard.press(key);
                expect(['viewer', 'body'], `${key} ${press + 1}`).toContain(await focusPlace(page));
            }
        }
    });

    test('Escape closes it in one step, with focus back on the entry that opened it', async ({ page }) => {
        await openFromSeries(page, P[1]);
        await page.keyboard.press('Escape');
        await expect(page).toHaveURL(seriesUrl());
        await expect(page.locator('dialog')).toHaveCount(0);
        await expect(entry(page, P[1])).toBeFocused();
    });

    test('a quick double Escape closes once and stays on the series', async ({ page }) => {
        await page.goto(`${origin()}/`);
        await openFromSeries(page, P[1]);
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await expect(page).toHaveURL(seriesUrl());
        await expect(page.locator('dialog')).toHaveCount(0);
    });

    test('Close after moves goes back to the series, with focus on the original opener, not the last photograph', async ({ page }) => {
        await openFromSeries(page, HARBOR[0]);
        const next = dialog(page).getByRole('button', { name: 'Next photograph' });
        await next.focus();
        await markFocused(page);
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(`${origin()}${href(HARBOR[1])}`);
        await expect(dialog(page)).toHaveAccessibleName(/Photograph 2 of 3$/);
        await expect(dialog(page).locator('[data-viewer-announcer]')).toHaveText('Photograph 2 of 3');
        expect(await focusIsMarked(page)).toBe(true);
        await page.keyboard.press('ArrowRight');
        await expect(page).toHaveURL(`${origin()}${href(HARBOR[2])}`);
        expect(await focusIsMarked(page)).toBe(true);
        await dialog(page).getByRole('button', { name: 'Close' }).click();
        await expect(page).toHaveURL(seriesUrl());
        await expect(page.locator('dialog')).toHaveCount(0);
        await expect(entry(page, HARBOR[0])).toBeFocused();
    });

    test('Back after moves closes it in one step, with focus on the original opener', async ({ page }) => {
        await openFromSeries(page, HARBOR[0]);
        await dialog(page).getByRole('button', { name: 'Next photograph' }).click();
        await expect(page).toHaveURL(`${origin()}${href(HARBOR[1])}`);
        await page.goBack();
        await expect(page).toHaveURL(seriesUrl());
        await expect(page.locator('dialog')).toHaveCount(0);
        await expect(entry(page, HARBOR[0])).toBeFocused();
    });

    test('the ends inside the modal stay focusable and announce themselves', async ({ page }) => {
        await openFromSeries(page, HARBOR[0]);
        const previous = dialog(page).getByRole('button', { name: 'Previous photograph' });
        await expect(previous).toHaveAttribute('aria-disabled', 'true');
        await previous.focus();
        await page.keyboard.press('Enter');
        await expect(previous).toBeFocused();
        await expect(dialog(page).locator('[data-viewer-announcer]')).toHaveText('First photograph in Fixture harbor.');
        await expect(page).toHaveURL(`${origin()}${href(HARBOR[0])}`);
    });
});
