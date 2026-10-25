// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DOUBLE_TAP_DISTANCE, DOUBLE_TAP_IDLE, DOUBLE_TAP_INTERVAL, SETTLE, TAP_HOLD, TAP_SLOP, reduceDoubleTap, type DoubleTapInput, type DoubleTapState } from '../doubleTap';
import { SWIPE_DISTANCE } from '../swipe';

/** Runs inputs from idle and returns how many times they fired, and the state they left. */
function run(inputs: DoubleTapInput[], from: DoubleTapState = DOUBLE_TAP_IDLE) {
    let state = from;
    let fired = 0;
    for (const input of inputs) {
        const result = reduceDoubleTap(state, input);
        state = result.state;
        if (result.fire) fired += 1;
    }
    return { fired, state };
}

const down = (pointerId: number, x: number, y: number, t: number, { primary = true, eligible = true } = {}): DoubleTapInput => ({ type: 'down', pointerId, x, y, t, primary, eligible });
const up = (pointerId: number, x: number, y: number, t: number): DoubleTapInput => ({ type: 'up', pointerId, x, y, t });
const move = (pointerId: number, x: number, y: number): DoubleTapInput => ({ type: 'move', pointerId, x, y });

/** One tap: down at `t`, up `hold` ms later, `dx` across from where it went down. */
const tap = (pointerId: number, x: number, y: number, t: number, { hold = 50, dx = 0, eligible = true } = {}): DoubleTapInput[] => [
    down(pointerId, x, y, t, { eligible }),
    up(pointerId, x + dx, y, t + hold),
];

