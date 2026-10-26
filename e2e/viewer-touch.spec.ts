import type { Locator, Page, TestInfo } from '@playwright/test';
import { waitForHydration } from './support/hydration';
import { expectReflow } from './support/reflow';
import { checkSurface } from './support/surface';
import { expectMinTargetSize } from './support/targets';
import { expect, test } from './support/test';
import { centerOf, doubleTap, dragThenFlick, flick, holdFinger, realTouches, touchDrag, twoFingerSpread } from './support/touch';
import { LONG_CAPTION, P, SHAPES, SHAPES_TITLE, href, useViewerCatalog } from './support/viewerCatalog';
import { SETTLE } from '../components/viewer/doubleTap';
import { CLAIM_SLOP, PEEK_GAP, SETTLE_SLOW, rubberBand } from '../components/viewer/swipe';

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

/** A one-finger swipe across the middle of the photograph: a flick, unless `duration` spreads its moves out. */
async function swipe(page: Page, dx: number, { dy = 0, end = 'lift' as 'lift' | 'cancel', on = stage(page), duration = 0 } = {}): Promise<void> {
    const center = await centerOf(on);
    await touchDrag(page, { from: center, dx, dy, end, duration });
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

/**
 * Holds every request for the Viewer pages of `photoIds` (the RSC payload of a move or of the idle prefetch) for `ms`,
 * so a move is still on its way when the test acts. Call it before the page loads, so the prefetch is held too.
 * Returns how many it has held.
 */
async function holdPages(page: Page, photoIds: readonly string[], ms = 1500): Promise<() => number> {
    let held = 0;
    const paths = new Set(photoIds.map((photoId) => href(photoId)));
    await page.route(
        (url) => paths.has(url.pathname),
        async (route) => {
            if (route.request().resourceType() === 'document') return route.fallback();
            held += 1;
            await new Promise((resolve) => setTimeout(resolve, ms));
            await route.fallback();
        },
    );
    return () => held;
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
        // Photograph 2's payload takes a second and a half, the idle prefetch's too, so Close comes while the move is
        // still in flight.
        const held = await holdPages(page, [P[1]]);
        await openFromSeries(page, P[0], testInfo);
        await swipe(page, -150);
        await expect.poll(held, 'the move asked for photograph 2').toBeGreaterThan(0);
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
        // Slow drags, 40 px over 400 ms, so neither is a flick (9a).
        await swipe(page, -40, { duration: 400 });
        await swipe(page, 40, { duration: 400 });
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

test.describe('the photograph follows the finger (9a)', () => {
    test.beforeEach(() => runsOn(test.info(), 'mobile', 'mobile-webkit'));

    const track = (page: Page) => stage(page).locator('[data-viewer-track]');
    /** How far across the photograph's strip sits from its rest, in CSS px. */
    const offset = (page: Page) =>
        track(page).evaluate((element) => {
            const transform = getComputedStyle(element).transform;
            return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m41;
        });
    const atRest = (page: Page) => expect.poll(() => track(page).evaluate((element) => getComputedStyle(element).transform), { message: 'the photograph is back at rest' }).toBe('none');
    /** Wait until a finger's touch has the neighbors on hand: a first touch asks for them. */
    const peeksIn = async (page: Page, count: number) => expect(stage(page).locator('[data-viewer-peek]')).toHaveCount(count);

    test('the photograph tracks the finger 1:1 from the claim, the next one peeks in 16 px behind it, and nothing else moves', async ({ page }) => {
        await openPage(page, P[1]);
        const from = await centerOf(stage(page));
        const before = { header: await header(page).boundingBox(), reading: await viewer(page).locator('[data-viewer-reading]').boundingBox() };
        const finger = await holdFinger(page, from);
        await peeksIn(page, 2);
        // Past the claim, then on: the photograph moves with the finger from where it was claimed, with no jump.
        await finger.moveTo({ x: from.x - CLAIM_SLOP - 2, y: from.y });
        await finger.moveTo({ x: from.x - 102, y: from.y + 3 });
        await expect.poll(() => offset(page)).toBeCloseTo(-90, 0);
        const slot = await track(page).boundingBox();
        const next = await stage(page).locator('[data-viewer-peek="next"]').boundingBox();
        expect(next && slot && next.x - (slot.x + slot.width), 'the gap the next photograph peeks in behind').toBeCloseTo(PEEK_GAP, 0);
        await expect(stage(page).locator('[data-viewer-peek="next"] img')).toBeVisible();
        // The header, the counter, and the reading area stay put while it's held.
        expect(await header(page).boundingBox()).toEqual(before.header);
        expect(await viewer(page).locator('[data-viewer-reading]').boundingBox()).toEqual(before.reading);
        await expect(header(page)).toContainText('02 / 03');
        // Back to 40 px, short of the rule, and lifted there: it slides back, and nothing changes.
        await finger.moveTo({ x: from.x - 40, y: from.y + 3 });
        await page.waitForTimeout(120);
        await finger.lift();
        await atRest(page);
        await expectStill(page, P[1], 2);
        await expect(announcer(page)).toHaveText('');
    });

    test('a short fast flick moves, and a short slow drag springs back', async ({ page }) => {
        await openPage(page, P[0]);
        // 36 px over 400 ms: under 48, and slow, so it springs back.
        await swipe(page, -36, { duration: 400 });
        await atRest(page);
        await expectStill(page, P[0], 1);
        // 32 px, quickly: a flick.
        await flick(page, await centerOf(stage(page)), -32);
        await expectStill(page, P[1], 2);
        await flick(page, await centerOf(stage(page)), 32);
        await expectStill(page, P[0], 1);
        await atRest(page);
    });

    test('a swipe settles onward with no overshoot, inside the settle time, and lands at rest on the new photograph', async ({ page }) => {
        await openPage(page, P[0]);
        const from = await centerOf(stage(page));
        const finger = await holdFinger(page, from);
        await peeksIn(page, 1);
        for (const dx of [-12, -40, -80, -120]) await finger.moveTo({ x: from.x + dx, y: from.y });
        const stageBox = await stage(page).boundingBox();
        // Every frame from the lift until it's at rest: where the arriving photograph's slot sits across, on the track
        // that shows it (the peek before its page arrives, the track itself after).
        await page.evaluate((arriving) => {
            const record = { lefts: [] as number[], times: [] as number[], start: performance.now(), running: true };
            (window as unknown as { kgSettle: typeof record }).kgSettle = record;
            const sample = () => {
                if (!record.running) return;
                const arrived = document.querySelector('[data-viewer-photo]')?.getAttribute('data-viewer-photo') === arriving;
                const slot = document.querySelector(arrived ? '[data-viewer-track]' : '[data-viewer-peek="next"]');
                const box = slot?.getBoundingClientRect();
                if (box) {
                    record.lefts.push(box.left);
                    record.times.push(performance.now() - record.start);
                }
                requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
        }, P[1]);
        await finger.lift();
        await expectStill(page, P[1], 2);
        await atRest(page);
        const { lefts, times } = await page.evaluate(() => {
            const record = (window as unknown as { kgSettle: { lefts: number[]; times: number[]; running: boolean } }).kgSettle;
            record.running = false;
            return record;
        });
        const restLeft = stageBox!.x + (await stage(page).evaluate((element) => parseFloat(getComputedStyle(element).paddingLeft)));
        // It only ever goes one way, toward its rest, and never past it.
        for (let index = 1; index < lefts.length; index++) expect(lefts[index], `frame ${index} at ${Math.round(times[index])} ms`).toBeLessThanOrEqual(lefts[index - 1] + 0.5);
        for (const left of lefts) expect(left).toBeGreaterThanOrEqual(restLeft - 0.5);
        // At rest within the settle and a few frames of slack for the test's own sampling.
        const landed = times[lefts.findIndex((left) => Math.abs(left - restLeft) < 0.5)];
        expect(landed, 'the settle landed').toBeLessThanOrEqual(SETTLE_SLOW + 120);
    });

    test('at the first photograph the pull meets the rubber band, announces the end, and slides back', async ({ page }) => {
        await openPage(page, P[0]);
        const from = await centerOf(stage(page));
        const width = await track(page).evaluate((element) => element.clientWidth);
        const finger = await holdFinger(page, from);
        await finger.moveTo({ x: from.x + 10, y: from.y });
        await finger.moveTo({ x: from.x + 180, y: from.y });
        // 170 px past the claim gives the rubber band's share.
        await expect.poll(() => offset(page)).toBeCloseTo(rubberBand(170, width), 0);
        expect(await offset(page)).toBeLessThan(100);
        await page.waitForTimeout(120);
        await finger.lift();
        await expect(announcer(page)).toHaveText('First photograph in Fixture harbor.');
        await atRest(page);
        await expectStill(page, P[0], 1);
    });

    test('a mostly vertical drag never moves the photograph', async ({ page }) => {
        const size = page.viewportSize();
        if (size) await page.setViewportSize({ width: size.width, height: 400 });
        await openPage(page, P[0]);
        const from = await centerOf(stage(page));
        const finger = await holdFinger(page, from);
        await finger.moveTo({ x: from.x - 4, y: from.y - 20 });
        await finger.moveTo({ x: from.x - 30, y: from.y - 120 });
        expect(await offset(page)).toBe(0);
        await finger.lift();
        await expectStill(page, P[0], 1);
        if (realTouches(page)) await expect.poll(() => page.evaluate(() => window.scrollY), 'the drag scrolled the page').toBeGreaterThan(0);
    });

    test('a drag past 48 px flicked back the other way cancels and slides back, as a paging view does', async ({ page }) => {
        await openPage(page, P[1]);
        await dragThenFlick(page, await centerOf(stage(page)), -120, 50);
        await atRest(page);
        await expectStill(page, P[1], 2);
        await expect(announcer(page)).toHaveText('');
        // The same drag let go at rest moves.
        await swipe(page, -70, { duration: 300 });
        await expectStill(page, P[2], 3);
    });

    test('a finger that catches the slide back at an end holds the photograph where it caught it, with no jump', async ({ page }) => {
        await openPage(page, P[0]);
        const from = await centerOf(stage(page));
        const pull = await holdFinger(page, from);
        await pull.moveTo({ x: from.x + 10, y: from.y });
        await pull.moveTo({ x: from.x + 180, y: from.y });
        await expect.poll(() => offset(page)).toBeGreaterThan(60);
        await page.waitForTimeout(120);
        await pull.lift();
        // Caught early in the slide back, while it's still well out.
        await page.waitForTimeout(30);
        const caught = await holdFinger(page, from);
        const held = await offset(page);
        expect(held, 'caught out past the end').toBeGreaterThan(20);
        await caught.moveTo({ x: from.x + 12, y: from.y });
        // At the claim the photograph is where the finger caught it, not pulled back through the band a second time.
        expect(Math.abs((await offset(page)) - held), `caught at ${held.toFixed(1)}`).toBeLessThan(3);
        await caught.moveTo({ x: from.x + 40, y: from.y });
        const further = await offset(page);
        expect(further).toBeGreaterThan(held);
        expect(further - held, 'the band still gives less than the finger').toBeLessThan(28);
        await page.waitForTimeout(120);
        await caught.lift();
        await atRest(page);
        await expectStill(page, P[0], 1);
    });

    test('a second finger mid-drag slides the photograph back and nothing moves, with both still down', async ({ page }) => {
        test.skip(!realTouches(page), 'Two real touches, through CDP.');
        await openPage(page, P[1]);
        const from = await centerOf(stage(page));
        const cdp = await page.context().newCDPSession(page);
        const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', touchPoints: { id: number; x: number; y: number }[]) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
        try {
            await send('touchStart', [{ id: 1, ...from }]);
            for (const dx of [-12, -40, -86]) await send('touchMove', [{ id: 1, x: from.x + dx, y: from.y }]);
            await expect.poll(() => offset(page)).toBeLessThan(-60);
            await send('touchStart', [
                { id: 1, x: from.x - 86, y: from.y },
                { id: 2, x: from.x + 40, y: from.y + 30 },
            ]);
            // Both fingers still down: the photograph is already on its way back to rest, and stays there.
            await atRest(page);
            await expect(track(page)).not.toHaveAttribute('data-moving');
            await send('touchMove', [
                { id: 1, x: from.x - 120, y: from.y },
                { id: 2, x: from.x + 60, y: from.y + 30 },
            ]);
            expect(await offset(page)).toBe(0);
            await send('touchEnd', [{ id: 1, x: from.x - 120, y: from.y }]);
            await send('touchEnd', []);
        } finally {
            await cdp.detach();
        }
        await page.waitForTimeout(400);
        expect(await offset(page)).toBe(0);
        await expectStill(page, P[1], 2);
    });

    test('while a move by a key or Next is on its way, a swipe the other way neither follows nor settles, and the page lands where the move went', async ({ page }) => {
        // Long enough that the page is still on its way after the swipe's lift.
        await holdPages(page, [P[0], P[1], P[2]], 3000);
        for (const press of ['key', 'tap'] as const) {
            await openPage(page, P[0]);
            if (press === 'key') await page.keyboard.press('ArrowRight');
            else await button(page, 'Next photograph').tap();
            await expect(header(page)).toContainText('02 / 03');
            // A quick swipe back, as after a tap on Next.
            const from = await centerOf(stage(page));
            const finger = await holdFinger(page, from);
            await finger.moveTo({ x: from.x + 14, y: from.y });
            await finger.moveTo({ x: from.x + 120, y: from.y });
            expect(await offset(page), `${press}: no follow`).toBe(0);
            await finger.lift();
            await page.waitForTimeout(300);
            // Still on its way: the swipe settled nothing, either way.
            expect(new URL(page.url()).pathname, `${press}: still on its way`).toBe(href(P[0]));
            expect(await offset(page), `${press}: no settle`).toBe(0);
            await expect(track(page)).not.toHaveAttribute('data-moving');
            await expect(header(page)).toContainText('02 / 03');
            // Both the idle prefetch and the move's own request are held, so give it their time.
            await expect(page).toHaveURL(`${origin()}${href(P[1])}`, { timeout: 10_000 });
            await expectStill(page, P[1], 2);
            await atRest(page);
        }
    });

    test('on a slow page the old words stay, whole, until the new photograph arrives, and are never blank', async ({ page }) => {
        const held = await holdPages(page, [P[1]]);
        await openPage(page, P[0]);
        const reading = viewer(page).locator('[data-viewer-reading]');
        await expect(reading.getByRole('heading', { name: 'Fixture harbor at dusk' })).toBeVisible();
        await flick(page, await centerOf(stage(page)), -60);
        await expect.poll(held, 'the move asked for photograph 2').toBeGreaterThan(0);
        // On its way: the counter shows the move, and the words under the photograph are the old ones at full opacity.
        await expect(header(page)).toContainText('02 / 03');
        for (let look = 0; look < 5; look++) {
            const words = await reading.evaluate((element) => ({
                text: element.querySelector('h2')?.textContent,
                opacity: Math.min(...[...element.children].map((child) => Number(getComputedStyle(child).opacity))),
            }));
            expect(words, `look ${look}`).toEqual({ text: 'Fixture harbor at dusk', opacity: 1 });
            await page.waitForTimeout(150);
        }
        // Then it lands, and the new words are in.
        await expectStill(page, P[1], 2);
        await expect(reading.getByRole('heading', { name: 'Fixture harbor at dusk' })).toHaveCount(0);
        await expect.poll(() => reading.evaluate((element) => Math.min(...[...element.children].map((child) => Number(getComputedStyle(child).opacity))))).toBe(1);
        await expect(viewer(page).locator('[data-viewer-leaving]')).toBeEmpty();
    });

    test('under reduced motion the photograph stays still under the finger and the move is a cut at the lift', async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await openPage(page, P[1]);
        const from = await centerOf(stage(page));
        const finger = await holdFinger(page, from);
        await finger.moveTo({ x: from.x - 20, y: from.y });
        await finger.moveTo({ x: from.x - 120, y: from.y });
        expect(await offset(page)).toBe(0);
        await expect(stage(page).locator('[data-viewer-peek]')).toHaveCount(0);
        await finger.lift();
        await expectStill(page, P[2], 3);
        expect(await offset(page)).toBe(0);
    });
});

test.describe('the fixed stage (9a)', () => {
    test.beforeEach(() => runsOn(test.info(), 'desktop', 'mobile'));

    /** The stage, the track, the photograph, and the reading area, in page coordinates. */
    const measure = (page: Page) =>
        viewer(page).evaluate((root) => {
            const rect = (element: Element | null) => {
                const box = element?.getBoundingClientRect();
                return box ? { x: box.x, y: box.y + window.scrollY, width: box.width, height: box.height } : null;
            };
            return {
                stage: rect(root.querySelector('[data-viewer-stage]')),
                track: rect(root.querySelector('[data-viewer-track]')),
                frame: rect(root.querySelector('[data-viewer-current]')),
                reading: rect(root.querySelector('[data-viewer-reading]')),
                // A wide screen keeps the photograph to four fifths of the viewport's width (fitSizes).
                widest: window.innerWidth >= 768 ? window.innerWidth * 0.8 : window.innerWidth,
            };
        });

    for (const size of [
        { width: 1440, height: 900, project: 'desktop' },
        { width: 1280, height: 800, project: 'desktop' },
        { width: 390, height: 844, project: 'mobile' },
    ]) {
        test(`at ${size.width} by ${size.height}, a wide photo with no copy, a tall one with a title alone, and a 3:2 with a long caption fit and center in one stage, with the reading area put`, async ({ page }, testInfo) => {
            test.skip(testInfo.project.name !== size.project, `The ${size.project} layout.`);
            await page.setViewportSize(size);
            const boxes: { stage: unknown; reading: number; frame: { x: number; y: number; width: number; height: number } }[] = [];
            for (const photoId of SHAPES) {
                await page.goto(`${origin()}${href(photoId, 'shapes')}`);
                await waitForHydration(page);
                const { stage: stageBox, track, frame, reading, widest } = await measure(page);
                expect(stageBox && track && frame && reading, photoId).toBeTruthy();
                // Aspect-fit: the whole photograph inside its slot, as large as the slot and the width cap let its shape be,
                // and centered both ways.
                const ratio = frame!.width / frame!.height;
                expect(frame!.width, `${photoId} fits its slot`).toBeCloseTo(Math.min(track!.width, widest, track!.height * ratio), 0);
                expect(frame!.height).toBeLessThanOrEqual(track!.height + 0.5);
                expect(frame!.x - track!.x).toBeCloseTo(track!.x + track!.width - (frame!.x + frame!.width), 0);
                expect(frame!.y - track!.y).toBeCloseTo(track!.y + track!.height - (frame!.y + frame!.height), 0);
                boxes.push({ stage: stageBox, reading: reading!.y, frame: frame! });
            }
            // The same stage and the same reading area for all three, whatever they hold.
            for (const box of boxes.slice(1)) {
                expect(box.stage).toEqual(boxes[0].stage);
                expect(box.reading).toBeCloseTo(boxes[0].reading, 1);
            }
            // And they really differ: wide, tall, 3:2, and no copy, a title, a long caption.
            const ratios = boxes.map(({ frame }) => frame.width / frame.height);
            expect(ratios[0]).toBeCloseTo(3, 1);
            expect(ratios[1]).toBeCloseTo(2 / 3, 1);
            expect(ratios[2]).toBeCloseTo(1.5, 1);
            const reading = viewer(page).locator('[data-viewer-reading]');
            await expect(reading).toContainText(LONG_CAPTION);
            expect(await reading.evaluate((element) => element.querySelector('p')!.getBoundingClientRect().height)).toBeGreaterThan(60);
        });
    }

    test('moving from a long reading area to a short one, the arriving photograph never jumps at the swap', async ({ page }, testInfo) => {
        await page.setViewportSize(testInfo.project.name === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 });
        await page.goto(`${origin()}${href(SHAPES[2], 'shapes')}`);
        await waitForHydration(page);
        const before = await measure(page);
        // Every frame from the move until it's at rest: where the arriving photograph sits down the page and how tall it
        // is, as the neighbor that peeks in before its page arrives and as the photograph after.
        const record = () =>
            page.evaluate((arriving) => {
                const log: { y: number; height: number; arrived: boolean }[] = [];
                (window as unknown as { kgSwap: { log: typeof log; running: boolean } }).kgSwap = { log, running: true };
                const sample = () => {
                    const state = (window as unknown as { kgSwap: { running: boolean } }).kgSwap;
                    if (!state.running) return;
                    const arrived = document.querySelector('[data-viewer-photo]')?.getAttribute('data-viewer-photo') === arriving;
                    const frame = document.querySelector(arrived ? '[data-viewer-current]' : '[data-viewer-peek="previous"] > *');
                    const box = frame?.getBoundingClientRect();
                    if (box) log.push({ y: box.y + window.scrollY, height: box.height, arrived });
                    requestAnimationFrame(sample);
                };
                requestAnimationFrame(sample);
            }, SHAPES[1]);
        if (testInfo.project.use.hasTouch) {
            // A swipe toward the right, with the tall photograph peeking in, on a phone.
            const from = await centerOf(stage(page));
            const finger = await holdFinger(page, from);
            await expect(stage(page).locator('[data-viewer-peek]')).toHaveCount(1);
            await finger.moveTo({ x: from.x + 20, y: from.y });
            await finger.moveTo({ x: from.x + 140, y: from.y });
            await record();
            await finger.lift();
        } else {
            // The arrow key, at 1440.
            await record();
            await page.keyboard.press('ArrowLeft');
        }
        await expect(page).toHaveURL(`${origin()}${href(SHAPES[1], 'shapes')}`);
        await expect.poll(() => stage(page).locator('[data-viewer-track]').evaluate((element) => getComputedStyle(element).transform)).toBe('none');
        const log = await page.evaluate(() => {
            const state = (window as unknown as { kgSwap: { log: { y: number; height: number; arrived: boolean }[]; running: boolean } }).kgSwap;
            state.running = false;
            return state.log;
        });
        const after = await measure(page);
        expect(log.some((entry) => entry.arrived), 'frames after the page arrived').toBe(true);
        for (const entry of log) {
            expect(entry.y, `${entry.arrived ? 'arrived' : 'peeking'} at ${entry.y}`).toBeCloseTo(after.frame!.y, 0);
            expect(entry.height).toBeCloseTo(after.frame!.height, 0);
        }
        // The stage and the reading area stayed put across the move.
        expect(after.stage).toEqual(before.stage);
        expect(after.reading!.y).toBeCloseTo(before.reading!.y, 1);
    });

    test('on a phone, a long series title stays on one line between Close and Zoom, whole for screen readers', async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== 'mobile', 'The narrow header.');
        for (const width of [390, 360]) {
            await page.setViewportSize({ width, height: 800 });
            await page.goto(`${origin()}${href(SHAPES[0], 'shapes')}`);
            await waitForHydration(page);
            const title = header(page).getByRole('heading', { level: 1 });
            await expect(title).toHaveText(SHAPES_TITLE);
            await expect(title).toHaveAccessibleName(SHAPES_TITLE);
            const line = await title.evaluate((element) => ({
                height: element.getBoundingClientRect().height,
                lineHeight: parseFloat(getComputedStyle(element).lineHeight),
                cut: element.scrollWidth > element.clientWidth,
                overflow: getComputedStyle(element).textOverflow,
            }));
            expect(line.height, `${width}: one line`).toBeLessThan(line.lineHeight * 1.5);
            expect(line, `${width}: cut with an ellipsis`).toMatchObject({ cut: true, overflow: 'ellipsis' });
            // The header keeps its row, and Close and Zoom stay whole and on screen beside it.
            // One row: the 44 px controls, the padding, and the accent rule. A second row would add another 44.
            expect((await header(page).boundingBox())!.height, `${width}: the header's height`).toBeLessThanOrEqual(60.5);
            for (const name of ['Close', 'Zoom']) {
                const control = header(page).getByRole(name === 'Close' ? 'link' : 'button', { name });
                const box = (await control.boundingBox())!;
                expect(box.x).toBeGreaterThanOrEqual(0);
                expect(box.x + box.width).toBeLessThanOrEqual(width);
            }
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        }
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

    test('on a tall photograph, a double-tap near its top or its bottom keeps that place under the finger down the photograph too', async ({ page }) => {
        // The one-photo series' photograph is 2:3, so zoomed it's taller than its box on a phone and scrolls both ways.
        // Since 9a its fitted box fits the phone's stage above the reading area, a little smaller than the zoomed box's
        // height, so the place near the bottom is 70% down: at 80% the scroll would need to go past its end.
        for (const [where, share] of [
            ['top', 0.2],
            ['bottom', 0.7],
        ] as const) {
            await page.goto(`${origin()}${href(P[3], 'ridge')}`);
            await waitForHydration(page);
            await expect(header(page).getByRole('heading', { level: 1 })).toHaveText('Fixture ridge');
            await settled(page);
            const frame = stage(page).locator('figure');
            const fitted = await frame.boundingBox();
            expect(fitted, 'the fitted photograph').not.toBeNull();
            const at = { x: fitted!.x + fitted!.width / 2, y: fitted!.y + fitted!.height * share };
            await doubleTap(page, at);
            await expect(button(page, 'Zoom')).toHaveAttribute('aria-pressed', 'true');
            const region = viewer(page).getByRole('region', { name: 'Zoomed photograph' });
            const scroll = () => region.evaluate((element) => ({ top: element.scrollTop, range: element.scrollHeight - element.clientHeight }));
            await expect.poll(async () => (await scroll()).range, 'the zoomed photograph is taller than its box').toBeGreaterThan(0);
            // Scrolled down to the place, and short of either end, so no clamp did the work.
            await expect.poll(async () => (await scroll()).top, `near the ${where}, the zoomed photograph scrolled down to the place`).toBeGreaterThan(0);
            const { top, range } = await scroll();
            expect(top, `near the ${where}, the scroll stops short of the end`).toBeLessThan(range);
            const zoomed = await frame.boundingBox();
            expect(zoomed!.height, 'zoomed in').toBeGreaterThan(fitted!.height);
            expect((at.y - zoomed!.y) / zoomed!.height, `near the ${where}, the same place down sits under the finger`).toBeCloseTo(share, 2);
            expect((at.x - zoomed!.x) / zoomed!.width, 'and the same place across').toBeCloseTo(0.5, 2);
        }
    });

    test('a double-tap that zooms out where Previous or Next sit unzoomed presses neither, and the Viewer stays', async ({ page }) => {
        // Zoomed out, the stage shrinks, and the second tap's click would land on whatever now sits under the finger.
        // Only real touches make that click, so this runs on Chromium; WebKit's synthetic taps make none.
        runsOn(test.info(), 'mobile');
        // The tall photograph between two others: zoomed, it's taller than the fixed stage (9a), so the stage grows over
        // the arrows' row. A 3:2 one zoomed is shorter than the stage, which then keeps its height and covers nothing.
        await page.goto(`${origin()}${href(SHAPES[1], 'shapes')}`);
        await waitForHydration(page);
        await expect(header(page)).toContainText('02 / 03');
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
            await expect(page).toHaveURL(`${origin()}${href(SHAPES[1], 'shapes')}`);
            await expect(header(page)).toContainText('02 / 03');
            await expect(announcer(page)).toHaveText('');
            await settled(page);
        }
    });

    test('Zoom never shrinks the phone\'s stage, so the arrows and the reading area never move up under a finger', async ({ page }) => {
        runsOn(test.info(), 'mobile');
        // A 3:2 photograph, whose zoomed box is shorter than the fixed stage.
        await openPage(page, P[1]);
        const before = { next: await button(page, 'Next photograph').boundingBox(), stage: await stage(page).boundingBox() };
        await button(page, 'Zoom').tap();
        await expect(button(page, 'Zoom')).toHaveAttribute('aria-pressed', 'true');
        const after = { next: await button(page, 'Next photograph').boundingBox(), stage: await stage(page).boundingBox() };
        expect(after.stage!.height).toBeGreaterThanOrEqual(before.stage!.height - 0.5);
        expect(after.next!.y).toBeGreaterThanOrEqual(before.next!.y - 0.5);
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
