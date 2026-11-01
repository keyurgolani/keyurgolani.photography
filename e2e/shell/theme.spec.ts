import type { Page } from '@playwright/test';
import { artist } from '../../data/artist';
import { waitForHydration } from '../support/hydration';
import { expect, test } from '../support/test';

// The theme control: System is the default, and on a dark device it paints Dark, which is today's site exactly; a
// visitor without JavaScript gets Dark too, and no control. These pin what the server sends, what the inline script
// resolves before any Next.js script, that Dark keeps today's grounds, that today's stored `dark` stays Dark and the
// preview's `charcoal` reads as Dark, Black as its own choice, a choice in another tab, and the control under forced
// colours.

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
/** Today's grounds, which Dark keeps: the legacy Gallery's dark main, the shell's Gallery After Hours, About's paper. */
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

test('the server sends System painting Dark', async ({ request }) => {
    const html = await (await request.get('/gallery')).text();
    expect(html).toMatch(/<html[^>]*data-theme="dark"/);
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
    ['dark', 'dark', 'Theme: System (Dark now)'],
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
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await galleryBackground(page)).toBe(DARK_GROUND);
    expect(await bodyBackground(page)).toBe(SHELL_GROUND);
});

for (const theme of ['dark', 'black', 'light'] as const) {
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

test("today's stored dark stays Dark, the preview's charcoal reads as Dark, and Black is its own choice", async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.addInitScript(() => {
        if (!sessionStorage.getItem('seeded')) {
            localStorage.setItem('theme', 'dark');
            sessionStorage.setItem('seeded', '1');
        }
    });
    await page.goto('/gallery');
    await waitForHydration(page);
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(html).toHaveAttribute('data-theme-choice', 'dark');
    expect(await bodyBackground(page)).toBe(SHELL_GROUND);
    await expect(control(page)).toHaveAccessibleName('Theme: Dark');

    await control(page).click();
    // A pointer's choice applies in the view transition's callback, a frame later.
    await page.getByRole('radio', { name: /^Black/ }).click();
    await expect(page.getByRole('radio', { name: /^Black/ })).toBeChecked();
    await expect(html).toHaveAttribute('data-theme', 'black');
    await expect(html).toHaveAttribute('data-theme-choice', 'black');
    expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('black');
    await page.keyboard.press('Escape');
    await expect(control(page)).toHaveAccessibleName('Theme: Black');
    // The menu, opened again in Black, keeps its sheet and its checked ring (the remap's review, M1).
    await control(page).click();
    await expect(page.getByRole('radio', { name: /^Black/ })).toBeChecked();
    const sheet = await page.locator('.theme-menu-popover').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(sheet, "the menu's sheet in Black").not.toBe('rgba(0, 0, 0, 0)');
    const ring = await page.locator('.theme-menu-option:has(.theme-menu-radio:checked) .theme-menu-preview').evaluate((el) => getComputedStyle(el).boxShadow);
    expect(ring, "the checked preview's ring in Black").not.toBe('none');
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'black');

    // The preview's stored Dark, `charcoal`, reads as Dark with no write.
    await page.evaluate(() => localStorage.setItem('theme', 'charcoal'));
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(html).toHaveAttribute('data-theme-choice', 'dark');
    expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('charcoal');
});

test('a choice made in another tab applies here too', async ({ context, page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/gallery');
    await waitForHydration(page);
    const other = await context.newPage();
    await other.goto('/gallery');
    await waitForHydration(other);
    await other.evaluate(() => localStorage.setItem('theme', 'bright'));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'bright');
    await expect(control(page)).toHaveAccessibleName('Theme: Bright');
    await other.close();
});

test('under forced colours the swatch keeps an edge, and only the chosen row shows a check', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark', forcedColors: 'active' });
    await page.goto('/gallery');
    await waitForHydration(page);
    expect(await page.locator('.theme-menu-swatch').evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
    await control(page).click();
    await expect(page.getByRole('radio', { name: /^System/ })).toBeChecked();
    const checks = await page.locator('.theme-menu-check').evaluateAll((marks) => marks.map((mark) => getComputedStyle(mark).visibility));
    expect(checks).toEqual(['visible', 'hidden', 'hidden', 'hidden', 'hidden']);
});

