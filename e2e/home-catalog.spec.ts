import type { Locator, Page, TestInfo } from '@playwright/test';
import sharp from 'sharp';
import { altOf, CATALOG_ORIGIN, HOME_OPENING, HOME_ORDER, HOME_SERIES } from './support/catalog-home';
import { contrast, type Rgb } from './support/contrast';
import { expectHomeImmersive, photoPoint } from './support/home';
import { waitForHydration } from './support/hydration';
import { checkSurface, expectUniqueNames } from './support/surface';
import { expect, test } from './support/test';

// #4: Home after the cutover, on playwright.config.ts's catalog-mode server,
// which serves the published fixture in e2e/support/catalog-home.ts. Keyboard
// cases run on desktop and mobile, the mouse case on desktop, and the touch
// cases on mobile, each respecting #18's first-tap reveal.

test.use({ baseURL: CATALOG_ORIGIN });

const primary = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const themeToggle = (page: Page) => page.getByRole('button', { name: /^Theme:/ });
const previous = (page: Page) => page.getByRole('button', { name: 'Previous photograph', exact: true });
const next = (page: Page) => page.getByRole('button', { name: 'Next photograph', exact: true });
const pause = (page: Page) => page.getByRole('button', { name: 'Pause slideshow', exact: true });
const play = (page: Page) => page.getByRole('button', { name: 'Play slideshow', exact: true });
const enter = (page: Page) => page.getByRole('link', { name: 'Enter the series', exact: true });
const position = (page: Page) => page.getByRole('group', { name: 'Slideshow' }).getByText(/^\d{2,} \/ \d{2,}$/);
/** The slide on screen: the one not hidden from assistive technology. */
const shownSlide = (page: Page) => page.locator('[data-photo-id][aria-hidden="false"]');
const shownImage = (page: Page) => shownSlide(page).locator('img');
const storyControls = (page: Page) => previous(page).or(next(page)).or(pause(page)).or(enter(page));

const runsOn = (testInfo: TestInfo, ...projects: string[]) =>
    test.skip(!projects.includes(testInfo.project.name), `Runs on ${projects.join(' and ')}.`);

/** The authored position of a photograph, as Home shows it. */
const at = (photoId: string) => `${String(HOME_ORDER.indexOf(photoId as (typeof HOME_ORDER)[number]) + 1).padStart(2, '0')} / ${String(HOME_ORDER.length).padStart(2, '0')}`;

