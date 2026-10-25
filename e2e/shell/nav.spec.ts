import type { Locator, Page } from '@playwright/test';
import { expectNotObscured } from '../support/focus';
import { expectHomeImmersive } from '../support/home';
import { waitForHydration } from '../support/hydration';
import { expectTabOrderMatchesVisualOrder } from '../support/keyboard';
import { expectReflow } from '../support/reflow';
import { checkSurface } from '../support/surface';
import { expect, test } from '../support/test';

// SiteNav on both #1 projects: order, names, and the current page per route,
// the #1 surface checks, reflow, normal flow outside Home, and no motion
// under reduce. On Home, its place in the chrome's nav region, above the
// slideshow controls.

const primary = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const navControls = (page: Page) => primary(page).locator('a, button');
const toggles = (page: Page) => page.getByRole('button', { name: /^Switch to (dark|light) mode$/ });
const slideshow = (page: Page) => page.getByRole('group', { name: 'Slideshow' });
const TOGGLE = /^Switch to (dark|light) mode$/;

/** The aria-label of whatever has focus, or its rendered text, which skips the toggle's hidden other name. */
const focusedName = (page: Page) =>
    page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el?.getAttribute('aria-label') ?? el?.innerText.trim() ?? '';
    });

async function open(page: Page, path: string, theme: 'dark' | 'light' = 'dark') {
    if (theme === 'light') await page.addInitScript(() => localStorage.setItem('theme', 'light'));
    await page.goto(path);
    await waitForHydration(page);
    await expect(primary(page)).toBeVisible();
}

type Box = { left: number; top: number; right: number; bottom: number };
const boxOf = (target: Locator) =>
    target.evaluate((el): Box => {
        const { left, top, right, bottom } = el.getBoundingClientRect();
        return { left, top, right, bottom };
    });
const overlap = (a: Box, b: Box) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;

for (const [path, current] of [['/gallery', 'Work'], ['/about', 'About'], ['/does-not-exist', null]] as const) {
    test(`on ${path} Tab goes wordmark, Home, Work, About, then the toggle, and ${current ?? 'no link'} is the current page`, async ({ page }) => {
        await open(page, path);
        const stops: string[] = [];
        for (let press = 0; press < 5; press++) {
            await page.keyboard.press('Tab');
            stops.push(await focusedName(page));
        }
        expect(stops.slice(0, 4)).toEqual(['KG, Keyur Golani', 'Home', 'Work', 'About']);
        expect(stops[4]).toMatch(TOGGLE);
        await expect(primary(page).locator('[aria-current="page"]')).toHaveText(current ? [current] : []);
        await expect(toggles(page)).toHaveCount(1);
    });
}

test('SiteNav reads left to right in DOM and Tab order', async ({ page }) => {
    await open(page, '/gallery');
    await expectTabOrderMatchesVisualOrder(page, navControls(page));
});

test('on / Home is the current page', async ({ page }) => {
    await open(page, '/');
    await expect(primary(page).locator('[aria-current="page"]')).toHaveText(['Home']);
    await expect(toggles(page)).toHaveCount(1);
});

test('the labels are visible text at rest, and the wordmark shows KG', async ({ page }) => {
    await open(page, '/gallery');
    for (const name of ['Home', 'Work', 'About']) {
        await expect(primary(page).getByRole('link', { name, exact: true })).toHaveText(name);
        await expect(primary(page).getByRole('link', { name, exact: true })).toBeVisible();
    }
    await expect(primary(page).getByRole('link', { name: 'KG, Keyur Golani' }).getByText('KG', { exact: true })).toBeVisible();
});

for (const theme of ['dark', 'light'] as const) {
    for (const path of ['/gallery', '/about', '/does-not-exist']) {
        test(`SiteNav passes the #1 checks on ${path} in the ${theme} theme`, async ({ page }) => {
            await open(page, path, theme);
            await checkSurface(page, { controls: [navControls(page)] });
        });
    }
}

test('SiteNav reflows at 320 px with 200% text, with no horizontal scroll', async ({ page }) => {
    await open(page, '/gallery');
    await expectReflow(navControls(page));
    await page.setViewportSize({ width: 320, height: 640 });
    await page.evaluate(() => document.documentElement.style.setProperty('font-size', '200%'));
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
});

for (const path of ['/gallery', '/about']) {
    test(`SiteNav sits in normal flow on ${path}`, async ({ page }) => {
        await open(page, path);
        const positions = await primary(page).evaluate((nav) => {
            const found: string[] = [];
            for (let node: Element | null = nav; node && node !== document.body; node = node.parentElement) {
                found.push(getComputedStyle(node).position);
            }
            return found;
        });
        expect(positions[0]).toBe('static');
        expect(positions.filter((position) => position === 'fixed' || position === 'sticky')).toEqual([]);
    });
}

