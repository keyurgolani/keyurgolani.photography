import type { CDPSession, Locator, Page, Route, TestInfo } from '@playwright/test';
import type { ImageItem } from '../lib/catalog/photos-api';
import { expectNoA11yViolations } from './support/a11y';
import { expectContrastOverImage } from './support/contrast';
import { expectFocusRingVisible } from './support/focus';
import { expectHomeImmersive, photoPoint } from './support/home';
import { waitForHydration } from './support/hydration';
import { expectReflow } from './support/reflow';
import { checkSurface } from './support/surface';
import { expect, setPhotoFixtures, test } from './support/test';

// #18: Home rests on the photograph alone, and intent brings the chrome back.
// The pointer, zero-movement, mouse-focus, and hover cases run on desktop,
// the touch cases on mobile and mobile-webkit, and the rest on desktop and
// mobile. Cases that time the chrome install the page clock once Home settles.

/** HOME_CHROME_IDLE_MS and HOME_CHROME_FADE_MS in components/home/homeChromeConfig.ts. */
const IDLE = 4000;
const FADE = 220;
/** HOME_LOADING_TIMEOUT_MS. */
const LOADING_TIMEOUT = 6000;
/** HeroReveal's exit starts by this long after mount: the intro's 1.5 s exit ends within the 6 s bound. */
const INTRO_EXIT_DEADLINE = LOADING_TIMEOUT - 1500;
/** The intro's layers, by their CSS module class names. */
const INTRO_LAYERS = ['grainOverlay', 'ripples', 'portrait'] as const;
/** One frame and then some on the page clock, for work a gesture leaves to the next frame. */
const FRAME = 50;

const main = (page: Page) => page.locator('main[data-interface-state]');
const chrome = (page: Page) => page.locator('[data-home-chrome]');
const primary = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const navLink = (page: Page, name: string) => primary(page).getByRole('link', { name, exact: true });
const wordmark = (page: Page) => primary(page).getByRole('link', { name: 'KG, Keyur Golani' });
const themeToggle = (page: Page) => page.getByRole('button', { name: /^Switch to (dark|light) mode$/ });
const group = (page: Page) => page.getByRole('group', { name: 'Slideshow' });
const previous = (page: Page) => page.getByRole('button', { name: 'Previous photograph', exact: true });
const next = (page: Page) => page.getByRole('button', { name: 'Next photograph', exact: true });
const pause = (page: Page) => page.getByRole('button', { name: 'Pause slideshow', exact: true });
const play = (page: Page) => page.getByRole('button', { name: 'Play slideshow', exact: true });
const playback = (page: Page) => pause(page).or(play(page));
const position = (page: Page) => group(page).getByText(/^\d{2,} \/ \d{2,}$/);
const playbackLabel = (page: Page) => playback(page).getByText(/^(Pause|Play)$/);
const sequenceControls = (page: Page) => previous(page).or(next(page)).or(playback(page));
/** Every control in the chrome. */
const chromeControls = (page: Page) => chrome(page).locator('a[href], button');
const currentPhoto = (page: Page) => page.locator('[aria-hidden="false"] > img[data-layer="optimized"]');

const runsOn = (testInfo: TestInfo, ...projects: string[]) =>
    test.skip(!projects.includes(testInfo.project.name), `Runs on ${projects.join(' and ')}.`);

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

/** Pauses the page clock a second ahead of the page's own time. */
async function pauseClock(page: Page) {
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(now + 1000);
    await settle(page);
}

/** The product of the opacities up the tree, which is what the visitor sees. */
const effectiveOpacity = (target: Locator) =>
    target.evaluate((el) => {
        let opacity = 1;
        for (let node: Element | null = el; node; node = node.parentElement) opacity *= parseFloat(getComputedStyle(node).opacity);
        return opacity;
    });

