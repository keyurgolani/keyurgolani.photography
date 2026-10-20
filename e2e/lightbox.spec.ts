import type { Page } from '@playwright/test';
import { expectHoverRulesGated } from './support/hover';
import { waitForHydration } from './support/hydration';
import { checkSurface } from './support/surface';
import { expect, test } from './support/test';
import { expectSingleTapActivates } from './support/touch';

const entries = (page: Page) => page.getByRole('button', { name: /^Photograph \d+ of 12$/ });
const lightbox = (page: Page) => page.getByRole('dialog', { name: 'Lightbox' });
const control = (page: Page, name: string) => lightbox(page).getByRole('button', { name, exact: true });
const enabledControls = (page: Page) => lightbox(page).getByRole('button', { disabled: false });
const currentThumbnail = (page: Page) => page.locator('.yarl__thumbnails_thumbnail[aria-current="true"]');

// ThemeToggle and BottomBar paint under the YARL portal, so the lightbox's own toolbar and thumbnail strip are its chrome.
const chrome = (page: Page) => [page.locator('.yarl__toolbar'), page.locator('.yarl__thumbnails_container')];

/** The scale() of the current slide's zoom wrapper. */
const zoomLevel = (page: Page) =>
    page.locator('.yarl__slide_current .yarl__slide_wrapper').evaluate((el: HTMLElement) => Number(/scale\(([\d.]+)\)/.exec(el.style.transform)?.[1] ?? 1));

/** The aria-label of whatever has focus. */
const focusedLabel = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName);

async function openGallery(page: Page, theme: 'dark' | 'light') {
    if (theme === 'light') await page.addInitScript(() => localStorage.setItem('theme', 'light'));
    await page.goto('/gallery');
    await waitForHydration(page);
    await expect(entries(page)).toHaveCount(12);
}

/** Waits until the lightbox has faded in and nothing in it is still animating. */
async function settle(page: Page) {
    await expect(page.locator('.yarl__portal_open')).toHaveCSS('opacity', '1');
    await expect
        .poll(() => page.locator('.yarl__portal').evaluate((root) => root.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length))
        .toBe(0);
}

/** Opens photo `position` with Enter on its tile. */
async function openLightbox(page: Page, { position = 1, theme = 'dark' }: { position?: number; theme?: 'dark' | 'light' } = {}) {
    await openGallery(page, theme);
    await entries(page).nth(position - 1).focus();
    await page.keyboard.press('Enter');
    await settle(page);
}

for (const viewport of [undefined, { width: 640, height: 400 }]) {
    test.describe(viewport ? 'at 640 by 400, which is 200% zoom' : 'at the project viewport', () => {
        if (viewport) test.use({ viewport });

        for (const theme of ['dark', 'light'] as const) {
            test(`passes the surface checks on every enabled control in the ${theme} theme`, async ({ page }) => {
                await openLightbox(page, { theme });
                await checkSurface(page, { controls: [enabledControls(page)], chrome: chrome(page) });
            });
        }
    });
}

test('Tab and Shift+Tab reach every enabled control', async ({ page }) => {
    await openLightbox(page);
    const labels = await enabledControls(page).evaluateAll((elements) => elements.map((el) => el.getAttribute('aria-label')));
    expect(labels).toEqual(expect.arrayContaining(['Previous', 'Next', 'Zoom in', 'Play', 'Close', '1 of 12']));
    await enabledControls(page).first().focus();
    const forward = [await focusedLabel(page)];
    for (let press = 1; press < labels.length; press++) {
        await page.keyboard.press('Tab');
        forward.push(await focusedLabel(page));
    }
    expect(forward).toEqual(labels);
    const back: (string | null | undefined)[] = [];
    for (let press = 1; press < labels.length; press++) {
        await page.keyboard.press('Shift+Tab');
        back.push(await focusedLabel(page));
    }
    expect(back).toEqual(labels.slice(0, -1).reverse());
});

