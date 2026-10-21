import type { Locator, Page } from '@playwright/test';
import sharp from 'sharp';
import { expectNoFadeOnBlur } from './support/focus';
import { expectHoverRulesGated } from './support/hover';
import { waitForHydration } from './support/hydration';
import { checkSurface } from './support/surface';
import { expect, test } from './support/test';
import { expectSingleTapActivates } from './support/touch';

const entries = (page: Page) => page.getByRole('button', { name: /^Photograph \d+ of 12$/ });
const lightbox = (page: Page) => page.getByRole('dialog', { name: 'Lightbox' });
const control = (page: Page, name: string) => lightbox(page).getByRole('button', { name, exact: true });
const enabledControls = (page: Page) => lightbox(page).getByRole('button', { disabled: false });
const currentThumbnail = (page: Page) => page.locator('.yarl__thumbnails_thumbnail[aria-current="true"]');

// ThemeToggle and BottomBar paint under the YARL portal, so the lightbox's own toolbar and thumbnail strip are its chrome.
const chrome = (page: Page) => [page.locator('.yarl__toolbar'), page.locator('.yarl__thumbnails_container')];

/** The scale() of the current slide's zoom wrapper. */
const zoomLevel = (page: Page) =>
    page.locator('.yarl__slide_current .yarl__slide_wrapper').evaluate((el: HTMLElement) => Number(/scale\(([\d.]+)\)/.exec(el.style.transform)?.[1] ?? 1));

/** The aria-label of whatever has focus. */
const focusedLabel = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName);

async function openGallery(page: Page, theme: 'dark' | 'light') {
    if (theme === 'light') await page.addInitScript(() => localStorage.setItem('theme', 'light'));
    await page.goto('/gallery');
    await waitForHydration(page);
    await expect(entries(page)).toHaveCount(12);
}

/** Waits until the lightbox has faded in and nothing in it is still animating. */
async function settle(page: Page) {
    await expect(page.locator('.yarl__portal_open')).toHaveCSS('opacity', '1');
    await expect
        .poll(() => page.locator('.yarl__portal').evaluate((root) => root.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length))
        .toBe(0);
}

/** Opens photo `position` with Enter on its tile. */
async function openLightbox(page: Page, { position = 1, theme = 'dark' }: { position?: number; theme?: 'dark' | 'light' } = {}) {
    await openGallery(page, theme);
    await entries(page).nth(position - 1).focus();
    await page.keyboard.press('Enter');
    await settle(page);
}

for (const viewport of [undefined, { width: 640, height: 400 }]) {
    test.describe(viewport ? 'at 640 by 400, which is 200% zoom' : 'at the project viewport', () => {
        if (viewport) test.use({ viewport });

        for (const theme of ['dark', 'light'] as const) {
            test(`passes the surface checks on every enabled control in the ${theme} theme`, async ({ page }) => {
                await openLightbox(page, { theme });
                await checkSurface(page, { controls: [enabledControls(page)], chrome: chrome(page) });
            });
        }
    });
}

test('each slide image is named for its photograph, and the thumbnails keep alt=""', async ({ page }) => {
    await openLightbox(page, { position: 2 });
    await expect(page.locator('.yarl__slide_current .yarl__slide_image')).toHaveAttribute('alt', 'Photograph 2 of 12');
    // Preloaded neighbors carry their own names.
    const slides = await page.locator('.yarl__slide_image').evaluateAll((images) => images.map((image) => image.getAttribute('alt')));
    expect(slides).toEqual(expect.arrayContaining(['Photograph 1 of 12', 'Photograph 2 of 12', 'Photograph 3 of 12']));
    const thumbnails = await page.locator('.yarl__thumbnails_thumbnail img').evaluateAll((images) => images.map((image) => image.getAttribute('alt')));
    expect(thumbnails.length).toBeGreaterThan(0);
    expect(thumbnails.every((alt) => alt === '')).toBe(true);
});