/** Each visibility change of Home's chrome, recorded in the page from the first frame. */
async function recordVisibility(page: Page) {
    await page.addInitScript(() => {
        const seen: string[] = [];
        (window as unknown as { __chromeStates: string[] }).__chromeStates = seen;
        new MutationObserver(() => {
            const state = document.querySelector('main[data-interface-state]')?.getAttribute('data-interface-state');
            if (state && seen[seen.length - 1] !== state) seen.push(state);
        }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-interface-state'], childList: true });
    });
    return () => page.evaluate(() => (window as unknown as { __chromeStates: string[] }).__chromeStates);
}

/** UI events page scripts dispatch, which a synthetic wake would show up in. */
async function recordSyntheticEvents(page: Page) {
    await page.addInitScript(() => {
        const dispatched: string[] = [];
        (window as unknown as { __synthetic: string[] }).__synthetic = dispatched;
        const dispatch = EventTarget.prototype.dispatchEvent;
        EventTarget.prototype.dispatchEvent = function (event: Event) {
            if (event instanceof UIEvent || event.type === 'click') dispatched.push(event.type);
            return dispatch.call(this, event);
        };
    });
    return () => page.evaluate(() => (window as unknown as { __synthetic: string[] }).__synthetic);
}

/**
 * Opens Home on three photographs and waits until it rests immersive. With
 * `clock`, installs the page clock once it does and pauses it, so the chrome's
 * timers run on it. Timers armed before then, like the slideshow's, keep real
 * time until Pause and Play re-arm them.
 */
async function openHome(page: Page, { photos = ['white', 'gray', 'black'], clock = false }: { photos?: readonly string[]; clock?: boolean } = {}) {
    setPhotoFixtures(page, photos);
    await page.goto('/');
    await waitForHydration(page);
    await expectHomeImmersive(page);
    if (clock) {
        await page.clock.install();
        await pauseClock(page);
    }
}

/** Each intro layer displayed at any rendered frame from the first, sampled in the page. */
async function recordIntroSeen(page: Page) {
    await page.addInitScript((names) => {
        const seen: string[] = [];
        (window as unknown as { __introSeen: string[] }).__introSeen = seen;
        const sample = () => {
            for (const name of names) {
                for (const el of document.querySelectorAll(`[class*="${name}"]`)) {
                    if (getComputedStyle(el).display !== 'none' && !seen.includes(name)) seen.push(name);
                }
            }
            requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
    }, [...INTRO_LAYERS]);
    return () => page.evaluate(() => (window as unknown as { __introSeen: string[] }).__introSeen);
}

/** Every intro layer still in the document. */
const introLayersLeft = (page: Page) =>
    page.evaluate((names) => names.filter((name) => document.querySelector(`[class*="${name}"]`) !== null), [...INTRO_LAYERS]);

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
 * What the focused element is: its name, whether it's in the chrome, what the
 * visitor sees of it, and whether a click at its centre reaches it with every
 * intro layer made to take the pointer, so it must stack above them.
 */
const focusedControl = (page: Page) =>
    page.evaluate((names) => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return { name: 'body', inChrome: false, opacity: 0, onTop: false };
        let opacity = 1;
        for (let node: Element | null = el; node; node = node.parentElement) opacity *= parseFloat(getComputedStyle(node).opacity);
        const layers = names.flatMap((name) => Array.from(document.querySelectorAll<HTMLElement>(`[class*="${name}"], [class*="${name}"] *`)));
        const before = layers.map((layer) => layer.style.getPropertyValue('pointer-events'));
        layers.forEach((layer) => layer.style.setProperty('pointer-events', 'auto', 'important'));
        const box = el.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        layers.forEach((layer, index) => layer.style.setProperty('pointer-events', before[index]));
        return {
            name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim(),
            inChrome: !!el.closest('[data-home-chrome]'),
            opacity,
            onTop: !!hit && el.contains(hit),
        };
    }, [...INTRO_LAYERS]);

/**
 * Mouse moves onto the photograph, ending on the photo point. There's more
 * than one, since a document's first move only fixes the position, and the
 * first goes elsewhere, so a reveal with the mouse already there moves too.
 */
async function revealByMouse(page: Page) {
    const { x, y } = await photoPoint(page);
    await page.mouse.move(x - 40, y + 30);
    await page.mouse.move(x, y, { steps: 2 });
    await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');
}

/** A tap on the photograph, clear of every control. With the clock paused, runs a frame so the gesture ends. */
async function revealByTap(page: Page, { clock = false } = {}) {
    const { x, y } = await photoPoint(page);
    await page.touchscreen.tap(x, y);
    await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');
    if (clock) await runFor(page, FRAME);
    await expect(main(page)).not.toHaveAttribute('data-reveal-gesture');
}

async function centreOf(target: Locator) {
    const box = await target.boundingBox();
    if (!box) throw new Error(`${target} has no box`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A real tap at the centre of `target`, which works where locator.tap() refuses a target that takes no pointer. */
async function tapAt(page: Page, target: Locator) {
    const { x, y } = await centreOf(target);
    await page.touchscreen.tap(x, y);
}

/** Every chrome control whose centre a click or tap would miss, which is none once the chrome is up. */
const controlsMissingTheirCentre = (page: Page) =>
    chromeControls(page).evaluateAll((controls) =>
        controls.flatMap((control) => {
            const box = control.getBoundingClientRect();
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            return hit && control.contains(hit) ? [] : [control.getAttribute('aria-label') ?? control.textContent?.trim() ?? control.tagName];
        }));

/** How long the chrome's opacity takes to change, as its computed transition duration plus delay in ms. */
const chromeFadeMs = (page: Page) =>
    chrome(page).evaluate((el) => {
        const style = getComputedStyle(el);
        const list = (value: string) => value.split(',').map((part) => part.trim());
        const ms = (time: string) => (time.endsWith('ms') ? parseFloat(time) : parseFloat(time) * 1000) || 0;
        const properties = list(style.transitionProperty);
        const durations = list(style.transitionDuration);
        const delays = list(style.transitionDelay);
        const index = properties.findIndex((property) => property === 'opacity' || property === 'all');
        if (index === -1) return 0;
        return ms(durations[index % durations.length]) + ms(delays[index % delays.length]);
    });

/** The slideshow position `steps` on from `text`, such as 03 / 03 after 02 / 03. */
function positionAfter(text: string | null, steps: number) {
    const [current, count] = (text ?? '').split(' / ').map(Number);
    const value = ((((current - 1 + steps) % count) + count) % count) + 1;
    return `${String(value).padStart(2, '0')} / ${String(count).padStart(2, '0')}`;
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

/** Whether the photograph on screen fills the viewport, within 1 px on every side. */
const photoCoversViewport = (page: Page) =>
    currentPhoto(page).evaluate((image) => {
        const { left, top, right, bottom } = image.getBoundingClientRect();
        return left <= 1 && top <= 1 && right >= window.innerWidth - 1 && bottom >= window.innerHeight - 1 && getComputedStyle(image).objectFit === 'cover';
    });

/** Opens About from Home's nav and comes back the same way, as a visitor does, by click or by tap. */
async function roundTripToAbout(page: Page, isMobile: boolean) {
    if (isMobile) await revealByTap(page);
    else await revealByMouse(page);
    if (isMobile) await navLink(page, 'About').tap();
    else await navLink(page, 'About').click();
    await expect(page).toHaveURL('/about');
    if (isMobile) await navLink(page, 'Home').tap();
    else await navLink(page, 'Home').click();
    await expect(page).toHaveURL('/');
}

test.describe('at rest', () => {
    test('Home settles to the photograph alone, filling the viewport, with nothing waking it, and again after a trip to About', async ({ page, isMobile }, testInfo) => {
        runsOn(testInfo, 'desktop', 'mobile');
        const synthetic = await recordSyntheticEvents(page);
        await openHome(page);
        expect(await photoCoversViewport(page)).toBe(true);
        expect(await synthetic()).toEqual([]);

        await roundTripToAbout(page, isMobile);
        await expectHomeImmersive(page);
        await expect.poll(() => photoCoversViewport(page)).toBe(true);
    });

    test('under reduced motion, no intro layer or portrait shows at any frame, and Home settles the same way, there and back', async ({ page, isMobile }, testInfo) => {
        runsOn(testInfo, 'desktop', 'mobile');
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const introSeen = await recordIntroSeen(page);
        await openHome(page);
        expect(await introSeen()).toEqual([]);
        await roundTripToAbout(page, isMobile);
        await expectHomeImmersive(page);
    });

    test('with no input, Home stays immersive', async ({ page }, testInfo) => {
        runsOn(testInfo, 'desktop', 'mobile');
        await openHome(page, { clock: true });
        await runFor(page, LOADING_TIMEOUT + IDLE * 3);
        await expectHomeImmersive(page);
    });
});

test.describe('the pointer', () => {
    test.beforeEach(() => runsOn(test.info(), 'desktop'));

    test('a mouse move reveals every control at once, fading in within 300 ms, and they work', async ({ page }) => {
        await openHome(page, { clock: true });
        const { x, y } = await photoPoint(page);
        await page.mouse.move(x, y, { steps: 2 });
        await runFor(page, 100);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');
        expect(await chromeFadeMs(page)).toBeGreaterThan(0);
        expect(await chromeFadeMs(page)).toBeLessThanOrEqual(300);
        await expect(chrome(page)).toHaveCSS('opacity', '1');
        await expect(page.locator('[data-home-vignette]')).toHaveCSS('opacity', '1');
        for (const control of await chromeControls(page).all()) await expect(control).toBeVisible();
        expect(await controlsMissingTheirCentre(page)).toEqual([]);

        const before = await position(page).textContent();
        await next(page).click();
        await expect(position(page)).toHaveText(positionAfter(before, 1));
    });

    test('movement resets the idle, and Home recedes 4000 ms plus the 220 ms fade after the last move', async ({ page }) => {
        await openHome(page, { clock: true });
        await revealByMouse(page);
        await runFor(page, 2000);
        const { x, y } = await photoPoint(page);
        await page.mouse.move(x - 20, y + 10);
        await runFor(page, IDLE - 1);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');
        await runFor(page, 1);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'receding');
        // Receding, the chrome still takes the pointer.
        expect(await controlsMissingTheirCentre(page)).toEqual([]);
        await runFor(page, FADE - 1);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'receding');
        await runFor(page, 1);
        await expectHomeImmersive(page);
    });

    test('a mouse move with no movement changes nothing', async ({ page }) => {
        await openHome(page, { clock: true });
        const { x, y } = await photoPoint(page);
        // The document's first pointer event, and one more at the same point. Chromium can report the first with
        // movement from a position it recorded but never dispatched, so reported movement mustn't count.
        await page.mouse.move(x, y);
        await page.mouse.move(x, y);
        await runFor(page, 100);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'immersive');
        await page.mouse.move(x + 1, y);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');
    });

    test('a mouse resting on a control holds the chrome, leaving it starts a fresh idle, and resting on the photograph never holds', async ({ page }) => {
        await openHome(page, { clock: true });
        await revealByMouse(page);
        await runFor(page, IDLE);
        await runFor(page, FADE);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'immersive');

        const onNext = await centreOf(next(page));
        await page.mouse.move(onNext.x, onNext.y, { steps: 4 });
        await expect(main(page)).toHaveAttribute('data-chrome-holds', 'hover');
        await runFor(page, IDLE * 3);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');

        const { x, y } = await photoPoint(page);
        await page.mouse.move(x, y, { steps: 4 });
        await expect(main(page)).toHaveAttribute('data-chrome-holds', '');
        await runFor(page, IDLE - 1);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');
        await runFor(page, 1);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'receding');
    });

    test('a press on a control holds the chrome until it lifts, which starts a fresh idle', async ({ page }) => {
        await openHome(page, { clock: true });
        await revealByMouse(page);
        const onNext = await centreOf(next(page));
        await page.mouse.move(onNext.x, onNext.y, { steps: 4 });
        await page.mouse.down();
        const { x, y } = await photoPoint(page);
        // Off the control, only the press can hold.
        await page.mouse.move(x, y, { steps: 4 });
        await expect(main(page)).toHaveAttribute('data-chrome-holds', 'press');
        await runFor(page, IDLE * 3);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');

        await page.mouse.up();
        await expect(main(page)).toHaveAttribute('data-chrome-holds', '');
        await runFor(page, IDLE - 1);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');
        await runFor(page, 1);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'receding');
    });

    for (const key of ['Enter', 'Space']) {
        test(`after a click on Next, a move onto the photograph, and 4.3 s, Home is immersive, and ${key} then only reveals`, async ({ page }) => {
            await openHome(page, { clock: true });
            await revealByMouse(page);
            // Pause and Play re-arm the slideshow on the page clock, so the position only moves when Next does.
            await pause(page).click();
            await play(page).click();
            await next(page).click();
            await expect(position(page)).toHaveText('02 / 03');
            await expect(next(page)).toBeFocused();

            const { x, y } = await photoPoint(page);
            await page.mouse.move(x, y, { steps: 4 });
            await runFor(page, 4300);
            await expectHomeImmersive(page);

            await page.keyboard.press(key);
            await runFor(page, FRAME);
            await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');
            await expect(position(page)).toHaveText('02 / 03');
            await page.keyboard.press(key);
            await expect(position(page)).toHaveText('03 / 03');
        });
    }
});

