import type { Locator, Page } from '@playwright/test';
import type { ImageItem } from '../utils/getImageData';
import { expectContrastOverImage } from './support/contrast';
import { expectNotObscured } from './support/focus';
import { photoPoint } from './support/home';
import { waitForHydration } from './support/hydration';
import { expectReflow } from './support/reflow';
import { checkSurface } from './support/surface';
import { expect, setPhotoFixtures, test } from './support/test';

/** HOME_AUTO_ADVANCE_MS in components/home/homePlayback.ts. */
const INTERVAL = 12_000;
/** HOME_CHROME_IDLE_MS and HOME_CHROME_FADE_MS: the chrome recedes this long after the last activity, then fades. */
const IDLE = 4_000;
const FADE = 220;

/** The display: contents wrapper inside Home's main that carries the playback state. */
const stage = (page: Page) => page.locator('[data-playback]');
const group = (page: Page) => page.getByRole('group', { name: 'Slideshow' });
const previous = (page: Page) => page.getByRole('button', { name: 'Previous photograph', exact: true });
const next = (page: Page) => page.getByRole('button', { name: 'Next photograph', exact: true });
const pause = (page: Page) => page.getByRole('button', { name: 'Pause slideshow', exact: true });
const play = (page: Page) => page.getByRole('button', { name: 'Play slideshow', exact: true });
const playback = (page: Page) => pause(page).or(play(page));
/** The playback button's visible label, whose box sits on the scrim clear of the button's corners. */
const playbackLabel = (page: Page) => playback(page).getByText(/^(Pause|Play)$/);
const sequenceControls = (page: Page) => previous(page).or(next(page)).or(playback(page));
const position = (page: Page) => group(page).getByText(/^\d{2,} \/ \d{2,}$/);
const hint = (page: Page) => group(page).getByText('Off with reduced motion', { exact: true });
const themeToggle = (page: Page) => page.getByRole('button', { name: /^Switch to (dark|light) mode$/ });
const primary = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const navLinks = (page: Page) => primary(page).getByRole('link');
const portrait = (page: Page) => page.locator('[class*="portrait"]');
const grainOverlay = (page: Page) => page.locator('[class*="grainOverlay"]');
const home = (page: Page) => page.locator('main[data-interface-state]');

/** The chrome layer HomeChromeController shows and hides around the controls. */
const chromeOpacity = (page: Page) => page.locator('[data-home-chrome]').evaluate((el) => parseFloat(getComputedStyle(el).opacity));
/** Whether the controller has the chrome up, whatever its opacity is at the moment. */
const chromeShown = async (page: Page) => (await home(page).getAttribute('data-interface-state')) === 'interactive';

/** Running animations and transitions whose single iteration lasts longer than `limit` ms. */
const runningLongerThan = (page: Page, limit: number) =>
    page.evaluate((max) =>
        document.getAnimations()
            .filter((animation) => animation.playState === 'running')
            .map((animation) => {
                const name = animation instanceof CSSAnimation ? animation.animationName
                    : animation instanceof CSSTransition ? `transition ${animation.transitionProperty}` : animation.id || 'script';
                return { name, duration: Number(animation.effect?.getComputedTiming().duration ?? 0) };
            })
            .filter(({ duration }) => duration > max), limit);

/** The play state of each slow zoom. CSS Modules hash the keyframes name, so this matches on the part they keep. */
const zoomStates = (page: Page) =>
    page.evaluate(() =>
        document.getAnimations()
            .filter((animation) => animation instanceof CSSAnimation && animation.animationName.includes('home-slow-zoom'))
            .map((animation) => animation.playState));

/**
 * Lets React finish the work a step scheduled. Its scheduler posts messages,
 * which the paused clock doesn't hold, so this waits without page timers.
 */
const settle = (page: Page) =>
    page.evaluate(() => new Promise<void>((resolve) => {
        let hops = 0;
        const channel = new MessageChannel();
        channel.port1.onmessage = () => (++hops < 3 ? channel.port2.postMessage(null) : resolve());
        channel.port2.postMessage(null);
    }));

