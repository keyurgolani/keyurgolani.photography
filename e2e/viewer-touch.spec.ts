import type { Locator, Page, TestInfo } from '@playwright/test';
import { waitForHydration } from './support/hydration';
import { expectReflow } from './support/reflow';
import { checkSurface } from './support/surface';
import { expectMinTargetSize } from './support/targets';
import { expect, test } from './support/test';
import { centerOf, doubleTap, realTouches, touchDrag, twoFingerSpread } from './support/touch';
import { P, href, useViewerCatalog } from './support/viewerCatalog';
import { SETTLE } from '../components/viewer/doubleTap';

// #9 PR 2: touch and presentation, on #7's published fixture. Swipes run on
// the touch projects: real touches through CDP on `mobile`, and synthetic
// pointer events on `mobile-webkit`, where Playwright sends only whole taps
// (support/touch.ts). The arrow keys under the open modal (review finding 3)
// run on all three projects, so WebKit's focus after a tap is covered.
// Reduced motion, 200% zoom, the #1 checks on the modal, and Enter and Space
// on its buttons run on desktop and mobile, as the contract asks. The page
// mode's #1 checks are in viewer.spec.ts.

test.describe.configure({ mode: 'serial' });

const origin = useViewerCatalog();

const viewer = (page: Page) => page.locator('[data-surface="viewer"]');
const header = (page: Page) => viewer(page).locator('header');
const button = (page: Page, name: string) => viewer(page).getByRole('button', { name, exact: true });
const stage = (page: Page) => viewer(page).locator('[data-viewer-stage]');
const announcer = (page: Page) => viewer(page).locator('[data-viewer-announcer]');
const dialog = (page: Page) => page.getByRole('dialog', { name: /^Fixture harbor/ });
const entry = (page: Page, photoId: string) => page.locator(`[id="photo-${photoId}"]`);
const technical = (page: Page) => viewer(page).getByRole('button', { name: /^(Show|Hide) technical details$/ });

function runsOn(testInfo: TestInfo, ...projects: string[]): void {
    test.skip(!projects.includes(testInfo.project.name), `Runs on ${projects.join(' and ')}.`);
}

async function openPage(page: Page, photoId: string): Promise<void> {
    await page.goto(`${origin()}${href(photoId)}`);
    await waitForHydration(page);
    await expect(header(page).getByRole('heading', { level: 1 })).toHaveText('Fixture harbor');
}

/**
 * Opens the modal from the series entry: a tap on the touch projects or a click, or Enter on the entry. Chromium shows
 * the ring on the Close that showModal() focuses only when a key opened the dialog, so the keyboard checks open it so.
 */
async function openFromSeries(page: Page, photoId: string, testInfo: TestInfo, via: 'pointer' | 'keyboard' = 'pointer'): Promise<void> {
    await page.goto(`${origin()}/work/harbor`);
    await waitForHydration(page);
    if (via === 'keyboard') {
        await entry(page, photoId).focus();
        await page.keyboard.press('Enter');
    } else if (testInfo.project.use.hasTouch) await entry(page, photoId).tap();
    else await entry(page, photoId).click();
    await expect(page).toHaveURL(`${origin()}${href(photoId)}`);
    await expect(dialog(page)).toBeVisible();
}

/** What holds focus: inside the Viewer, on the body, or somewhere else on the page. */
async function focusPlace(page: Page): Promise<string> {
    return page.evaluate(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) return 'body';
        if (active.closest('[data-surface="viewer"]')) return 'viewer';
        return active.outerHTML.slice(0, 120);
    });
}

/**
 * Diagnostics for a Close tap CI once saw do nothing: from the next load on, every pointer event (its id, type,
 * target, and whether the Viewer root holds its capture), capture changes, clicks, the dialog's toggle, cancel and
 * close, `history.back`, and popstate. Returns a reader for the log.
 */
