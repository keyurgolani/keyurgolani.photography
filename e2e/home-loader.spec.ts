import type { Locator, Page, TestInfo } from '@playwright/test';
import { STAND_IN_PORTRAIT } from './support/aboutPortrait';
import { expectHomeImmersive, photoPoint } from './support/home';
import { waitForHydration } from './support/hydration';
import { expect, setPhotoFixtures, test } from './support/test';

// Home's intro shows About's portrait, the stand-in the servers read from
// their site config folder, and hands off as v1.1.0 did: the portrait glides
// down and shrinks into its place 280 px above the bottom, at 0.85, and stays
// as the badge, for 3 s and then whenever the chrome shows. The badge and the
// loading portrait sit under the chrome and take no pointer, and a mouse over
// either tilts it. A server without a portrait is covered by the unit tests
// (components/__tests__/HeroReveal.test.tsx and app/__tests__/page.test.tsx),
// since every server here reads the same folder.

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

/** Holds every photograph until the returned function runs, so Home stays loading. */
async function holdPhotos(page: Page) {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/assets/photos/**', async (route) => {
        await released;
        await route.fallback();
    });
    return release;
}

/**
 * Opens Home on a first visit with the photographs held, so Home stays
 * loading, and the intro with it unless reduced motion skips it, until `release`.
 */
async function openLoading(page: Page, { intro = 'loading' }: { intro?: 'loading' | 'settled' } = {}) {
    setPhotoFixtures(page, ['white', 'gray', 'black']);
    const release = await holdPhotos(page);
    await page.goto('/');
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

/** The badge's place, v1.1.0's: centred, 280 px above the bottom, at 0.85 of the 256 px box, or 320 px from 768 px wide. */
const badgePlace = (page: Page) => {
    const { width, height } = page.viewportSize()!;
    return { x: width / 2, y: height - 280, width: (width >= 768 ? 320 : 256) * 0.85 };
};

const opacityOf = (target: Locator) => target.evaluate((el) => Number(getComputedStyle(el).opacity));

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

    test('glides down and shrinks into its place without fading, and stays there as the badge for 3 s, then goes with the chrome', async ({ page }, testInfo) => {
        runsOn(testInfo, 'desktop', 'mobile');
        // Every frame from the first: the portrait's opacity and its box, under either class.
        await page.addInitScript(() => {
            const samples: { opacity: number; y: number; width: number; badge: boolean }[] = [];
            (window as unknown as { __portrait: typeof samples }).__portrait = samples;
            const sample = () => {
                const el = document.querySelector<HTMLElement>('[class*="portrait"], [data-home-badge]');
                if (el && document.documentElement.hasAttribute('data-hydrated')) {
                    const { top, height, width } = el.getBoundingClientRect();
                    samples.push({ opacity: Number(getComputedStyle(el).opacity), y: top + height / 2, width, badge: el.hasAttribute('data-home-badge') });
                }
                requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
        });
        const release = await openLoading(page);
        release();
        await expect(main(page)).toHaveAttribute('data-home-intro', 'settled', { timeout: 20_000 });
        const place = badgePlace(page);
        const landed = await boxOf(badge(page));
        expect(Math.abs(landed.x - place.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(landed.y - place.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(landed.width - place.width)).toBeLessThanOrEqual(1);
        await expect(badge(page)).toHaveAttribute('data-lingering', '');
        expect(await opacityOf(badge(page))).toBe(1);

        const samples = await page.evaluate(() => (window as unknown as { __portrait: { opacity: number; y: number; width: number; badge: boolean }[] }).__portrait);
        const { height } = page.viewportSize()!;
        expect(samples.length).toBeGreaterThan(10);
        expect(samples.filter((s) => s.opacity < 1), 'the portrait never fades on the way').toEqual([]);
        // Down and smaller, frame on frame, from the centre to its place.
        for (let i = 1; i < samples.length; i++) {
            expect(samples[i].y, `frame ${i}`).toBeGreaterThanOrEqual(samples[i - 1].y - 0.5);
            expect(samples[i].width, `frame ${i}`).toBeLessThanOrEqual(samples[i - 1].width + 0.5);
        }
        expect(Math.abs(samples[0].y - height / 2)).toBeLessThanOrEqual(1);
        expect(samples.some((s) => s.y > height / 2 + 5 && s.y < place.y - 5), 'it passes through the frames between').toBe(true);

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
        const place = badgePlace(page);
        const box = await boxOf(badge(page));
        expect(Math.abs(box.y - place.y)).toBeLessThanOrEqual(1);
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
        const place = badgePlace(page);
        const box = await boxOf(badge(page));
        expect(Math.abs(box.x - place.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(box.y - place.y)).toBeLessThanOrEqual(1);
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
    test('a mouse over the loading portrait tilts it in perspective while the woken nav keeps its clicks', async ({ page }, testInfo) => {
        runsOn(testInfo, 'desktop');
        await openLoading(page);
        const { x, y } = await boxOf(loading(page));
        await page.mouse.move(x + 20, y + 20);
        await page.mouse.move(x + 120, y + 120, { steps: 3 });
        await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');
        await expect.poll(() => card(loading(page)).evaluate((el) => el.style.transform)).toMatch(/^perspective\(800px\) translateY\(.+\) rotateX\(.+deg\) rotateY\(.+deg\)$/);
        expect(Number(await card(loading(page)).evaluate((el) => el.style.getPropertyValue('--tilt')))).toBeGreaterThan(0);
        // Off the card, it comes back to rest.
        await page.mouse.move(40, y);
        await expect.poll(() => card(loading(page)).evaluate((el) => el.style.transform)).toBe('');

        // The nav is on top and takes its click while the intro is still up.
        await expect(main(page)).toHaveAttribute('data-home-intro', 'loading');
        const about = navLink(page, 'About');
        const centre = await boxOf(about);
        expect(await page.evaluate(([px, py]) => !!document.elementFromPoint(px, py)?.closest('a[href="/about"]'), [centre.x, centre.y])).toBe(true);
        await about.click();
        await expect(page).toHaveURL('/about');
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
        await expect(page).toHaveURL('/gallery');
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
        await expect(page).toHaveURL('/gallery');
    });
});