test('Previous, Next, and a thumbnail move the current photo with Enter and with Space', async ({ page }) => {
    await openLightbox(page, { position: 2 });
    await expect(currentThumbnail(page)).toHaveAccessibleName('2 of 12');
    const presses: [string, string, string][] = [
        ['Next', 'Enter', '3 of 12'],
        ['Next', 'Space', '4 of 12'],
        ['Previous', 'Enter', '3 of 12'],
        ['Previous', 'Space', '2 of 12'],
        ['3 of 12', 'Enter', '3 of 12'],
        ['2 of 12', 'Space', '2 of 12'],
    ];
    for (const [name, key, current] of presses) {
        await control(page, name).focus();
        await page.keyboard.press(key);
        await expect(currentThumbnail(page)).toHaveAccessibleName(current);
    }
});

test('Zoom in and Zoom out change the scale with Enter and with Space', async ({ page }) => {
    await openLightbox(page);
    await expect(control(page, 'Zoom in')).toBeEnabled();
    let level = await zoomLevel(page);
    for (const [name, key] of [['Zoom in', 'Enter'], ['Zoom in', 'Space'], ['Zoom out', 'Enter'], ['Zoom out', 'Space']] as const) {
        await control(page, name).focus();
        await page.keyboard.press(key);
        const before = level;
        await expect.poll(() => zoomLevel(page)).not.toBe(before);
        level = await zoomLevel(page);
        expect(name === 'Zoom in' ? level > before : level < before, `${name} with ${key} moves the scale from ${before} to ${level}`).toBe(true);
    }
});

test('Play and Pause swap with Enter and with Space', async ({ page }) => {
    await openLightbox(page);
    await control(page, 'Play').focus();
    await page.keyboard.press('Enter');
    await expect(control(page, 'Pause')).toBeFocused();
    await page.keyboard.press('Space');
    await expect(control(page, 'Play')).toBeFocused();
});

test('Close shuts the lightbox with Enter and with Space', async ({ page }) => {
    await openLightbox(page);
    for (const key of ['Enter', 'Space']) {
        if (key === 'Space') {
            await entries(page).first().focus();
            await page.keyboard.press('Enter');
            await settle(page);
        }
        await control(page, 'Close').focus();
        await page.keyboard.press(key);
        await expect(lightbox(page)).toBeHidden();
    }
});

test('Escape returns focus to the photo that opened the lightbox, after a slide change too', async ({ page }) => {
    await openLightbox(page, { position: 2 });
    await page.keyboard.press('ArrowRight');
    await expect(currentThumbnail(page)).toHaveAccessibleName('3 of 12');
    await page.keyboard.press('Escape');
    await expect(lightbox(page)).toBeHidden();
    await expect(entries(page).nth(1)).toBeFocused();
});

test('Close returns focus to the photo a mouse click opened', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile', 'Mouse clicks run on the desktop project.');
    await openGallery(page, 'dark');
    await entries(page).nth(4).click();
    await settle(page);
    await control(page, 'Close').click();
    await expect(lightbox(page)).toBeHidden();
    await expect(entries(page).nth(4)).toBeFocused();
});

test('Close returns focus to the photo a tap opened', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'Taps run on the touch project.');
    await openGallery(page, 'dark');
    await entries(page).nth(3).tap();
    await settle(page);
    await control(page, 'Close').tap();
    await expect(lightbox(page)).toBeHidden();
    await expect(entries(page).nth(3)).toBeFocused();
});

test('one tap on a toolbar button activates it and leaves it untransformed', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'Taps run on the touch project.');
    await openGallery(page, 'dark');
    await entries(page).first().tap();
    await settle(page);
    await expectSingleTapActivates(control(page, 'Play'), () => expect(control(page, 'Pause')).toBeVisible());
    // :active scales the button during the press. A sticky hover style would never settle back to none.
    await expect.poll(() => control(page, 'Pause').evaluate((el) => getComputedStyle(el).transform)).toBe('none');
});

test('every app hover rule in the lightbox waits for a fine pointer', async ({ page }) => {
    await openLightbox(page);
    await expectHoverRulesGated(page);
});