async function recordEvents(page: Page): Promise<() => Promise<string[]>> {
    await page.addInitScript(() => {
        const log: string[] = [];
        (window as unknown as { kgEvents: string[] }).kgEvents = log;
        const name = (target: EventTarget | null) =>
            target instanceof Element ? `${target.tagName.toLowerCase()}${target.getAttribute('aria-label') ? `[${target.getAttribute('aria-label')}]` : ''}${target.textContent ? ` "${target.textContent.trim().slice(0, 12)}"` : ''}` : String(target);
        const note = (text: string) => log.push(`${Math.round(performance.now())} ${text} @${location.pathname.slice(-6)}`);
        const pointerTypes = ['pointerdown', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture'];
        for (const type of [...pointerTypes, 'click', 'toggle', 'cancel', 'close', 'popstate']) {
            window.addEventListener(
                type,
                (event) => {
                    const root = document.querySelector('[data-surface="viewer"]');
                    if (event instanceof PointerEvent) {
                        note(`${type} id=${event.pointerId} ${event.pointerType} on ${name(event.target)} rootCapture=${root?.hasPointerCapture(event.pointerId) ?? 'none'}`);
                    } else {
                        note(`${type} on ${name(event.target)}${root instanceof HTMLDialogElement ? ` open=${root.open}` : ''}`);
                    }
                },
                true,
            );
        }
        const back = history.back.bind(history);
        history.back = () => {
            note(`history.back length=${history.length}`);
            back();
        };
    });
    return () => page.evaluate(() => (window as unknown as { kgEvents?: string[] }).kgEvents ?? ['no log']);
}

/** A one-finger swipe across the middle of the photograph. */
async function swipe(page: Page, dx: number, { dy = 0, end = 'lift' as 'lift' | 'cancel', on = stage(page) } = {}): Promise<void> {
    const center = await centerOf(on);
    await touchDrag(page, { from: center, dx, dy, end });
}

/** Resolves once `region`'s scroll position holds still across two 100 ms looks, so any fling after a real drag is over. */
async function scrollSettled(region: Locator): Promise<void> {
    const looks: number[] = [];
    await expect
        .poll(
            async () => {
                looks.push(await region.evaluate((element) => element.scrollLeft));
                return looks.length >= 3 && looks.slice(-3).every((left) => left === looks[looks.length - 1]);
            },
            { message: 'the pan came to rest', intervals: [100] },
        )
        .toBe(true);
}

/** The URL and header still show photograph `n` of 3. */
async function expectStill(page: Page, photoId: string, n: number): Promise<void> {
    await expect(page).toHaveURL(`${origin()}${href(photoId)}`);
    await expect(header(page)).toContainText(`0${n} / 03`);
}

test.describe('swipe', () => {
    test.beforeEach(() => runsOn(test.info(), 'mobile', 'mobile-webkit'));

    test('on a page, a swipe toward the left is Next and toward the right Previous, announced, in place, with focus left alone', async ({ page }) => {
        await openPage(page, P[1]);
        const length = await page.evaluate(() => history.length);
        await swipe(page, -150);
        await expectStill(page, P[2], 3);
        await expect(announcer(page)).toHaveText('Photograph 3 of 3');
        expect(await focusPlace(page)).toBe('body');
        await swipe(page, 150);
        await expectStill(page, P[1], 2);
        await swipe(page, 150);
        await expectStill(page, P[0], 1);
        // The first photograph's end: a swipe toward it announces the end and stays.
        await swipe(page, 150);
        await expect(announcer(page)).toHaveText('First photograph in Fixture harbor.');
        await expectStill(page, P[0], 1);
        // Moves replace the entry and stay a page.
        expect(await page.evaluate(() => history.length)).toBe(length);
        await expect(page.locator('dialog')).toHaveCount(0);
        expect(await focusPlace(page)).toBe('body');
    });

    test('a tap on Next right after a swipe moves again, so the swipe leaves no browser fling behind to swallow it', async ({ page }) => {
        // Chromium flings at the lift of a fast drag even where touch-action forbids the pan, and on Linux a
        // tap during that fling only stops it. The swipe cancels its own touchmoves, so there's no fling.
        await openPage(page, P[0]);
        await swipe(page, -150);
        await expectStill(page, P[1], 2);
        await button(page, 'Next photograph').tap();
        await expectStill(page, P[2], 3);
    });

    test('in the modal, a swipe moves too, focus stays on Close, and Close still puts focus back on the entry that opened it', async ({ page }, testInfo) => {
        // CI on Linux once saw this Close tap do nothing. The log prints only on failure, to the job log.
        const events = await recordEvents(page);
        try {
            await openFromSeries(page, P[0], testInfo);
            await expect(button(page, 'Close')).toBeFocused();
            await swipe(page, -150);
            await expectStill(page, P[1], 2);
            await expect(dialog(page)).toHaveAccessibleName(/Photograph 2 of 3$/);
            // showModal() put focus on Close, and a swipe never moves it.
            await expect(button(page, 'Close')).toBeFocused();
            await button(page, 'Close').tap();
            await expect(page).toHaveURL(`${origin()}/work/harbor`);
            await expect(page.locator('dialog')).toHaveCount(0);
            await expect(entry(page, P[0])).toBeFocused();
        } catch (error) {
            console.log(`viewer-touch modal swipe, ${testInfo.project.name}, events:\n${(await events()).join('\n')}`);
            throw error;
        }
    });

    test('Close during a slow move lands on the series with focus on the opener, never on a Viewer URL with no Viewer', async ({ page }, testInfo) => {
        await openFromSeries(page, P[0], testInfo);
        // Photograph 2's payload takes a second and a half, so Close comes while the move is still in flight.
        let held = 0;
        await page.route(
            (url) => url.pathname === href(P[1]),
            async (route) => {
                held += 1;
                await new Promise((resolve) => setTimeout(resolve, 1500));
                await route.fallback();
            },
        );
        await swipe(page, -150);
        await expect.poll(() => held, 'the move asked for photograph 2').toBeGreaterThan(0);
        await button(page, 'Close').tap();
        await expect(page).toHaveURL(`${origin()}/work/harbor`);
        await expect(page.locator('dialog')).toHaveCount(0);
        await expect(entry(page, P[0])).toBeFocused();
        // After the held payload would have landed, the visitor is still on the series.
        await page.waitForTimeout(2000);
        await expect(page).toHaveURL(`${origin()}/work/harbor`);
        await expect(page.locator('dialog')).toHaveCount(0);
    });

    test('a short swipe and a mostly vertical drag never move, and the vertical drag still scrolls the page', async ({ page }) => {
        // The photograph with the longest reading area, in a shorter viewport, so the page has room to scroll under the drag.
        const size = page.viewportSize();
        if (size) await page.setViewportSize({ width: size.width, height: 400 });
        await openPage(page, P[0]);
        expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight), 'the page can scroll').toBe(true);
        await swipe(page, -40);
        await swipe(page, 40);
        await expectStill(page, P[0], 1);
        // 60 across and 120 up: well past 48, but under 1.25 times the vertical travel.
        await swipe(page, -60, { dy: -120 });
        await expectStill(page, P[0], 1);
        if (realTouches(page)) {
            await expect.poll(() => page.evaluate(() => window.scrollY), 'the drag scrolled the page').toBeGreaterThan(0);
        }
        await expect(announcer(page)).toHaveText('');
        // The control: in the same short viewport, back at the top, a full swipe still moves.
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await swipe(page, -150);
        await expectStill(page, P[1], 2);
    });

    test('a cancelled touch never moves, and the next swipe does, so nothing is left stuck', async ({ page }) => {
        await openPage(page, P[1]);
        await swipe(page, -150, { end: 'cancel' });
        await expectStill(page, P[1], 2);
        await swipe(page, -150);
        await expectStill(page, P[2], 3);
    });

    test('two fingers, as in a pinch, never move; the pinch zooms, a drag on the pinched page pans it, and back at scale 1 a swipe moves', async ({ page }) => {
        await openPage(page, P[1]);
        const from = await centerOf(stage(page));
        const scale = () => page.evaluate(() => window.visualViewport?.scale ?? 1);
        await twoFingerSpread(page, { from });
        await expectStill(page, P[1], 2);
        await expect(announcer(page)).toHaveText('');
        if (realTouches(page)) {
            // The stage keeps pinch zoom (touch-action pinch-zoom), so the spread zoomed the page in.
            await expect.poll(scale, 'the pinch zoomed the page').toBeGreaterThan(1.01);
            await expect(viewer(page)).toHaveAttribute('data-pinched', '');
            // Pinched in, a sideways drag on the photograph is the browser's pan, not a move. The pinch kept this point on the stage.
            const offset = () => page.evaluate(() => window.visualViewport?.offsetLeft ?? 0);
            const before = await offset();
            await touchDrag(page, { from, dx: -150 });
            await expectStill(page, P[1], 2);
            await expect.poll(offset, 'the drag panned the pinched page').toBeGreaterThan(before);
            // Pinch back out on the same page: two fingers closing in, until the page is at scale 1 again.
            await twoFingerSpread(page, { from, gap: 220, spread: -100 });
            await expect.poll(scale, 'the page is back at scale 1').toBeLessThanOrEqual(1.01);
            await expect(viewer(page)).not.toHaveAttribute('data-pinched');
        }
        // No reload: the same page's recognizer, after the two fingers, takes the next swipe.
        await swipe(page, -150);
        await expectStill(page, P[2], 3);
    });

    test('a drag on the zoomed photograph pans it and never moves, and after Zoom resets a swipe moves again', async ({ page }) => {
        await openPage(page, P[1]);
        const zoom = button(page, 'Zoom');
        await zoom.tap();
        await expect(zoom).toHaveAttribute('aria-pressed', 'true');
        const region = viewer(page).getByRole('region', { name: 'Zoomed photograph' });
        await expect(region).toBeVisible();
        await expect.poll(() => region.evaluate((element) => element.scrollWidth > element.clientWidth), 'the zoomed photograph overflows its box').toBe(true);
        await swipe(page, -150, { on: region });
        await swipe(page, 150, { on: region });
        await expectStill(page, P[1], 2);
        await expect(zoom).toHaveAttribute('aria-pressed', 'true');
        if (realTouches(page)) {
            // Toward the left first, so the region's scroll moved off its start.
            await swipe(page, -150, { on: region });
            await expect.poll(() => region.evaluate((element) => element.scrollLeft), 'the drag panned the photograph').toBeGreaterThan(0);
            // That pan is the browser's own scroll, so it flings on after the lift, and a tap during a fling only stops it
            // (Chromium on Linux, as on a phone). A visitor taps Zoom once the photograph stops, and so does this.
            await scrollSettled(region);
        }
        await zoom.tap();
        await expect(zoom).toHaveAttribute('aria-pressed', 'false');
        await swipe(page, -150);
        await expectStill(page, P[2], 3);
    });
});