for (const width of [320, 1280]) {
    test(`on / the revealed SiteNav and the slideshow controls don't overlap at ${width} px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await open(page, '/');
        // Keyboard focus in the chrome shows it and holds it.
        await page.keyboard.press('Tab');
        await expect.poll(() => primary(page).evaluate((nav) => parseFloat(getComputedStyle(nav.closest('[data-home-chrome]') ?? nav).opacity))).toBe(1);
        expect(overlap(await boxOf(primary(page)), await boxOf(slideshow(page)))).toBe(false);
        await expect(toggles(page)).toHaveCount(1);
    });
}

test.describe('on /about at short screens, over the in-flow portrait', () => {
    // The legacy About's fixed bottom portrait reached up behind SiteNav on short screens and painted over the links.
    // Since #11 the portrait sits in flow below SiteNav, and nothing in main is fixed or sticky.
    const portraitImages = (page: Page) => page.getByTestId('about-portrait').locator('img');

    for (const [width, height] of [[844, 390], [568, 320]] as const) {
        test(`at ${width} by ${height} each control keeps its ring clear of the portrait, and each link takes a click or tap at its centre`, async ({ page }, testInfo) => {
            await page.setViewportSize({ width, height });
            await open(page, '/about');
            await expect(portraitImages(page)).not.toHaveCount(0);
            const pinned = await page.locator('main').evaluate((main) =>
                [main, ...Array.from(main.querySelectorAll('*'))].filter((el) => /^(fixed|sticky)$/.test(getComputedStyle(el).position)).map((el) => el.tagName),
            );
            expect(pinned, 'nothing in main is fixed or sticky').toEqual([]);

            for (const control of await navControls(page).all()) await expectNotObscured(control, [portraitImages(page)]);

            for (const [name, path] of [['Home', '/'], ['Work', '/gallery'], ['About', '/about']] as const) {
                const link = primary(page).getByRole('link', { name, exact: true });
                const atCentre = await link.evaluate((el) => {
                    const { left, top, width: w, height: h } = el.getBoundingClientRect();
                    const hit = document.elementFromPoint(left + w / 2, top + h / 2);
                    return hit !== null && el.contains(hit);
                });
                expect(atCentre, `${name} is the element at its own centre`).toBe(true);
                if (testInfo.project.name === 'mobile') await link.tap();
                else await link.click();
                await expect(page).toHaveURL(path);
                if (path === '/about') continue;
                await page.goto('/about');
                await waitForHydration(page);
            }
        });
    }
});

test.describe('on / on a short screen', () => {
    // The screens where the settled portrait once reached up behind SiteNav and took the hit at every link's centre.
    // Settled Home has no portrait now, and keyboard focus reveals the chrome and holds it.
    const SHORT_SCREENS = [[640, 400], [667, 375], [568, 320], [740, 360], [736, 414], [768, 400]] as const;
    const portrait = (page: Page) => page.locator('[class*="portrait"]');

    /** Whether a click or tap at the centre of `target` lands on it. */
    const takesItsCentre = (target: Locator) =>
        target.evaluate((el) => {
            const { left, top, width, height } = el.getBoundingClientRect();
            const hit = document.elementFromPoint(left + width / 2, top + height / 2);
            return hit !== null && el.contains(hit);
        });

    /** Presses Tab until `target` has focus, so the focus is keyboard focus. */
    async function tabTo(page: Page, target: Locator) {
        for (let press = 0; press < 10; press++) {
            if (await target.evaluate((el) => el === document.activeElement)) return;
            await page.keyboard.press('Tab');
        }
        await expect(target).toBeFocused();
    }

    const checks = () => SHORT_SCREENS.forEach(([width, height]) => {
        test(`at ${width} by ${height} the links keep their rings in view and take a click or tap`, async ({ page }, testInfo) => {
            await page.setViewportSize({ width, height });
            await open(page, '/');
            await expectHomeImmersive(page);
            await expect(portrait(page)).toHaveCount(0);

            for (const name of ['Home', 'Work', 'About']) {
                const link = primary(page).getByRole('link', { name, exact: true });
                await tabTo(page, link);
                await expectNotObscured(link, []);
            }

            for (const [name, path] of [['Home', '/'], ['Work', '/gallery'], ['About', '/about']] as const) {
                const link = primary(page).getByRole('link', { name, exact: true });
                await tabTo(page, link);
                expect(await takesItsCentre(link), `${name} is the element at its own centre`).toBe(true);
                if (testInfo.project.name === 'mobile') await link.tap();
                else await link.click();
                await expect(page).toHaveURL(path);
                if (path === '/') continue;
                await page.goBack();
                await expect(page).toHaveURL('/');
                await expectHomeImmersive(page);
            }
        });
    });

    test.describe('with motion on', checks);

    test.describe('under reduced motion', () => {
        // No intro and no portrait, and the links keep their rings and their hits the same way.
        test.beforeEach(async ({ page }) => {
            await page.emulateMedia({ reducedMotion: 'reduce' });
        });
        checks();
    });
});

test.describe('under reduced motion', () => {
    test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
    });

    test('nothing in SiteNav transitions or transforms', async ({ page }) => {
        await open(page, '/gallery');
        const moving = await primary(page).evaluate((nav) => {
            const found: string[] = [];
            for (const el of [nav, ...Array.from(nav.querySelectorAll('*'))]) {
                const style = getComputedStyle(el);
                if (style.transform !== 'none') found.push(`${el.tagName} transforms ${style.transform}`);
                for (const value of style.transitionDuration.split(',')) {
                    const text = value.trim();
                    const ms = text.endsWith('ms') ? parseFloat(text) : parseFloat(text) * 1000;
                    if (ms > 0.01) found.push(`${el.tagName} transitions for ${text}`);
                }
            }
            return found;
        });
        expect(moving).toEqual([]);
    });
});