test.describe('the keyboard', () => {
    test.beforeEach(() => runsOn(test.info(), 'desktop', 'mobile'));

    test('Tab reveals the chrome at once with a visible ring before anything activates, keyboard focus holds it, and focus leaving starts a fresh idle', async ({ page }) => {
        await openHome(page, { clock: true });
        await page.keyboard.press('Tab');
        await expect(wordmark(page)).toBeFocused();
        await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');
        await expect(page).toHaveURL('/');
        expect(await effectiveOpacity(wordmark(page))).toBe(1);
        await expectFocusRingVisible(wordmark(page));

        await runFor(page, IDLE * 4);
        await expect(main(page)).toHaveAttribute('data-chrome-holds', 'keyboard-focus');
        expect(await effectiveOpacity(wordmark(page))).toBe(1);

        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await expect(main(page)).toHaveAttribute('data-chrome-holds', '');
        await runFor(page, IDLE - 1);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');
        await runFor(page, 1);
        await runFor(page, FADE);
        await expectHomeImmersive(page);
    });

    test('Tab during the first-visit intro lands every focus on a fully visible control above the intro', async ({ page }) => {
        setPhotoFixtures(page, ['white', 'gray', 'black']);
        await holdPhotos(page);
        // Paused before the load, so the intro stays up for as long as the test takes.
        await page.clock.install();
        await page.clock.pauseAt(Date.now() + 1000);
        await page.goto('/');
        await waitForHydration(page);
        await settle(page);
        await expect(main(page)).toHaveAttribute('data-home-intro', 'loading');
        expect(await introLayersLeft(page)).toEqual([...INTRO_LAYERS]);

        const count = await chromeControls(page).count();
        expect(count).toBeGreaterThan(0);
        for (let i = 0; i < count; i++) {
            await page.keyboard.press('Tab');
            const focused = await focusedControl(page);
            expect(focused, `Tab ${i + 1}`).toEqual({ name: focused.name, inChrome: true, opacity: 1, onTop: true });
        }
        await expect(main(page)).toHaveAttribute('data-chrome-holds', 'keyboard-focus');
        await expect(main(page)).toHaveAttribute('data-home-intro', 'loading');
        await expect(page).toHaveURL('/');
    });

    test('a Tab to Work before Home hydrates leaves it visibly focused, and the first Enter after hydration follows it', async ({ page }) => {
        setPhotoFixtures(page, ['white', 'gray', 'black']);
        // Hold the scripts, not the stylesheets, so the server HTML paints and takes focus before React runs.
        let releaseScripts = () => {};
        const scriptsHeld = new Promise<void>((resolve) => (releaseScripts = resolve));
        await page.route('**/_next/static/**/*.js', async (route) => {
            await scriptsHeld;
            await route.continue();
        });
        await page.goto('/', { waitUntil: 'commit' });
        await expect(navLink(page, 'Work')).toBeAttached();
        for (let i = 0; i < 10 && !(await navLink(page, 'Work').evaluate((link) => link === document.activeElement)); i++) {
            await page.keyboard.press('Tab');
        }
        await expect(navLink(page, 'Work')).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.hasAttribute('data-hydrated')), 'React has not hydrated yet').toBe(false);
        expect(await effectiveOpacity(navLink(page, 'Work'))).toBe(1);

        releaseScripts();
        await waitForHydration(page);
        await settle(page);
        await expect(navLink(page, 'Work')).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL('/gallery');
    });
});

