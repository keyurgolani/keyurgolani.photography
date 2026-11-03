import type { Locator, Page } from '@playwright/test';
import { expectContrastOverImage } from './support/contrast';
import { expectFocusRingVisible, expectNoFadeOnBlur, expectNotObscured, expectRingNotClipped } from './support/focus';
import { expectHomeImmersive, photoPoint } from './support/home';
import { expectHoverRulesGated } from './support/hover';
import { waitForHydration } from './support/hydration';
import { checkSurface, expectUniqueNames } from './support/surface';
import { expectMinTargetSize } from './support/targets';
import { altOf, CATALOG_ORIGIN, HOME_OPENING, HOME_ORDER } from './support/catalog-home';
import { expect, setPhotoFixtures, test } from './support/test';

// #1's checks on Home's slideshow, on playwright.config.ts's catalog server, which serves the published Home
// fixture: since #13's slice E Home renders only a published revision. The photographs are the fixture's own,
// painted with the photo fixtures (setPhotoFixtures()) from the opening photograph on.
test.use({ baseURL: CATALOG_ORIGIN });

/** The photograph `steps` on from the opening one in authored order, wrapping, as Home moves. */
const fromOpening = (steps: number) => HOME_ORDER[(HOME_ORDER.indexOf(HOME_OPENING) + steps + HOME_ORDER.length * 4) % HOME_ORDER.length];

const primary = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const navLinks = (page: Page) => primary(page).getByRole('link');
const themeControl = (page: Page) => page.getByRole('button', { name: /^Theme:/ });
const previous = (page: Page) => page.getByRole('button', { name: 'Previous photograph', exact: true });
const next = (page: Page) => page.getByRole('button', { name: 'Next photograph', exact: true });
const arrows = (page: Page) => previous(page).or(next(page));
const playback = (page: Page) => page.getByRole('button', { name: /^(Pause|Play) slideshow$/ });
/** Previous, Next, and the playback button, which sit together in the chrome layer. */
const sequenceControls = (page: Page) => arrows(page).or(playback(page));
/** The image of the slide on screen. */
const currentPhoto = (page: Page) => page.locator('[data-photo-id][aria-hidden="false"] img');

const effectiveOpacity = (target: Locator) =>
    target.evaluate((el) => {
        let opacity = 1;
        for (let node: Element | null = el; node; node = node.parentElement) opacity *= parseFloat(getComputedStyle(node).opacity);
        return opacity;
    });

/** The name of whatever has focus: its aria-label, or its rendered text, which skips the theme control's hidden names. */
const focusedLabel = (page: Page) =>
    page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? (document.activeElement as HTMLElement | null)?.innerText.replace(/\s+/g, ' ').trim());

/** Presses Tab until `target` has focus, so the focus is keyboard focus. */
async function tabTo(page: Page, target: Locator, limit = 10) {
    for (let press = 0; press < limit; press++) {
        if (await target.evaluate((el) => el === document.activeElement)) return;
        await page.keyboard.press('Tab');
    }
    await expect(target).toBeFocused();
}

/**
 * Opens Home with `photos` painted from the opening photograph on, in
 * `theme`, and waits until it rests on the photograph alone. Keyboard focus reveals the chrome and holds
 * it, and the pointer cases reveal it first, since #18 takes the first click
 * or tap on immersive Home as intent.
 */
async function openHome(page: Page, { photos = ['white', 'gray', 'black'], theme = 'dark' }: { photos?: readonly string[]; theme?: 'dark' | 'light' } = {}) {
    setPhotoFixtures(page, photos);
    if (theme === 'light') await page.addInitScript(() => localStorage.setItem('theme', 'light'));
    await page.goto('/');
    await waitForHydration(page);
    await expectHomeImmersive(page);
}

for (const viewport of [undefined, { width: 640, height: 400 }]) {
    test.describe(viewport ? 'at 640 by 400, which is 200% zoom' : 'at the project viewport', () => {
        if (viewport) test.use({ viewport });

        for (const theme of ['dark', 'light'] as const) {
            test(`passes the surface checks on the slideshow controls, with 44 px targets and unique names on every control, in the ${theme} theme`, async ({ page }) => {
                await openHome(page, { theme });
                await checkSurface(page, { controls: [sequenceControls(page)], chrome: [primary(page), themeControl(page)] });
                await expectMinTargetSize(themeControl(page).or(navLinks(page)));
                await expectUniqueNames([themeControl(page), sequenceControls(page), navLinks(page)]);
            });

            test(`Tab reaches the theme control in SiteNav with its focus ring in the ${theme} theme`, async ({ page }) => {
                await openHome(page, { theme });
                const toggle = themeControl(page);
                await tabTo(page, toggle);
                await expect(toggle).toHaveCSS('opacity', '1');
                await expectFocusRingVisible(toggle);
                await expectRingNotClipped(toggle);
                await expectNotObscured(toggle, [primary(page), toggle]);
            });
        }
    });
}