/** Expects `photoId` on screen, loaded, at its authored position. */
async function expectShown(page: Page, photoId: string) {
    await expect(shownSlide(page)).toHaveAttribute('data-photo-id', photoId);
    await expect(shownImage(page)).toHaveAttribute('alt', altOf(photoId));
    await expect.poll(() => shownImage(page).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    // Playwright counts opacity 0 as visible, so check the slide really shows.
    await expect(shownSlide(page)).toHaveCSS('opacity', '1');
}

/** Opens Home, counting /api/photos requests, and waits until it rests on the opening photograph alone. */
async function openHome(page: Page) {
    const legacyRequests: string[] = [];
    page.on('request', (request) => {
        if (new URL(request.url()).pathname.startsWith('/api/photos')) legacyRequests.push(request.url());
    });
    await page.goto('/');
    await waitForHydration(page);
    await expectHomeImmersive(page);
    return legacyRequests;
}

async function tabTo(page: Page, target: Locator, limit = 15) {
    for (let press = 0; press < limit; press++) {
        if (await target.evaluate((el) => el === document.activeElement)) return;
        await page.keyboard.press('Tab');
    }
    await expect(target).toBeFocused();
}

test('opens on the authored opening photograph, the same one on every reload, and never asks /api/photos', async ({ page }) => {
    const legacyRequests = await openHome(page);
    await expectShown(page, HOME_OPENING);
    await expect(position(page)).toHaveText(at(HOME_OPENING));
    await page.reload();
    await waitForHydration(page);
    await expectShown(page, HOME_OPENING);
    expect(legacyRequests).toEqual([]);
});

test('puts the series title, its statement, and the opening photograph in the server HTML', async ({ request }) => {
    const html = await (await request.get('/')).text();
    expect(html).toContain(HOME_SERIES.title);
    expect(html).toContain(HOME_SERIES.shortStatement);
    expect(html).toContain(`data-photo-id="${HOME_OPENING}"`);
    expect(html).toContain(`/work/${HOME_SERIES.slug}`);
});

test('passes the surface checks on the story and slideshow controls, with unique names', async ({ page }) => {
    await openHome(page);
    await checkSurface(page, { controls: [storyControls(page)], chrome: [primary(page), themeToggle(page)] });
    await expectUniqueNames([themeToggle(page), storyControls(page), primary(page).getByRole('link')]);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(HOME_SERIES.title);
});

test('Enter and Space on Previous and Next move through the authored order, wrapping, and Pause stops it', async ({ page }) => {
    await openHome(page);
    await tabTo(page, next(page));
    const start = HOME_ORDER.indexOf(HOME_OPENING);
    for (const [step, key] of (['Enter', 'Space', 'Enter'] as const).entries()) {
        await page.keyboard.press(key);
        await expectShown(page, HOME_ORDER[(start + step + 1) % HOME_ORDER.length]);
    }
    await previous(page).focus();
    await page.keyboard.press('Space');
    await expectShown(page, HOME_ORDER[(start + 2) % HOME_ORDER.length]);
    await pause(page).focus();
    await page.keyboard.press('Enter');
    await expect(play(page)).toBeVisible();
    await expect(page.locator('[data-playback]')).toHaveAttribute('data-playback', 'paused');
});

test('Enter on Enter the series goes to the series page', async ({ page }) => {
    await openHome(page);
    await tabTo(page, enter(page));
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`/work/${HOME_SERIES.slug}`);
});

test('a click on Next, after a move reveals the chrome, moves to the next authored photograph', async ({ page }, testInfo) => {
    runsOn(testInfo, 'desktop');
    await openHome(page);
    const { x, y } = await photoPoint(page);
    await page.mouse.move(x, y, { steps: 2 });
    await next(page).click();
    await expectShown(page, HOME_ORDER[(HOME_ORDER.indexOf(HOME_OPENING) + 1) % HOME_ORDER.length]);
});

test('after the first tap reveals the chrome, a tap on Next, Pause, and Enter the series each act', async ({ page }, testInfo) => {
    runsOn(testInfo, 'mobile');
    await openHome(page);
    const { x, y } = await photoPoint(page);
    await page.touchscreen.tap(x, y);
    await expect(page.locator('main[data-interface-state]')).toHaveAttribute('data-interface-state', 'interactive');
    await next(page).tap();
    await expectShown(page, HOME_ORDER[(HOME_ORDER.indexOf(HOME_OPENING) + 1) % HOME_ORDER.length]);
    await pause(page).tap();
    await expect(play(page)).toBeVisible();
    await enter(page).tap();
    await expect(page).toHaveURL(`/work/${HOME_SERIES.slug}`);
});

test('a failed next image keeps the photograph on screen, and Skip moves past it', async ({ page }, testInfo) => {
    runsOn(testInfo, 'desktop', 'mobile');
    const start = HOME_ORDER.indexOf(HOME_OPENING);
    const failing = HOME_ORDER[(start + 1) % HOME_ORDER.length];
    const after = HOME_ORDER[(start + 2) % HOME_ORDER.length];
    await page.route(`**/media/${failing}/**`, (route) => route.abort());
    await openHome(page);
    await expectShown(page, HOME_OPENING);
    await tabTo(page, next(page));
    await page.keyboard.press('Enter');
    await expect(position(page)).toHaveText(at(failing));
    await expect(page.getByRole('status')).toHaveText(`Photograph ${at(failing).replace(' / ', ' of ')} couldn’t load.`);
    await expectShown(page, HOME_OPENING);
    // Skip sits before the slideshow controls, so Shift+Tab reaches it from Next.
    const skip = page.getByRole('button', { name: 'Skip', exact: true });
    for (let press = 0; press < 3 && !(await skip.evaluate((el) => el === document.activeElement)); press++) await page.keyboard.press('Shift+Tab');
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expectShown(page, after);
    await expect(page.getByRole('status')).toHaveText('');
});

