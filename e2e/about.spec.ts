import type { Page } from '@playwright/test';
import { artist } from '../data/artist';
import { expectNoA11yViolations } from './support/a11y';
import { expectFocusRingVisible, expectNoFadeOnBlur, expectRingNotClipped } from './support/focus';
import { waitForHydration } from './support/hydration';
import { expectReflow } from './support/reflow';
import { expect, test } from './support/test';

// The About subset of #1: the navigation links and theme control in full,
// Tab reach and the ring for the external links, and axe. #11's own checks
// on those links are in about-links.spec.ts.

const ENABLED = artist.destinations.filter((destination) => destination.enabled);

const primary = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const navLinks = (page: Page) => primary(page).getByRole('link');
const themeToggle = (page: Page) => page.getByRole('button', { name: /^Switch to (dark|light) mode$/ });
const links = (page: Page) => page.getByRole('navigation', { name: /^External profiles( and contact)?$/ }).getByRole('link');
const source = (page: Page) => links(page).filter({ hasText: /^Site source$/ });

/** Stops with an aria-label report it, links without one their href, and the toggle its rendered name. */
const focusedStop = (page: Page) =>
    page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el?.getAttribute('aria-label') ?? el?.getAttribute('href') ?? el?.innerText.trim();
    });

async function openAbout(page: Page) {
    await page.goto('/about');
    await waitForHydration(page);
    await expect(links(page)).toHaveCount(ENABLED.length);
}

test('passes axe', async ({ page }) => {
    await openAbout(page);
    await expectNoA11yViolations(page);
});

test('Tab goes through SiteNav, its toggle last, then the external links, and Shift+Tab walks back', async ({ page }) => {
    await openAbout(page);
    const stops = ['KG, Keyur Golani', '/', '/gallery', '/about', 'Switch to light mode', ...ENABLED.map((destination) => destination.href)];
    const forward: (string | undefined)[] = [];
    for (let press = 0; press < stops.length; press++) {
        await page.keyboard.press('Tab');
        forward.push(await focusedStop(page));
    }
    expect(forward).toEqual(stops);
    const back: (string | undefined)[] = [];
    for (let press = 1; press < stops.length; press++) {
        await page.keyboard.press('Shift+Tab');
        back.push(await focusedStop(page));
    }
    expect(back).toEqual(stops.slice(0, -1).reverse());
});

test('Enter and Space on the theme toggle flip the theme', async ({ page }) => {
    await openAbout(page);
    const html = page.locator('html');
    await themeToggle(page).focus();
    await page.keyboard.press('Enter');
    await expect(html).toHaveAttribute('data-theme', 'light');
    await page.keyboard.press('Space');
    await expect(html).toHaveAttribute('data-theme', 'dark');
});

for (const [name, path] of [['Work', '/gallery'], ['Home', '/']] as const) {
    test(`Enter on the ${name} link goes to ${path}`, async ({ page }) => {
        await openAbout(page);
        await primary(page).getByRole('link', { name, exact: true }).focus();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(path);
    });
}

test('the theme toggle, the Primary links, and the external links show the focus ring', async ({ page }) => {
    await openAbout(page);
    for (const group of [themeToggle(page), navLinks(page), links(page)]) {
        for (const target of await group.all()) await expectFocusRingVisible(target);
    }
});

test.describe('in a short 1280 by 400 window', () => {
    test.use({ viewport: { width: 1280, height: 400 } });

    test('no overflow container clips an external link ring', async ({ page }) => {
        await openAbout(page);
        for (const target of await links(page).all()) await expectRingNotClipped(target);
    });
});

test('the external links reflow at 320 px without overlap', async ({ page }) => {
    await openAbout(page);
    await expectReflow(links(page));
});

test('every external link shows its label at rest, so nothing waits for hover or focus', async ({ page }) => {
    await openAbout(page);
    const list = page.getByRole('navigation', { name: /^External profiles( and contact)?$/ });
    // What each element in the list shows, which hover or focus must not change.
    const shown = () =>
        list.evaluate((nav) =>
            [nav, ...Array.from(nav.querySelectorAll('*'))].map((el) => {
                const { display, visibility, opacity } = getComputedStyle(el);
                return `${el.tagName} ${display} ${visibility} ${opacity}`;
            }),
        );
    const atRest = await shown();
    for (const [index, link] of (await links(page).all()).entries()) {
        await expect(link.getByText(ENABLED[index].label, { exact: true })).toBeVisible();
        await link.hover();
        expect(await shown(), `hovering ${ENABLED[index].label}`).toEqual(atRest);
        await link.focus();
        expect(await shown(), `focusing ${ENABLED[index].label}`).toEqual(atRest);
    }
});

test('the Site source link and the rest drop their focus ring at once on blur', async ({ page }) => {
    await openAbout(page);
    await expect(source(page)).toHaveCount(1);
    for (const target of await links(page).all()) await expectNoFadeOnBlur(target);
});