async function runFor(page: Page, ms: number) {
    await page.clock.runFor(ms);
    await settle(page);
}

/** Presses `key` until `target` has focus, so the focus is keyboard focus. */
async function pressUntilFocused(page: Page, key: 'Tab' | 'Shift+Tab', target: Locator, limit = 8) {
    for (let press = 0; press < limit; press++) {
        if (await target.evaluate((el) => el === document.activeElement)) return;
        await page.keyboard.press(key);
    }
    await expect(target).toBeFocused();
}

/**
 * Shows the chrome with a pointer: mouse moves onto the photograph, more than
 * one since Chromium gives a document's first move no movement, or a tap on
 * it. With the page clock paused, `clocked` runs a frame so a tap's gesture ends.
 */
async function revealByPointer(page: Page, isMobile: boolean, { clocked = false } = {}) {
    const { x, y } = await photoPoint(page);
    if (isMobile) {
        await page.touchscreen.tap(x, y);
        if (clocked) await runFor(page, 50);
    } else {
        await page.mouse.move(x - 40, y + 30);
        await page.mouse.move(x, y, { steps: 2 });
    }
    await expect(home(page)).toHaveAttribute('data-interface-state', 'interactive');
    await expect(home(page)).not.toHaveAttribute('data-reveal-gesture');
}

/**
 * Opens Home on three photographs and waits until it settles into `state`.
 * With `clock`, it installs the page clock before the load or after it, and
 * pauses it once settled. Timers armed before an install keep real time.
 */
async function openHome(page: Page, { state = 'advancing', clock }: { state?: string; clock?: 'before' | 'after' } = {}) {
    setPhotoFixtures(page, ['white', 'gray', 'black']);
    if (clock === 'before') await page.clock.install();
    await page.goto('/');
    await waitForHydration(page);
    await expect(stage(page)).toHaveAttribute('data-playback', state, { timeout: 20_000 });
    if (clock === 'after') await page.clock.install();
    if (clock) {
        // A second ahead of the page's clock, which keeps running until the pause lands.
        const now = await page.evaluate(() => Date.now());
        await page.clock.pauseAt(now + 1000);
        await settle(page);
    }
}

/** Two white records with distinct src values. The fixture route serves both files by basename. */
async function serveTwoWhitePhotos(page: Page) {
    const record = (src: string, id: number): ImageItem => ({
        id, src, thumbnail: src, medium: src, optimized: src, width: 1200, height: 800, optimizedWidth: 1200, optimizedHeight: 800,
        caption: '', date: Date.UTC(2024, 0, 1), lqip: '',
    });
    await page.route('**/api/photos', (route) =>
        route.fulfill({ json: [record('/assets/photos/white.jpg', 0), record('/assets/photos/copy-2/white.jpg', 1)] }));
}

type Box = { left: number; top: number; right: number; bottom: number };
const box = (target: Locator) => target.evaluate((el): Box => {
    const { left, top, right, bottom } = el.getBoundingClientRect();
    return { left, top, right, bottom };
});
const overlaps = (a: Box, b: Box) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;

