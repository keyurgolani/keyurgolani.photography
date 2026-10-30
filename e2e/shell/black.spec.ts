import type { Page } from '@playwright/test';
import { CATALOG_ORIGIN, HOME_SERIES } from '../support/catalog-home';
import { waitForHydration } from '../support/hydration';
import { expect, test } from '../support/test';

// Black, OLED (the OLED spec, round 2, approved for build): the screen's own black and nothing else, on the pages next
// has. The photographs meet the screen's edge on Work and a series' head, the nav has no bar or hairline, the KG mark
// is filled, actions are drawn, the menu's swatch is the print edge to edge, Home's slides dip to black, and the focus
// ring keeps its dark band. Home's intro grain and the portrait's ring are styles/__tests__/blackTheme.test.ts's. Dark
// is today's, and the parity gate (e2e/themes/dark-parity.spec.ts) holds it.

test.skip(({ isMobile }) => isMobile, 'Each test sets the 1440 and 390 viewports itself, on the desktop project.');
test.use({ baseURL: CATALOG_ORIGIN });

const BLACK = 'rgb(0, 0, 0)';
const VIEWPORTS = [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
] as const;

async function openBlack(page: Page, path: string, viewport: { width: number; height: number }) {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => localStorage.setItem('theme', 'black'));
    await page.goto(path);
    await waitForHydration(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'black');
}

const style = (page: Page, selector: string, prop: string) => page.locator(selector).first().evaluate((el, name) => getComputedStyle(el).getPropertyValue(name), prop);

for (const viewport of VIEWPORTS) {
    test(`at ${viewport.width}, the shell is black: the ground, no nav bar or hairline, the KG filled, the focus band dark`, async ({ page }) => {
        await openBlack(page, '/work', viewport);
        expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "the body's ground").toBe(BLACK);
        const nav = page.getByRole('navigation', { name: 'Primary' });
        expect(await nav.evaluate((el) => getComputedStyle(el).boxShadow), 'no hairline under the nav').toMatch(/^(none|rgba\(0, 0, 0, 0\)[^,]*)$/);
        const mark = nav.locator('[class*="monogram"]').first();
        const kg = await mark.evaluate((el) => ({ fill: getComputedStyle(el).backgroundColor, ink: getComputedStyle(el).color }));
        expect(kg, 'the KG mark is a white disc with black letters').toEqual({ fill: 'rgb(255, 255, 255)', ink: BLACK });
        const ring = await page.evaluate(() => ({ light: getComputedStyle(document.documentElement).getPropertyValue('--focus-ring-light').trim(), dark: getComputedStyle(document.documentElement).getPropertyValue('--focus-ring-dark').trim() }));
        expect(ring, 'the focus ring keeps its dark band (P1-1)').toEqual({ light: '#ffffff', dark: '#000000' });
    });

    test(`at ${viewport.width}, Work's covers and a series' cover meet the screen's edge, with no box`, async ({ page }) => {
        await openBlack(page, '/work', viewport);
        const cover = page.getByRole('main').locator('ul > li > a').first().locator('[class*="frame"]').first();
        const box = await cover.boundingBox();
        expect(box?.x, "Work's first cover starts at the screen's edge").toBe(0);
        expect(await cover.evaluate((el) => getComputedStyle(el).borderRadius), 'square corners').toBe('0px');
        await page.goto(`/work/${HOME_SERIES.slug}`);
        await waitForHydration(page);
        const head = await page.locator('main figure a').first().boundingBox();
        expect(head?.x, "the series' cover starts at the screen's edge").toBe(0);
    });

    test(`at ${viewport.width}, the 404's action is drawn, not filled, and the page is black`, async ({ page }) => {
        await openBlack(page, '/does-not-exist', viewport);
        const action = page.getByRole('main').getByRole('link').first();
        const drawn = await action.evaluate((el) => ({ fill: getComputedStyle(el).backgroundColor, edge: getComputedStyle(el).borderTopColor, ink: getComputedStyle(el).color }));
        expect(drawn).toEqual({ fill: 'rgba(0, 0, 0, 0)', edge: 'rgb(245, 245, 245)', ink: 'rgb(245, 245, 245)' });
        expect(await style(page, 'main', 'background-color')).toBe(BLACK);
    });
}

test("Home's slides dip to black: each half of the crossfade, the next after the last has gone", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => localStorage.setItem('theme', 'black'));
    await page.goto('/');
    await waitForHydration(page);
    const timing = await page.locator('[class*="slide"][class*="active"]').first().evaluate((el) => {
        const style = getComputedStyle(el);
        const ms = (value: string) => parseFloat(value) * (value.endsWith('ms') ? 1 : 1000);
        return { duration: ms(style.transitionDuration.split(',')[0]), delay: ms(style.transitionDelay.split(',')[0]) };
    });
    expect(timing.delay, 'the next waits for the last to fade out').toBeGreaterThan(0);
    expect(timing.delay, 'each half the crossfade').toBe(timing.duration);
});

test("the menu's Black swatch is the print edge to edge, unlike Dark's inset print", async ({ page }) => {
    await openBlack(page, '/work', { width: 1440, height: 900 });
    await page.getByRole('button', { name: /^Theme:/ }).click();
    await expect(page.getByRole('radio', { name: /^Black/ })).toBeChecked();
    const swatch = await page.locator('.theme-menu-preview[data-preview="black"]').evaluate((el) => {
        const photo = el.querySelector('.theme-menu-preview-photo')!.getBoundingClientRect();
        const tile = el.getBoundingClientRect();
        return { fill: getComputedStyle(el).backgroundColor, edge: Math.max(Math.abs(photo.width - tile.width), Math.abs(photo.height - tile.height)) };
    });
    expect(swatch.fill).toBe(BLACK);
    expect(swatch.edge, 'the photo fills the tile').toBeLessThanOrEqual(1);
    expect(await page.locator('.theme-menu-popover').evaluate((el) => getComputedStyle(el).backgroundColor), "the menu's sheet").toBe(BLACK);
});
