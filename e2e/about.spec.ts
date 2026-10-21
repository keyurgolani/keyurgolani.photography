import type { Page } from '@playwright/test';
import { expectNoA11yViolations } from './support/a11y';
import { expectFocusRingVisible, expectNoFadeOnBlur, expectRingNotClipped } from './support/focus';
import { waitForHydration } from './support/hydration';
import { expectReflow } from './support/reflow';
import { expect, test } from './support/test';

// The About subset of #1: the navigation links and theme control in full,
// Tab reach and the ring style for the social cards and source link, and axe.

const primary = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const navLinks = (page: Page) => primary(page).getByRole('link');
const themeToggle = (page: Page) => page.getByRole('button', { name: /^Switch to (dark|light) mode$/ });
const cards = (page: Page) => page.getByRole('link', { name: /@iserialclicker/ });
const source = (page: Page) => page.getByRole('link', { name: 'View source on GitHub', exact: true });

/** Stops with an aria-label report it, and the social cards their href. */
const focusedStop = (page: Page) =>
    page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.getAttribute('href') ?? document.activeElement?.tagName);

async function openAbout(page: Page) {
    await page.goto('/about');
    await waitForHydration(page);
    await expect(cards(page)).toHaveCount(3);
}

test('passes axe', async ({ page }) => {
    await openAbout(page);
    await expectNoA11yViolations(page);
});

test('Tab reaches the theme toggle, the social cards, the Primary links, then the source link, and Shift+Tab walks back', async ({ page }) => {
    await openAbout(page);
    const stops = [
        'Switch to light mode',
        'https://www.instagram.com/iserialclicker',
        'https://500px.com/p/iserialclicker',
        'https://www.flickr.com/photos/iserialclicker',
        'Gallery',
        'Home',
        'About',
        'View source on GitHub',
    ];
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

for (const [name, path] of [['Gallery', '/gallery'], ['Home', '/']] as const) {
    test(`Enter on the ${name} link goes to ${path}`, async ({ page }) => {
        await openAbout(page);
        await primary(page).getByRole('link', { name, exact: true }).focus();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(path);
    });
}

test('the theme toggle, the Primary links, the social cards, and the source link show the focus ring', async ({ page }) => {
    await openAbout(page);
    for (const group of [themeToggle(page), navLinks(page), cards(page), source(page)]) {
        for (const target of await group.all()) await expectFocusRingVisible(target);
    }
});

// #11 (About links) owns these.
test.describe('#11', () => {
    test.describe('in a short 1280 by 400 window, where the cards outgrow the page', () => {
        test.use({ viewport: { width: 1280, height: 400 } });

        test.fixme('no overflow container clips a social card or source link ring', async ({ page }) => {
            await openAbout(page);
            for (const target of await cards(page).or(source(page)).all()) await expectRingNotClipped(target);
        });
    });

    test.fixme('the social cards and source link reflow at 320 px without overlap', async ({ page }) => {
        await openAbout(page);
        await expectReflow(cards(page).or(source(page)));
    });

    test.fixme('"Visit Profile" and "View Source" show on keyboard focus, not only on hover', async ({ page }) => {
        await openAbout(page);
        for (const card of await cards(page).all()) {
            await card.focus();
            await expect(card.getByText('Visit Profile', { exact: false })).toBeVisible();
            await expect(card.getByText('Visit Profile', { exact: false }).locator('xpath=..')).toHaveCSS('opacity', '1');
        }
        await source(page).focus();
        await expect(source(page).getByText('View Source')).toHaveCSS('opacity', '1');
    });

    test.fixme('the source link drops its focus ring at once on blur', async ({ page }) => {
        await openAbout(page);
        await expectNoFadeOnBlur(source(page));
    });
});
