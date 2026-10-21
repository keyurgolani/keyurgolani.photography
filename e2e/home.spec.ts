import type { Locator, Page } from '@playwright/test';
import { expectContrastOverImage } from './support/contrast';
import { expectFocusRingVisible, expectNoFadeOnBlur, expectNotObscured, expectRingNotClipped } from './support/focus';
import { expectHoverRulesGated } from './support/hover';
import { waitForHydration } from './support/hydration';
import { checkSurface, expectUniqueNames } from './support/surface';
import { expectMinTargetSize } from './support/targets';
import { expect, setPhotoFixtures, test } from './support/test';

const primary = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const navLinks = (page: Page) => primary(page).getByRole('link');
const themeToggle = (page: Page) => page.getByRole('button', { name: /^Switch to (dark|light) mode$/ });
const previous = (page: Page) => page.getByRole('button', { name: 'Previous photograph', exact: true });
const next = (page: Page) => page.getByRole('button', { name: 'Next photograph', exact: true });
const arrows = (page: Page) => previous(page).or(next(page));
/** The full-quality layer of the slide on screen. */
const currentPhoto = (page: Page) => page.locator('[aria-hidden="false"] > img[data-layer="optimized"]');

const effectiveOpacity = (target: Locator) =>
    target.evaluate((el) => {
        let opacity = 1;
        for (let node: Element | null = el; node; node = node.parentElement) opacity *= parseFloat(getComputedStyle(node).opacity);
        return opacity;
    });

/** Every stop on this page is named by its aria-label. */
const focusedLabel = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName);

/** BottomBar's own opacity, apart from the chrome layer's, which reaches 1 once it has slid up after the intro. */
const bottomBarOpacity = (page: Page) =>
    primary(page).evaluate((el) => parseFloat(getComputedStyle(el.closest('.fixed.bottom-0') ?? el).opacity));

/**
 * Opens Home on `photos`, which it shuffles, and waits out the intro: the
 * grain overlay gone and BottomBar slid up. It doesn't wait on the chrome
 * layer, which shows for about 5.5 s after the intro and hides 3 s after the
 * last activity, so a slow run can't miss that window. No test here needs the
 * chrome shown before it acts.
 */
async function openHome(page: Page, photos: readonly string[] = ['white', 'gray', 'black']) {
    setPhotoFixtures(page, photos);
    await page.goto('/');
    await waitForHydration(page);
    await expect(page.locator('[class*="grainOverlay"]')).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => bottomBarOpacity(page), { timeout: 10_000 }).toBe(1);
}

test('passes the surface checks on the arrows, with 44 px targets and unique names on every control', async ({ page }) => {
    await openHome(page);
    await checkSurface(page, { controls: [arrows(page)], chrome: [primary(page), themeToggle(page)] });
    await expectMinTargetSize(themeToggle(page).or(navLinks(page)));
    await expectUniqueNames([themeToggle(page), arrows(page), navLinks(page)]);
});

