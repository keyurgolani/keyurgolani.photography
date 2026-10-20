import type { Page } from '@playwright/test';
import { expectContrastOverImage } from './support/contrast';
import { FIXTURE_CAPTION } from './support/fixtures';
import { expectHoverRulesGated } from './support/hover';
import { waitForHydration } from './support/hydration';
import { expectReachableWithin } from './support/keyboard';
import { expectReflow } from './support/reflow';
import { checkSurface } from './support/surface';
import { expect, test } from './support/test';
import { expectSingleTapActivates } from './support/touch';

const COUNT = 12;
const photoName = (position: number) => `Photograph ${position} of ${COUNT}`;

const entries = (page: Page) => page.getByRole('button', { name: /^Photograph \d+ of 12$/ });
const primary = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const navLinks = (page: Page) => primary(page).getByRole('link');
const themeToggle = (page: Page) => page.getByRole('button', { name: /^Switch to (dark|light) mode$/ });
const lightbox = (page: Page) => page.getByRole('dialog', { name: 'Lightbox' });

async function openGallery(page: Page, theme: 'dark' | 'light' = 'dark') {
    if (theme === 'light') await page.addInitScript(() => localStorage.setItem('theme', 'light'));
    await page.goto('/gallery');
    await waitForHydration(page);
    await expect(entries(page)).toHaveCount(COUNT);
}

/** Every stop on this page is named by its aria-label. */
const focusedLabel = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName);

for (const viewport of [undefined, { width: 640, height: 400 }]) {
    test.describe(viewport ? 'at 640 by 400, which is 200% zoom' : 'at the project viewport', () => {
        if (viewport) test.use({ viewport });

        for (const theme of ['dark', 'light'] as const) {
            test(`passes the surface checks in the ${theme} theme`, async ({ page }) => {
                await openGallery(page, theme);
                await checkSurface(page, {
                    entries: entries(page),
                    controls: [navLinks(page), themeToggle(page)],
                    chrome: [primary(page), themeToggle(page)],
                });
            });
        }
    });
}

test('Tab reaches the theme toggle, the Primary links, then each photo in order, and Shift+Tab walks back', async ({ page }) => {
    await openGallery(page);
    const stops = ['Switch to light mode', 'Gallery', 'Home', 'About', ...Array.from({ length: COUNT }, (_, index) => photoName(index + 1))];
    const forward: (string | undefined)[] = [];
    for (let press = 0; press < stops.length; press++) {
        await page.keyboard.press('Tab');
        forward.push(await focusedLabel(page));
    }
    expect(forward).toEqual(stops);
    const back: (string | undefined)[] = [];
    for (let press = 1; press < stops.length; press++) {
        await page.keyboard.press('Shift+Tab');
        back.push(await focusedLabel(page));
    }
    expect(back).toEqual(stops.slice(0, -1).reverse());
});

test('the Primary navigation is within 3 Tab presses of page load', async ({ page }) => {
    await openGallery(page);
    await expectReachableWithin(page, primary(page), 3);
});

test('Enter and Space on a photo open the lightbox on it', async ({ page }) => {
    await openGallery(page);
    for (const key of ['Enter', 'Space']) {
        await entries(page).nth(2).focus();
        await page.keyboard.press(key);
        await expect(lightbox(page)).toBeVisible();
        await expect(page.locator('.yarl__thumbnails_thumbnail[aria-current="true"]')).toHaveAccessibleName('3 of 12');
        await page.keyboard.press('Escape');
        await expect(lightbox(page)).toBeHidden();
    }
});

test('Enter and Space on the theme toggle flip the theme', async ({ page }) => {
    await openGallery(page);
    const html = page.locator('html');
    await themeToggle(page).focus();
    await page.keyboard.press('Enter');
    await expect(html).toHaveAttribute('data-theme', 'light');
    await page.keyboard.press('Space');
    await expect(html).toHaveAttribute('data-theme', 'dark');
});

for (const [name, path] of [['Home', '/'], ['About', '/about']] as const) {
    test(`Enter on the ${name} link goes to ${path}`, async ({ page }) => {
        await openGallery(page);
        await primary(page).getByRole('link', { name, exact: true }).focus();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(path);
    });
}

test('each photo is named by its position before its image loads, and described by its caption', async ({ page }) => {
    await openGallery(page);
    const last = entries(page).last();
    await expect(last).toHaveAccessibleName(photoName(COUNT));
    await expect(last.locator('img')).toHaveCount(0);
    await expect(entries(page).first()).toHaveAccessibleDescription(FIXTURE_CAPTION);
    await expect(entries(page).nth(1)).toHaveAccessibleDescription('');
});

test('the photo grid fills in DOM order, without dense packing', async ({ page }) => {
    await openGallery(page);
    await expect(page.locator('main .grid')).toHaveCSS('grid-auto-flow', 'row');
});

test('every app hover rule on the page waits for a fine pointer', async ({ page }) => {
    await openGallery(page);
    await expectHoverRulesGated(page);
});

test('one tap on a photo opens the lightbox and leaves the tile untransformed', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'Taps run on the touch project.');
    await openGallery(page);
    const tile = entries(page).first();
    // The open lightbox hides the page from role queries, so hold on to the element itself.
    const element = await tile.elementHandle();
    await expectSingleTapActivates(tile, () => expect(lightbox(page)).toBeVisible());
    // A sticky hover style would never settle back to none.
    await expect.poll(() => element?.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
});

test('the caption keeps 4.5:1 over the white photo once focus reveals it', async ({ page }) => {
    await openGallery(page);
    const tile = entries(page).first(); // white.jpg, captioned
    await expect.poll(() => tile.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await tile.focus();
    const caption = tile.getByText(FIXTURE_CAPTION);
    await expect(caption.locator('xpath=..')).toHaveCSS('opacity', '1');
    await expectContrastOverImage(caption, { min: 4.5 });
});

test('ThemeToggle and the Primary links reflow at 320 px with 200% text', async ({ page }) => {
    await openGallery(page);
    await expectReflow(themeToggle(page).or(navLinks(page)));
});