/** Real clicks that reach the document, which a consumed one never does. */
async function countDeliveredClicks(page: Page) {
    await page.addInitScript(() => {
        const counter = { clicks: 0 };
        (window as unknown as { __clicks: typeof counter }).__clicks = counter;
        document.addEventListener('click', (event) => {
            if (event.detail > 0) counter.clicks += 1;
        });
    });
    return () => page.evaluate(() => (window as unknown as { __clicks: { clicks: number } }).__clicks.clicks);
}

test.describe('touch', () => {
    test.beforeEach(() => runsOn(test.info(), 'mobile', 'mobile-webkit'));

    test('the first tap on idle Home reveals the controls without navigating, even on a receded link, and the next tap follows it', async ({ page }) => {
        const clicks = await countDeliveredClicks(page);
        await openHome(page);
        await tapAt(page, navLink(page, 'Work'));
        await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');
        await expect(main(page)).not.toHaveAttribute('data-reveal-gesture');
        await expect(chrome(page)).toHaveCSS('opacity', '1');
        await expect(page).toHaveURL('/');
        // The tap's own click, which WebKit credits to the mouse, never reaches the page.
        expect(await clicks()).toBe(0);

        await tapAt(page, navLink(page, 'Work'));
        await expect(page).toHaveURL('/gallery');
    });

    test('the first tap on a receded Next only reveals, and the next tap moves the photograph', async ({ page }) => {
        const clicks = await countDeliveredClicks(page);
        await openHome(page, { clock: true });
        const before = await position(page).textContent();
        await tapAt(page, next(page));
        await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');
        await runFor(page, FRAME);
        await expect(position(page)).toHaveText(before ?? '');
        expect(await clicks()).toBe(0);

        await tapAt(page, next(page));
        await expect(position(page)).toHaveText(positionAfter(before, 1));
    });

    test('a tap on revealed or fading chrome is never consumed', async ({ page }) => {
        await openHome(page, { clock: true });
        await revealByTap(page, { clock: true });
        await tapAt(page, pause(page));
        await expect(play(page)).toBeVisible();
        const start = await position(page).textContent();

        await tapAt(page, next(page));
        await expect(position(page)).toHaveText(positionAfter(start, 1));

        await runFor(page, IDLE);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'receding');
        await tapAt(page, next(page));
        await expect(position(page)).toHaveText(positionAfter(start, 2));
        await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');
    });

    test('a cancelled touch ends the gesture like a lifted one, and two fingers leave nothing behind', async ({ page }, testInfo) => {
        test.skip(testInfo.project.name === 'mobile-webkit', 'Playwright sends WebKit only whole taps, so a cancel and a second finger run on Chromium.');
        await openHome(page, { clock: true });
        const cdp: CDPSession = await page.context().newCDPSession(page);
        const point = await photoPoint(page);

        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
        await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');
        await expect(main(page)).toHaveAttribute('data-reveal-gesture');
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
        await runFor(page, FRAME);
        await expect(main(page)).not.toHaveAttribute('data-reveal-gesture');
        await runFor(page, 500);
        await tapAt(page, pause(page));
        await expect(play(page)).toBeVisible();
        const start = await position(page).textContent();

        await runFor(page, IDLE);
        await runFor(page, FADE);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'immersive');
        const onNext = await centreOf(next(page));
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ x: point.x, y: point.y, id: 1 }, { x: onNext.x, y: onNext.y, id: 2 }],
        });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await runFor(page, FRAME);
        await expect(main(page)).not.toHaveAttribute('data-reveal-gesture');
        await expect(main(page)).toHaveAttribute('data-chrome-holds', '');
        await expect(position(page)).toHaveText(start ?? '');
        await tapAt(page, next(page));
        await expect(position(page)).toHaveText(positionAfter(start, 1));
    });
});