test('Tab and Shift+Tab reach every enabled control', async ({ page }) => {
    await openLightbox(page);
    const labels = await enabledControls(page).evaluateAll((elements) => elements.map((el) => el.getAttribute('aria-label')));
    expect(labels).toEqual(expect.arrayContaining(['Previous', 'Next', 'Zoom in', 'Play', 'Close', '1 of 12']));
    await enabledControls(page).first().focus();
    const forward = [await focusedLabel(page)];
    for (let press = 1; press < labels.length; press++) {
        await page.keyboard.press('Tab');
        forward.push(await focusedLabel(page));
    }
    expect(forward).toEqual(labels);
    const back: (string | null | undefined)[] = [];
    for (let press = 1; press < labels.length; press++) {
        await page.keyboard.press('Shift+Tab');
        back.push(await focusedLabel(page));
    }
    expect(back).toEqual(labels.slice(0, -1).reverse());
});

test('Previous, Next, and a thumbnail move the current photo with Enter and with Space', async ({ page }) => {
    await openLightbox(page, { position: 2 });
    await expect(currentThumbnail(page)).toHaveAccessibleName('2 of 12');
    const presses: [string, string, string][] = [
        ['Next', 'Enter', '3 of 12'],
        ['Next', 'Space', '4 of 12'],
        ['Previous', 'Enter', '3 of 12'],
        ['Previous', 'Space', '2 of 12'],
        ['3 of 12', 'Enter', '3 of 12'],
        ['2 of 12', 'Space', '2 of 12'],
    ];
    for (const [name, key, current] of presses) {
        await control(page, name).focus();
        await page.keyboard.press(key);
        await expect(currentThumbnail(page)).toHaveAccessibleName(current);
    }
});

test('Zoom in and Zoom out change the scale with Enter and with Space', async ({ page }) => {
    await openLightbox(page);
    await expect(control(page, 'Zoom in')).toBeEnabled();
    let level = await zoomLevel(page);
    for (const [name, key] of [['Zoom in', 'Enter'], ['Zoom in', 'Space'], ['Zoom out', 'Enter'], ['Zoom out', 'Space']] as const) {
        await control(page, name).focus();
        await page.keyboard.press(key);
        const before = level;
        await expect.poll(() => zoomLevel(page)).not.toBe(before);
        level = await zoomLevel(page);
        expect(name === 'Zoom in' ? level > before : level < before, `${name} with ${key} moves the scale from ${before} to ${level}`).toBe(true);
    }
});

test('Play and Pause swap with Enter and with Space', async ({ page }) => {
    await openLightbox(page);
    await control(page, 'Play').focus();
    await page.keyboard.press('Enter');
    await expect(control(page, 'Pause')).toBeFocused();
    await page.keyboard.press('Space');
    await expect(control(page, 'Play')).toBeFocused();
});

test('Close shuts the lightbox with Enter and with Space', async ({ page }) => {
    await openLightbox(page);
    for (const key of ['Enter', 'Space']) {
        if (key === 'Space') {
            await entries(page).first().focus();
            await page.keyboard.press('Enter');
            await settle(page);
        }
        await control(page, 'Close').focus();
        await page.keyboard.press(key);
        await expect(lightbox(page)).toBeHidden();
    }
});

test('Escape returns focus to the photo that opened the lightbox, after a slide change too', async ({ page }) => {
    await openLightbox(page, { position: 2 });
    await page.keyboard.press('ArrowRight');
    await expect(currentThumbnail(page)).toHaveAccessibleName('3 of 12');
    await page.keyboard.press('Escape');
    await expect(lightbox(page)).toBeHidden();
    await expect(entries(page).nth(1)).toBeFocused();
});

test('Close returns focus to the photo a mouse click opened', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile', 'Mouse clicks run on the desktop project.');
    await openGallery(page, 'dark');
    await entries(page).nth(4).click();
    await settle(page);
    await control(page, 'Close').click();
    await expect(lightbox(page)).toBeHidden();
    await expect(entries(page).nth(4)).toBeFocused();
});

