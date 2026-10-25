import type { Page } from '@playwright/test';
import { artist } from '../../data/artist';
import { waitForHydration } from '../support/hydration';
import { expect, test } from '../support/test';

test.skip(({ isMobile }) => isMobile, 'The desktop project covers it. SiteNav runs on both in nav.spec.ts.');

const toggle = (page: Page) => page.getByRole('button', { name: /^Switch to (dark|light) mode$/ });
/** The body's background, or '' while the parser hasn't reached the body yet. */
const bodyBackground = (page: Page) => page.evaluate(() => (document.body ? getComputedStyle(document.body).backgroundColor : ''));
const LIGHT_GROUND = 'rgb(250, 250, 250)';
const DARK_GROUND = 'rgb(5, 5, 5)';
/** About's Light Takes Shape paper, the same in both themes. */
const PAPER = 'rgb(244, 236, 215)';

/** Page errors, and console errors about hydration or React's 418, 423, and 425. */
function watchErrors(page: Page) {
    const problems: string[] = [];
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
        if (message.type() === 'error' && /hydrat|errors\/(418|423|425)\b|#(418|423|425)\b/i.test(message.text())) problems.push(`console: ${message.text()}`);
    });
    return problems;
}

test('a stored light theme is on <html> and the body before any Next.js script runs', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('theme', 'light'));
    // Hold the scripts, not the stylesheets: a pending stylesheet at the top of <head> blocks the inline script.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
        setTimeout(resolve, 3_000);
    });
    await page.route('**/_next/static/**/*.js', async (route) => {
        await held;
        await route.continue();
    });
    const problems = watchErrors(page);
    await page.goto('/gallery', { waitUntil: 'commit' });

    await expect.poll(() => bodyBackground(page)).toBe(LIGHT_GROUND);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-hydrated')), 'React has not hydrated yet').toBe(false);

    release();
    await waitForHydration(page);
    await expect(toggle(page)).toHaveAccessibleName('Switch to dark mode');
    expect(problems).toEqual([]);
});

for (const [stored, name, icon] of [[undefined, 'Switch to light mode', 'sun'], ['light', 'Switch to dark mode', 'moon']] as const) {
    test(`with ${stored ?? 'no'} theme stored, the toggle's name and icon are right before React runs`, async ({ page }) => {
        if (stored) await page.addInitScript((theme) => localStorage.setItem('theme', theme), stored);
        // No Next.js script ever loads, so nothing hydrates. The inline theme script still runs.
        await page.route('**/_next/static/**/*.js', (route) => route.abort());
        await page.goto('/gallery', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('html')).toHaveAttribute('data-theme', stored ?? 'dark');
        expect(await page.evaluate(() => document.documentElement.hasAttribute('data-hydrated')), 'React never hydrated').toBe(false);
        await expect(toggle(page)).toHaveAccessibleName(name);
        await expect(toggle(page).locator(`svg.lucide-${icon}`)).toBeVisible();
        await expect(toggle(page).locator('svg:visible')).toHaveCount(1);
    });
}

test('a stored value other than light or dark leaves the dark theme', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('theme', 'blue'));
    await page.goto('/gallery');
    await waitForHydration(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await bodyBackground(page)).toBe(DARK_GROUND);
});

for (const theme of ['dark', 'light'] as const) {
    for (const path of ['/', '/gallery', '/about', '/does-not-exist']) {
        test(`${path} logs no page or hydration error in the ${theme} theme`, async ({ page }) => {
            if (theme === 'light') await page.addInitScript(() => localStorage.setItem('theme', 'light'));
            const problems = watchErrors(page);
            await page.goto(path);
            await waitForHydration(page);
            await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
            await expect(page.getByRole('navigation', { name: 'Primary' })).toBeAttached();
            expect(problems).toEqual([]);
        });
    }
}

test('one toggle flips the theme and stores it, a reload keeps it, and the icon matches at first paint', async ({ page }) => {
    await page.goto('/gallery');
    await waitForHydration(page);
    const html = page.locator('html');
    await expect(toggle(page)).toHaveAccessibleName('Switch to light mode');
    await expect(toggle(page).locator('svg:visible')).toHaveCount(1);
    await expect(toggle(page).locator('svg.lucide-sun')).toBeVisible();

    await toggle(page).click();
    await expect(html).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('light');
    await expect(toggle(page)).toHaveAccessibleName('Switch to dark mode');
    await expect(toggle(page).locator('svg.lucide-moon')).toBeVisible();

    // The icon follows html[data-theme], so it's right before React runs on the reload.
    await page.route('**/_next/static/**/*.js', (route) => route.abort());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(html).toHaveAttribute('data-theme', 'light');
    await expect(toggle(page).locator('svg.lucide-moon')).toBeVisible();
    await expect(toggle(page).locator('svg.lucide-sun')).toBeHidden();
});

test.describe('with JavaScript disabled', () => {
    test.use({ javaScriptEnabled: false });

    for (const [path, heading, ground, groundName] of [
        ['/gallery', 'Gallery', DARK_GROUND, 'the dark ground'],
        ['/about', artist.profile.statementHeading, PAPER, "About's paper"],
    ] as const) {
        test(`${path} shows its heading and SiteNav on ${groundName}`, async ({ page }) => {
            await page.goto(path);
            await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
            await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
            await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
            expect(await bodyBackground(page)).toBe(ground);
        });
    }
});