test.describe('assistive technology', () => {
    test.beforeEach(() => runsOn(test.info(), 'desktop', 'mobile'));

    test('receded controls keep their names, roles, current page, and sequence state', async ({ page }) => {
        await openHome(page);
        await expect(chrome(page)).toMatchAriaSnapshot(`
          - navigation "Primary":
            - link "KG, Keyur Golani"
            - list:
              - listitem:
                - link "Home"
              - listitem:
                - link "Work"
              - listitem:
                - link "About"
            - button /Switch to (dark|light) mode/
          - group "Slideshow":
            - button "Previous photograph"
            - text: 01 / 03
            - button "Next photograph"
            - button "Pause slideshow"
        `);
        await expect(navLink(page, 'Home')).toHaveAttribute('aria-current', 'page');
        expect(await primary(page).evaluate((nav) => nav.tagName)).toBe('NAV');
        await expect(main(page)).toHaveAttribute('data-interface-state', 'immersive');
    });

    test('activating a receded control as a screen reader does works on the first attempt and reveals the chrome', async ({ page }) => {
        await openHome(page);
        const before = await position(page).textContent();
        await next(page).dispatchEvent('click');
        await expect(position(page)).toHaveText(positionAfter(before, 1));
        await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');

        await navLink(page, 'Work').dispatchEvent('click');
        await expect(page).toHaveURL('/gallery');
    });
});