test.describe('double-tap', () => {
    // #9c: the stage's touch-action turns the browser's double-tap zoom off, so the Viewer reads two taps on the
    // photograph as its own Zoom (components/viewer/doubleTap.ts has the thresholds, both sides of each).
    test.beforeEach(() => runsOn(test.info(), 'mobile', 'mobile-webkit'));

    /** A scroll quiets taps for the settle (a tap that stops a fling isn't one), so each case waits out any scroll its setup made. */
    const settled = (page: Page) => page.waitForTimeout(SETTLE + 50);

    test('on a page, a double-tap on the photograph toggles Zoom, never moves, and a swipe right after still moves', async ({ page }) => {
        await openPage(page, P[1]);
        await settled(page);
        const zoom = button(page, 'Zoom');
        await doubleTap(page, await centerOf(stage(page)));
        await expect(zoom).toHaveAttribute('aria-pressed', 'true');
        const region = viewer(page).getByRole('region', { name: 'Zoomed photograph' });
        await expect(region).toBeVisible();
        await expectStill(page, P[1], 2);
        // Zoomed, the photograph keeps pinch and pan both ways, and no browser double-tap zoom, so the Viewer's runs again.
        await expect(region).toHaveCSS('touch-action', 'manipulation');
        await doubleTap(page, await centerOf(region));
        await expect(zoom).toHaveAttribute('aria-pressed', 'false');
        await expectStill(page, P[1], 2);
        await expect(announcer(page)).toHaveText('');
        await swipe(page, -150);
        await expectStill(page, P[2], 3);
    });

    test('a double-tap zooms in on the place tapped, which stays under the finger', async ({ page }) => {
        await openPage(page, P[1]);
        await settled(page);
        const frame = stage(page).locator('figure');
        const fitted = await frame.boundingBox();
        expect(fitted, 'the fitted photograph').not.toBeNull();
        // A quarter across, halfway down.
        const at = { x: fitted!.x + fitted!.width / 4, y: fitted!.y + fitted!.height / 2 };
        await doubleTap(page, at);
        await expect(button(page, 'Zoom')).toHaveAttribute('aria-pressed', 'true');
        const region = viewer(page).getByRole('region', { name: 'Zoomed photograph' });
        await expect.poll(() => region.evaluate((element) => element.scrollLeft), 'the zoomed photograph scrolled to the place').toBeGreaterThan(0);
        const zoomed = await frame.boundingBox();
        expect(zoomed!.width, 'zoomed in').toBeGreaterThan(fitted!.width);
        expect((at.x - zoomed!.x) / zoomed!.width, 'the same place across sits under the finger').toBeCloseTo(0.25, 2);
        await expectStill(page, P[1], 2);
    });

    test('a double-tap that zooms out where Previous or Next sit unzoomed presses neither, and the Viewer stays', async ({ page }) => {
        // Zoomed out, the stage shrinks, and the second tap's click would land on whatever now sits under the finger.
        // Only real touches make that click, so this runs on Chromium; WebKit's synthetic taps make none.
        runsOn(test.info(), 'mobile');
        await openPage(page, P[1]);
        for (const name of ['Next photograph', 'Previous photograph']) {
            const at = await centerOf(button(page, name));
            const zoom = button(page, 'Zoom');
            await zoom.tap();
            await expect(zoom).toHaveAttribute('aria-pressed', 'true');
            const onPhotograph = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-zoomed]') != null, at);
            expect(onPhotograph, `zoomed, the photograph covers where ${name} sits unzoomed`).toBe(true);
            await settled(page);
            await doubleTap(page, at);
            await expect(zoom).toHaveAttribute('aria-pressed', 'false');
            await page.waitForTimeout(300);
            await expectStill(page, P[1], 2);
            await expect(announcer(page)).toHaveText('');
            await settled(page);
        }
    });

    test('two taps too far apart in time are two taps, and nothing zooms', async ({ page }) => {
        await openPage(page, P[1]);
        await settled(page);
        await doubleTap(page, await centerOf(stage(page)), { gap: 600 });
        await page.waitForTimeout(300);
        await expect(button(page, 'Zoom')).toHaveAttribute('aria-pressed', 'false');
        await expectStill(page, P[1], 2);
    });

    test('in the modal, a double-tap toggles Zoom, keeps the dialog open, and Close still lands on the opener', async ({ page }, testInfo) => {
        await openFromSeries(page, P[0], testInfo);
        await settled(page);
        await doubleTap(page, await centerOf(stage(page)));
        await expect(button(page, 'Zoom')).toHaveAttribute('aria-pressed', 'true');
        await expectStill(page, P[0], 1);
        await expect(dialog(page)).toBeVisible();
        // A tap on the photograph takes focus as any tap on content does: off Close, onto the zoomed region or the body. It never leaves the dialog.
        expect(['viewer', 'body']).toContain(await focusPlace(page));
        await button(page, 'Close').tap();
        await expect(page).toHaveURL(`${origin()}/work/harbor`);
        await expect(entry(page, P[0])).toBeFocused();
    });

    test('a double-tap leaves vertical scroll alone: a mostly vertical drag still scrolls the page and never zooms or moves', async ({ page }) => {
        const size = page.viewportSize();
        if (size) await page.setViewportSize({ width: size.width, height: 400 });
        await openPage(page, P[0]);
        await settled(page);
        const zoom = button(page, 'Zoom');
        await doubleTap(page, await centerOf(stage(page)));
        await expect(zoom).toHaveAttribute('aria-pressed', 'true');
        await doubleTap(page, await centerOf(stage(page)));
        await expect(zoom).toHaveAttribute('aria-pressed', 'false');
        await swipe(page, -20, { dy: -120 });
        await expectStill(page, P[0], 1);
        await expect(zoom).toHaveAttribute('aria-pressed', 'false');
        if (realTouches(page)) {
            await expect.poll(() => page.evaluate(() => window.scrollY), 'the drag scrolled the page').toBeGreaterThan(0);
        }
    });
});