test.describe('normal motion', () => {
    test('Pause holds the photo and the zoom, Play moves once a full interval later, and holds never change the choice', async ({ page, isMobile }) => {
        test.setTimeout(90_000);
        // Installed before the load, so the slideshow's timer is the clock's from the start.
        await openHome(page, { clock: 'before' });
        const { width, height } = page.viewportSize()!;
        await expect(position(page)).toHaveText('01 / 03');

        // Pause by click or tap, then move the mouse off the controls so its hold can't stand in for a broken Pause.
        await revealByPointer(page, isMobile, { clocked: true });
        if (isMobile) await pause(page).tap();
        else await pause(page).click();
        await expect(stage(page)).toHaveAttribute('data-playback', 'paused');
        if (!isMobile) await page.mouse.move(width / 2, height / 2);

        await runFor(page, INTERVAL * 3);
        await expect(position(page)).toHaveText('01 / 03');
        expect(await runningLongerThan(page, 5000)).toEqual([]);
        const zooms = await zoomStates(page);
        expect(zooms.length).toBeGreaterThan(0);
        expect(zooms.every((state) => state === 'paused')).toBe(true);

        // The chrome receded during the wait, so a pointer reveals it again first.
        await revealByPointer(page, isMobile, { clocked: true });
        if (isMobile) {
            await play(page).tap();
            await expect(stage(page)).toHaveAttribute('data-playback', 'advancing');
        } else {
            // The click leaves the mouse resting on Play, which holds the chrome and the slideshow until it moves off.
            await play(page).click();
            await expect(stage(page)).toHaveAttribute('data-playback', 'held');
            await runFor(page, IDLE + FADE);
            await expect(stage(page)).toHaveAttribute('data-playback', 'held');
            await page.mouse.move(width / 2, height / 2, { steps: 2 });
            await expect(stage(page)).toHaveAttribute('data-playback', 'advancing');
            await expect(position(page)).toHaveText('01 / 03');
        }
        await settle(page);
        await runFor(page, INTERVAL - 1);
        await expect(position(page)).toHaveText('01 / 03');
        await runFor(page, 1);
        await expect(position(page)).toHaveText('02 / 03');

        // Keyboard focus on Next shows the chrome at once and keeps it up past the idle timeout.
        if (!isMobile) await page.mouse.move(width / 2, height / 2);
        await pressUntilFocused(page, 'Shift+Tab', next(page));
        expect(await chromeOpacity(page)).toBe(1);
        await expect(stage(page)).toHaveAttribute('data-playback', 'held');
        await runFor(page, IDLE + 1000);
        expect(await chromeOpacity(page)).toBe(1);
        await expect(position(page)).toHaveText('02 / 03');

        // The toggle sits in SiteNav inside the chrome, so focus there holds too, and nothing moves.
        await pressUntilFocused(page, 'Shift+Tab', themeToggle(page));
        await expect(stage(page)).toHaveAttribute('data-playback', 'held');
        await settle(page);
        await runFor(page, INTERVAL);
        await expect(position(page)).toHaveText('02 / 03');
        await expect(themeToggle(page)).toBeFocused();
    });

    test('a key press on Next after a click makes it keyboard focus, which holds the slideshow', async ({ page, isMobile }) => {
        test.skip(isMobile, 'A mouse click runs on the desktop project.');
        test.setTimeout(60_000);
        await openHome(page, { clock: 'before' });
        const { width, height } = page.viewportSize()!;
        await revealByPointer(page, false, { clocked: true });
        await next(page).click();
        await expect(position(page)).toHaveText('02 / 03');

        // Enter moves once more and shows the ring, with no new focus event. Then the mouse leaves, so only that focus can hold.
        await page.keyboard.press('Enter');
        await expect(position(page)).toHaveText('03 / 03');
        await page.mouse.move(width / 2, height / 2);
        await expect(stage(page)).toHaveAttribute('data-playback', 'held');
        await runFor(page, IDLE + INTERVAL);
        await expect(stage(page)).toHaveAttribute('data-playback', 'held');
        await expect(position(page)).toHaveText('03 / 03');
        await expect(next(page)).toBeFocused();
    });

    test('Pause and Play take the same width, so Previous, the position, and Next stay put', async ({ page }) => {
        await openHome(page);
        const lefts = async () => Promise.all([previous(page), position(page), next(page)].map(async (target) => (await box(target)).left));
        const before = await lefts();
        await pause(page).focus();
        await page.keyboard.press('Enter');
        await expect(play(page)).toBeVisible();
        const after = await lefts();
        after.forEach((left, index) => expect(Math.abs(left - before[index]), `control ${index} moved`).toBeLessThan(0.5));
    });

    test.describe('on a short screen', () => {
        // Short screens, where the settled portrait once covered Previous, phones on their side included, and the
        // narrower ones where it covered Previous's ring or centre until the chrome sat over it. Settled Home has no
        // portrait now, and Previous keeps its ring in view and its hit at every size.
        const SHORT_SCREENS = [
            [640, 400], [667, 375], [568, 320], [740, 360], [736, 414], [768, 400], [780, 420], [800, 480], [812, 375], [820, 400], [844, 390], [896, 414], [932, 430],
            [533, 320], [512, 384], [480, 320], [360, 320], [568, 520],
        ] as const;
        /** Points around Previous's centre. The square layers once took a click 10 px left of and 12 px above it. */
        const PROBES = [[0, 0], [-10, -12], [10, -12], [-10, 12], [10, 12], [-18, 0], [18, 0], [0, -18], [0, 18]] as const;

        for (const [width, height] of SHORT_SCREENS) {
            test(`at ${width} by ${height} Previous keeps its ring in view and takes a click or tap anywhere on it`, async ({ page, isMobile }) => {
                await page.setViewportSize({ width, height });
                await openHome(page);
                await expect(position(page)).toHaveText('01 / 03');
                await expect(portrait(page)).toHaveCount(0);
                // Keyboard focus reveals the chrome and holds it, so it takes the pointer.
                await pressUntilFocused(page, 'Tab', previous(page));
                await expectNotObscured(previous(page), []);

                const missed = await previous(page).evaluate((el, probes) => {
                    const { left, top, width: w, height: h } = el.getBoundingClientRect();
                    return probes.filter(([dx, dy]) => {
                        const hit = document.elementFromPoint(left + w / 2 + dx, top + h / 2 + dy);
                        return !(hit && el.contains(hit));
                    }).map(([dx, dy]) => `${dx}, ${dy}`);
                }, PROBES);
                expect(missed, 'points on Previous that something else takes').toEqual([]);
                if (isMobile) await previous(page).tap();
                else await previous(page).click();
                await expect(position(page)).toHaveText('03 / 03');
            });
        }
    });

    test('a Pause survives client navigation away and back, and a reload forgets it', async ({ page }) => {
        await openHome(page);
        await pause(page).focus();
        await page.keyboard.press('Enter');
        await expect(play(page)).toBeVisible();

        await primary(page).getByRole('link', { name: 'Work', exact: true }).focus();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL('/gallery');
        await primary(page).getByRole('link', { name: 'Home', exact: true }).focus();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL('/');
        await expect(stage(page)).toHaveAttribute('data-playback', 'paused', { timeout: 20_000 });
        await expect(play(page)).toHaveCount(1);

        await page.reload();
        await waitForHydration(page);
        await expect(stage(page)).toHaveAttribute('data-playback', 'advancing', { timeout: 20_000 });
        await expect(pause(page)).toHaveCount(1);
    });
});

