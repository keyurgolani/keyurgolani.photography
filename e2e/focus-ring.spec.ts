import type { Locator, Page } from '@playwright/test';
import { expectFocusRingVisible } from './support/focus';
import { measure } from './support/measure';
import { expect, test } from './support/test';

// The focus token on ThemeToggle, each SiteNav link, and the About source
// link, in both themes and under hover, since Tailwind's dark: and hover:
// shadow variants land after the token. Then the lightbox elements YARL
// focuses on its own, which must not draw it.

const toggle = (page: Page) => page.getByRole('button', { name: /^Switch to (dark|light) mode$/ });
const source = (page: Page) => page.getByRole('navigation', { name: 'External profiles' }).getByRole('link', { name: 'Site source', exact: true });
const firstPhoto = (page: Page) => page.getByRole('button', { name: 'Photograph 1 of 12', exact: true });

/** Opens the lightbox with Enter, so the focus YARL moves matches :focus-visible. A click on a button tile doesn't. */
async function openLightbox(page: Page) {
    await firstPhoto(page).focus();
    await page.keyboard.press('Enter');
}

/** Outline style and box-shadow, which are both none when an element draws no ring. */
async function ringOf(target: Locator) {
    const { focused, focusVisible, outline, boxShadow } = await measure(target);
    return { focused, focusVisible, outline: outline.style, boxShadow };
}

for (const theme of ['black', 'light'] as const) {
    test.describe(`${theme} theme`, () => {
        async function open(page: Page, path: string) {
            if (theme === 'light') await page.addInitScript(() => localStorage.setItem('theme', 'light'));
            await page.goto(path);
            await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        }

        test('ThemeToggle shows the focus ring', async ({ page }) => {
            await open(page, '/gallery');
            await expectFocusRingVisible(toggle(page));
        });

        for (const name of ['KG, Keyur Golani', 'Home', 'Work', 'About']) {
            test(`the ${name} link shows the focus ring`, async ({ page }) => {
                await open(page, '/gallery');
                await expectFocusRingVisible(page.getByRole('link', { name, exact: true }));
            });
        }

        test('the About source link shows the focus ring', async ({ page }) => {
            await open(page, '/about');
            await expectFocusRingVisible(source(page));
        });

        for (const [label, path, target] of [
            ['ThemeToggle', '/gallery', toggle],
            ['the About source link', '/about', source],
        ] as const) {
            test(`${label} keeps the band under hover`, async ({ page }, testInfo) => {
                test.skip(testInfo.project.name === 'mobile', 'Hover styles only apply to fine pointers.');
                await open(page, path);
                await target(page).hover();
                await expectFocusRingVisible(target(page));
            });
        }

        test('the lightbox container YARL focuses on open draws no ring', async ({ page }) => {
            await open(page, '/gallery');
            await openLightbox(page);
            const container = page.locator('.yarl__container');
            await expect(container).toBeFocused();
            expect(await ringOf(container)).toEqual({ focused: true, focusVisible: true, outline: 'none', boxShadow: 'none' });
        });

        test('the thumbnail track YARL focuses draws no ring, and its active thumbnail draws the token', async ({ page }) => {
            await open(page, '/gallery');
            await openLightbox(page);
            // The leftmost thumbnail leaves the track on ArrowRight, so YARL moves focus to the track.
            await page.locator('.yarl__thumbnails_thumbnail').first().focus();
            await page.keyboard.press('ArrowRight');
            const track = page.locator('.yarl__thumbnails_track');
            await expect(track).toBeFocused();
            expect(await ringOf(track)).toEqual({ focused: true, focusVisible: true, outline: 'none', boxShadow: 'none' });
            const active = await measure(page.locator('.yarl__thumbnails_thumbnail_active'));
            expect(active.outline).toEqual({ style: 'solid', width: 3, offset: 3, alpha: 1 });
            expect(active.boxShadow).toMatch(/^rgb\(0, 0, 0\) 0px 0px 0px 3px/);
        });
    });
}