test('Close returns focus to the photo a tap opened', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'Taps run on the touch project.');
    await openGallery(page, 'dark');
    await entries(page).nth(3).tap();
    await settle(page);
    await control(page, 'Close').tap();
    await expect(lightbox(page)).toBeHidden();
    await expect(entries(page).nth(3)).toBeFocused();
});

for (const edge of ['top', 'bottom'] as const) {
    test(`closing leaves the page where it was when a click or tap opened a photo with its ${edge} edge out of view`, async ({ page }, testInfo) => {
        const touch = testInfo.project.name === 'mobile';
        await openGallery(page, 'dark');
        const tile = entries(page).nth(7);
        // Chrome's plain focus() leaves a photo taller than the room between the scroll paddings where it is.
        const room = await page.evaluate(() => {
            const style = getComputedStyle(document.documentElement);
            return window.innerHeight - parseFloat(style.scrollPaddingTop) - parseFloat(style.scrollPaddingBottom);
        });
        expect((await tile.boundingBox())?.height, 'the photo fits between the scroll paddings').toBeLessThan(room);
        // 40 px past the edge of the viewport, so YARL's plain focus() on close would bring it into view.
        await tile.evaluate((el, edge) => {
            const { top, bottom } = el.getBoundingClientRect();
            window.scrollTo(0, window.scrollY + (edge === 'top' ? top + 40 : bottom - window.innerHeight - 40));
        }, edge);
        const box = await tile.boundingBox();
        if (!box) throw new Error('The photo has no box');
        const before = await page.evaluate(() => window.scrollY);

        // At the middle of the part in view, since click() and tap() would scroll the photo into view first.
        const viewport = page.viewportSize();
        if (!viewport) throw new Error('No viewport');
        const [x, y] = [box.x + box.width / 2, (Math.max(box.y, 0) + Math.min(box.y + box.height, viewport.height)) / 2];
        if (touch) await page.touchscreen.tap(x, y);
        else await page.mouse.click(x, y);
        await settle(page);
        if (touch) await control(page, 'Close').tap();
        else await control(page, 'Close').click();
        await expect(lightbox(page)).toBeHidden();

        expect(await page.evaluate(() => window.scrollY), 'the page stays where it was').toBe(before);
        await expect(tile).toBeFocused();
    });
}

test('Escape returns focus to a photo whose click never focused it', async ({ page }) => {
    await openGallery(page, 'dark');
    // The click handler runs but focus stays put, as in Safari, which doesn't focus a button on click.
    await entries(page).nth(2).dispatchEvent('click');
    await settle(page);
    await page.keyboard.press('Escape');
    await expect(lightbox(page)).toBeHidden();
    await expect(entries(page).nth(2)).toBeFocused();
});

test('closing leaves focus where the reader moved it while the lightbox fades out', async ({ page }) => {
    await openLightbox(page, { position: 2 });
    await page.keyboard.press('Escape');
    // YARL lifts inert as soon as the close starts, then fades out for 250 ms.
    const home = page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Home', exact: true });
    await home.focus();
    await expect(lightbox(page)).toBeHidden();
    await expect(home).toBeFocused();
});

test('one tap on a toolbar button activates it and leaves it untransformed', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'Taps run on the touch project.');
    await openGallery(page, 'dark');
    await entries(page).first().tap();
    await settle(page);
    await expectSingleTapActivates(control(page, 'Play'), () => expect(control(page, 'Pause')).toBeVisible());
    // :active scales the button during the press. A sticky hover style would never settle back to none.
    await expect
        .poll(() => control(page, 'Pause').evaluate((el) => `${getComputedStyle(el).transform} ${getComputedStyle(el).scale}`))
        .toBe('none none');
});