test('Tab goes from the theme toggle to both arrows, then the Primary links, and Shift+Tab walks back', async ({ page }) => {
    await openHome(page);
    const stops = ['Switch to light mode', 'Previous photograph', 'Next photograph', 'Gallery', 'Home', 'About'];
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

test('Tab shows the theme toggle with its focus ring inside the 3 s idle window', async ({ page }) => {
    await openHome(page);
    await page.keyboard.press('Tab');
    const toggle = themeToggle(page);
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveCSS('opacity', '1');
    await expectFocusRingVisible(toggle);
    await expectRingNotClipped(toggle);
    await expectNotObscured(toggle, [primary(page), toggle]);
});

test('keyboard focus on an arrow shows both arrows at full opacity', async ({ page }) => {
    await openHome(page);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(previous(page)).toBeFocused();
    expect(await effectiveOpacity(previous(page))).toBe(1);
    await expect(next(page)).toHaveCSS('opacity', '1');
});

test('the arrows drop their focus ring at once on blur', async ({ page }) => {
    await openHome(page);
    for (const arrow of [previous(page), next(page)]) await expectNoFadeOnBlur(arrow);
});

test('Enter and Space on the arrows change the photo', async ({ page }) => {
    await openHome(page);
    await expect(currentPhoto(page)).toHaveAttribute('alt', 'Photograph 1 of 3');
    const presses: [(page: Page) => Locator, string, number][] = [
        [next, 'Enter', 2],
        [next, 'Space', 3],
        [previous, 'Enter', 2],
        [previous, 'Space', 1],
    ];
    for (const [arrow, key, position] of presses) {
        await arrow(page).focus();
        await page.keyboard.press(key);
        await expect(currentPhoto(page)).toHaveAttribute('alt', `Photograph ${position} of 3`);
    }
});

test('Enter and Space on the theme toggle flip the theme', async ({ page }) => {
    await openHome(page);
    const html = page.locator('html');
    await page.keyboard.press('Tab');
    await expect(themeToggle(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(html).toHaveAttribute('data-theme', 'light');
    await page.keyboard.press('Space');
    await expect(html).toHaveAttribute('data-theme', 'dark');
});

for (const [name, path] of [['Gallery', '/gallery'], ['About', '/about']] as const) {
    test(`Enter on the ${name} link goes to ${path}`, async ({ page }) => {
        await openHome(page);
        await primary(page).getByRole('link', { name, exact: true }).focus();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(path);
    });
}

test('each slide names its photo once, on the full-quality layer', async ({ page }) => {
    await openHome(page);
    const alts = (layer: string) => page.locator(`img[data-layer="${layer}"]`).evaluateAll((images) => images.map((image) => image.getAttribute('alt')));
    const thumbnails = await alts('thumbnail');
    expect(thumbnails.length).toBeGreaterThan(0);
    expect(thumbnails.every((alt) => alt === '')).toBe(true);
    const optimized = await alts('optimized');
    expect(optimized.length).toBeGreaterThan(0);
    for (const alt of optimized) expect(alt).toMatch(/^Photograph [1-3] of 3$/);
});

test('the arrow icons keep 3:1 over the white photo', async ({ page }) => {
    await openHome(page, ['white']);
    await expect(currentPhoto(page)).toHaveCSS('opacity', '1');
    for (const arrow of [previous(page), next(page)]) {
        await arrow.focus();
        await expect(arrow).toHaveCSS('opacity', '1');
        await expectContrastOverImage(arrow.locator('svg'), { min: 3 });
    }
});

test('every app hover rule on the page waits for a fine pointer', async ({ page }) => {
    await openHome(page);
    await expectHoverRulesGated(page);
});

// #18 (Home immersive mode) owns these, and e2e/home-immersive.spec.ts replaces them.
test.describe('#18', () => {
    test.fixme('a click on Previous or Next changes the photo', async ({ page }, testInfo) => {
        test.skip(testInfo.project.name === 'mobile', 'Mouse clicks run on the desktop project.');
        await openHome(page);
        await next(page).click();
        await expect(currentPhoto(page)).toHaveAttribute('alt', 'Photograph 2 of 3');
    });

    test.fixme('a tap on Previous or Next changes the photo', async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== 'mobile', 'Taps run on the touch project.');
        await openHome(page);
        await next(page).tap();
        await expect(currentPhoto(page)).toHaveAttribute('alt', 'Photograph 2 of 3');
    });

    test.fixme('the first tap on idle Home reveals the controls without navigating', async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== 'mobile', 'Taps run on the touch project.');
        await openHome(page);
        await expect.poll(() => effectiveOpacity(primary(page)), { timeout: 10_000 }).toBe(0);
        await primary(page).getByRole('link', { name: 'Gallery', exact: true }).tap();
        await expect(page).toHaveURL('/');
        await expect.poll(() => effectiveOpacity(primary(page))).toBe(1);
    });

    test.fixme('focus inside the controls holds them visible past the idle timeout', async ({ page }) => {
        await openHome(page);
        const gallery = primary(page).getByRole('link', { name: 'Gallery', exact: true });
        await gallery.focus();
        // The chrome hides 3 s after the last activity and then fades for 1 s, and app/page.tsx's synthetic click
        // when autoplay turns on, 2.5 s after the intro, restarts that timer. So 7 s waits on the behavior itself,
        // not on readiness.
        await page.waitForTimeout(7_000);
        expect(await effectiveOpacity(gallery)).toBe(1);
    });
});