test.describe('reduced motion', () => {
    test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
    });

    test('before load: no grain, ripple, or portrait, nothing advances, and the playback button does nothing', async ({ page, isMobile }) => {
        // Samples every rendered frame from the first for a displayed intro layer or portrait.
        await page.addInitScript(() => {
            const seen = { overlay: false, ripples: false, portrait: false };
            (window as unknown as { __introSeen: typeof seen }).__introSeen = seen;
            const sample = () => {
                for (const el of document.querySelectorAll('[class*="grainOverlay"]')) if (getComputedStyle(el).display !== 'none') seen.overlay = true;
                for (const el of document.querySelectorAll('[class*="ripples"]')) if (getComputedStyle(el).display !== 'none') seen.ripples = true;
                for (const el of document.querySelectorAll('[class*="portrait"]')) if (getComputedStyle(el).display !== 'none') seen.portrait = true;
                requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
        });
        // The clock goes in after the load, so the frame sampler runs on real frames. Nothing advances under reduce, so no timer predates it.
        await openHome(page, { state: 'reduced-motion', clock: 'after' });

        expect(await page.evaluate(() => (window as unknown as { __introSeen: unknown }).__introSeen)).toEqual({ overlay: false, ripples: false, portrait: false });
        await expect(grainOverlay(page)).toHaveCount(0);
        await expect(portrait(page)).toHaveCount(0);

        await runFor(page, INTERVAL * 3);
        await expect(position(page)).toHaveText('01 / 03');

        await expect(play(page)).toHaveAttribute('aria-disabled', 'true');
        await expect(play(page)).toHaveAccessibleDescription('Off with reduced motion');
        // Playwright won't act on an aria-disabled element unless forced, but a visitor still can, once the chrome is up.
        await revealByPointer(page, isMobile, { clocked: true });
        if (isMobile) await play(page).tap({ force: true });
        else await play(page).click({ force: true });
        await play(page).focus();
        await page.keyboard.press('Enter');
        await page.keyboard.press('Space');
        await settle(page);
        await expect(stage(page)).toHaveAttribute('data-playback', 'reduced-motion');
        await expect(play(page)).toHaveCount(1);
        await runFor(page, INTERVAL * 2);
        await expect(position(page)).toHaveText('01 / 03');
        expect(await runningLongerThan(page, 1)).toEqual([]);
    });

    test('a pointer or Tab shows the controls at once, and Next moves', async ({ page, isMobile }) => {
        // Nothing advances under reduce, so this runs on real time and waits out the idle timeout.
        await openHome(page, { state: 'reduced-motion' });

        await expect.poll(() => chromeOpacity(page), { timeout: IDLE + 3000 }).toBe(0);
        await revealByPointer(page, isMobile);
        // Waits on the chrome's own state, then checks that nothing fades it in, so a slow machine can't fail it.
        await expect.poll(() => chromeShown(page)).toBe(true);
        expect(await runningLongerThan(page, 1)).toEqual([]);
        await expect.poll(() => chromeOpacity(page)).toBe(1);
        if (isMobile) await next(page).tap();
        else await next(page).click();
        await expect(position(page)).toHaveText('02 / 03');
        expect(await runningLongerThan(page, 1)).toEqual([]);

        await expect.poll(() => chromeOpacity(page), { timeout: IDLE + 3000 }).toBe(0);
        // Programmatic focus on the toggle sets where Tab starts, and Tab gives Next keyboard focus.
        await themeToggle(page).focus();
        await pressUntilFocused(page, 'Tab', next(page));
        expect(await chromeOpacity(page)).toBe(1);
        await page.keyboard.press('Enter');
        await expect(position(page)).toHaveText('03 / 03');
        expect(await runningLongerThan(page, 1)).toEqual([]);
    });

    test('passes the #1 automated and keyboard checks', async ({ page }) => {
        await openHome(page, { state: 'reduced-motion' });
        await checkSurface(page, { controls: [sequenceControls(page), navLinks(page)], chrome: [primary(page), themeToggle(page)] });
    });

    test('over white, the controls keep their contrast, reflow, and clear SiteNav and the toggle', async ({ page }) => {
        await serveTwoWhitePhotos(page);
        await openHome(page, { state: 'reduced-motion' });
        // Keyboard focus in the nav keeps the chrome up through the checks, with its ring clear of the controls.
        await themeToggle(page).focus();
        await pressUntilFocused(page, 'Shift+Tab', navLinks(page).first());

        for (const text of [position(page), playbackLabel(page), hint(page)]) await expectContrastOverImage(text, { min: 4.5 });
        for (const control of [previous(page), next(page), playback(page)]) await expectContrastOverImage(control.locator('svg'), { min: 3 });

        const controls = await box(group(page));
        for (const [name, other] of [['theme toggle', themeToggle(page)], ['SiteNav', primary(page)]] as const) {
            expect(overlaps(controls, await box(other)), `the controls overlap the ${name}`).toBe(false);
        }
        await expectReflow(sequenceControls(page).or(group(page)).or(themeToggle(page)).or(primary(page)));
    });

    test('at 320 by 640 with 100% text, the controls clear SiteNav and the toggle, with no portrait', async ({ page }) => {
        await page.setViewportSize({ width: 320, height: 640 });
        await openHome(page, { state: 'reduced-motion' });
        await expect(portrait(page)).toHaveCount(0);

        const controls = await box(group(page));
        for (const [name, other] of [['theme toggle', themeToggle(page)], ['SiteNav', primary(page)]] as const) {
            expect(overlaps(controls, await box(other)), `the controls overlap the ${name}`).toBe(false);
        }
    });

    for (const path of ['/gallery', '/about']) {
        test(`${path} runs nothing past 1 ms`, async ({ page }) => {
            await page.goto(path);
            await waitForHydration(page);
            if (path === '/gallery') await expect(page.locator('main .grid > *')).toHaveCount(12);
            expect(await runningLongerThan(page, 1)).toEqual([]);
        });
    }

    test("the lightbox's own !important transitions end at once too", async ({ page }) => {
        await page.goto('/gallery');
        await waitForHydration(page);
        await page.getByRole('button', { name: 'Photograph 1 of 12', exact: true }).focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('dialog', { name: 'Lightbox' })).toBeVisible();

        const slow = await page.locator('.yarl__button, .yarl__thumbnails_thumbnail').evaluateAll((elements) =>
            elements.flatMap((el) => {
                const longest = Math.max(...getComputedStyle(el).transitionDuration.split(',').map((time) => parseFloat(time) * (time.trim().endsWith('ms') ? 1 : 1000)));
                return longest > 0.01 ? [`${el.className} transitions for ${longest} ms`] : [];
            }));
        expect(slow).toEqual([]);
    });

    // These rules cover the server HTML, where the intro renders before any script can.
    test('the CSS that covers server HTML hides the intro layers and the portrait, only under reduce', async ({ page }) => {
        await openHome(page, { state: 'reduced-motion' });
        const hiddenLayers = () =>
            page.evaluate(() => {
                const found = new Set<string>();
                for (const sheet of Array.from(document.styleSheets)) {
                    let rules: CSSRuleList;
                    try {
                        rules = sheet.cssRules;
                    } catch {
                        continue;
                    }
                    for (const rule of Array.from(rules)) {
                        if (!(rule instanceof CSSMediaRule) || !rule.media.mediaText.includes('prefers-reduced-motion')) continue;
                        if (!matchMedia(rule.media.mediaText).matches) continue;
                        for (const inner of Array.from(rule.cssRules)) {
                            if (!(inner instanceof CSSStyleRule) || inner.style.display !== 'none') continue;
                            for (const name of ['grainOverlay', 'ripples', 'portrait']) if (inner.selectorText.includes(name)) found.add(name);
                        }
                    }
                }
                return [...found].sort();
            });
        expect(await hiddenLayers()).toEqual(['grainOverlay', 'portrait', 'ripples']);

        await page.emulateMedia({ reducedMotion: 'no-preference' });
        expect(await hiddenLayers()).toEqual([]);
    });
});

