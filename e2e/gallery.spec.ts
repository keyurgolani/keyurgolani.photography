import type { Locator, Page } from '@playwright/test';
import type { ImageItem } from '../utils/getImageData';
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
const themeToggle = (page: Page) => page.getByRole('button', { name: /^Switch to (dark|light) mode$/ });
const lightbox = (page: Page) => page.getByRole('dialog', { name: 'Lightbox' });

/** Each label shown on hover or focus, with the control that shows it. */
const labels = (page: Page) => [
    ...['Gallery', 'Home', 'About'].map((name) => {
        const host = primary(page).getByRole('link', { name, exact: true });
        return { name, host, label: host.locator('span') };
    }),
    { name: 'ThemeToggle', host: themeToggle(page), label: themeToggle(page).locator('span') },
];

/** The label's center, where a click or tap aimed at the page under it would land. */
async function centerOf(target: Locator) {
    const box = await target.boundingBox();
    if (!box) throw new Error(`${target} has no box`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Whether a click or tap at the label's center would hit the label. */
const hitsLabel = (label: Locator) =>
    label.evaluate((el) => {
        const { left, top, width, height } = el.getBoundingClientRect();
        const hit = document.elementFromPoint(left + width / 2, top + height / 2);
        return hit !== null && el.contains(hit);
    });

/** The middle of the gap between a control and its label, where the label's bridge sits. */
async function gapOf(host: Locator, label: Locator) {
    const [control, tip] = [await host.boundingBox(), await label.boundingBox()];
    if (!control || !tip) throw new Error(`${label} or its control has no box`);
    const above = tip.y + tip.height <= control.y;
    const y = above ? (tip.y + tip.height + control.y) / 2 : (control.y + control.height + tip.y) / 2;
    return { x: tip.x + tip.width / 2, y };
}

/** Whether a click or tap at `point` would hit the label, its bridge included. */
const hitsLabelAt = (label: Locator, { x, y }: { x: number; y: number }) =>
    label.evaluate((el, [px, py]) => {
        const hit = document.elementFromPoint(px, py);
        return hit !== null && el.contains(hit);
    }, [x, y] as const);

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

test('the Primary navigation sits outside main, and the theme toggle is a plain button', async ({ page }) => {
    await openGallery(page);
    await expect(primary(page)).toHaveCount(1);
    await expect(page.locator('main nav')).toHaveCount(0);
    await expect(themeToggle(page)).toHaveAttribute('type', 'button');
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

test('a hidden label lets clicks and taps through to the page, and a shown one stays hoverable', async ({ page, isMobile }) => {
    await openGallery(page);
    for (const { name, host, label } of labels(page)) {
        await expect(label, `${name}'s label starts hidden`).toHaveCSS('opacity', '0');
        const gap = await gapOf(host, label);
        expect(await hitsLabel(label), `${name}'s hidden label takes no pointer`).toBe(false);
        expect(await hitsLabelAt(label, gap), `${name}'s hidden label's bridge takes no pointer`).toBe(false);
        // Hover styles only apply to fine pointers.
        if (isMobile) continue;
        await host.hover();
        await expect(label).toHaveCSS('opacity', '1');
        expect(await hitsLabel(label), `${name}'s shown label takes the pointer`).toBe(true);
        expect(await hitsLabelAt(label, gap), `${name}'s shown label bridges the gap to its control`).toBe(true);
        // WCAG 1.4.13: the pointer can cross the gap onto the label without it going away.
        const { x, y } = await centerOf(label);
        await page.mouse.move(x, y, { steps: 10 });
        await expect(label).toHaveCSS('opacity', '1');
    }
});

test('Escape hides a label shown on focus until focus moves', async ({ page }) => {
    await openGallery(page);
    const [gallery, home] = labels(page);
    // Nothing has had a pointer yet, so this focus matches :focus-visible like a Tab would.
    await gallery.host.focus();
    await expect(gallery.label).toHaveCSS('opacity', '1');
    await page.keyboard.press('Escape');
    await expect(gallery.label).toHaveCSS('opacity', '0');
    await expect(gallery.host).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(home.host).toBeFocused();
    await expect(home.label).toHaveCSS('opacity', '1');
    await page.keyboard.press('Shift+Tab');
    await expect(gallery.label).toHaveCSS('opacity', '1');
});

test('Escape hides a label shown on hover until the pointer leaves', async ({ page, isMobile }) => {
    test.skip(isMobile, 'Hover styles only apply to fine pointers.');
    await openGallery(page);
    for (const { name, host, label } of labels(page)) {
        await host.hover();
        await expect(label).toHaveCSS('opacity', '1');
        await page.keyboard.press('Escape');
        await expect(label, `${name}'s label hides on Escape`).toHaveCSS('opacity', '0');
        expect(await hitsLabel(label), `${name}'s dismissed label takes no pointer`).toBe(false);
        expect(await hitsLabelAt(label, await gapOf(host, label)), `${name}'s dismissed label's bridge takes no pointer`).toBe(false);
        // Off the control and back, in the page's side padding.
        await page.mouse.move(5, 300);
        await host.hover();
        await expect(label, `${name}'s label shows again on the next hover`).toHaveCSS('opacity', '1');
        await page.mouse.move(5, 300);
    }
});

test('the photo grid fills in DOM order, without dense packing', async ({ page }) => {
    await openGallery(page);
    await expect(page.locator('main .grid')).toHaveCSS('grid-auto-flow', 'row');
});

// Each theme has its own hover rules, and only the active theme's match markup.
for (const theme of ['dark', 'light'] as const) {
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

test('a photo, the theme toggle, and the Primary links drop their focus ring at once on blur', async ({ page }) => {
    await openGallery(page);
    for (const target of [entries(page).first(), themeToggle(page), ...(await navLinks(page).all())]) await expectNoFadeOnBlur(target);
});

test('ThemeToggle and the Primary links reflow at 320 px with 200% text', async ({ page }) => {
    await openGallery(page);
    await expectReflow(themeToggle(page).or(navLinks(page)));
});