describe('reduceDoubleTap', () => {
    it('holds the thresholds: about 300 ms and about 24 px between the taps, a 10 px tap slop under the swipe\'s 48, and a 300 ms settle', () => {
        expect(DOUBLE_TAP_INTERVAL).toBe(300);
        expect(DOUBLE_TAP_DISTANCE).toBe(24);
        expect(TAP_SLOP).toBe(10);
        expect(TAP_HOLD).toBe(300);
        expect(SETTLE).toBe(300);
        expect(TAP_SLOP).toBeLessThan(SWIPE_DISTANCE);
    });

    it('fires once, at the second tap\'s lift, for two taps in the same place', () => {
        const first = run(tap(1, 200, 300, 1000));
        expect(first.fired).toBe(0);
        const second = run([down(2, 200, 300, 1150)], first.state);
        expect(second.fired).toBe(0);
        expect(run([up(2, 200, 300, 1200)], second.state).fired).toBe(1);
    });

    it.each([
        // The second tap goes down this many ms after the first tap's lift (at 1050).
        [DOUBLE_TAP_INTERVAL, 1],
        [DOUBLE_TAP_INTERVAL + 1, 0],
        [0, 1],
    ])('a second tap %d ms after the first lifts fires %d time(s)', (gap, expected) => {
        expect(run([...tap(1, 200, 300, 1000), ...tap(2, 200, 300, 1050 + gap)]).fired).toBe(expected);
    });

    it.each([
        // Where the second tap goes down, from the first's 200, 300.
        [200 + DOUBLE_TAP_DISTANCE, 300, 1],
        [200 + DOUBLE_TAP_DISTANCE + 0.1, 300, 0],
        // 24 px on the diagonal is about 17 across and 17 down: 16 and 16 is inside it, 17 and 18 past it.
        [216, 316, 1],
        [217, 318, 0],
        [200, 300 - DOUBLE_TAP_DISTANCE, 1],
        [200, 300 - DOUBLE_TAP_DISTANCE - 1, 0],
    ])('a second tap at %d, %d fires %d time(s)', (x, y, expected) => {
        expect(run([...tap(1, 200, 300, 1000), ...tap(2, x, y, 1150)]).fired).toBe(expected);
    });

    it.each([
        // How far a touch travels between going down and lifting.
        [TAP_SLOP - 0.1, 1],
        [TAP_SLOP, 0],
    ])('a touch that travels %d px is a tap only under the slop: fires %d time(s)', (dx, expected) => {
        expect(run([...tap(1, 200, 300, 1000, { dx }), ...tap(2, 200, 300, 1150)]).fired).toBe(expected);
        expect(run([...tap(1, 200, 300, 1000), ...tap(2, 200, 300, 1150, { dx })]).fired).toBe(expected);
    });

    it('counts the travel on the way, so a touch that goes out and comes back is no tap', () => {
        const outAndBack = [down(1, 200, 300, 1000), move(1, 205, 300), move(1, 230, 300), move(1, 201, 300), up(1, 200, 300, 1050)];
        expect(run([...outAndBack, ...tap(2, 200, 300, 1500)]).fired).toBe(0);
        // Moves under the slop are a tap still.
        const jitter = [down(1, 200, 300, 1000), move(1, 205, 304), move(1, 202, 301), up(1, 201, 300, 1050)];
        expect(run([...jitter, ...tap(2, 200, 300, 1150)]).fired).toBe(1);
    });

    it.each([
        [TAP_HOLD, 1],
        [TAP_HOLD + 1, 0],
    ])('a touch held %d ms is a tap only up to the hold: fires %d time(s)', (hold, expected) => {
        expect(run([...tap(1, 200, 300, 1000, { hold }), ...tap(2, 200, 300, 1000 + hold + 100)]).fired).toBe(expected);
        expect(run([...tap(1, 200, 300, 1000), ...tap(2, 200, 300, 1150, { hold })]).fired).toBe(expected);
    });

    it('starts afresh after it fires: a third tap is a first tap, and a fourth fires again', () => {
        expect(run([...tap(1, 200, 300, 1000), ...tap(2, 200, 300, 1150), ...tap(3, 200, 300, 1300)]).fired).toBe(1);
        expect(run([...tap(1, 200, 300, 1000), ...tap(2, 200, 300, 1150), ...tap(3, 200, 300, 1300), ...tap(4, 200, 300, 1450)]).fired).toBe(2);
    });

    it('lets a late second tap be the first of a new pair', () => {
        expect(run([...tap(1, 200, 300, 1000), ...tap(2, 200, 300, 2000), ...tap(3, 200, 300, 2150)]).fired).toBe(1);
        // And a far one too.
        expect(run([...tap(1, 200, 300, 1000), ...tap(2, 300, 300, 1150), ...tap(3, 300, 300, 1300)]).fired).toBe(1);
    });

    it('never fires for a tap off the photograph, or one that comes after it', () => {
        expect(run([...tap(1, 200, 300, 1000, { eligible: false }), ...tap(2, 200, 300, 1150)]).fired).toBe(0);
        expect(run([...tap(1, 200, 300, 1000), ...tap(2, 200, 300, 1150, { eligible: false })]).fired).toBe(0);
        // A tap on a control between the two drops the first.
        expect(run([...tap(1, 200, 300, 1000), ...tap(2, 20, 20, 1100, { eligible: false }), ...tap(3, 200, 300, 1200)]).fired).toBe(0);
    });

    describe('with the swipe', () => {
        it('never fires on a swipe, and a swipe drops a first tap', () => {
            // A swipe is a touch that travels 48 px or more, so it's never a tap.
            const swipe = (pointerId: number, t: number) => [down(pointerId, 200, 300, t), move(pointerId, 150, 300), up(pointerId, 200 - SWIPE_DISTANCE - 100, 300, t + 80)];
            expect(run([...swipe(1, 1000), ...swipe(2, 1100)]).fired).toBe(0);
            expect(run([...tap(1, 200, 300, 1000), ...swipe(2, 1100), ...tap(3, 200, 300, 1250)]).fired).toBe(0);
        });

        it.each([
            // A tap pair that starts this many ms after a swipe's lift.
            [SETTLE - 1, 0],
            [SETTLE, 1],
        ])('quiets taps for the settle after a swipe: a pair starting %d ms after the lift fires %d time(s)', (gap, expected) => {
            const swipe = [down(1, 200, 300, 1000), up(1, 50, 300, 1080)];
            expect(run([...swipe, ...tap(2, 200, 300, 1080 + gap), ...tap(3, 200, 300, 1080 + gap + 120)]).fired).toBe(expected);
        });

        it('never pairs a swipe\'s last tap-like lift with a tap: the second tap of a pair that ends in a drag is no tap', () => {
            expect(run([...tap(1, 200, 300, 1000), down(2, 200, 300, 1150), move(2, 260, 300), up(2, 100, 300, 1250)]).fired).toBe(0);
        });
    });

    describe('with scroll, pinch, and the zoomed pan', () => {
        it('drops a first tap on any scroll, and quiets taps for the settle after the last scroll event', () => {
            expect(run([...tap(1, 200, 300, 1000), { type: 'scroll', t: 1060 }, ...tap(2, 200, 300, 1100)]).fired).toBe(0);
            // A fling: scroll events every frame after the finger lifts. A tap to stop it and a second tap never zoom.
            const fling: DoubleTapInput[] = Array.from({ length: 20 }, (_, n) => ({ type: 'scroll', t: 1000 + n * 16 }));
            const last = 1000 + 19 * 16;
            expect(run([...fling, ...tap(1, 200, 300, last + 10), ...tap(2, 200, 300, last + 150)]).fired).toBe(0);
            expect(run([...fling, ...tap(1, 200, 300, last + SETTLE - 1), ...tap(2, 200, 300, last + SETTLE + 150)]).fired).toBe(0);
            expect(run([...fling, ...tap(1, 200, 300, last + SETTLE), ...tap(2, 200, 300, last + SETTLE + 150)]).fired).toBe(1);
        });

        it('drops a touch on a scroll while it\'s down, so a scroll under a still finger is no tap', () => {
            expect(run([...tap(1, 200, 300, 1000), down(2, 200, 300, 1100), { type: 'scroll', t: 1120 }, up(2, 200, 300, 1150)]).fired).toBe(0);
        });

        it('quiets taps after a cancel, the browser taking the touch for a scroll or a pinch', () => {
            const cancelled = [down(1, 200, 300, 1000), { type: 'cancel', pointerId: 1, t: 1040 } as DoubleTapInput];
            expect(run([...tap(1, 200, 300, 900), ...cancelled, ...tap(2, 200, 300, 1100)]).fired).toBe(0);
            expect(run([...cancelled, ...tap(2, 200, 300, 1040 + SETTLE - 1), ...tap(3, 200, 300, 1040 + SETTLE + 100)]).fired).toBe(0);
            expect(run([...cancelled, ...tap(2, 200, 300, 1040 + SETTLE), ...tap(3, 200, 300, 1040 + SETTLE + 100)]).fired).toBe(1);
            // A cancel of a pointer it doesn't follow changes nothing.
            expect(run([...tap(1, 200, 300, 1000), { type: 'cancel', pointerId: 9, t: 1080 }, ...tap(2, 200, 300, 1150)]).fired).toBe(1);
        });

        it('never fires on two fingers, and nothing starts until every finger is up', () => {
            // A pinch: two fingers down, both lift.
            const pinch = [down(1, 200, 300, 1000), down(2, 240, 300, 1010, { primary: false }), up(2, 240, 300, 1050), up(1, 200, 300, 1060)];
            expect(run([...pinch, ...pinch]).fired).toBe(0);
            // A first tap, then a second finger lands before the second tap lifts.
            expect(run([...tap(1, 200, 300, 1000), down(2, 200, 300, 1100), down(3, 260, 300, 1120, { primary: false }), up(2, 200, 300, 1150), up(3, 260, 300, 1160)]).fired).toBe(0);
            // A finger still down: the next touch isn't primary, so it can't start a pair.
            const held = run([down(1, 10, 10, 1000, { eligible: false })]);
            expect(run([...tap(2, 200, 300, 1100).map((input) => (input.type === 'down' ? { ...input, primary: false } : input)), down(3, 200, 300, 1250, { primary: false }), up(3, 200, 300, 1300)], held.state).fired).toBe(0);
        });

        it('lets a primary touch clear a finger the browser never reported lifting', () => {
            const stale = run([down(1, 10, 10, 1000)]).state;
            expect(stale.down).toEqual([1]);
            expect(run([...tap(2, 200, 300, 2000), ...tap(3, 200, 300, 2150)], stale).fired).toBe(1);
        });

        it('drops a first tap on a reset (a move by any route) and keeps the fingers it counts', () => {
            const first = run(tap(1, 200, 300, 1000));
            const reset = reduceDoubleTap(first.state, { type: 'reset' });
            expect(reset.fire).toBe(false);
            expect(reset.state.first).toBeNull();
            expect(run(tap(2, 200, 300, 1150), reset.state).fired).toBe(0);
            const held = run([down(1, 200, 300, 1000)]);
            expect(reduceDoubleTap(held.state, { type: 'reset' }).state.down).toEqual([1]);
        });
    });
});