test('static glass keeps its backdrop-filter under reduced motion', async ({ page }) => {
    await openHome(page);
    const glass = () =>
        page.evaluate(() =>
            Array.from(document.querySelectorAll('body *')).flatMap((el) => {
                const value = getComputedStyle(el).backdropFilter;
                return value === 'none' ? [] : [`${el.tagName.toLowerCase()} ${value}`];
            }),
        );
    const normal = await glass();
    expect(normal.length, 'Home has glass to compare').toBeGreaterThan(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(stage(page)).toHaveAttribute('data-playback', 'reduced-motion');
    expect(await glass()).toEqual(normal);
});

test('a live preference change takes effect both ways without a reload or the intro', async ({ page }) => {
    await openHome(page);
    await page.evaluate(() => ((window as unknown as { __sameDocument: boolean }).__sameDocument = true));
    expect((await zoomStates(page)).length).toBeGreaterThan(0);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(stage(page)).toHaveAttribute('data-playback', 'reduced-motion');
    await expect(play(page)).toHaveAttribute('aria-disabled', 'true');
    expect(await zoomStates(page)).toEqual([]);
    await expect(grainOverlay(page)).toHaveCount(0);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(stage(page)).toHaveAttribute('data-playback', 'advancing');
    await expect(pause(page)).not.toHaveAttribute('aria-disabled');
    expect(await zoomStates(page)).toContain('running');
    await expect(grainOverlay(page)).toHaveCount(0);
    await expect(page.locator('#grain-filter')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
});