test('a choice in the control applies at once, is stored, and a reload keeps it from first paint', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/gallery');
    await waitForHydration(page);
    const html = page.locator('html');
    await expect(control(page)).toHaveAccessibleName('Theme: System (Dark now)');

    await control(page).click();
    // A pointer's choice applies in the view transition's callback, a frame later.
    await page.getByRole('radio', { name: /^Light/ }).click();
    await expect(page.getByRole('radio', { name: /^Light/ })).toBeChecked();
    await expect(html).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('light');
    await page.keyboard.press('Escape');
    await expect(control(page)).toHaveAccessibleName('Theme: Light');

    await page.route('**/_next/static/**/*.js', (route) => route.abort());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(html).toHaveAttribute('data-theme', 'light');
    await expect(control(page)).toHaveAccessibleName('Theme: Light');
});

test("a press before the menu's styles land waits, marked busy, and opens the menu once they're in (R2-P3-3)", async ({ page, request }) => {
    // The page's own stylesheets are the ones its HTML links; the popover's come later, with its chunk. Hold only those.
    const html = await (await request.get('/work')).text();
    const firstLoad = new Set(
        [...html.matchAll(/<link\b[^>]*>/g)]
            .map((match) => match[0])
            .filter((tag) => /\brel="stylesheet"/.test(tag))
            .map((tag) => new URL(/\bhref="([^"]+)"/.exec(tag)![1], 'http://x').pathname),
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let asked = 0;
    await page.route('**/*.css', async (route) => {
        if (!firstLoad.has(new URL(route.request().url()).pathname)) {
            asked++;
            await held;
        }
        await route.continue();
    });
    await page.goto('/work');
    await waitForHydration(page);
    // The button has no popovertarget until the styles are in, so this press can only wait.
    await expect(control(page)).not.toHaveAttribute('popovertarget');
    await control(page).click();
    await expect(control(page)).toHaveAttribute('aria-busy', 'true');
    await expect.poll(() => asked).toBeGreaterThan(0);
    const open = () => page.locator('[popover]').evaluate((el) => el.matches(':popover-open'));
    expect(await open()).toBe(false);
    release();
    await expect.poll(open).toBe(true);
    await expect(control(page)).not.toHaveAttribute('aria-busy');
    await expect(control(page)).toHaveAttribute('popovertarget');
});

test.describe('with JavaScript disabled', () => {
    test.use({ javaScriptEnabled: false });

    for (const [path, heading, ground, groundName] of [
        ['/gallery', 'Gallery', SHELL_GROUND, "today's dark ground"],
        ['/about', artist.profile.statementHeading, PAPER, "About's paper"],
    ] as const) {
        test(`${path} shows its heading and SiteNav on ${groundName}, in Dark, with no theme control`, async ({ page }) => {
            await page.emulateMedia({ colorScheme: 'light' });
            await page.goto(path);
            await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
            await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
            await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
            // Nothing in the menu could work without JavaScript, so it isn't offered (R2-P2-6).
            await expect(page.getByRole('button', { name: /^Theme:/ })).toHaveCount(0);
            expect(await bodyBackground(page)).toBe(ground);
            if (path === '/gallery') expect(await galleryBackground(page)).toBe(DARK_GROUND);
        });
    }
});

test('under reduced motion a switch starts next to no transitions, however many elements it recolours', async ({ page }) => {
    // The v1.3.0 phone scroll regression: the reduced-motion baseline's 0.01 ms of `all` on every element made a switch
    // start a transition per element and colour, about 45,000 on the 5,000-photo series. ThemeProvider's
    // data-theme-swap and its rule in app/globals.css stop them; drop either and this counts hundreds.
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.goto('/gallery');
    await waitForHydration(page);
    await control(page).click();
    const light = page.getByRole('radio', { name: /^Light/ });
    await expect(light).toBeVisible();
    await light.hover();
    const elements = await page.evaluate(() => {
        const counted = window as unknown as { transitionRuns: number };
        counted.transitionRuns = 0;
        document.addEventListener('transitionrun', () => void counted.transitionRuns++, true);
        return document.querySelectorAll('body *').length;
    });
    // Work in CI's fixture holds about 120 elements: an unguarded switch still starts at least one transition per
    // recoloured element, several times the ceiling below.
    expect(elements, 'a page with enough elements that an unguarded switch would count far past the ceiling').toBeGreaterThanOrEqual(100);

    await light.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect.poll(() => page.evaluate(() => document.documentElement.hasAttribute('data-theme-swap')), 'the guard comes off two frames later').toBe(false);
    // A few frames more, for any 0.01 ms transition's events to land.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 100)))));
    const runs = await page.evaluate(() => (window as unknown as { transitionRuns: number }).transitionRuns);
    // The radio's own :checked and the menu's rows may start a handful; a recoloured page starts one per element.
    expect(runs, `transitions a switch started, against ${elements} elements`).toBeLessThanOrEqual(20);
});
