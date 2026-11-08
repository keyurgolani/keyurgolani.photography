import type { Locator, Page, TestInfo } from '@playwright/test';
import sharp from 'sharp';
import { STAND_IN_PORTRAIT } from './support/aboutPortrait';
import type { TestCatalog } from '../lib/catalog/testing';
import { CATALOG_ORIGIN, HOME_LONG_STATEMENT } from './support/catalog-home';
import { READY_TIMEOUT, startCatalogServer, type CatalogServer } from './support/catalogServer';
import { expectHomeImmersive, photoPoint } from './support/home';
import { publishHomeCopyFixture } from './support/homeFixture';
import { waitForHydration } from './support/hydration';
import { expect, setPhotoFixtures, test } from './support/test';

// Home's intro shows About's portrait, the stand-in the servers read from
// their site config folder, and hands off as v1.1.0 did: the portrait glides
// and shrinks into its place, and stays as the badge, for 3 s and then
// whenever the chrome shows. That's v1.1.0's place, 280 px above the bottom
// at 0.85, wherever it clears the nav, the series title and its panel by 16 px, and the
// nearest place that does elsewhere (HeroReveal's badgePlace()). The badge and the
// loading portrait sit under the chrome and take no pointer, and a mouse over
// either tilts it. While the intro plays, the mouse doesn't wake the chrome. A server without a portrait, from the
// start or from partway through, is home-loader-portrait.spec.ts, on a server with a site config folder of its own.
// All of it on playwright.config.ts's catalog server: since #13's slice E Home renders only a published revision.

test.use({ baseURL: CATALOG_ORIGIN });

/** BADGE_LINGER_MS in components/HeroReveal.tsx. */
const LINGER = 3000;

const main = (page: Page) => page.locator('main[data-interface-state]');
const loading = (page: Page) => page.locator('[class*="portrait"]');
const badge = (page: Page) => page.locator('[data-home-badge]');
const card = (target: Locator) => target.locator('[class*="card"]').first();
const primary = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const navLink = (page: Page, name: string) => primary(page).getByRole('link', { name, exact: true });

const runsOn = (testInfo: TestInfo, ...projects: string[]) =>
    test.skip(!projects.includes(testInfo.project.name), `Runs on ${projects.join(' and ')}.`);

/**
 * Holds every photograph until the returned function runs, so Home stays loading. A held photograph is an image, so
 * the page's load event waits for it too: navigate with HELD.
 */