test("Previous and Next keep YARL's translateY(-50%) on hover, while pressed, and after a tap", async ({ page }, testInfo) => {
    const touch = testInfo.project.name === 'mobile';
    await openGallery(page, 'dark');
    if (touch) await entries(page).first().tap();
    else await entries(page).first().click();
    await settle(page);
    // Playwright's tap() presses and releases at once, and whether a held synthetic touch shows
    // :active depends on the platform's gesture timing, so DevTools forces the pressed state.
    const devtools = await page.context().newCDPSession(page);
    await devtools.send('DOM.enable');
    await devtools.send('CSS.enable');
    for (const [name, selector] of [['Next', '.yarl__navigation_next'], ['Previous', '.yarl__navigation_prev']] as const) {
        const button = control(page, name);
        const transform = () => button.evaluate((el) => getComputedStyle(el).transform);
        const resting = await transform();
        expect(resting, `${name} rests at translateY(-50%)`).toMatch(/^matrix\(1, 0, 0, 1, 0, -\d+(\.\d+)?\)$/);
        if (!touch) {
            // Hover styles only apply to fine pointers.
            await button.hover();
            expect(await transform(), `${name} keeps translateY(-50%) under hover`).toBe(resting);
        }
        const { root } = await devtools.send('DOM.getDocument', { depth: 0 });
        const { nodeId } = await devtools.send('DOM.querySelector', { nodeId: root.nodeId, selector });
        await devtools.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['active'] });
        expect(await button.evaluate((el) => el.matches(':active')), `${name} should be :active`).toBe(true);
        expect(await transform(), `${name} keeps translateY(-50%) while pressed`).toBe(resting);
        await devtools.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
        if (touch) {
            await button.tap();
            await expect.poll(() => button.evaluate((el) => `${getComputedStyle(el).transform} ${getComputedStyle(el).scale}`)).toBe(`${resting} none`);
        }
    }
});

test('the lightbox controls drop their focus ring at once on blur', async ({ page }) => {
    await openLightbox(page);
    for (const name of ['Close', 'Next', '2 of 12']) await expectNoFadeOnBlur(control(page, name));
});

/** Contrast between a control's lightest and darkest pixels. Over a flat backdrop, that's its icon or halo against the backdrop. */
async function iconContrast(target: Locator): Promise<number> {
    const png = await target.screenshot({ animations: 'disabled' });
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const linear = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
    let darkest = 1;
    let lightest = 0;
    for (let i = 0; i < data.length; i += info.channels) {
        const luminance = 0.2126 * linear(data[i]) + 0.7152 * linear(data[i + 1]) + 0.0722 * linear(data[i + 2]);
        darkest = Math.min(darkest, luminance);
        lightest = Math.max(lightest, luminance);
    }
    return (lightest + 0.05) / (darkest + 0.05);
}

for (const theme of ['dark', 'light'] as const) {
    for (const [fixture, color] of [['white', '#fff'], ['black', '#000']] as const) {
        test(`the lightbox icons keep 3:1 over the ${fixture} photo in the ${theme} theme`, async ({ page }) => {
            await openLightbox(page, { theme });
            // A flat backdrop in the fixture's color stands in for that photo right behind every icon. White is the
            // hard case for the dark theme's white icons, and black for the light theme's dark ones. html[data-theme]
            // outranks the light theme's own [data-theme="light"] .yarl__container background.
            await page.addStyleTag({
                content: `html[data-theme] .yarl__container, html[data-theme] .yarl__toolbar { background: ${color} !important; backdrop-filter: none !important; } .yarl__container::before, .yarl__slide { visibility: hidden !important; }`,
            });
            await expect(page.locator('.yarl__container')).toHaveCSS('background-color', color === '#fff' ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)');
            for (const name of ['Play', 'Zoom in', 'Close', 'Previous', 'Next']) {
                expect(await iconContrast(control(page, name)), `${name}'s icon over ${fixture}`).toBeGreaterThanOrEqual(3);
            }
        });
    }
}

// Each theme has its own hover rules, and only the active theme's match markup.
for (const theme of ['dark', 'light'] as const) {
    test(`every app hover rule in the lightbox waits for a fine pointer in the ${theme} theme`, async ({ page }) => {
        await openLightbox(page, { theme });
        await expectHoverRulesGated(page);
    });
}