const whitePhoto = (format: 'avif' | 'webp') => sharp({ create: { width: 1920, height: 1280, channels: 3, background: '#ffffff' } })[format]().toBuffer();

/**
 * Rule 8 over the text's own pixels: the worst contrast between `target`'s
 * color and each pixel under its line boxes, with its text made transparent
 * for the screenshot. The line boxes, not the element's box, since the
 * story's scrim only has to hold behind the text.
 */
async function worstTextContrast(page: Page, target: Locator): Promise<number> {
    const { rects, rgb, alpha } = await target.evaluate((el) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true })!;
        context.fillStyle = getComputedStyle(el).color;
        context.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
        let opacity = 1;
        for (let node: Element | null = el; node; node = node.parentElement) opacity *= parseFloat(getComputedStyle(node).opacity);
        const range = document.createRange();
        range.selectNodeContents(el);
        const rects = Array.from(range.getClientRects(), ({ x, y, width, height }) => ({ x, y, width, height })).filter(({ width, height }) => width >= 1 && height >= 1);
        el.setAttribute('data-e2e-text-contrast', '');
        return { rects, rgb: [r, g, b] as Rgb, alpha: (a / 255) * opacity };
    });
    expect(rects.length, `${target} has text to measure`).toBeGreaterThan(0);
    const style = await page.addStyleTag({ content: '[data-e2e-text-contrast] { color: transparent !important; -webkit-text-fill-color: transparent !important; }' });
    let worst = Infinity;
    try {
        for (const clip of rects) {
            const png = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
            const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
            for (let i = 0; i < data.length; i += info.channels) {
                const behind: Rgb = [data[i], data[i + 1], data[i + 2]];
                const blend = (c: number) => rgb[c] * alpha + behind[c] * (1 - alpha);
                worst = Math.min(worst, contrast([blend(0), blend(1), blend(2)], behind));
            }
        }
    } finally {
        await style.evaluate((node) => node.parentNode?.removeChild(node));
        await target.evaluate((el) => el.removeAttribute('data-e2e-text-contrast'));
    }
    return worst;
}

for (const width of [1440, 1024]) {
    test(`the series title and statement keep 4.5:1 over a white opening photograph, revealed by keyboard, at ${width} px`, async ({ page }, testInfo) => {
        if (testInfo.project.name === 'desktop') await page.setViewportSize({ width, height: 900 });
        else test.skip(width !== 1440, 'One mobile run is enough.');
        await page.route(`**/media/${HOME_OPENING}/**`, async (route) => {
            const format = new URL(route.request().url()).pathname.endsWith('.avif') ? 'avif' : 'webp';
            await route.fulfill({ status: 200, contentType: `image/${format}`, body: await whitePhoto(format) });
        });
        await openHome(page);
        await expectShown(page, HOME_OPENING);
        await page.keyboard.press('Tab');
        await expect(page.locator('main')).toHaveAttribute('data-chrome-holds', /keyboard-focus/);
        await expect(page.locator('[data-home-chrome]')).toHaveCSS('opacity', '1');
        await expect(shownSlide(page)).toHaveAttribute('data-photo-id', HOME_OPENING);
        const title = page.getByRole('heading', { level: 1 });
        const statement = page.locator('[data-chrome-region="story"] p');
        await expect(statement).toHaveText(HOME_SERIES.shortStatement);
        for (const [name, target] of [['title', title], ['statement', statement]] as const) {
            expect(await worstTextContrast(page, target), `the ${name}'s worst contrast over the white photograph`).toBeGreaterThanOrEqual(4.5);
        }
    });
}