async function holdPhotos(page: Page) {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/media/**', async (route) => {
        await released;
        await route.fallback();
    });
    return release;
}

/** A navigation's wait while holdPhotos() holds the photographs: the document, not the load event they keep back. */
const HELD = { waitUntil: 'domcontentloaded' } as const;

/**
 * Opens Home on a first visit with the photographs held, so Home stays
 * loading, and the intro with it unless reduced motion skips it, until `release`.
 */
async function openLoading(page: Page, { intro = 'loading' }: { intro?: 'loading' | 'settled' } = {}) {
    setPhotoFixtures(page, ['white', 'gray', 'black']);
    const release = await holdPhotos(page);
    await page.goto('/', HELD);
    await waitForHydration(page);
    await expect(main(page)).toHaveAttribute('data-home-intro', intro);
    await expect(main(page)).toHaveAttribute('data-home-loading', 'true');
    return release;
}

/** The centre and width of `target`'s box as painted, transforms included. */
const boxOf = (target: Locator) =>
    target.evaluate((el) => {
        const { left, top, width, height } = el.getBoundingClientRect();
        return { x: left + width / 2, y: top + height / 2, width };
    });

/**
 * v1.1.0's place for the badge: centred 280 px above the bottom at 0.85 of
 * the 256 px box, or 320 px from 768 px wide. The catalog Home keeps it where
 * it clears the series title and its panel, and the nearest place that does
 * elsewhere, which the end of this file checks.
 */
const badgePlace = (page: Page) => {
    const { width, height } = page.viewportSize()!;
    return { x: width / 2, y: height - 280, width: (width >= 768 ? 320 : 256) * 0.85 };
};

type Edges = { left: number; top: number; right: number; bottom: number };
/** How far apart two boxes are, negative when they overlap. */
const gap = (a: Edges, b: Edges) => Math.max(b.left - a.right, a.left - b.right, b.top - a.bottom, a.top - b.bottom);

/** The badge's painted oval with its 4 px ring, and the chrome it keeps clear of: the nav, the series story, its panel. */
const aroundBadge = (page: Page) =>
    page.evaluate(() => {
        const box = (el: Element | null) => {
            if (!el) return null;
            const { left, top, right, bottom } = el.getBoundingClientRect();
            return { left, top, right, bottom };
        };
        const face = box(document.querySelector('[data-home-badge] [class*="face"]'));
        return {
            oval: face && { left: face.left - 4, top: face.top - 4, right: face.right + 4, bottom: face.bottom + 4 },
            nav: box(document.querySelector('nav[aria-label="Primary"]')),
            title: box(document.querySelector('[data-chrome-region="story"] h1')),
            statement: box(document.querySelector('[data-chrome-region="story"] p')),
            link: box(document.querySelector('[data-chrome-region="story"] a')),
            work: box(document.querySelector('[data-chrome-region="story"] a[href="/work"]')),
            panel: box(document.querySelector('[data-chrome-region="story"] [data-chrome-panel]')),
        };
    });

/**
 * The landed badge's box, checked in its place: v1.1.0's exactly, badgePlace()'s, where the catalog Home keeps that
 * place, and today's place beside the story exactly; 16 px clear of the series title, its statement and both links
 * wherever it lands, and of the nav and the title's panel too above the story; and holding still, so a badge still
 * gliding in fails. Beside the story keeps clear of the text alone, as it always has, so there it may sit nearer the
 * nav, or on the panel's fade. It returns the box, and `around`, what it was measured against.
 */
async function inItsPlace(page: Page) {
    const box = await boxOf(badge(page));
    const place = await badge(page).getAttribute('data-badge-place');
    if (place === 'v1.1.0') {
        const exact = badgePlace(page);
        for (const key of ['x', 'y', 'width'] as const) expect(Math.abs(box[key] - exact[key]), `v1.1.0's ${key}`).toBeLessThanOrEqual(1);
    }
    if (place === 'side') {
        // Today's place beside the story: a quarter of the width right of the center, 10 px above the middle.
        const { width, height } = page.viewportSize()!;
        expect(Math.abs(box.x - (width * 3) / 4), "beside the story, today's x").toBeLessThanOrEqual(1);
        expect(Math.abs(box.y - (height / 2 - 10)), "beside the story, today's y").toBeLessThanOrEqual(1);
    }
    const around = await aroundBadge(page);
    expect(around.oval).not.toBeNull();
    for (const name of [...(place === 'side' ? [] : (['nav'] as const)), 'title', 'statement', 'link', 'work'] as const) {
        expect(around[name], name).not.toBeNull();
        expect(gap(around.oval!, around[name]!), `the badge's room from the ${name}`).toBeGreaterThanOrEqual(15.5);
    }
    // The title's dark panel, drawn from 640 px wide, its fade included.
    const panel = around.panel && around.panel.right > around.panel.left ? around.panel : null;
    if (panel && place !== 'side') expect(gap(around.oval!, panel), "the badge's room from the title's panel").toBeGreaterThanOrEqual(15.5);
    await page.waitForTimeout(250);
    const later = await boxOf(badge(page));
    for (const key of ['x', 'y', 'width'] as const) expect(Math.abs(later[key] - box[key]), `the badge's ${key} a moment later`).toBeLessThanOrEqual(1);
    return { ...box, around: { ...around, panel } };
}

const opacityOf = (target: Locator) => target.evaluate((el) => Number(getComputedStyle(el).opacity));

/** The mean relative luminance, 0 to 255, of what's painted in `clip`. */
async function luminanceOf(page: Page, clip: { x: number; y: number; width: number; height: number }) {
    const { data, info } = await sharp(await page.screenshot({ clip })).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let sum = 0;
    for (let i = 0; i < data.length; i += info.channels) sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    return sum / (data.length / info.channels);
}

/** The token in the URL an image shows. */
const tokenOf = (src: string) => /\/about\/portrait\/([0-9a-f]{32})\/w(\d+)\.(avif|webp)$/.exec(new URL(src).pathname);

/** A mouse move onto the photograph, clear of every control, which wakes the chrome. */
async function wakeByMouse(page: Page) {
    const { x, y } = await photoPoint(page);
    await page.mouse.move(x - 40, y + 30);
    await page.mouse.move(x, y, { steps: 2 });
    await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');
}

test.describe("About's portrait in the intro", () => {
    test("waits at the center over the grain, from the same small variant About's files serve, with its alt", async ({ page }, testInfo) => {
        runsOn(testInfo, 'desktop', 'mobile');
        await openLoading(page);
        const image = loading(page).getByRole('img', { name: STAND_IN_PORTRAIT.alt, exact: true });
        await expect(image).toBeVisible();
        await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
        const shown = tokenOf(await image.evaluate((el: HTMLImageElement) => el.currentSrc));
        expect(shown, 'the image is one of the portrait variants').not.toBeNull();
        // 324 px wide from 768 px up, 260 px below, at the device's pixel ratio: never more than the 800 px variant.
        expect(Number(shown![2])).toBeLessThanOrEqual(800);

        const { width, height } = page.viewportSize()!;
        const centre = await boxOf(loading(page));
        expect(Math.abs(centre.x - width / 2)).toBeLessThanOrEqual(1);
        expect(Math.abs(centre.y - height / 2)).toBeLessThanOrEqual(1);

        // About names the same token, so the browser holds one set of files for both.
        const about = await (await page.request.get('/about')).text();
        expect(about).toContain(`/about/portrait/${shown![1]}/`);
    });

    test('glides and shrinks into its place without fading, and stays there as the badge for 3 s, then goes with the chrome', async ({ page }, testInfo) => {
        runsOn(testInfo, 'desktop', 'mobile');
        // Every frame from the first: the portrait's opacity and its box, under either class.
        await page.addInitScript(() => {
            const samples: { opacity: number; x: number; y: number; width: number; badge: boolean }[] = [];
            (window as unknown as { __portrait: typeof samples }).__portrait = samples;
            const sample = () => {
                const el = document.querySelector<HTMLElement>('[class*="portrait"], [data-home-badge]');
                if (el && document.documentElement.hasAttribute('data-hydrated')) {
                    const { left, top, height, width } = el.getBoundingClientRect();
                    samples.push({ opacity: Number(getComputedStyle(el).opacity), x: left + width / 2, y: top + height / 2, width, badge: el.hasAttribute('data-home-badge') });
                }
                requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
        });
        const release = await openLoading(page);
        release();
        await expect(main(page)).toHaveAttribute('data-home-intro', 'settled', { timeout: 20_000 });
        // Where it lands is badgePlace()'s at the catalog Home's lane, or the place nearest it clear of the series title.
        const place = await inItsPlace(page);
        await expect(badge(page)).toHaveAttribute('data-lingering', '');
        expect(await opacityOf(badge(page))).toBe(1);

        const samples = await page.evaluate(() => (window as unknown as { __portrait: { opacity: number; x: number; y: number; width: number; badge: boolean }[] }).__portrait);
        const { width, height } = page.viewportSize()!;
        expect(samples.length).toBeGreaterThan(10);
        expect(samples.filter((s) => s.opacity < 1), 'the portrait never fades on the way').toEqual([]);
        // Toward its place and smaller, frame on frame, from the centre.
        const towards = (from: number, to: number) => (to >= from ? 1 : -1);
        const [dx, dy] = [towards(width / 2, place.x), towards(height / 2, place.y)];
        for (let i = 1; i < samples.length; i++) {
            expect((samples[i].x - samples[i - 1].x) * dx, `frame ${i}`).toBeGreaterThanOrEqual(-0.5);
            expect((samples[i].y - samples[i - 1].y) * dy, `frame ${i}`).toBeGreaterThanOrEqual(-0.5);
            expect(samples[i].width, `frame ${i}`).toBeLessThanOrEqual(samples[i - 1].width + 0.5);
        }
        expect(Math.abs(samples[0].x - width / 2)).toBeLessThanOrEqual(1);
        expect(Math.abs(samples[0].y - height / 2)).toBeLessThanOrEqual(1);
        const start = samples[0].width;
        expect(samples.some((s) => s.width < start - 5 && s.width > place.width + 5), 'it passes through the frames between').toBe(true);

        // Its 3 s, then it goes with the chrome, and comes back with it.
        await expectHomeImmersive(page);
        await expect(badge(page)).not.toHaveAttribute('data-lingering');
        if (testInfo.project.name === 'desktop') await wakeByMouse(page);
        else {
            const { x, y } = await photoPoint(page);
            await page.touchscreen.tap(x, y);
            await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');
        }
        await expect.poll(() => opacityOf(badge(page)), { timeout: 3000 }).toBe(1);
        await expectHomeImmersive(page);
    });

    test("fades over v1.1.0's 1 s, and takes no pointer, so a click or tap on it reaches what's under it", async ({ page }, testInfo) => {
        runsOn(testInfo, 'desktop', 'mobile');
        const release = await openLoading(page);
        expect(await loading(page).evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
        release();
        await expect(main(page)).toHaveAttribute('data-home-intro', 'settled', { timeout: 20_000 });
        const style = await badge(page).evaluate((el) => {
            const { transitionProperty, transitionDuration, transitionTimingFunction, pointerEvents } = getComputedStyle(el);
            return { transitionProperty, transitionDuration, transitionTimingFunction, pointerEvents };
        });
        expect(style).toEqual({ transitionProperty: 'opacity', transitionDuration: '1s', transitionTimingFunction: 'ease-in-out', pointerEvents: 'none' });
        const { x, y } = await boxOf(badge(page));
        const hit = await page.evaluate(([px, py]) => !!document.elementFromPoint(px, py)?.closest('[data-home-badge]'), [x, y]);
        expect(hit, 'the badge is never the element under the pointer').toBe(false);
    });

    test('a portrait that fails to load leaves the intro without it, and no badge or broken image after', async ({ page }, testInfo) => {
        runsOn(testInfo, 'desktop', 'mobile');
        await page.route('**/about/portrait/**', (route) => route.fulfill({ status: 500, body: '' }));
        const release = await openLoading(page);
        await expect(loading(page)).toHaveCount(0);
        await expect(page.locator('[class*="grainOverlay"]')).toHaveCount(1);
        release();
        await expectHomeImmersive(page);
        await expect(badge(page)).toHaveCount(0);
        expect(await page.locator('main img').evaluateAll((images) => images.filter((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth === 0).length)).toBe(0);
    });

    test('a return visit skips the intro and starts with the badge in its place, for its 3 s', async ({ page }, testInfo) => {
        runsOn(testInfo, 'desktop', 'mobile');
        setPhotoFixtures(page, ['white', 'gray', 'black']);
        await page.goto('/');
        await waitForHydration(page);
        await expectHomeImmersive(page);
        if (testInfo.project.name === 'desktop') await wakeByMouse(page);
        else {
            const { x, y } = await photoPoint(page);
            await page.touchscreen.tap(x, y);
        }
        if (testInfo.project.name === 'desktop') await navLink(page, 'About').click();
        else await navLink(page, 'About').tap();
        await expect(page).toHaveURL('/about');
        if (testInfo.project.name === 'desktop') await navLink(page, 'Home').click();
        else await navLink(page, 'Home').tap();
        await expect(page).toHaveURL('/');
        await expect(badge(page)).toHaveAttribute('data-lingering', '');
        await expect(main(page)).toHaveAttribute('data-home-intro', 'settled');
        await expect(page.locator('[class*="grainOverlay"]')).toHaveCount(0);
        await inItsPlace(page);
        expect(await opacityOf(badge(page))).toBe(1);
        await expect(badge(page)).not.toHaveAttribute('data-lingering', { timeout: LINGER + 2000 });
    });

    test('under reduced motion there is no intro, and the badge shows in its place, at once, once loading ends, and never tilts', async ({ page }, testInfo) => {
        runsOn(testInfo, 'desktop', 'mobile');
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const release = await openLoading(page, { intro: 'settled' });
        await expect(page.locator('[class*="grainOverlay"]')).toHaveCount(0);
        await expect(loading(page)).toHaveCount(0);
        // Waiting in its place, hidden, while Home loads.
        await expect(badge(page)).not.toHaveAttribute('data-landed');
        expect(await opacityOf(badge(page))).toBe(0);
        release();
        await expect(badge(page)).toHaveAttribute('data-landed', '', { timeout: 20_000 });
        const box = await inItsPlace(page);
        // The site's reduced-motion rule ends every transition at once, well under 200 ms.
        expect(await badge(page).evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration))).toBeLessThanOrEqual(0.2);
        await expect.poll(() => opacityOf(badge(page))).toBe(1);
        if (testInfo.project.name === 'desktop') {
            await page.mouse.move(box.x + 60, box.y + 60);
            await page.mouse.move(box.x + 80, box.y + 80);
            expect(await card(badge(page)).evaluate((el) => el.style.transform)).toBe('');
        }
    });
});

test.describe('the tilt and the chrome', () => {
    test("a mouse over the loading portrait tilts it and leaves the chrome asleep, so nothing dims it, as on v1.1.0, and Tab wakes the chrome at once", async ({ page }, testInfo) => {
        runsOn(testInfo, 'desktop');
        setPhotoFixtures(page, ['white', 'gray', 'black']);
        // Paused before the load, so the intro stays at its loading frame for as long as the test takes: its exit runs
        // on timers, so the photographs may arrive. They aren't held, since page.screenshot() never finishes while a
        // routed request is held, and luminanceOf() takes one.
        await page.clock.install();
        await page.clock.pauseAt(Date.now() + 1000);
        await page.goto('/');
        await waitForHydration(page);
        await expect(main(page)).toHaveAttribute('data-home-intro', 'loading');
        // The opening photograph has arrived, so Home has stopped loading: what holds the chrome asleep here is the
        // intro's loading frame alone, which HomeChromeController's mouse gate reads. The next test has the
        // photographs still loading as well.
        await expect(main(page)).toHaveAttribute('data-home-loading', 'false');
        const image = loading(page).getByRole('img');
        await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
        const face = await loading(page).locator('[class*="face"]').boundingBox();
        // The middle of the oval, where the scrim would darken it most, before any mouse.
        const clip = { x: face!.x + face!.width / 4, y: face!.y + face!.height / 4, width: face!.width / 2, height: face!.height / 2 };
        const rest = await luminanceOf(page, clip);

        const { x, y } = await boxOf(loading(page));
        await page.mouse.move(x + 20, y + 20);
        await page.mouse.move(x + 120, y + 120, { steps: 3 });
        await expect.poll(() => card(loading(page)).evaluate((el) => el.style.transform)).toMatch(/^perspective\(800px\) translateY\(.+\) rotateX\(.+deg\) rotateY\(.+deg\)$/);
        expect(Number(await card(loading(page)).evaluate((el) => el.style.getPropertyValue('--tilt')))).toBeGreaterThan(0);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'immersive');
        await expect(page.locator('[data-home-vignette]')).toHaveCSS('opacity', '0');

        // Off the card, still moving: it comes back to rest, as bright as before the mouse came.
        await page.mouse.move(40, y);
        await page.mouse.move(60, y + 10, { steps: 2 });
        await expect.poll(() => card(loading(page)).evaluate((el) => el.style.transform)).toBe('');
        // The card's 0.1 s ease back, and the scrim's 220 ms fade had one started.
        await page.waitForTimeout(400);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'immersive');
        const after = await luminanceOf(page, clip);
        expect(Math.abs(after - rest) / rest, `the portrait's luminance, ${after.toFixed(1)} against ${rest.toFixed(1)} at rest`).toBeLessThan(0.02);

        // Tab wakes the chrome at once, with focus drawn on a nav control over the intro.
        const inNav = () => page.evaluate(() => !!document.activeElement?.closest('nav[aria-label="Primary"]'));
        for (let press = 0; press < 5 && !(await inNav()); press++) await page.keyboard.press('Tab');
        expect(await page.evaluate(() => document.activeElement?.matches(':focus-visible') ?? false)).toBe(true);
        expect(await inNav()).toBe(true);
        await expect(page.locator('[data-home-chrome]')).toHaveCSS('opacity', '1');
        await expect(main(page)).toHaveAttribute('data-chrome-holds', /keyboard-focus/);
        await expect(main(page)).toHaveAttribute('data-home-intro', 'loading');

        // The woken nav takes its click while the intro is still up.
        await page.clock.resume();
        const about = navLink(page, 'About');
        const centre = await boxOf(about);
        expect(await page.evaluate(([px, py]) => !!document.elementFromPoint(px, py)?.closest('a[href="/about"]'), [centre.x, centre.y])).toBe(true);
        await about.click();
        await expect(page).toHaveURL('/about');
    });

    test('with the photographs still loading too, a mouse over the loading portrait only tilts it, and nothing dims it', async ({ page }, testInfo) => {
        runsOn(testInfo, 'desktop');
        setPhotoFixtures(page, ['white', 'gray', 'black']);
        await holdPhotos(page);
        await page.clock.install();
        await page.clock.pauseAt(Date.now() + 1000);
        await page.goto('/', HELD);
        await waitForHydration(page);
        await expect(main(page)).toHaveAttribute('data-home-intro', 'loading');
        await expect(main(page)).toHaveAttribute('data-home-loading', 'true');

        const { x, y } = await boxOf(loading(page));
        await page.mouse.move(x + 20, y + 20);
        await page.mouse.move(x + 120, y + 120, { steps: 3 });
        await expect.poll(() => card(loading(page)).evaluate((el) => el.style.transform)).toMatch(/^perspective\(800px\) translateY\(.+\) rotateX\(.+deg\) rotateY\(.+deg\)$/);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'immersive');
        // The scrim's opacity stands in for the luminance reading the test above takes: page.screenshot() never
        // finishes while the photographs are held.
        await expect(page.locator('[data-home-vignette]')).toHaveCSS('opacity', '0');
        await expect(main(page)).toHaveAttribute('data-home-loading', 'true');
    });

    test('a mouse over the landed badge tilts it, and the nav takes its clicks over it', async ({ page }, testInfo) => {
        runsOn(testInfo, 'desktop');
        const release = await openLoading(page);
        release();
        await expect(main(page)).toHaveAttribute('data-home-intro', 'settled', { timeout: 20_000 });
        const { x, y, width } = await boxOf(badge(page));
        await page.mouse.move(x - width / 2 + 10, y - width / 2 + 10);
        await page.mouse.move(x - width / 2 + 20, y - width / 2 + 20, { steps: 2 });
        await expect.poll(() => card(badge(page)).evaluate((el) => el.style.transform)).toMatch(/^perspective\(800px\) /);
        await expect.poll(() => opacityOf(badge(page))).toBe(1);
        await navLink(page, 'Work').click();
        await expect(page).toHaveURL('/work');
    });

    test('Enter on a nav link during the intro follows it', async ({ page }, testInfo) => {
        runsOn(testInfo, 'desktop', 'mobile');
        await openLoading(page);
        for (let press = 0; press < 10 && !(await navLink(page, 'Work').evaluate((el) => el === document.activeElement)); press++) {
            await page.keyboard.press('Tab');
        }
        await expect(navLink(page, 'Work')).toBeFocused();
        await expect(main(page)).toHaveAttribute('data-home-intro', 'loading');
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL('/work');
    });
});

