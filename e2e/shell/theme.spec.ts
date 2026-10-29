import type { Page } from '@playwright/test';
import { artist } from '../../data/artist';
import { waitForHydration } from '../support/hydration';
import { expect, test } from '../support/test';

// The theme control (themes mockup, owner ruling 2026-10-28): System is the default, and on a dark device it paints
// Black, which is today's site exactly; a visitor without JavaScript gets Black too. These pin what the server sends,
// what the inline script resolves before any Next.js script, and that Black keeps today's grounds.

test.skip(({ isMobile }) => isMobile, 'The desktop project covers it. SiteNav runs on both in nav.spec.ts.');

const control = (page: Page) => page.getByRole('button', { name: /^Theme:/ });
/** The body's background, or '' while the parser hasn't reached the body yet. */
const bodyBackground = (page: Page) => page.evaluate(() => (document.body ? getComputedStyle(document.body).backgroundColor : ''));
/** The legacy Gallery's main, the one ground the old toggle painted, or '' while the parser hasn't reached it yet. */
const galleryBackground = (page: Page) =>
    page.evaluate(() => {
        const main = document.querySelector('main');
        return main ? getComputedStyle(main).backgroundColor : '';
    });
/** Today's grounds, which Black keeps: the legacy Gallery's dark main, the shell's Gallery After Hours, About's paper. */
const DARK_GROUND = 'rgb(5, 5, 5)';
const SHELL_GROUND = 'rgb(8, 10, 9)';
const PAPER = 'rgb(244, 236, 215)';
const LIGHT_SHELL = 'rgb(235, 229, 217)';

/** Page errors, and console errors about hydration or React's 418, 423, and 425. */
function watchErrors(page: Page) {
    const problems: string[] = [];
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
        if (message.type() === 'error' && /hydrat|errors\/(418|423|425)\b|#(418|423|425)\b/i.test(message.text())) problems.push(`console: ${message.text()}`);
    });
    return problems;
}

test('the server sends System painting Black', async ({ request }) => {
    const html = await (await request.get('/gallery')).text();
    expect(html).toMatch(/<html[^>]*data-theme="black"/);
    expect(html).toMatch(/<html[^>]*data-theme-choice="system"/);
});

test('a stored Light choice is on <html> and paints, before any Next.js script runs', async ({ page }) => {
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

    await expect.poll(() => bodyBackground(page)).toBe(LIGHT_SHELL);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-hydrated')), 'React has not hydrated yet').toBe(false);

    release();
    await waitForHydration(page);
    await expect(control(page)).toHaveAccessibleName('Theme: Light');
    expect(problems).toEqual([]);
});

for (const [scheme, theme, name] of [
    ['dark', 'black', 'Theme: System (Black now)'],
    ['light', 'light', 'Theme: System (Light now)'],
] as const) {
    test(`with nothing stored on a ${scheme} device, System paints ${theme} and the control says so before React runs`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        // No Next.js script ever loads, so nothing hydrates. The inline theme script still runs.
        await page.route('**/_next/static/**/*.js', (route) => route.abort());
        await page.goto('/gallery', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('html')).toHaveAttribute('data-theme-choice', 'system');
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        expect(await page.evaluate(() => document.documentElement.hasAttribute('data-hydrated')), 'React never hydrated').toBe(false);
        await expect(control(page)).toHaveAccessibleName(name);
    });
}

test('a stored value that is no choice is System, and on a dark device keeps today\'s grounds', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.addInitScript(() => localStorage.setItem('theme', 'blue'));
    await page.goto('/gallery');
    await waitForHydration(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'black');
    expect(await galleryBackground(page)).toBe(DARK_GROUND);
    expect(await bodyBackground(page)).toBe(SHELL_GROUND);
});

for (const theme of ['black', 'light'] as const) {
    for (const path of ['/', '/gallery', '/about', '/does-not-exist']) {
        test(`${path} logs no page or hydration error in the ${theme} theme`, async ({ page }) => {
            await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
            const problems = watchErrors(page);
            await page.goto(path);
            await waitForHydration(page);
            await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
            await expect(page.getByRole('navigation', { name: 'Primary' })).toBeAttached();
            expect(problems).toEqual([]);
        });
    }
}

test('a choice in the control applies at once, is stored, and a reload keeps it from first paint', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/gallery');
    await waitForHydration(page);
    const html = page.locator('html');
    await expect(control(page)).toHaveAccessibleName('Theme: System (Black now)');

    await control(page).click();
    await page.getByRole('radio', { name: /^Light/ }).check();
    await expect(html).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('light');
    await page.keyboard.press('Escape');
    await expect(control(page)).toHaveAccessibleName('Theme: Light');

    await page.route('**/_next/static/**/*.js', (route) => route.abort());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(html).toHaveAttribute('data-theme', 'light');
    await expect(control(page)).toHaveAccessibleName('Theme: Light');
});

test.describe('with JavaScript disabled', () => {
    test.use({ javaScriptEnabled: false });

    for (const [path, heading, ground, groundName] of [
        ['/gallery', 'Gallery', SHELL_GROUND, "today's dark ground"],
        ['/about', artist.profile.statementHeading, PAPER, "About's paper"],
    ] as const) {
        test(`${path} shows its heading and SiteNav on ${groundName}, in Black`, async ({ page }) => {
            await page.emulateMedia({ colorScheme: 'light' });
            await page.goto(path);
            await expect(page.locator('html')).toHaveAttribute('data-theme', 'black');
            await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
            await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
            expect(await bodyBackground(page)).toBe(ground);
            if (path === '/gallery') expect(await galleryBackground(page)).toBe(DARK_GROUND);
        });
    }
});
