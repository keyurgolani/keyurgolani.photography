import type { Locator, Page, TestInfo } from '@playwright/test';
import sharp from 'sharp';
import type { TestCatalog } from '../lib/catalog/testing';
import { altOf, CATALOG_ORIGIN, HOME_ONE_LINE_TITLE, HOME_OPENING, HOME_ORDER, HOME_SERIES } from './support/catalog-home';
import { READY_TIMEOUT, startCatalogServer, type CatalogServer } from './support/catalogServer';
import { contrast, type Rgb } from './support/contrast';
import { expectHomeImmersive, photoPoint } from './support/home';
import { publishHomeCopyFixture } from './support/homeFixture';
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
/** #4's secondary link in the story (v2.0.0 B7). */
const allWork = (page: Page) => page.getByRole('link', { name: 'All bodies of work', exact: true });
const position = (page: Page) => page.getByRole('group', { name: 'Slideshow' }).getByText(/^\d{2,} \/ \d{2,}$/);
/** The slide on screen: the one not hidden from assistive technology. */
const shownSlide = (page: Page) => page.locator('[data-photo-id][aria-hidden="false"]');
const shownImage = (page: Page) => shownSlide(page).locator('img');
const storyControls = (page: Page) => previous(page).or(next(page)).or(pause(page)).or(enter(page)).or(allWork(page));

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
async function openHome(page: Page, url = '/') {
    const legacyRequests: string[] = [];
    page.on('request', (request) => {
        if (new URL(request.url()).pathname.startsWith('/api/photos')) legacyRequests.push(request.url());
    });
    await page.goto(url);
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

test('All bodies of work follows Enter the series in the story, and Enter on it goes to Work (#4, v2.0.0 B7)', async ({ page }) => {
    await openHome(page);
    const story = page.locator('[data-chrome-region="story"]');
    await expect(story.getByRole('link')).toHaveText(['Enter the series', 'All bodies of work']);
    await tabTo(page, enter(page));
    await page.keyboard.press('Tab');
    await expect(allWork(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('/work');
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

/** The authored photograph `steps` on from the opening one, wrapping. */
const after = (steps: number) => HOME_ORDER[(HOME_ORDER.indexOf(HOME_OPENING) + steps) % HOME_ORDER.length];
const status = (page: Page) => page.locator('[data-chrome-region="sequence"] [role="status"]');
const homeState = (page: Page) => page.locator('[data-home-state]');
const skip = (page: Page) => page.getByRole('button', { name: 'Skip', exact: true });
const retry = (page: Page) => page.getByRole('button', { name: 'Retry', exact: true });

/** Shift+Tab from where focus is until `target` has it, so it's keyboard focus. */
async function shiftTabTo(page: Page, target: Locator, limit = 4) {
    for (let press = 0; press < limit && !(await target.evaluate((el) => el === document.activeElement)); press++) await page.keyboard.press('Shift+Tab');
    await expect(target).toBeFocused();
}

test('a failed next image keeps the photograph on screen, and a focused Skip that lands gives focus back to Next', async ({ page }, testInfo) => {
    runsOn(testInfo, 'desktop', 'mobile');
    await page.route(`**/media/${after(1)}/**`, (route) => route.abort());
    await openHome(page);
    await expectShown(page, HOME_OPENING);
    await tabTo(page, next(page));
    await page.keyboard.press('Enter');
    await expect(status(page)).toHaveText(`Couldn’t load photograph ${at(after(1)).replace(' / ', ' of ')}`);
    await expectShown(page, HOME_OPENING);
    // The position stays on the photograph on screen.
    await expect(position(page)).toHaveText(at(HOME_OPENING));
    // Skip sits before the slideshow controls, so Shift+Tab reaches it from Next.
    await shiftTabTo(page, skip(page));
    await page.keyboard.press('Enter');
    await expectShown(page, after(2));
    await expect(status(page)).toHaveText('');
    await expect(skip(page)).toHaveCount(0);
    await expect(next(page)).toBeFocused();
    await expect(page.locator('main')).toHaveAttribute('data-chrome-holds', /\bkeyboard-focus\b/);
});

test('two automatic failures in a row suspend playback with a polite note, and Play resumes it', async ({ page }, testInfo) => {
    runsOn(testInfo, 'desktop', 'mobile');
    test.setTimeout(90_000);
    for (const steps of [1, 2]) await page.route(`**/media/${after(steps)}/**`, (route) => route.abort());
    await openHome(page);
    await expectShown(page, HOME_OPENING);
    // The first tick finds after(1) failed and skips to after(2) at once, which fails too: playback suspends.
    await expect(status(page)).toHaveText('Some photographs couldn’t load.', { timeout: 20_000 });
    // A polite notice: the status region, never an alert. The app router mounts Next's route announcer on every page
    // once it hydrates, an assertive role="alert" div in <next-route-announcer>'s shadow root that speaks only a route
    // change's title. So: no alert but that one, and nothing in any alert, which says nothing on Home is assertive.
    const alerts = page.getByRole('alert');
    await expect(alerts.and(page.locator(':not(#__next-route-announcer__)'))).toHaveCount(0);
    await expect(alerts.filter({ hasText: /\S/ })).toHaveCount(0);
    await expect(page.locator('[data-playback]')).toHaveAttribute('data-playback', 'held');
    await expectShown(page, HOME_OPENING);
    await expect(play(page)).toBeAttached();
    await play(page).dispatchEvent('click');
    await expect(status(page)).toHaveText('');
    await expect(page.locator('[data-playback]')).toHaveAttribute('data-playback', 'advancing');
    // A full interval later it moves on past the failed one.
    await expect(shownSlide(page)).toHaveAttribute('data-photo-id', after(3), { timeout: 20_000 });
    await expectShown(page, after(3));
});

test('with every photograph failing, Home says so with Retry, and a focused Retry that lands gives focus to Enter the series', async ({ page }, testInfo) => {
    runsOn(testInfo, 'desktop', 'mobile');
    const asked = new Set<string>();
    await page.route('**/media/ph_*/**', (route) => {
        asked.add(new URL(route.request().url()).pathname.split('/')[2]);
        return route.abort();
    });
    await page.goto('/');
    await waitForHydration(page);
    await expect(homeState(page)).toHaveAttribute('data-home-state', 'image-unavailable');
    await expect(status(page)).toHaveText('These photographs can’t be shown right now.');
    await expect(page.locator('main')).toHaveAttribute('data-home-loading', 'false');
    await expect(page.locator('main')).toHaveAttribute('data-chrome-holds', /\bno-photo\b/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(HOME_SERIES.title);
    await expect(enter(page)).toBeVisible();
    // The walk stops at two photographs: the opening and the next.
    expect([...asked].sort()).toEqual([HOME_OPENING, after(1)].sort());
    await page.unroute('**/media/ph_*/**');
    await tabTo(page, retry(page));
    await page.keyboard.press('Enter');
    await expect(homeState(page)).toHaveAttribute('data-home-state', 'ready');
    await expect(retry(page)).toHaveCount(0);
    await expect(enter(page)).toBeFocused();
});

test('a failed opening walks on to the next photograph, which plays from its own position', async ({ page }, testInfo) => {
    runsOn(testInfo, 'desktop', 'mobile');
    await page.route(`**/media/${HOME_OPENING}/**`, (route) => route.fulfill({ status: 500, body: '' }));
    await openHome(page);
    await expectShown(page, after(1));
    await expect(position(page)).toHaveText(at(after(1)));
    await expect(status(page)).toHaveText('');
    await expect(homeState(page)).toHaveAttribute('data-home-state', 'ready');
});

for (const [name, hero] of [
    ['delayed 10 s', async (page: Page) => page.route(`**/media/${HOME_OPENING}/**`, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        await route.fallback().catch(() => undefined);
    })],
    ['failing with 500', async (page: Page) => page.route(`**/media/${HOME_OPENING}/**`, (route) => route.fulfill({ status: 500, body: '' }))],
] as const) {
    test(`with the opening photograph ${name}, Next and Enter the series work within 3 s of DOMContentLoaded (#6 item 16)`, async ({ page }, testInfo) => {
        runsOn(testInfo, 'desktop', 'mobile');
        await hero(page);
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        const start = Date.now();
        await waitForHydration(page);
        await tabTo(page, next(page));
        await page.keyboard.press('Enter');
        // Next moves on from the opening: the one after it shows, whatever the opening is doing.
        await expect(shownSlide(page)).not.toHaveAttribute('data-photo-id', HOME_OPENING, { timeout: 3_000 });
        await expect.poll(() => shownImage(page).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), { timeout: 3_000 }).toBe(true);
        await tabTo(page, enter(page));
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(`/work/${HOME_SERIES.slug}`, { timeout: 3_000 });
        expect(Date.now() - start, 'from DOMContentLoaded to the series page').toBeLessThan(3_000);
    });
}

test('asks for the next photograph eagerly once the opening shows, Home\'s second eager image (#6 gap 32)', async ({ page }, testInfo) => {
    runsOn(testInfo, 'desktop', 'mobile');
    const asked: string[] = [];
    page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/media/')) asked.push(url.pathname.split('/')[2]);
    });
    await openHome(page);
    await expectShown(page, HOME_OPENING);
    const second = page.locator(`[data-photo-id="${after(1)}"] img`);
    await expect(second).toHaveAttribute('loading', 'eager');
    await expect.poll(() => second.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    expect(new Set(asked)).toEqual(new Set([HOME_OPENING, after(1)]));
});

test('is a carousel named for the series, each slide N of M, with the live region off while it plays and polite after Next', async ({ page }, testInfo) => {
    runsOn(testInfo, 'desktop', 'mobile');
    await openHome(page);
    const region = page.getByRole('region', { name: HOME_SERIES.title });
    await expect(region).toHaveAttribute('aria-roledescription', 'carousel');
    const count = HOME_ORDER.length;
    await expect(shownSlide(page)).toHaveAttribute('aria-roledescription', 'slide');
    await expect(shownSlide(page)).toHaveAttribute('aria-label', `${HOME_ORDER.indexOf(HOME_OPENING) + 1} of ${count}`);
    const live = region.locator('[aria-live]');
    await expect(live).toHaveAttribute('aria-live', 'off');
    await tabTo(page, next(page));
    await page.keyboard.press('Enter');
    await expectShown(page, after(1));
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expect(live).toHaveText(`${HOME_ORDER.indexOf(after(1)) + 1} of ${count}, ${altOf(after(1))}`);
});

test('marks Home with its state and the revision it renders', async ({ page, request }, testInfo) => {
    runsOn(testInfo, 'desktop', 'mobile');
    const ready = (await (await request.get('/api/ready')).json()) as { revisionId: string };
    await openHome(page);
    await expect(homeState(page)).toHaveAttribute('data-home-state', 'ready');
    await expect(page.locator('main')).toHaveAttribute('data-catalog-revision', ready.revisionId);
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

/**
 * Where the white-photograph case below runs: two desktop widths, and on mobile Pixel 7's own screen and the narrow
 * phones under 380 px, in Dark (the suite's System) and in Black, and 320 by 568 in every theme. From 360 px All bodies
 * of work sits beside Enter the series; at 320 it stays under Enter. 320 by 568 is the smallest phone, with the copy
 * highest up its screen: there Home's badge shrinks above the story (badgePlace()), since Light, Bright and Black raise
 * it over the scrim, where no wash can hold the title over it. Reduced motion adds the controls' "Off with reduced
 * motion" hint, which lifts the copy about 25 px.
 */
const WHITE_CASES = [
    { name: 'at 1440 px', project: 'desktop', viewport: { width: 1440, height: 900 } },
    { name: 'at 1024 px', project: 'desktop', viewport: { width: 1024, height: 900 } },
    { name: 'on Pixel 7', project: 'mobile', viewport: null },
    { name: 'at 360 px on a phone', project: 'mobile', viewport: { width: 360, height: 800 } },
    { name: 'at 320 px on a phone', project: 'mobile', viewport: { width: 320, height: 568 } },
    { name: 'at 379 px on a phone', project: 'mobile', viewport: { width: 379, height: 800 } },
    { name: 'at 360 px on a phone, with reduced motion', project: 'mobile', viewport: { width: 360, height: 800 }, reducedMotion: true },
    { name: 'at 379 px on a phone, with reduced motion', project: 'mobile', viewport: { width: 379, height: 800 }, reducedMotion: true },
    { name: 'at 320 px on a phone, in Black', project: 'mobile', viewport: { width: 320, height: 800 }, theme: 'black' },
    { name: 'at 360 px on a phone, in Black', project: 'mobile', viewport: { width: 360, height: 800 }, theme: 'black' },
    { name: 'at 360 px on a phone, in Black, with reduced motion', project: 'mobile', viewport: { width: 360, height: 800 }, theme: 'black', reducedMotion: true },
    { name: 'at 379 px on a phone, in Black', project: 'mobile', viewport: { width: 379, height: 800 }, theme: 'black' },
    { name: 'at 320 by 568 on a phone, in Black', project: 'mobile', viewport: { width: 320, height: 568 }, theme: 'black' },
    { name: 'at 320 by 568 on a phone, in Light', project: 'mobile', viewport: { width: 320, height: 568 }, theme: 'light' },
    { name: 'at 320 by 568 on a phone, in Bright', project: 'mobile', viewport: { width: 320, height: 568 }, theme: 'bright' },
] as const;

/** Rule 8: every case keeps 4.5:1. */
const AA = 4.5;

for (const { name: where, project, viewport, ...rest } of WHITE_CASES) {
    // Under 380 px Dark's wash follows the copy at every text size: today's fixed wash held the title at 4.319:1 and
    // the statement at 4.437:1 over this photograph at 360 px with reduced motion, and 2.33:1 at 320 by 568.
    const theme = 'theme' in rest ? rest.theme : undefined;
    const reducedMotion = 'reducedMotion' in rest;
    test(`the series title and statement keep their contrast over a white opening photograph, revealed by keyboard, ${where}`, async ({ page }, testInfo) => {
        runsOn(testInfo, project);
        if (viewport) await page.setViewportSize(viewport);
        if (theme) await page.addInitScript((stored) => localStorage.setItem('theme', stored), theme);
        if (reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
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
        for (const [name, target] of [['title', title], ['statement', statement], ['Work link', allWork(page)]] as const) {
            expect(await worstTextContrast(page, target), `the ${name}'s worst contrast over the white photograph`).toBeGreaterThanOrEqual(AA);
        }
        // Below 360 px the link stays under Enter the series (CatalogHome.module.css), so only the contrast applies.
        if (project !== 'mobile' || (viewport && viewport.width < 360)) return;
        // On a phone the link rides Enter's row, inside the print, and adds no height: the title sits where it does with
        // the link taken out of the layout, which is next's story. Dark's phone wash is today's, so the title needs that.
        const [enterBox, workBox] = await Promise.all([enter(page).boundingBox(), allWork(page).boundingBox()]);
        const contentRight = await page.locator('[data-chrome-region="story"] > div').evaluate((el) => el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight));
        expect(workBox!.y, 'All bodies of work on Enter the series’ row').toBeCloseTo(enterBox!.y, 1);
        expect(workBox!.height).toBeGreaterThanOrEqual(44);
        expect(workBox!.x, 'after Enter the series, 0.5rem on').toBeCloseTo(enterBox!.x + enterBox!.width + 8, 1);
        expect(workBox!.x + workBox!.width, "inside the story's gutter, on the print").toBeLessThanOrEqual(contentRight + 0.5);
        const titleTop = async () => (await title.boundingBox())!.y;
        const withLink = await titleTop();
        const hidden = await page.addStyleTag({ content: '[data-chrome-region="story"] a[href="/work"] { display: none !important; }' });
        expect(await titleTop(), "the title's top without the link").toBeCloseTo(withLink, 1);
        await hidden.evaluate((node) => node.parentNode?.removeChild(node));
    });
}

/** How far apart two boxes are, negative when they overlap. */
const gapBetween = (a: { left: number; top: number; right: number; bottom: number }, b: { left: number; top: number; right: number; bottom: number }) =>
    Math.max(b.left - a.right, a.left - b.right, b.top - a.bottom, a.top - b.bottom);

// On a phone the badge never lies on the copy, in any theme: Light, Bright and Black raise it over the scrim, where no
// wash can hold the title over it. 320 by 568 is the smallest phone, with the copy highest up its screen.
for (const viewport of [
    { width: 320, height: 568 },
    { width: 360, height: 640 },
    { width: 390, height: 844 },
]) {
    for (const theme of ['light', 'bright', 'dark', 'black'] as const) {
        test(`on a phone at ${viewport.width} by ${viewport.height} in ${theme}, the landed badge keeps 16 px from the series title, its statement and its links`, async ({ page }, testInfo) => {
            runsOn(testInfo, 'mobile');
            await page.setViewportSize(viewport);
            await page.addInitScript((stored) => localStorage.setItem('theme', stored), theme);
            await openHome(page);
            await expectShown(page, HOME_OPENING);
            await revealByKeyboard(page);
            const badge = page.locator('[data-home-badge]');
            await expect(badge).toHaveAttribute('data-landed', '');
            await expect(badge).toHaveCSS('opacity', '1');
            const measure = () =>
                page.evaluate(() => {
                    const box = (el: Element | null) => {
                        if (!el) return null;
                        const { left, top, right, bottom } = el.getBoundingClientRect();
                        return { left, top, right, bottom };
                    };
                    const face = box(document.querySelector('[data-home-badge] [class*="face"]'));
                    const story = document.querySelector('[data-chrome-region="story"]')!;
                    return {
                        place: document.querySelector('[data-home-badge]')!.getAttribute('data-badge-place'),
                        visibility: getComputedStyle(document.querySelector('[data-home-badge]')!).visibility,
                        oval: face && { left: face.left - 4, top: face.top - 4, right: face.right + 4, bottom: face.bottom + 4 },
                        nav: box(document.querySelector('nav[aria-label="Primary"]')),
                        title: box(story.querySelector('h1')),
                        statement: box(story.querySelector('p')),
                        enter: box(story.querySelector('a:not([href="/work"])')),
                        work: box(story.querySelector('a[href="/work"]')),
                    };
                });
            // Measured again a moment later, so a badge still moving to its place fails.
            const first = await measure();
            await page.waitForTimeout(250);
            const around = await measure();
            console.log(`badge on a phone at ${viewport.width}x${viewport.height} in ${theme}: ${JSON.stringify(around)}`);
            expect(around.oval, 'the badge paints its oval').not.toBeNull();
            for (const key of ['left', 'top', 'right', 'bottom'] as const) expect(Math.abs(around.oval![key] - first.oval![key]), `the oval's ${key} a moment later`).toBeLessThanOrEqual(1);
            expect(around.visibility, 'the badge shows at this size').toBe('visible');
            for (const name of ['nav', 'title', 'statement', 'enter', 'work'] as const) {
                expect(around[name], name).not.toBeNull();
                expect(gapBetween(around.oval!, around[name]!), `the badge's room from the ${name}`).toBeGreaterThanOrEqual(15.5);
            }
        });
    }
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

/**
 * Dark from 380 px on a phone: its fixed wash is set in percentages of the stage's height, so on a short stage, or with
 * reduced motion's hint lifting the copy about 25 px, the title can sit where the wash has thinned. 390 by 664 is an
 * iPhone in Safari with its toolbars showing. 390 by 844 with reduced motion is a taller stage, Dark parity's phone.
 * Dark's wash follows the copy only where the title's top sits above 65.5% of the stage or the statement's above 74.75%
 * (badgePlace.ts's copyAboveDarkWash()), and is today's elsewhere: `follows` says which. `failNext` shows the failure
 * notice, which lifts the copy. A one-line title starts lower, under the title's line, while its statement stays
 * where it was: those rows, below, take a fixture of their own. Each row prints its numbers, and the title's and the
 * statement's tops as percentages of the stage, whether it holds or not.
 */
type DarkStage = { name: string; viewport: { width: number; height: number }; follows: boolean; reducedMotion?: boolean; failNext?: boolean };

const DARK_SHORT_STAGES: DarkStage[] = [
    { name: 'at 380 by 664, a short stage', viewport: { width: 380, height: 664 }, follows: true },
    { name: 'at 390 by 664, an iPhone in Safari with its toolbars showing', viewport: { width: 390, height: 664 }, follows: true },
    { name: 'at 380 by 800, with reduced motion', viewport: { width: 380, height: 800 }, reducedMotion: true, follows: true },
    { name: 'at 389 by 800, with reduced motion', viewport: { width: 389, height: 800 }, reducedMotion: true, follows: true },
    { name: "at 390 by 844, with reduced motion, a taller stage, where Dark's wash is today's", viewport: { width: 390, height: 844 }, reducedMotion: true, follows: false },
    { name: 'at 390 by 844, with reduced motion, with the failure notice showing', viewport: { width: 390, height: 844 }, reducedMotion: true, failNext: true, follows: true },
];

/** The rows one-line-title fixture's server serves: its title starts under the title's line, its statement above the statement's. */
const ONE_LINE_STAGES: DarkStage[] = [
    { name: 'at 390 by 664, with a one-line title', viewport: { width: 390, height: 664 }, follows: true },
    { name: 'at 380 by 800, with reduced motion and a one-line title', viewport: { width: 380, height: 800 }, reducedMotion: true, follows: true },
];

/** One Dark stage row, on Home at `url`. */
async function darkStage(page: Page, testInfo: TestInfo, { viewport, follows, reducedMotion = false, failNext = false }: DarkStage, url = '/') {
    runsOn(testInfo, 'mobile');
    await page.setViewportSize(viewport);
    await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
    if (reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
    await openingAs(page, '#ffffff');
    if (failNext) await page.route(`**/media/${after(1)}/**`, (route) => route.abort());
    await openHome(page, url);
    await expectShown(page, HOME_OPENING);
    await revealByKeyboard(page);
    if (failNext) {
        await tabTo(page, next(page));
        await page.keyboard.press('Enter');
        await expect(status(page)).toHaveText(`Couldn’t load photograph ${at(after(1)).replace(' / ', ' of ')}`);
        await expectShown(page, HOME_OPENING);
    }
    const title = page.getByRole('heading', { level: 1 });
    const statement = page.locator('[data-chrome-region="story"] p');
    const scrim = page.locator('[data-home-vignette]');
    await expect(statement).toHaveText(HOME_SERIES.shortStatement);
    const lines = await title.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
    const titleContrast = await worstTextContrast(page, title);
    const statementContrast = await worstTextContrast(page, statement);
    const tops = await page.evaluate(() => {
        const stage = document.querySelector('[data-home-vignette]')!.getBoundingClientRect();
        const down = (el: Element | null) => (el ? (((el.getBoundingClientRect().top - stage.top) / stage.height) * 100).toFixed(2) : 'none');
        const story = document.querySelector('[data-chrome-region="story"]')!;
        return { title: down(story.querySelector('h1')), statement: down(story.querySelector('p')) };
    });
    const copyTop = await scrim.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--home-copy-top') || 'unset');
    const high = await page.locator('main').evaluate((el) => el.hasAttribute('data-copy-high'));
    const row = `Dark ${viewport.width}x${viewport.height}${reducedMotion ? ', reduced motion' : ''}${failNext ? ', failure notice' : ''}, ${lines}-line title: title ${titleContrast.toFixed(3)}:1 at ${tops.title}%, statement ${statementContrast.toFixed(3)}:1 at ${tops.statement}%, copy top ${copyTop}, wash ${high ? 'follows the copy' : "today's"}`;
    console.log(row);
    testInfo.annotations.push({ type: 'contrast', description: row });
    expect.soft(titleContrast, "the title's worst contrast over the white photograph").toBeGreaterThanOrEqual(AA);
    expect.soft(statementContrast, "the statement's worst contrast over the white photograph").toBeGreaterThanOrEqual(AA);
    expect.soft(high, follows ? "Dark's wash follows the copy" : "Dark's wash is today's").toBe(follows);
    if (!follows) await expect.soft(scrim).toHaveCSS('background-image', 'linear-gradient(rgba(8, 10, 9, 0.12) 0%, rgba(8, 10, 9, 0.28) 34%, rgba(8, 10, 9, 0.92) 100%)');
    return lines;
}

for (const stage of DARK_SHORT_STAGES) {
    test(`in Dark, the series title and statement keep 4.5:1 over a white opening photograph on a phone ${stage.name}`, async ({ page }, testInfo) => {
        await darkStage(page, testInfo, stage);
    });
}

// The one-line rows on a Home fixture of their own, whose featured series has a nine-character title
// (HOME_ONE_LINE_TITLE), so nothing changes the page after it opens. Its own `next start`, on mobile only.
test.describe('Dark on a phone, with a one-line title', () => {
    test.describe.configure({ mode: 'default' });
    let oneLine: { catalog: TestCatalog; server: CatalogServer } | undefined;

    test.beforeAll(async () => {
        const testInfo = test.info();
        test.skip(testInfo.project.name !== 'mobile', 'Runs on mobile.');
        test.setTimeout(READY_TIMEOUT + 60_000);
        const { catalog } = await publishHomeCopyFixture({ title: HOME_ONE_LINE_TITLE });
        // Above the ports the other specs with servers of their own take when E2E_CATALOG_PORT pins them.
        const base = Number(process.env.E2E_CATALOG_PORT);
        oneLine = { catalog, server: await startCatalogServer(catalog.root, Number.isInteger(base) && base > 0 ? base + 40 + testInfo.parallelIndex : undefined) };
    });

    // The fixture's data root stays under the OS temp folder, for whoever runs the suite to move to the Trash.
    test.afterAll(async () => {
        test.setTimeout(READY_TIMEOUT + 60_000);
        await oneLine?.server.stop();
    });

    for (const stage of ONE_LINE_STAGES) {
        test(`in Dark, the series title and statement keep 4.5:1 over a white opening photograph on a phone ${stage.name}`, async ({ page }, testInfo) => {
            if (!oneLine) throw new Error("The one-line fixture's server did not start");
            expect(await darkStage(page, testInfo, stage, `${oneLine.server.origin}/`), "the title's lines").toBe(1);
            await expect(page.getByRole('heading', { level: 1 })).toHaveText(HOME_ONE_LINE_TITLE);
        });
    }
});

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

for (const theme of ['dark', 'black'] as const) {
    test(`in ${theme}, at 200% text on a small phone, the title keeps 4.5:1 with the chrome scrolled to its end (M1)`, async ({ page }, testInfo) => {
        runsOn(testInfo, 'mobile');
        await page.setViewportSize({ width: 375, height: 667 });
        // Dark and Black, over white: light ink, so the enlarged-text hold (spec §10) is what keeps the title. Light's and
        // Bright's copy follows the photograph's tone.
        await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
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
}

test("Dark on a phone is today's at default text, and follows the copy only when the text is enlarged", async ({ page }, testInfo) => {
    runsOn(testInfo, 'mobile');
    await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
    await openHome(page);
    await expectShown(page, HOME_OPENING);
    const root = page.locator('main');
    const scrim = page.locator('[data-home-vignette]');
    await expect(root).not.toHaveAttribute('data-text-enlarged');
    // Pixel 7's stage is tall enough for the copy to sit under the fixed wash's line (copyAboveDarkWash()).
    await expect(root).not.toHaveAttribute('data-copy-high');
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