test.describe('loading', () => {
    test.beforeEach(() => runsOn(test.info(), 'desktop', 'mobile'));

    for (const [name, respond] of [
        ['an empty library', (route: Route) => route.fulfill({ json: [] })],
        ['a failed photo list', (route: Route) => route.fulfill({ status: 500, body: 'error' })],
    ] as const) {
        test(`${name} ends loading at once, and navigation stays up and works`, async ({ page, isMobile }) => {
            await page.route('**/api/photos', respond);
            await page.clock.install();
            await page.goto('/');
            await waitForHydration(page);
            await expect(main(page)).toHaveAttribute('data-home-loading', 'false');
            await expect(main(page)).toHaveAttribute('data-chrome-holds', 'no-photo');
            await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');
            await runFor(page, LOADING_TIMEOUT + IDLE * 2);
            await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');
            await expect.poll(() => effectiveOpacity(primary(page))).toBe(1);
            if (isMobile) await navLink(page, 'Work').tap();
            else await navLink(page, 'Work').click();
            await expect(page).toHaveURL('/gallery');
        });
    }

    test('a failed first photograph ends loading at once with the chrome up', async ({ page }) => {
        setPhotoFixtures(page, ['white', 'gray', 'black']);
        await page.route('**/assets/photos/**', (route) => route.fulfill({ status: 404, body: '' }));
        await page.clock.install();
        await page.goto('/');
        await waitForHydration(page);
        await expect(main(page)).toHaveAttribute('data-home-loading', 'false');
        await expect(main(page)).toHaveAttribute('data-chrome-holds', 'no-photo');
        await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');
    });

    test('a stalled photograph ends the intro, fade included, and loading by 6 s, and the photograph arriving lets the chrome recede', async ({ page }) => {
        setPhotoFixtures(page, ['white', 'gray', 'black']);
        const release = await holdPhotos(page);
        // Paused before the load, so the intro and the loading deadline run on the page clock from mount.
        await page.clock.install();
        await page.clock.pauseAt(Date.now() + 1000);
        await page.goto('/');
        await waitForHydration(page);
        await settle(page);
        await runFor(page, INTRO_EXIT_DEADLINE - 1);
        await expect(main(page)).toHaveAttribute('data-home-intro', 'loading');
        expect(await introLayersLeft(page)).toEqual([...INTRO_LAYERS]);

        // The exit starts with the photograph still held, and nothing of the intro is left at 6 s.
        await runFor(page, LOADING_TIMEOUT - INTRO_EXIT_DEADLINE + 1);
        await expect(main(page)).toHaveAttribute('data-home-intro', 'settled');
        expect(await introLayersLeft(page)).toEqual([]);
        await expect(main(page)).toHaveAttribute('data-home-loading', 'false');
        await expect(main(page)).toHaveAttribute('data-chrome-holds', 'no-photo');
        await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');
        await expect(chrome(page)).toHaveCSS('opacity', '1');
        expect(await controlsMissingTheirCentre(page)).toEqual([]);

        release();
        await expect(main(page)).toHaveAttribute('data-chrome-holds', '');
        await runFor(page, IDLE);
        await runFor(page, FADE);
        await runFor(page, 2000);
        await expectHomeImmersive(page);
    });

    test('under reduced motion a stalled photograph shows no intro at any frame until loading ends at 6 s', async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        setPhotoFixtures(page, ['white', 'gray', 'black']);
        const release = await holdPhotos(page);
        const introSeen = await recordIntroSeen(page);
        await page.goto('/');
        await waitForHydration(page);
        await expect(main(page)).toHaveAttribute('data-home-intro', 'settled');
        await expect(main(page)).toHaveAttribute('data-home-loading', 'true');
        expect(await introLayersLeft(page)).toEqual([]);

        await expect(main(page)).toHaveAttribute('data-home-loading', 'false', { timeout: LOADING_TIMEOUT + 5000 });
        await expect(main(page)).toHaveAttribute('data-chrome-holds', 'no-photo');
        expect(await introSeen()).toEqual([]);
        release();
    });
});

