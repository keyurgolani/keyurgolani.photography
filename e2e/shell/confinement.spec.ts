import type { Page } from '@playwright/test';
import { waitForHydration } from '../support/hydration';
import { expect, test } from '../support/test';

// The Light Takes Shape and Chromatic Chapters layers stay on their own
// surfaces. About's main and its Primary nav carry the about surface and see
// its tokens, and nothing else does. Until #7 adds the Viewer surface, no
// route sees a Chromatic Chapters token.

test.skip(({ isMobile }) => isMobile, 'The desktop project covers it.');

/** Each token as the body, the Primary nav, and main resolve it. */
const tokensOf = (page: Page) =>
    page.evaluate(() => {
        const read = (el: Element | null) =>
            el && {
                paper: getComputedStyle(el).getPropertyValue('--lts-paper').trim(),
                ground: getComputedStyle(el).getPropertyValue('--cc-ground').trim(),
            };
        return { body: read(document.body), nav: read(document.querySelector('nav[aria-label="Primary"]')), main: read(document.querySelector('main')) };
    });

async function expectConfined(page: Page) {
    await expect(page.locator('[data-surface]')).toHaveCount(0);
    const { body, nav } = await tokensOf(page);
    expect({ body, nav }).toEqual({ body: { paper: '', ground: '' }, nav: { paper: '', ground: '' } });
}

async function expectAboutSurface(page: Page) {
    await expect(page.locator('[data-surface]')).toHaveCount(2);
    await expect(page.locator('main[data-surface="about"]')).toHaveCount(1);
    await expect(page.locator('nav[aria-label="Primary"][data-surface="about"]')).toHaveCount(1);
    expect(await tokensOf(page)).toEqual({ body: { paper: '', ground: '' }, nav: { paper: '#f4ecd7', ground: '' }, main: { paper: '#f4ecd7', ground: '' } });
}

for (const path of ['/', '/gallery', '/does-not-exist']) {
    test(`nothing on ${path} carries data-surface or a surface token`, async ({ page }) => {
        await page.goto(path);
        await waitForHydration(page);
        await expectConfined(page);
    });
}

test('on /about only main and the Primary nav carry the about surface, and neither sees a Chromatic Chapters token', async ({ page }) => {
    await page.goto('/about');
    await waitForHydration(page);
    await expectAboutSurface(page);
});

test('it holds after a client-side move from /about through /work to the legacy /gallery', async ({ page }) => {
    await page.goto('/about');
    await waitForHydration(page);
    await expectAboutSurface(page);
    const work = page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Work', exact: true });
    await expect(work).toHaveAttribute('href', '/work');
    await work.click();
    await expect(page).toHaveURL('/gallery');
    await expect(page.getByRole('heading', { level: 1, name: 'Gallery' })).toBeVisible();
    await expectConfined(page);
});