const solidPhoto = (colour: string) => (format: 'avif' | 'webp') => sharp({ create: { width: 1920, height: 1280, channels: 3, background: colour } })[format]().toBuffer();

/** Serves the opening photograph as one flat colour. */
async function openingAs(page: Page, colour: string) {
    await page.route(`**/media/${HOME_OPENING}/**`, async (route) => {
        const format = new URL(route.request().url()).pathname.endsWith('.avif') ? 'avif' : 'webp';
        await route.fulfill({ status: 200, contentType: `image/${format}`, body: await solidPhoto(colour)(format) });
    });
}

/** Reveals the chrome by keyboard and waits for it to show. */
async function revealByKeyboard(page: Page) {
    await page.keyboard.press('Tab');
    await expect(page.locator('main')).toHaveAttribute('data-chrome-holds', /keyboard-focus/);
    await expect(page.locator('[data-home-chrome]')).toHaveCSS('opacity', '1');
}

for (const theme of ['light', 'bright'] as const) {
    test(`in ${theme}, the copy takes a dark scrim over a dark opening photograph and keeps 4.5:1`, async ({ page }) => {
        await page.addInitScript((stored) => localStorage.setItem('theme', stored), theme);
        await openingAs(page, '#0a1018');
        await openHome(page);
        await expectShown(page, HOME_OPENING);
        await expect(page.locator('main')).toHaveAttribute('data-copy-tone', 'dark');
        await revealByKeyboard(page);
        const title = page.getByRole('heading', { level: 1 });
        const statement = page.locator('[data-chrome-region="story"] p');
        for (const [name, target] of [['title', title], ['statement', statement]] as const) {
            expect(await worstTextContrast(page, target), `the ${name}'s worst contrast over the dark photograph in ${theme}`).toBeGreaterThanOrEqual(4.5);
        }
    });
}

test('in Light, the copy keeps its paper scrim over a light opening photograph', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('theme', 'light'));
    await openingAs(page, '#f4f1ea');
    await openHome(page);
    await expectShown(page, HOME_OPENING);
    await expect(page.locator('main')).toHaveAttribute('data-copy-tone', 'light');
});

test('at 200% text on a small phone, the title keeps 4.5:1 with the chrome scrolled to its end (M1)', async ({ page }, testInfo) => {
    runsOn(testInfo, 'mobile');
    await page.setViewportSize({ width: 375, height: 667 });
    // Dark, over white: light ink, so its enlarged-text hold (spec §10) is what keeps the title. Light's and Bright's copy
    // follows the photograph's tone.
    await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
    await openingAs(page, '#ffffff');
    await openHome(page);
    await expectShown(page, HOME_OPENING);
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    await revealByKeyboard(page);
    const chrome = page.locator('[data-home-chrome]');
    await expect.poll(() => chrome.evaluate((el) => el.scrollHeight > el.clientHeight + 1), 'the chrome scrolls at 200% text').toBe(true);
    await expect(page.locator('[data-home-vignette]')).toHaveCSS('--home-copy-top', '0%');
    // As far as the chrome scrolls while the title is still in view below the nav: past 24 px the old hold left the
    // title's top lines in the fade.
    const title = page.getByRole('heading', { level: 1 });
    const scrolled = await chrome.evaluate((el, heading) => {
        const nav = document.querySelector('nav[aria-label="Primary"]')?.getBoundingClientRect().bottom ?? 0;
        const by = Math.min(el.scrollHeight - el.clientHeight, Math.floor(heading!.getBoundingClientRect().top - nav - 8));
        el.scrollTo(0, by);
        return el.scrollTop;
    }, await title.elementHandle());
    expect(scrolled, 'the chrome scrolled further than the old hold allowed').toBeGreaterThan(24);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await worstTextContrast(page, title), "the title's worst contrast with the chrome scrolled").toBeGreaterThanOrEqual(4.5);
});