test.describe('reduced motion', () => {
    test.beforeEach(() => runsOn(test.info(), 'desktop', 'mobile'));

    test('the chrome appears and goes at once, never fading', async ({ page, isMobile }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const states = await recordVisibility(page);
        await openHome(page, { clock: true });
        if (isMobile) await revealByTap(page, { clock: true });
        else await revealByMouse(page);
        // The reduced-motion baseline leaves every transition at 0.01 ms, which ends by the next frame.
        expect(await chromeFadeMs(page)).toBeLessThanOrEqual(0.01);
        await expect.poll(() => effectiveOpacity(chrome(page))).toBe(1);

        await runFor(page, IDLE);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'immersive');
        expect(await chromeFadeMs(page)).toBeLessThanOrEqual(0.01);
        await expect.poll(() => effectiveOpacity(chrome(page))).toBe(0);
        expect(await states()).not.toContain('receding');
    });

    test('a preference change mid-session applies without a reload, mid-fade too', async ({ page, isMobile }) => {
        const states = await recordVisibility(page);
        await openHome(page, { clock: true });
        await page.evaluate(() => ((window as unknown as { __sameDocument: boolean }).__sameDocument = true));
        const reveal = () => (isMobile ? revealByTap(page, { clock: true }) : revealByMouse(page));

        await reveal();
        await runFor(page, IDLE);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'receding');
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await settle(page);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'immersive');

        const before = (await states()).length;
        await reveal();
        await runFor(page, IDLE);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'immersive');
        expect((await states()).slice(before)).not.toContain('receding');

        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await reveal();
        await runFor(page, IDLE);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'receding');
        expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
    });
});

/** Hides the document and shows it again the way a tab switch does, as Home's useDocumentVisible sees it. */
async function setDocumentHidden(page: Page, hidden: boolean) {
    await page.evaluate((hide) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hide ? 'hidden' : 'visible') });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => hide });
        document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
    await settle(page);
}