test.describe("the badge's place on the catalog Home", () => {
    // From 85rem the story yields the badge's lane, so the badge keeps v1.1.0's exact place beside a two-line title,
    // and the panel's fade ends 16 px before it. Below, the title keeps its width and the badge lifts above it.
    for (const { width, height, place, titleLines } of [
        { width: 1440, height: 900, place: 'v1.1.0', titleLines: 2 },
        { width: 1536, height: 864, place: 'v1.1.0', titleLines: 2 },
        { width: 1366, height: 768, place: 'v1.1.0', titleLines: 2 },
        { width: 1280, height: 800, place: 'clear', titleLines: 2 },
        { width: 1024, height: 768, place: 'clear', titleLines: 2 },
        { width: 390, height: 844, place: 'clear' },
        { width: 360, height: 740, place: 'clear' },
        { width: 844, height: 390, place: 'side' },
        // 1280 x 800 at 200%: beside the story, on the panel's fade, as today.
        { width: 640, height: 400, place: 'side' },
    ]) {
        test(`the landed badge keeps 16 px from the series title, its panel and the nav at ${width} x ${height}`, async ({ page }, testInfo) => {
            runsOn(testInfo, 'desktop');
            await page.setViewportSize({ width, height });
            await page.goto('/');
            await waitForHydration(page);
            await expect(main(page)).toHaveAttribute('data-home-intro', 'settled', { timeout: 20_000 });
            await expect(badge(page)).toHaveAttribute('data-landed', '');
            await expect(badge(page)).toHaveAttribute('data-badge-place', place);
            // inItsPlace() checks v1.1.0's exact place there, and the room from the nav, the story and the panel.
            const { around } = await inItsPlace(page);
            const lines = await page.locator('[data-chrome-region="story"] h1').evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
            console.log(`badge boxes at ${width}x${height}: ${JSON.stringify(around)}, title lines ${lines}`);
            if (titleLines !== undefined) expect(lines, "the series title's lines").toBe(titleLines);
            const { panel } = around;
            expect(panel === null, 'the panel is drawn from 640 px wide').toBe(width < 640);
            // In v1.1.0's place from 85rem, the lane is exact: the panel ends 16 px before the oval, not further.
            if (panel && place === 'v1.1.0') expect(around.oval!.left - panel.right, 'the panel ends 16 px before the badge').toBeLessThanOrEqual(17);
        });
    }

    // Pixel 7 held sideways: today's place beside the story, clear of the text. Its oval's top is 12.8 px under the nav,
    // and that stays as today's.
    test("on a phone held sideways at 863 x 360, the landed badge shows in today's place beside the story, clear of the series title, its statement and both links", async ({ page }, testInfo) => {
        runsOn(testInfo, 'mobile');
        await page.setViewportSize({ width: 863, height: 360 });
        await page.goto('/');
        await waitForHydration(page);
        await expect(main(page)).toHaveAttribute('data-home-intro', 'settled', { timeout: 20_000 });
        await expect(badge(page)).toHaveAttribute('data-landed', '');
        await expect(badge(page)).toHaveAttribute('data-badge-place', 'side');
        await expect(badge(page)).toHaveCSS('visibility', 'visible');
        // inItsPlace() checks today's exact place beside the story, and the room from the title, statement and links.
        const { around } = await inItsPlace(page);
        console.log(`badge boxes at 863x360 on a phone: ${JSON.stringify(around)}, ${(around.oval!.top - around.nav!.bottom).toFixed(2)} px under the nav`);
    });

    // A phone so short that no place keeps the badge 16 px from the nav and the copy: 320 x 500 with the fixture's
    // two-line title. In Black, which raises the badge over the scrim, as Light and Bright do.
    test('where no place clears the copy, the badge is out of sight and out of the accessibility tree at default text, and shows under the scrim with the text enlarged', async ({ page }, testInfo) => {
        runsOn(testInfo, 'mobile');
        await page.setViewportSize({ width: 320, height: 500 });
        await page.addInitScript(() => localStorage.setItem('theme', 'black'));
        await page.goto('/');
        await waitForHydration(page);
        await expect(main(page)).toHaveAttribute('data-home-intro', 'settled', { timeout: 20_000 });
        await expect(badge(page)).toHaveAttribute('data-landed', '');
        await expect(badge(page)).toHaveAttribute('data-badge-place', 'none');
        const alt = await badge(page).locator('img').getAttribute('alt');
        expect(alt, "the portrait's alt").toBeTruthy();
        const portrait = badge(page).getByRole('img', { name: alt!, exact: true });
        await expect(main(page)).not.toHaveAttribute('data-text-enlarged');
        await expect(badge(page)).toHaveCSS('visibility', 'hidden');
        await expect(badge(page)).toBeHidden();
        await expect(portrait).toHaveCount(0);
        expect(await page.locator('body').ariaSnapshot(), 'the accessibility tree').not.toContain(alt!);
        // Enlarged text: the chrome scrolls, so the copy can move under the badge anywhere, and the scrim carries it.
        await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
        await expect(main(page)).toHaveAttribute('data-text-enlarged', '');
        await expect(badge(page)).toHaveAttribute('data-badge-place', 'none');
        await expect(badge(page)).toHaveCSS('visibility', 'visible');
        await expect(badge(page)).toHaveCSS('z-index', '42');
        await expect(portrait).toHaveCount(1);
    });
});

