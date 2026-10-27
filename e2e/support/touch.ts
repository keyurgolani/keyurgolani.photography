import type { CDPSession, Locator, Page } from '@playwright/test';
import { waitForHydration } from './hydration';

/**
 * Contract rule 7: one tap activates, with no hover, long press, double tap,
 * or drag first. Taps the target once, which needs a hasTouch context, then
 * awaits `activated`, which should assert with web-first expects a state only
 * activation reaches. Chromium fires mouseover before the click on a tap, so
 * this can't catch a hover gate, only a first tap that does something other
 * than activate.
 */
export async function expectSingleTapActivates(target: Locator, activated: () => Promise<unknown>): Promise<void> {
    await waitForHydration(target.page());
    await target.tap();
    await activated();
}

export interface Point {
    x: number;
    y: number;
}

/**
 * One finger's path: from a point, by `dx` across and `dy` down, in `steps` moves, then lifted or cancelled. With
 * `duration`, the moves are spread over that many ms, and the lift comes right after the last, so the finger is still
 * going at the speed of the drag; without it they go as fast as the browser takes them, a flick.
 */
export interface Drag {
    from: Point;
    dx: number;
    dy?: number;
    steps?: number;
    end?: 'lift' | 'cancel';
    duration?: number;
}

/**
 * True where touches are real. Chromium takes them through CDP's
 * `Input.dispatchTouchEvent`, so its own touch-action, scrolling, pinch zoom,
 * and pointercancel all apply. Playwright sends WebKit only whole taps, so
 * there the same paths go as synthetic pointer events: they check the page's
 * own rule, but not the browser's gesture handling.
 */
export function realTouches(page: Page): boolean {
    return page.context().browser()?.browserType().name() === 'chromium';
}

/** The center of `target`'s box, in viewport CSS px. */
export async function centerOf(target: Locator): Promise<Point> {
    const box = await target.boundingBox();
    if (!box) throw new Error(`${target} has no box`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

interface Finger {
    id: number;
    from: Point;
    dx: number;
    dy: number;
}

/** Where each finger is after `step` of `steps`. */
const at = (fingers: readonly Finger[], step: number, steps: number) =>
    fingers.map(({ id, from, dx, dy }) => ({ id, x: from.x + (dx * step) / steps, y: from.y + (dy * step) / steps }));

/** Synthetic pointer events, for WebKit: each finger goes down where it starts and ends wherever it is last. */
async function pointerGesture(page: Page, fingers: readonly Finger[], steps: number, end: 'lift' | 'cancel', duration = 0): Promise<void> {
    const frames = Array.from({ length: steps + 1 }, (_, step) => at(fingers, step, steps));
    await page.evaluate(
        async ({ frames, end, pause }) => {
            const wait = () => (pause > 0 ? new Promise((resolve) => setTimeout(resolve, pause)) : undefined);
            const send = (type: string, { id, x, y }: { id: number; x: number; y: number }, primary: boolean, target?: Element) => {
                const element = target ?? document.elementFromPoint(x, y) ?? document.body;
                element.dispatchEvent(
                    new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: primary, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true }),
                );
                return element;
            };
            const first = frames[0];
            const targets = first.map((point, index) => send('pointerdown', point, index === 0));
            for (const frame of frames.slice(1)) {
                await wait();
                frame.forEach((point, index) => send('pointermove', point, index === 0, targets[index]));
            }
            const last = frames[frames.length - 1];
            // Fingers lift in reverse, the last to land first, as a pinch usually ends.
            for (let index = last.length - 1; index >= 0; index--) {
                send(end === 'cancel' ? 'pointercancel' : 'pointerup', last[index], index === 0, targets[index]);
            }
        },
        { frames, end, pause: duration / steps },
    );
}

/** Real touches through CDP, for Chromium. Every finger lands, they move together, and they lift in reverse. */
async function cdpGesture(page: Page, fingers: readonly Finger[], steps: number, end: 'lift' | 'cancel', duration = 0): Promise<void> {
    const cdp: CDPSession = await page.context().newCDPSession(page);
    try {
        const start = at(fingers, 0, steps);
        for (let count = 1; count <= start.length; count++) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: start.slice(0, count) });
        }
        for (let step = 1; step <= steps; step++) {
            if (duration > 0) await page.waitForTimeout(duration / steps);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(fingers, step, steps) });
        }
        if (end === 'cancel') {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
            return;
        }
        const last = at(fingers, steps, steps);
        for (let count = last.length - 1; count >= 0; count--) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: last.slice(0, count) });
        }
    } finally {
        await cdp.detach();
    }
}

/** One finger dragged along `drag`: real touches on Chromium, synthetic pointer events on WebKit (see realTouches). */
export async function touchDrag(page: Page, { from, dx, dy = 0, steps = 8, end = 'lift', duration = 0 }: Drag): Promise<void> {
    const fingers = [{ id: 1, from, dx, dy }];
    if (realTouches(page)) await cdpGesture(page, fingers, steps, end, duration);
    else await pointerGesture(page, fingers, steps, end, duration);
}

/**
 * A quick flick of one finger from `from` by `dx` across: real touches through CDP on Chromium, where the moves and the
 * lift go out together right after the touch lands, as a fast finger's do (headless Chromium otherwise paces each touch
 * a frame, about 33 ms, behind the last, slower than any flick), and synthetic pointer events spread over 24 ms on WebKit.
 */