test("Dark on a phone is today's at default text, and follows the copy only when the text is enlarged", async ({ page }, testInfo) => {
    runsOn(testInfo, 'mobile');
    await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
    await openHome(page);
    await expectShown(page, HOME_OPENING);
    const root = page.locator('main');
    const scrim = page.locator('[data-home-vignette]');
    await expect(root).not.toHaveAttribute('data-text-enlarged');
    // v1.2.0's phone wash, `linear-gradient(0deg, … .92 0%, … .28 66%, … .12 100%)`, as Chrome serializes it.
    await expect(scrim).toHaveCSS('background-image', 'linear-gradient(rgba(8, 10, 9, 0.12) 0%, rgba(8, 10, 9, 0.28) 34%, rgba(8, 10, 9, 0.92) 100%)');
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    await expect(root).toHaveAttribute('data-text-enlarged', '');
    await expect(scrim).not.toHaveCSS('background-image', /0\.28\) 34%/);
});

/**
 * A photograph in two flat halves, `top` over `bottom`: the copy sits over the bottom half at both sizes. Served at
 * 960 x 640 for every srcset candidate (400w to 1920w), so the candidate the browser takes has a natural size that
 * isn't its intrinsic one, as a real derivative's density makes it.
 */
const TWO_TONE_WIDTH = 960;
const twoTone = (top: string, bottom: string) => async (format: 'avif' | 'webp') => {
    const half = await sharp({ create: { width: TWO_TONE_WIDTH, height: 320, channels: 3, background: bottom } }).png().toBuffer();
    return sharp({ create: { width: TWO_TONE_WIDTH, height: 640, channels: 3, background: top } }).composite([{ input: half, left: 0, top: 320 }])[format]().toBuffer();
};

// H1: the browser picks a scaled srcset candidate, so the image's natural size isn't its intrinsic size. The tone must
// read the bottom half under the copy, not a region shifted by the candidate's density. Each fixture size is its own
// context, at its own pixel density.
for (const [size, viewport, scale] of [
    ['390 at DPR 3', { width: 390, height: 844 }, 3],
    ['1440 at DPR 2', { width: 1440, height: 900 }, 2],
] as const) {
    for (const theme of ['light', 'bright'] as const) {
        for (const [bottom, expected] of [
            ['dark', 'dark'],
            ['light', 'light'],
        ] as const) {
            test(`in ${theme} at ${size}, the tone reads the photograph under the copy: a ${bottom} bottom half is ${expected}`, async ({ browser }, testInfo) => {
                runsOn(testInfo, 'desktop');
                const context = await browser.newContext({ baseURL: CATALOG_ORIGIN, viewport, deviceScaleFactor: scale, colorScheme: 'dark' });
                try {
                    const page = await context.newPage();
                    await page.addInitScript((stored) => localStorage.setItem('theme', stored), theme);
                    const [light, dark] = ['#f4f1ea', '#0a1018'];
                    const photo = bottom === 'dark' ? twoTone(light, dark) : twoTone(dark, light);
                    await page.route(`**/media/${HOME_OPENING}/**`, async (route) => {
                        const format = new URL(route.request().url()).pathname.endsWith('.avif') ? 'avif' : 'webp';
                        await route.fulfill({ status: 200, contentType: `image/${format}`, body: await photo(format) });
                    });
                    await openHome(page);
                    await expectShown(page, HOME_OPENING);
                    // The candidate the browser took is a scaled one, so this case is the one H1 is about.
                    expect(await shownImage(page).evaluate((image: HTMLImageElement) => image.naturalWidth), 'a natural size other than the intrinsic one').not.toBe(TWO_TONE_WIDTH);
                    await expect(page.locator('main')).toHaveAttribute('data-copy-tone', expected);
                    await revealByKeyboard(page);
                    for (const target of [page.getByRole('heading', { level: 1 }), page.locator('[data-chrome-region="story"] p')]) {
                        expect(await worstTextContrast(page, target), `${theme} at ${size} over a ${bottom} bottom half`).toBeGreaterThanOrEqual(4.5);
                    }
                } finally {
                    await context.close();
                }
            });
        }
    }
}