test.describe('arrows under the open modal', () => {
    test('move when focus falls to the body, and after a tap or click on the photograph', async ({ page }, testInfo) => {
        await openFromSeries(page, P[0], testInfo);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        expect(await focusPlace(page)).toBe('body');
        await page.keyboard.press('ArrowRight');
        await expectStill(page, P[1], 2);
        await expect(announcer(page)).toHaveText('Photograph 2 of 3');
        // WebKit can leave focus on the body after a tap on content that takes none; the key works either way.
        if (testInfo.project.use.hasTouch) {
            const { x, y } = await centerOf(stage(page));
            await page.touchscreen.tap(x, y);
        } else {
            await stage(page).click();
        }
        expect(['viewer', 'body']).toContain(await focusPlace(page));
        await page.keyboard.press('ArrowRight');
        await expectStill(page, P[2], 3);
        await page.keyboard.press('ArrowLeft');
        await expectStill(page, P[1], 2);
        // Escape still closes it in one step, onto the opener.
        await page.keyboard.press('Escape');
        await expect(page).toHaveURL(`${origin()}/work/harbor`);
        await expect(entry(page, P[0])).toBeFocused();
    });
});

test.describe('presentation', () => {
    test.beforeEach(() => runsOn(test.info(), 'desktop', 'mobile'));

    test('under reduced motion a move swaps the photograph in place, with no slide, and gives the new position at once', async ({ page }, testInfo) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await openPage(page, P[0]);
        const before = await stage(page).boundingBox();
        // Every frame from before the move until the new photograph shows: anything that animates for longer than the
        // reduced-motion baseline's 0.01 ms, anything that animates position or transform at all, and any transform on the stage.
        await page.evaluate(() => {
            const record = { animations: [] as string[], transforms: [] as string[], running: true };
            (window as unknown as { kgMotion: typeof record }).kgMotion = record;
            const MOVES = /^(transform|translate|scale|rotate|left|right|top|bottom|inset|margin|offset)/i;
            const sample = () => {
                if (!record.running) return;
                for (const animation of document.getAnimations()) {
                    const effect = animation.effect as KeyframeEffect | null;
                    const duration = Number(effect?.getTiming().duration ?? 0);
                    const properties =
                        animation instanceof CSSTransition ? [animation.transitionProperty] : (effect?.getKeyframes() ?? []).flatMap((frame) => Object.keys(frame));
                    const moves = properties.some((property) => MOVES.test(property));
                    if (duration > 0.01 || moves) {
                        const target = effect?.target instanceof Element ? `${effect.target.tagName}.${effect.target.className}` : 'none';
                        record.animations.push(`${properties.join(',')} ${duration}ms on ${target}`);
                    }
                }
                const stageElement = document.querySelector('[data-viewer-stage]');
                for (const element of stageElement ? [stageElement, ...stageElement.querySelectorAll('*')] : []) {
                    const transform = getComputedStyle(element).transform;
                    if (transform !== 'none') record.transforms.push(transform);
                }
                requestAnimationFrame(sample);
            };
            sample();
        });
        if (testInfo.project.use.hasTouch) await swipe(page, -150);
        else await button(page, 'Next photograph').click();
        await expectStill(page, P[1], 2);
        await expect(announcer(page)).toHaveText('Photograph 2 of 3');
        const motion = await page.evaluate(() => {
            const record = (window as unknown as { kgMotion: { animations: string[]; transforms: string[]; running: boolean } }).kgMotion;
            record.running = false;
            return { animations: [...new Set(record.animations)], transforms: [...new Set(record.transforms)] };
        });
        expect(motion).toEqual({ animations: [], transforms: [] });
        const after = await stage(page).boundingBox();
        expect(after?.x).toBeCloseTo(before?.x ?? NaN, 0);
    });

    test('the modal passes the #1 checks, with 44 px targets, 3:1 boundaries on the ground, and controls that reflow at 200% text', async ({ page }, testInfo) => {
        await openFromSeries(page, P[1], testInfo, 'keyboard');
        const controls = [button(page, 'Close'), button(page, 'Zoom'), button(page, 'Previous photograph'), button(page, 'Next photograph'), technical(page)];
        await checkSurface(page, { controls });
        // Rule 8: the boundaries and icons use the tokens styles/__tests__/surfaces.test.ts holds at 3:1 on the ground.
        // Close and Zoom are the header's borderless text buttons, so their ink label and icon carry it.
        // The pointer rests on the photograph, so no control shows its hover border.
        const rest = await centerOf(stage(page));
        await page.mouse.move(rest.x, rest.y);
        const paintOf = (control: Locator) =>
            control.evaluate((element) => ({
                border: getComputedStyle(element).borderTopColor,
                icon: getComputedStyle(element.querySelector('svg') ?? element).color,
            }));
        for (const [index, control] of controls.entries()) {
            const border = index < 2 ? 'rgba(0, 0, 0, 0)' : 'rgba(255, 255, 255, 0.38)';
            expect(await paintOf(control), `${control}`).toEqual({ border, icon: 'rgb(246, 244, 238)' });
        }
        // A fine pointer still brings a border in on Close and Zoom.
        if (!testInfo.project.use.hasTouch) {
            for (const control of controls.slice(0, 2)) {
                await control.hover();
                expect((await paintOf(control)).border, `${control} on hover`).toBe('rgb(246, 244, 238)');
            }
        }
        for (const name of ['Previous photograph', 'Next photograph']) {
            expect(await button(page, name).evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgba(8, 11, 10, 0.9)');
        }
        await expectReflow(viewer(page).locator('a, button'));
    });

    test('at 200% browser zoom, as 1280 by 800 shows at 640 by 400, both modes keep every control on screen, whole, and 44 px, with no sideways scroll', async ({ page }, testInfo) => {
        runsOn(testInfo, 'desktop');
        await page.setViewportSize({ width: 640, height: 400 });
        for (const mode of ['page', 'modal'] as const) {
            if (mode === 'page') await openPage(page, P[1]);
            else await openFromSeries(page, P[1], testInfo, 'keyboard');
            await expect(viewer(page)).toHaveAttribute('data-viewer-mode', mode);
            const controls = viewer(page).locator('a, button');
            await expectMinTargetSize(controls, 44);
            const sideways = await viewer(page).evaluate((root) => {
                const scroller = root instanceof HTMLDialogElement ? root : document.documentElement;
                return scroller.scrollWidth - scroller.clientWidth;
            });
            expect(sideways, `${mode}: no sideways scroll`).toBeLessThanOrEqual(0);
            for (const control of await controls.all()) await expectReachable(control);
        }
    });

    test('in the modal, Enter and Space work on every button, and focus stays on the one pressed', async ({ page }, testInfo) => {
        await openFromSeries(page, P[1], testInfo, 'keyboard');
        const zoom = button(page, 'Zoom');
        await zoom.focus();
        await page.keyboard.press('Enter');
        await expect(zoom).toHaveAttribute('aria-pressed', 'true');
        await page.keyboard.press('Space');
        await expect(zoom).toHaveAttribute('aria-pressed', 'false');
        await expect(zoom).toBeFocused();

        const toggle = technical(page);
        await toggle.focus();
        await page.keyboard.press('Enter');
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await page.keyboard.press('Space');
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');

        const next = button(page, 'Next photograph');
        const previous = button(page, 'Previous photograph');
        await next.focus();
        await page.keyboard.press('Enter');
        await expectStill(page, P[2], 3);
        await expect(next).toBeFocused();
        await previous.focus();
        await page.keyboard.press('Space');
        await expectStill(page, P[1], 2);
        await expect(previous).toBeFocused();
        await page.keyboard.press('Enter');
        await expectStill(page, P[0], 1);
        await next.focus();
        await page.keyboard.press('Space');
        await expectStill(page, P[1], 2);
        await expect(next).toBeFocused();

        await button(page, 'Close').focus();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(`${origin()}/work/harbor`);
        await expect(entry(page, P[1])).toBeFocused();
        // Space closes it too, once.
        await openFromSeries(page, P[1], testInfo, 'keyboard');
        await button(page, 'Close').focus();
        await page.keyboard.press('Space');
        await expect(page).toHaveURL(`${origin()}/work/harbor`);
        await expect(page.locator('dialog')).toHaveCount(0);
        await expect(entry(page, P[1])).toBeFocused();
    });
});

/** Scrolled into view, the control is wholly inside the viewport, and a press at its center reaches it. */
async function expectReachable(control: Locator): Promise<void> {
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeInViewport({ ratio: 1 });
    const hit = await control.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return top !== null && (top === element || element.contains(top));
    });
    expect(hit, `${control} takes a press at its center`).toBe(true);
}
