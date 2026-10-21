import type { Page } from '@playwright/test';
import { waitForHydration } from '../support/hydration';
import { expect, test } from '../support/test';

// The Light Takes Shape and Chromatic Chapters layers stay on their own
// surfaces. Until #12 and #7 add the About and Viewer surfaces, nothing on
// these routes carries data-surface or sees a surface token.

test.skip(({ isMobile }) => isMobile, 'The desktop project covers it.');

async function expectConfined(page: Page) {
    await expect(page.locator('[data-surface]')).toHaveCount(0);
    const tokens = await page.evaluate(() => {
        const read = (el: Element | null) =>
            el && {
                paper: getComputedStyle(el).getPropertyValue('--lts-paper').trim(),
                ground: getComputedStyle(el).getPropertyValue('--cc-ground').trim(),
            };
        return { body: read(document.body), nav: read(document.querySelector('nav[aria-label="Primary"]')) };
    });
    expect(tokens).toEqual({ body: { paper: '', ground: '' }, nav: { paper: '', ground: '' } });
}

for (const path of ['/', '/gallery', '/about', '/does-not-exist']) {
    test(`nothing on ${path} carries data-surface or a surface token`, async ({ page }) => {
        await page.goto(path);
        await waitForHydration(page);
        await expectConfined(page);
    });
}

test('it holds after a client-side move from /about to /gallery', async ({ page }) => {
    await page.goto('/about');
    await waitForHydration(page);
    await expectConfined(page);
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Work', exact: true }).click();
    await expect(page).toHaveURL('/gallery');
    await expect(page.getByRole('heading', { level: 1, name: 'Gallery' })).toBeVisible();
    await expectConfined(page);
});
