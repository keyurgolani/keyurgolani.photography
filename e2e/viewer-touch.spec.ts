import type { Locator, Page, TestInfo } from '@playwright/test';
import { waitForHydration } from './support/hydration';
import { expectReflow } from './support/reflow';
import { checkSurface } from './support/surface';
import { expectMinTargetSize } from './support/targets';
import { expect, test } from './support/test';
import { centerOf, realTouches, touchDrag, twoFingerSpread } from './support/touch';
import { P, href, useViewerCatalog } from './support/viewerCatalog';

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

async function openFromSeries(page: Page, photoId: string, testInfo: TestInfo): Promise<void> {
    await page.goto(`${origin()}/work/harbor`);
    await waitForHydration(page);
    if (testInfo.project.use.hasTouch) await entry(page, photoId).tap();
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

/** A one-finger swipe across the middle of the photograph. */
async function swipe(page: Page, dx: number, { dy = 0, end = 'lift' as 'lift' | 'cancel', on = stage(page) } = {}): Promise<void> {
    const center = await centerOf(on);
    await touchDrag(page, { from: center, dx, dy, end });
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

    test('in the modal, a swipe moves too, and Close still puts focus back on the entry that opened it', async ({ page }, testInfo) => {
        await openFromSeries(page, P[0], testInfo);
        await swipe(page, -150);
        await expectStill(page, P[1], 2);
        await expect(dialog(page)).toHaveAccessibleName(/Photograph 2 of 3$/);
        expect(['viewer', 'body']).toContain(await focusPlace(page));
        await button(page, 'Close').tap();
        await expect(page).toHaveURL(`${origin()}/work/harbor`);
        await expect(page.locator('dialog')).toHaveCount(0);
        await expect(entry(page, P[0])).toBeFocused();
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
    });

    test('a cancelled touch never moves, and the next swipe does, so nothing is left stuck', async ({ page }) => {
        await openPage(page, P[1]);
        await swipe(page, -150, { end: 'cancel' });
        await expectStill(page, P[1], 2);
        await swipe(page, -150);
        await expectStill(page, P[2], 3);
    });

    test('two fingers, as in a pinch, never move, and the next one-finger swipe does', async ({ page }) => {
        await openPage(page, P[1]);
        await twoFingerSpread(page, { from: await centerOf(stage(page)) });
        await expectStill(page, P[1], 2);
        await expect(announcer(page)).toHaveText('');
        // A pinch may leave the page zoomed in; a fresh load starts at scale 1 for the swipe that proves nothing stuck.
        await openPage(page, P[1]);
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
        }
        await zoom.tap();
        await expect(zoom).toHaveAttribute('aria-pressed', 'false');
        await swipe(page, -150);
        await expectStill(page, P[2], 3);
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
        // Every frame from before the move until the new photograph shows: anything animating, and any transform on the stage.
        await page.evaluate(() => {
            const record = { animations: 0, transforms: [] as string[], running: true };
            (window as unknown as { kgMotion: typeof record }).kgMotion = record;
            const sample = () => {
                if (!record.running) return;
                record.animations = Math.max(record.animations, document.getAnimations().length);
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
            const record = (window as unknown as { kgMotion: { animations: number; transforms: string[]; running: boolean } }).kgMotion;
            record.running = false;
            return { animations: record.animations, transforms: record.transforms };
        });
        expect(motion).toEqual({ animations: 0, transforms: [] });
        const after = await stage(page).boundingBox();
        expect(after?.x).toBeCloseTo(before?.x ?? NaN, 0);
    });

    test('the modal passes the #1 checks, with 44 px targets, 3:1 boundaries on the ground, and controls that reflow at 200% text', async ({ page }, testInfo) => {
        await openFromSeries(page, P[1], testInfo);
        const controls = [button(page, 'Close'), button(page, 'Zoom'), button(page, 'Previous photograph'), button(page, 'Next photograph'), technical(page)];
        await checkSurface(page, { controls });
        // Rule 8: the boundaries and icons use the tokens styles/__tests__/surfaces.test.ts holds at 3:1 on the ground.
        // The pointer rests on the photograph, so no control shows its hover border.
        const rest = await centerOf(stage(page));
        await page.mouse.move(rest.x, rest.y);
        for (const control of controls) {
            const paint = await control.evaluate((element) => ({
                border: getComputedStyle(element).borderTopColor,
                icon: getComputedStyle(element.querySelector('svg') ?? element).color,
            }));
            expect(paint, `${control}`).toEqual({ border: 'rgba(255, 255, 255, 0.38)', icon: 'rgb(246, 244, 238)' });
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
            else await openFromSeries(page, P[1], testInfo);
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
        await openFromSeries(page, P[1], testInfo);
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
        await openFromSeries(page, P[1], testInfo);
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