test.describe('a hidden document', () => {
    test.beforeEach(() => runsOn(test.info(), 'desktop'));

    test('drops a resting mouse and returns Home to immersive, which stays until the next intent', async ({ page }) => {
        await openHome(page, { clock: true });
        await revealByMouse(page);
        const onNext = await centreOf(next(page));
        await page.mouse.move(onNext.x, onNext.y, { steps: 4 });
        await expect(main(page)).toHaveAttribute('data-chrome-holds', 'hover');

        await setDocumentHidden(page, true);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'immersive');
        await expect(main(page)).toHaveAttribute('data-chrome-holds', '');
        await setDocumentHidden(page, false);
        await runFor(page, IDLE * 3);
        await expectHomeImmersive(page);
    });

    test('keyboard focus keeps the chrome up across it', async ({ page }) => {
        await openHome(page, { clock: true });
        await page.keyboard.press('Tab');
        await expect(main(page)).toHaveAttribute('data-chrome-holds', 'keyboard-focus');
        await setDocumentHidden(page, true);
        await setDocumentHidden(page, false);
        await runFor(page, IDLE * 2);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');
    });

    test('the no-photo hold keeps the chrome up across it', async ({ page }) => {
        await page.route('**/api/photos', (route) => route.fulfill({ json: [] }));
        await page.goto('/');
        await waitForHydration(page);
        await expect(main(page)).toHaveAttribute('data-chrome-holds', 'no-photo');
        await setDocumentHidden(page, true);
        await expect(main(page)).toHaveAttribute('data-interface-state', 'interactive');
    });
});

test.describe('off Home', () => {
    test.beforeEach(() => runsOn(test.info(), 'desktop', 'mobile'));

    for (const path of ['/gallery', '/about']) {
        test(`on ${path} navigation and the theme toggle stay fully visible after 10 s with no input, and no chrome controller runs`, async ({ page }) => {
            await page.clock.install();
            await page.goto(path);
            await waitForHydration(page);
            await expect(primary(page)).toBeVisible();
            await runFor(page, 10_000);
            expect(await effectiveOpacity(primary(page))).toBe(1);
            expect(await effectiveOpacity(themeToggle(page))).toBe(1);
            await expect(page.locator('[data-interface-state]')).toHaveCount(0);
        });
    }
});

test.describe('contrast and reflow', () => {
    test.beforeEach(() => runsOn(test.info(), 'desktop', 'mobile'));

    test('over a white photograph, the revealed nav and sequence text keep 4.5:1 and the icons 3:1', async ({ page }) => {
        await serveTwoWhitePhotos(page);
        await page.goto('/');
        await waitForHydration(page);
        await expectHomeImmersive(page);
        // Keyboard focus in the nav holds the chrome up through the checks.
        await page.keyboard.press('Tab');
        await expect(main(page)).toHaveAttribute('data-chrome-holds', 'keyboard-focus');

        for (const name of ['Home', 'Work', 'About']) await expectContrastOverImage(navLink(page, name), { min: 4.5 });
        // The helper reads every pixel in the box, and the monogram's 1 px circle sits at the box's edge, behind no
        // glyph, so the circle is taken out for the text.
        const circle = await page.addStyleTag({ content: '[class*="monogram"] { border-color: transparent !important; }' });
        await expectContrastOverImage(wordmark(page).getByText('KG', { exact: true }), { min: 4.5 });
        await circle.evaluate((style) => style.parentNode?.removeChild(style));
        for (const text of [position(page), playbackLabel(page)]) await expectContrastOverImage(text, { min: 4.5 });
        for (const control of [previous(page), next(page), playback(page), themeToggle(page)]) {
            await expectContrastOverImage(control.locator('svg').first(), { min: 3 });
        }
    });

    test('at 320 px with 200% text, every revealed control is reachable in the scrolling chrome, clear of the others', async ({ page }) => {
        await openHome(page);
        await page.keyboard.press('Tab');
        await expect(main(page)).toHaveAttribute('data-chrome-holds', 'keyboard-focus');
        await expectReflow(chromeControls(page));
    });
});

test.describe('the #1 checks', () => {
    test.beforeEach(() => runsOn(test.info(), 'desktop', 'mobile'));

    test('Home passes the #1 automated and keyboard checks, immersive and revealed', async ({ page, isMobile }) => {
        await openHome(page);
        // Immersive for axe, and each focus in the keyboard checks reveals the chrome.
        await checkSurface(page, { controls: [sequenceControls(page), primary(page).locator('a, button')], chrome: [primary(page), themeToggle(page)] });

        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        if (isMobile) await revealByTap(page);
        else await revealByMouse(page);
        await expectNoA11yViolations(page);
        await expect(main(page)).not.toHaveAttribute('data-interface-state', 'immersive');
    });
});