export async function flick(page: Page, from: Point, dx: number): Promise<void> {
    if (!realTouches(page)) {
        await pointerGesture(page, [{ id: 1, from, dx, dy: 0 }], 2, 'lift', 24);
        return;
    }
    const cdp: CDPSession = await page.context().newCDPSession(page);
    try {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, ...from }] });
        await Promise.all([
            cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: from.x + dx / 2, y: from.y }] }),
            cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: from.x + dx, y: from.y }] }),
            cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
        ]);
    } finally {
        await cdp.detach();
    }
}

/**
 * A finger dragged `out` across, a move a frame at a time, then flicked `back` the other way and lifted at speed: a
 * drag thrown back. Its last steps out are nearly still, so the speed at the lift is the flick's (over the last 80 ms,
 * about 0.6 px/ms or more for 50 px back). Real touches on Chromium, where the flick's moves and
 * the lift go out together as in flick(); synthetic pointer events on WebKit.
 */
export async function dragThenFlick(page: Page, from: Point, out: number, back: number): Promise<void> {
    const path = [0.1, 0.33, 0.66, 0.985, 1].map((share) => from.x + out * share);
    if (!realTouches(page)) {
        await page.evaluate(
            async ({ from, path, out, back }) => {
                const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
                const target = document.elementFromPoint(from.x, from.y) ?? document.body;
                const send = (type: string, x: number) =>
                    target.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: from.y, bubbles: true, cancelable: true, composed: true }));
                send('pointerdown', from.x);
                for (const x of path) {
                    await pause(20);
                    send('pointermove', x);
                }
                await pause(50);
                send('pointermove', from.x + out + back / 2);
                await pause(8);
                send('pointermove', from.x + out + back);
                send('pointerup', from.x + out + back);
            },
            { from, path, out, back },
        );
        return;
    }
    const cdp: CDPSession = await page.context().newCDPSession(page);
    try {
        const point = (x: number) => [{ id: 1, x, y: from.y }];
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from.x) });
        for (const x of path) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x) });
        // Short of the 80 ms window, so the last step out is still in it: headless Chromium delivers the flick's moves a
        // frame later with one time, and the speed is read from that step to them.
        await page.waitForTimeout(16);
        await Promise.all([
            cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(from.x + out + back / 2) }),
            cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(from.x + out + back) }),
            cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
        ]);
    } finally {
        await cdp.detach();
    }
}

/** A finger held on the screen: moved to a point, then lifted or cancelled, with the page free to be read between. */
export interface HeldFinger {
    moveTo(point: Point): Promise<void>;
    lift(): Promise<void>;
    cancel(): Promise<void>;
}

/**
 * One finger down at `from`, held until the caller lifts it: real touches through CDP on Chromium, synthetic pointer
 * events on WebKit (see realTouches), where the moves go to the element the finger went down on, as a capture would.
 */
export async function holdFinger(page: Page, from: Point): Promise<HeldFinger> {
    let last = from;
    if (realTouches(page)) {
        const cdp: CDPSession = await page.context().newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, ...from }] });
        return {
            async moveTo(point) {
                last = point;
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, ...point }] });
            },
            async lift() {
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                await cdp.detach();
            },
            async cancel() {
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
                await cdp.detach();
            },
        };
    }
    const send = (type: string, point: Point) =>
        page.evaluate(
            ({ type, point }) => {
                const holder = window as unknown as { kgFinger?: Element };
                if (type === 'pointerdown') holder.kgFinger = document.elementFromPoint(point.x, point.y) ?? document.body;
                const target = holder.kgFinger ?? document.body;
                target.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: point.x, clientY: point.y, bubbles: true, cancelable: true, composed: true }));
            },
            { type, point },
        );
    await send('pointerdown', from);
    return {
        async moveTo(point) {
            last = point;
            await send('pointermove', point);
        },
        lift: () => send('pointerup', last),
        cancel: () => send('pointercancel', last),
    };
}

/** Two fingers that land at `from`, `gap` px apart across, and move apart by `spread` each, as a pinch out does. */
export async function twoFingerSpread(page: Page, { from, gap = 40, spread = 80, steps = 8 }: { from: Point; gap?: number; spread?: number; steps?: number }): Promise<void> {
    const fingers = [
        { id: 1, from: { x: from.x - gap / 2, y: from.y }, dx: -spread, dy: 0 },
        { id: 2, from: { x: from.x + gap / 2, y: from.y }, dx: spread, dy: 0 },
    ];
    if (realTouches(page)) await cdpGesture(page, fingers, steps, 'lift');
    else await pointerGesture(page, fingers, steps, 'lift');
}

/**
 * Two quick taps at `at`, `gap` ms apart from the first lift to the second touch: real touches on Chromium, synthetic
 * pointer events on WebKit (see realTouches), each held about 40 ms.
 */
export async function doubleTap(page: Page, at: Point, { gap = 80 }: { gap?: number } = {}): Promise<void> {
    if (!realTouches(page)) {
        await page.evaluate(
            async ({ at, gap }) => {
                const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
                const target = document.elementFromPoint(at.x, at.y) ?? document.body;
                const send = (type: string) =>
                    target.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, composed: true }));
                for (const index of [0, 1]) {
                    if (index > 0) await pause(gap);
                    send('pointerdown');
                    await pause(40);
                    send('pointerup');
                }
            },
            { at, gap },
        );
        return;
    }
    const cdp: CDPSession = await page.context().newCDPSession(page);
    try {
        for (let index = 0; index < 2; index++) {
            if (index > 0) await page.waitForTimeout(gap);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: at.x, y: at.y }] });
            await page.waitForTimeout(40);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        }
    } finally {
        await cdp.detach();
    }
}
