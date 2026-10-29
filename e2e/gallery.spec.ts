import type { Locator, Page } from '@playwright/test';
import type { ImageItem } from '../lib/catalog/photos-api';
import { expectContrastOverImage } from './support/contrast';
import { FIXTURE_CAPTION } from './support/fixtures';
import { expectNoFadeOnBlur } from './support/focus';
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
const themeControl = (page: Page) => page.getByRole('button', { name: /^Theme:/ });
const lightbox = (page: Page) => page.getByRole('dialog', { name: 'Lightbox' });

async function openGallery(page: Page, theme: 'black' | 'light' = 'black') {
    if (theme === 'light') await page.addInitScript(() => localStorage.setItem('theme', 'light'));
    await page.goto('/gallery');
    await waitForHydration(page);
    await expect(entries(page)).toHaveCount(COUNT);
}

/** The name of whatever has focus: its aria-label, or its rendered text, which skips the theme control's hidden names. */
const focusedLabel = (page: Page) =>
    page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? (document.activeElement as HTMLElement | null)?.innerText.replace(/\s+/g, ' ').trim());

for (const viewport of [undefined, { width: 640, height: 400 }]) {
    test.describe(viewport ? 'at 640 by 400, which is 200% zoom' : 'at the project viewport', () => {
        if (viewport) test.use({ viewport });

        for (const theme of ['black', 'light'] as const) {
            test(`passes the surface checks in the ${theme} theme`, async ({ page }) => {
                await openGallery(page, theme);
                await checkSurface(page, {
                    entries: entries(page),
                    controls: [navLinks(page), themeControl(page)],
                    chrome: [primary(page)],
                });
            });
        }
    });
}

test('Tab goes through SiteNav, its theme control last, then each photo in order, and Shift+Tab walks back', async ({ page }) => {
    await openGallery(page);
    const stops = ['KG, Keyur Golani', 'Home', 'Work', 'About', 'Theme: System (Black now)', ...Array.from({ length: COUNT }, (_, index) => photoName(index + 1))];
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

test('the Primary navigation sits outside main, and the theme control is a plain button', async ({ page }) => {
    await openGallery(page);
    await expect(primary(page)).toHaveCount(1);
    await expect(page.locator('main nav')).toHaveCount(0);
    await expect(themeControl(page)).toHaveAttribute('type', 'button');
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

test('Enter on the theme control opens its menu on the checked choice, an arrow chooses, and Escape closes it', async ({ page }) => {
    await openGallery(page);
    const html = page.locator('html');
    await themeControl(page).focus();
    // Focus loads the menu's styles; it opens once they're in.
    await expect(themeControl(page)).toHaveAttribute('popovertarget', /.+/);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('radio', { name: /^System/ })).toBeChecked();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('radio', { name: /^System/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(html).toHaveAttribute('data-theme-choice', 'light');
    await expect(html).toHaveAttribute('data-theme', 'light');
    await page.keyboard.press('Escape');
    await expect(themeControl(page)).toBeFocused();
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

// Each theme has its own hover rules, and only the active theme's match markup.
for (const theme of ['black', 'light'] as const) {
    test(`every app hover rule on the page waits for a fine pointer in the ${theme} theme`, async ({ page }) => {
        await openGallery(page, theme);
        await expectHoverRulesGated(page);
    });
}

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

/** Focuses `tile` once its image has loaded and checks its caption over the photo. */
async function expectCaptionContrast(tile: Locator) {
    await expect.poll(() => tile.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await tile.focus();
    const caption = tile.getByText(FIXTURE_CAPTION);
    await expect(caption.locator('xpath=..')).toHaveCSS('opacity', '1');
    await expectContrastOverImage(caption, { min: 4.5 });
}

test('the caption keeps 4.5:1 over the white photo once focus reveals it', async ({ page }) => {
    await openGallery(page);
    const tile = entries(page).first(); // white.jpg, captioned, 8 rows
    await expectCaptionContrast(tile);
});

test('the caption keeps 4.5:1 over the white photo on a 3-row tile, where the scrim has the least room', async ({ page }) => {
    // A captioned 4:1 record gets the shortest tile, 3 rows of 50 px and 2 gaps of 12 px.
    const src = '/assets/photos/white.jpg';
    const record: ImageItem = { id: 0, src, thumbnail: src, medium: src, optimized: src, width: 2000, height: 500, optimizedWidth: 2000, optimizedHeight: 500, caption: FIXTURE_CAPTION, date: Date.UTC(2024, 0, 1), lqip: '' };
    await page.route('**/api/photos', (route) => route.fulfill({ json: [record] }));
    await page.goto('/gallery');
    await waitForHydration(page);
    const tile = page.getByRole('button', { name: 'Photograph 1 of 1', exact: true });
    await expect.poll(async () => (await tile.boundingBox())?.height).toBe(174);
    await expectCaptionContrast(tile);
});

test('a photo, the theme control, and the Primary links drop their focus ring at once on blur', async ({ page }) => {
    await openGallery(page);
    for (const target of [entries(page).first(), themeControl(page), ...(await navLinks(page).all())]) await expectNoFadeOnBlur(target);
});

test('The theme control and the Primary links reflow at 320 px with 200% text', async ({ page }) => {
    await openGallery(page);
    await expectReflow(themeControl(page).or(navLinks(page)));
});
