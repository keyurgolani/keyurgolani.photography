// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CLAIM_SLOP, PINCH_SCALE, SWIPE_DISTANCE, SWIPE_IDLE, SWIPE_RATIO, claimsTouch, isPinched, reduceSwipe, swipeStep, type SwipeInput, type SwipeState } from '../swipe';

/** Runs inputs from idle and returns the moves they asked for, and the state they left. */
function run(inputs: SwipeInput[], from: SwipeState = SWIPE_IDLE) {
    let state = from;
    const steps: string[] = [];
    for (const input of inputs) {
        const result = reduceSwipe(state, input);
        state = result.state;
        if (result.step !== null) steps.push(result.step);
    }
    return { steps, state };
}

const down = (pointerId: number, x: number, y: number, { primary = pointerId === 1, eligible = true } = {}): SwipeInput => ({
    type: 'down',
    pointerId,
    x,
    y,
    primary,
    eligible,
});
const up = (pointerId: number, x: number, y: number): SwipeInput => ({ type: 'up', pointerId, x, y });
const cancel = (pointerId: number): SwipeInput => ({ type: 'cancel', pointerId });

describe('swipeStep', () => {
    it('holds the approved thresholds: 48 CSS px across, at 1.25 times the vertical travel', () => {
        expect(SWIPE_DISTANCE).toBe(48);
        expect(SWIPE_RATIO).toBe(1.25);
    });

    it.each([
        [-48, 0, 'next'],
        [48, 0, 'previous'],
        [-47.9, 0, null],
        [47, 0, null],
        // At 48 across, 38.4 down is exactly 1.25 times, and a hair more fails.
        [-48, 38.4, 'next'],
        [-48, -38.4, 'next'],
        [48, 38.5, null],
        [-48, -39, null],
        [-200, 160, 'next'],
        [-200, 161, null],
        [0, 0, null],
        [0, 300, null],
        [-30, -500, null],
    ])('dx %d, dy %d asks for %s', (dx, dy, expected) => {
        expect(swipeStep(dx, dy)).toBe(expected);
    });
});

describe('claimsTouch', () => {
    it.each([
        // Under the slop the axis isn't settled yet, whichever way the finger has gone.
        [0, 0, null],
        [-9.9, 0, null],
        [0, 9.9, null],
        [7, -7, null],
        // Past it, more across than down is the Viewer's, as the browser's own pan test has it, and a tie isn't.
        [-10, 0, true],
        [10, 9.9, true],
        [30, -29, true],
        [0, 10, false],
        [10, 10, false],
        [-20, 21, false],
    ])('a touch %s across and %s down is claimed: %s', (dx, dy, expected) => {
        expect(CLAIM_SLOP).toBe(10);
        expect(claimsTouch(dx, dy)).toBe(expected);
    });
});

describe('isPinched', () => {
    it.each([
        [undefined, false],
        [1, false],
        [1.01, false],
        [1.011, true],
        [2, true],
    ])('scale %s is pinched: %s', (scale, expected) => {
        expect(PINCH_SCALE).toBe(1.01);
        expect(isPinched(scale)).toBe(expected);
    });
});

describe('reduceSwipe', () => {
    it('moves once the one finger lifts past the threshold, by its net travel only', () => {
        expect(run([down(1, 200, 300), up(1, 140, 310)]).steps).toEqual(['next']);
        expect(run([down(1, 200, 300), up(1, 260, 290)]).steps).toEqual(['previous']);
        // Out 60 px and back: the net travel is short, whatever the path.
        expect(run([down(1, 200, 300), up(1, 195, 300)]).steps).toEqual([]);
        expect(run([down(1, 200, 300), up(1, 160, 300)]).steps).toEqual([]);
    });

    it('ends the gesture at the lift, so a second lift asks for nothing', () => {
        const { steps, state } = run([down(1, 200, 300), up(1, 100, 300), up(1, 0, 300)]);
        expect(steps).toEqual(['next']);
        expect(state).toEqual(SWIPE_IDLE);
    });

    it('never moves on a vertical drag, which the browser takes as a scroll and cancels', () => {
        expect(run([down(1, 200, 300), up(1, 180, 100)]).steps).toEqual([]);
        expect(run([down(1, 200, 300), cancel(1), up(1, 100, 300)]).steps).toEqual([]);
    });

    it('never moves after a cancel or a lost capture, and lets the next touch start fresh', () => {
        const { steps, state } = run([down(1, 200, 300), cancel(1)]);
        expect(steps).toEqual([]);
        expect(state).toEqual(SWIPE_IDLE);
        expect(run([down(1, 200, 300), up(1, 100, 300)], state).steps).toEqual(['next']);
    });

    it('never moves when a start isn\'t on the unzoomed photograph', () => {
        expect(run([down(1, 200, 300, { eligible: false }), up(1, 100, 300)]).steps).toEqual([]);
    });

    it('ends the gesture on a second finger, and neither finger moves the Viewer as they lift (a pinch)', () => {
        const pinch = run([down(1, 200, 300), down(2, 220, 300), up(2, 400, 300), up(1, 50, 300)]);
        expect(pinch.steps).toEqual([]);
        expect(pinch.state).toEqual(SWIPE_IDLE);
        // In the other order too, and when the second finger lands on a control, outside the stage.
        expect(run([down(1, 200, 300), down(2, 220, 300), up(1, 50, 300), up(2, 400, 300)]).steps).toEqual([]);
        expect(run([down(1, 200, 300), down(2, 20, 30, { eligible: false }), up(1, 50, 300)]).steps).toEqual([]);
    });

    it('lets no finger start while another is down, even after the first lifts', () => {
        const { steps } = run([down(1, 200, 300, { eligible: false }), down(2, 200, 300), up(1, 0, 0), up(2, 100, 300)]);
        expect(steps).toEqual([]);
    });

    it('drops the gesture on a reset (a move by another route, Zoom, unmount), but keeps count of the fingers down', () => {
        const { steps, state } = run([down(1, 200, 300), { type: 'reset' }, up(1, 100, 300)]);
        expect(steps).toEqual([]);
        expect(state).toEqual(SWIPE_IDLE);
        const held = run([down(1, 200, 300), { type: 'reset' }]).state;
        expect(held).toEqual({ down: [1], start: null });
        // The finger still down blocks a second one.
        expect(run([down(2, 200, 300, { primary: false }), up(2, 100, 300)], held).steps).toEqual([]);
    });

    it('takes a primary pointer as the only one down, so a lift the browser never sent can\'t block every later swipe', () => {
        const stale: SwipeState = { down: [7, 8], start: null };
        expect(run([down(1, 200, 300), up(1, 100, 300)], stale).steps).toEqual(['next']);
        expect(run([down(9, 200, 300, { primary: false }), up(9, 100, 300)], stale).steps).toEqual([]);
    });

    it('counts a repeated down for the same pointer once', () => {
        const { state } = run([down(1, 200, 300), down(1, 210, 300, { primary: false })]);
        expect(state.down).toEqual([1]);
        expect(state.start).toEqual({ pointerId: 1, x: 210, y: 300 });
    });

    it('ignores a lift or cancel from a pointer it never followed', () => {
        const from = run([down(1, 200, 300)]).state;
        expect(run([up(5, 0, 0), cancel(6), up(1, 100, 300)], from).steps).toEqual(['next']);
    });
});