// A small phone held sideways, 568 x 320, with a statement that runs two lines (HOME_LONG_STATEMENT), on a Home fixture
// of its own: the statement reaches under the place beside the story, and above the story there's no room under the
// nav, so the badge is out of sight. Its own `next start`, on mobile only.
test.describe('the badge with no clear place on a phone held sideways', () => {
    test.describe.configure({ mode: 'default' });
    let long: { catalog: TestCatalog; server: CatalogServer } | undefined;

    test.beforeAll(async () => {
        const testInfo = test.info();
        test.skip(testInfo.project.name !== 'mobile', 'Runs on mobile.');
        test.setTimeout(READY_TIMEOUT + 60_000);
        const { catalog } = await publishHomeCopyFixture({ shortStatement: HOME_LONG_STATEMENT });
        // Above the ports the other specs with servers of their own take when E2E_CATALOG_PORT pins them.
        const base = Number(process.env.E2E_CATALOG_PORT);
        long = { catalog, server: await startCatalogServer(catalog.root, Number.isInteger(base) && base > 0 ? base + 50 + testInfo.parallelIndex : undefined) };
    });

    // The fixture's data root stays under the OS temp folder, for whoever runs the suite to move to the Trash.
    test.afterAll(async () => {
        test.setTimeout(READY_TIMEOUT + 60_000);
        await long?.server.stop();
    });

    test('at 568 x 320 with a two-line statement, the badge is out of sight at default text', async ({ page }) => {
        if (!long) throw new Error("The long-statement fixture's server did not start");
        await page.setViewportSize({ width: 568, height: 320 });
        await page.goto(`${long.server.origin}/`);
        await waitForHydration(page);
        await expect(page.locator('[data-chrome-region="story"] p')).toHaveText(HOME_LONG_STATEMENT);
        await expect(main(page)).toHaveAttribute('data-home-intro', 'settled', { timeout: 20_000 });
        await expect(badge(page)).toHaveAttribute('data-landed', '');
        const lines = await page.locator('[data-chrome-region="story"] p').evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
        console.log(`badge at 568x320 with a ${lines}-line statement: ${JSON.stringify(await aroundBadge(page))}`);
        expect(lines, "the statement's lines").toBe(2);
        await expect(badge(page)).toHaveAttribute('data-badge-place', 'none');
        await expect(badge(page)).toHaveCSS('visibility', 'hidden');
    });
});