test('Tab goes through SiteNav, its theme control last, then both arrows and Pause, and Shift+Tab walks back', async ({ page }) => {
    await openHome(page);
    const stops = ['KG, Keyur Golani', 'Home', 'Work', 'About', 'Theme: System (Dark now)', 'Enter the series', 'Previous photograph', 'Next photograph', 'Pause slideshow'];
    const forward: (string | undefined)[] = [];
    for (let press = 0; press < stops.length; press++) {
        await page.keyboard.press('Tab');
        forward.push(await focusedLabel(page));
    }
    expect(forward).toEqual(stops);
    const back: (string | undefined)[] = [];
    for (let press = 1; press < stops.length; press++) {
        await page.keyboard.press('Shift+Tab');
        back.push(await focusedLabel(page));
    }
    expect(back).toEqual(stops.slice(0, -1).reverse());
});

test('keyboard focus on an arrow shows both arrows at full opacity', async ({ page }) => {
    await openHome(page);
    await tabTo(page, previous(page));
    expect(await effectiveOpacity(previous(page))).toBe(1);
    await expect(next(page)).toHaveCSS('opacity', '1');
});

test('the slideshow controls drop their focus ring at once on blur', async ({ page }) => {
    await openHome(page);
    for (const control of [previous(page), next(page), playback(page)]) await expectNoFadeOnBlur(control);
});

test('Enter and Space on the arrows change the photo', async ({ page }) => {
    await openHome(page);
    await expect(currentPhoto(page)).toHaveAttribute('alt', altOf(fromOpening(0)));
    const presses: [(page: Page) => Locator, string, number][] = [
        [next, 'Enter', 1],
        [next, 'Space', 2],
        [previous, 'Enter', 1],
        [previous, 'Space', 0],
    ];
    for (const [arrow, key, steps] of presses) {
        await arrow(page).focus();
        await page.keyboard.press(key);
        await expect(currentPhoto(page)).toHaveAttribute('alt', altOf(fromOpening(steps)));
    }
});

test('Enter on the theme control opens its menu on the checked choice, an arrow chooses, and Escape closes it', async ({ page }) => {
    await openHome(page);
    const html = page.locator('html');
    await tabTo(page, themeControl(page));
    // Focus loads the menu's styles; it opens once they're in.
    await expect(themeControl(page)).toHaveAttribute('popovertarget', /.+/);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('radio', { name: /^System/ })).toBeChecked();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('radio', { name: /^System/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(html).toHaveAttribute('data-theme-choice', 'light');
    await expect(html).toHaveAttribute('data-theme', 'light');
    await page.keyboard.press('Escape');
    await expect(themeControl(page)).toBeFocused();
});

for (const [name, href, path] of [['Work', '/work', '/work'], ['About', '/about', '/about']] as const) {
    test(`Enter on the ${name} link goes to ${path}`, async ({ page }) => {
        await openHome(page);
        await expect(primary(page).getByRole('link', { name, exact: true })).toHaveAttribute('href', href);
        await primary(page).getByRole('link', { name, exact: true }).focus();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(path);
    });
}

test('each slide names its photograph once, on its one image', async ({ page }) => {
    await openHome(page);
    const slides = await page.locator('[data-photo-id]').evaluateAll((elements) =>
        elements.map((slide) => ({ id: slide.getAttribute('data-photo-id') ?? '', alts: Array.from(slide.querySelectorAll('img'), (image) => image.getAttribute('alt')) })));
    expect(slides.length).toBeGreaterThan(0);
    for (const { id, alts } of slides) expect(alts, id).toEqual(alts.length === 0 ? [] : [altOf(id)]);
});

test('the control icons keep 3:1 over the white photo', async ({ page }) => {
    await openHome(page, { photos: ['white'] });
    await expect(currentPhoto(page)).toHaveCSS('opacity', '1');
    for (const control of [previous(page), next(page), playback(page)]) {
        await control.focus();
        await expect(control).toHaveCSS('opacity', '1');
        await expectContrastOverImage(control.locator('svg'), { min: 3 });
    }
});

test('every app hover rule on the page waits for a fine pointer', async ({ page }) => {
    await openHome(page);
    await expectHoverRulesGated(page);
});

// Immersive Home takes the first click or tap as intent, so these reveal the chrome first.
test('a click on Previous or Next changes the photo', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile', 'Mouse clicks run on the desktop project.');
    await openHome(page);
    const { x, y } = await photoPoint(page);
    await page.mouse.move(x, y, { steps: 2 });
    await next(page).click();
    await expect(currentPhoto(page)).toHaveAttribute('alt', altOf(fromOpening(1)));
});

test('a tap on Previous or Next changes the photo', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'Taps run on the touch project.');
    await openHome(page);
    const { x, y } = await photoPoint(page);
    await page.touchscreen.tap(x, y);
    await next(page).tap();
    await expect(currentPhoto(page)).toHaveAttribute('alt', altOf(fromOpening(1)));
});

test('a press on the photograph lands on its layer, never on an image', async ({ page }) => {
    await openHome(page);
    const { height } = page.viewportSize()!;
    // Left of centre, clear of the controls and SiteNav, on immersive Home.
    const hit = await page.evaluate((y) => {
        const el = document.elementFromPoint(24, y);
        return el && { tag: el.tagName, inPhotograph: el.closest('[class*="carousel"]') !== null };
    }, Math.round(height / 2));
    expect(hit).toEqual({ tag: 'DIV', inPhotograph: false });
});

// The keyboard hold past the idle and the first tap on idle Home, #18's, are in e2e/home-immersive.spec.ts.
