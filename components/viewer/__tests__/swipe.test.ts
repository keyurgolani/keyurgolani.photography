// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
    CLAIM_SLOP,
    CONTROL_SLOPE,
    FLICK_DISTANCE,
    FLICK_SPEED,
    PEEK_GAP,
    PINCH_SCALE,
    RETURN_SLOW,
    RUBBER_BAND,
    SETTLE_FAST,
    SETTLE_SLOW,
    SWIPE_DISTANCE,
    SWIPE_IDLE,
    SWIPE_RATIO,
    POINTER_STOPPED,
    VELOCITY_WINDOW,
    caughtBase,
    claimsTouch,
    followOffset,
    followTravel,
    isPinched,
    keepSamples,
    liftVelocity,
    reduceSwipe,
    releaseVelocity,
    rubberBand,
    settleOf,
    swipeStep,
    unbandedPull,
    type Sample,
    type SwipeInput,
    type SwipeState,
} from '../swipe';

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
        expect(state.start).toEqual({ pointerId: 1, x: 210, y: 300, samples: [], claimedAt: null, vertical: false, moved: false });
    });

    it('ignores a lift or cancel from a pointer it never followed', () => {
        const from = run([down(1, 200, 300)]).state;
        expect(run([up(5, 0, 0), cancel(6), up(1, 100, 300)], from).steps).toEqual(['next']);
    });
});

describe('the flick (9a)', () => {
    it('holds the owner\'s numbers: 24 CSS px at 0.5 px per ms, the speed over the last 80 ms', () => {
        expect([FLICK_DISTANCE, FLICK_SPEED, VELOCITY_WINDOW]).toEqual([24, 0.5, 80]);
    });

    it.each([
        // Short of 48, a flick moves when it's fast enough the same way, at 24 or more.
        [-24, 0, -0.5, 'next'],
        [24, 0, 0.5, 'previous'],
        [-30, 0, -2, 'next'],
        [-23.9, 0, -3, null],
        [-30, 0, -0.49, null],
        // Fast the other way, the finger turned back: short of 48 it doesn't move.
        [-30, 0, 0.8, null],
        [30, 0, -0.8, null],
        // The ratio still holds: a flick that's mostly down the page is a scroll.
        [-30, 24, -1, 'next'],
        [-30, 24.1, -1, null],
        // Past 48 the distance rule moves, at any speed the same way, and at rest.
        [-60, 0, 0, 'next'],
        [-60, 0, -1.5, 'next'],
        [80, 0, 0.2, 'previous'],
        // But flicked back the other way at 0.5 px/ms or faster, it cancels, however far it went, as a paging view does
        // on iOS and Android. Slower than that back, the distance still moves.
        [-80, 0, 0.5, null],
        [-200, 0, 1.2, null],
        [80, 0, -0.8, null],
        [-80, 0, 0.49, 'next'],
        [80, 0, -0.3, 'previous'],
    ])('dx %d, dy %d at %d px/ms asks for %s', (dx, dy, velocity, expected) => {
        expect(swipeStep(dx, dy, velocity)).toBe(expected);
    });
});

describe('releaseVelocity', () => {
    const at = (...pairs: [number, number][]): Sample[] => pairs.map(([x, t]) => ({ x, t }));

    it('reads the travel over the last 80 ms, signed as the travel is', () => {
        expect(releaseVelocity(at([200, 0], [190, 16], [170, 32], [140, 48]))).toBeCloseTo(-60 / 48);
        // Only the samples within 80 ms of the lift count: the slow start is dropped.
        expect(releaseVelocity(at([200, 0], [199, 100], [180, 140], [160, 180]))).toBeCloseTo(-39 / 80);
        expect(releaseVelocity(at([100, 0], [140, 40]))).toBe(1);
    });

    it('is zero for a finger that held still before it lifted, a single sample, or no time between them', () => {
        expect(releaseVelocity(at([200, 0], [120, 50], [120, 300]))).toBe(0);
        expect(releaseVelocity(at([120, 300]))).toBe(0);
        expect(releaseVelocity([])).toBe(0);
        expect(releaseVelocity(at([200, 10], [150, 10]))).toBe(0);
    });

    it('keeps only the samples the window still needs', () => {
        expect(keepSamples(at([1, 0], [2, 50], [3, 90]), { x: 4, t: 120 })).toEqual(at([2, 50], [3, 90], [4, 120]));
    });
});

describe('liftVelocity', () => {
    const gesture = (samples: [number, number][], moved = true) => ({ pointerId: 1, x: 0, y: 0, samples: samples.map(([x, t]) => ({ x, t })), claimedAt: null, vertical: false, moved });

    it('reads from where the finger went down to its last move, and a lift in place a frame later adds nothing', () => {
        expect(POINTER_STOPPED).toBe(40);
        // Down at 200, two moves 33 ms apart (headless Chromium's pace for CDP touches), the lift 33 ms after the last.
        expect(liftVelocity(gesture([[200, 0], [184, 25], [168, 58]]), { x: 168, t: 91 })).toBeCloseTo(-32 / 58);
        // A lift that moved again counts.
        expect(liftVelocity(gesture([[200, 0], [180, 16]]), { x: 170, t: 24 })).toBeCloseTo(-30 / 24);
    });

    it('is zero for a lift 40 ms or more after the last move, and for one with no move since the finger went down', () => {
        expect(liftVelocity(gesture([[200, 0], [150, 16]]), { x: 150, t: 56 })).toBe(0);
        expect(liftVelocity(gesture([[200, 0], [150, 16]]), { x: 150, t: 55 })).toBeCloseTo(-50 / 16);
        expect(liftVelocity(gesture([[200, 0]], false), { x: 100, t: 5 })).toBe(0);
        expect(liftVelocity(gesture([], false), { x: 100, t: 5 })).toBe(0);
    });
});

describe('rubberBand', () => {
    it('is iOS\'s (1 - 1 / (x c / d + 1)) d, with c 0.55 and d the stage width', () => {
        expect(RUBBER_BAND).toBe(0.55);
        const d = 390;
        for (const x of [1, 40, 170, 390, 2000]) expect(rubberBand(x, d)).toBeCloseTo((1 - 1 / ((x * 0.55) / d + 1)) * d, 9);
        // About c times a small pull, less as it grows, never the whole stage.
        expect(rubberBand(10, d) / 10).toBeCloseTo(0.55, 1);
        expect(rubberBand(170, d)).toBeCloseTo(75.4, 1);
        expect(rubberBand(1e7, d)).toBeLessThan(d);
    });

    it('gives nothing for no pull or no stage', () => {
        expect(rubberBand(0, 390)).toBe(0);
        expect(rubberBand(-10, 390)).toBe(0);
        expect(rubberBand(100, 0)).toBe(0);
    });
});

describe('followOffset and followTravel', () => {
    const both = { previous: true, next: true };

    it('follows 1:1 from where the touch was claimed, so the photograph never jumps the slop', () => {
        const start = run([down(1, 200, 300), { type: 'move', pointerId: 1, x: 188, y: 301, t: 16 }]).state.start;
        expect(start?.claimedAt).toBe(188);
        expect(followTravel(start, 188)).toBe(0);
        expect(followTravel(start, 100)).toBe(-88);
        expect(followOffset(-88, 0, 390, both)).toBe(-88);
        // From where a caught settle held it.
        expect(followOffset(-20, 35, 390, both)).toBe(15);
    });

    it('doesn\'t follow a touch that isn\'t claimed yet, or that settled down the page', () => {
        expect(followTravel(run([down(1, 200, 300), { type: 'move', pointerId: 1, x: 195, y: 302, t: 16 }]).state.start, 195)).toBeNull();
        const vertical = run([down(1, 200, 300), { type: 'move', pointerId: 1, x: 196, y: 320, t: 16 }, { type: 'move', pointerId: 1, x: 100, y: 330, t: 32 }]).state.start;
        expect(vertical?.vertical).toBe(true);
        expect(followTravel(vertical, 100)).toBeNull();
        expect(followTravel(null, 100)).toBeNull();
    });

    it('picks up a pull caught past an end where the rubber band had it, so the photograph doesn\'t jump (71 px stays 71 px)', () => {
        const first = { previous: false, next: true };
        for (const offset of [71, 30.4, 95, 200]) {
            const base = caughtBase(offset, 390, first);
            expect(followOffset(0, base, 390, first), `${offset} px`).toBeCloseTo(offset, 6);
            // And it goes on from there with the band, a little less per px as the pull grows.
            expect(followOffset(10, base, 390, first)).toBeGreaterThan(offset);
            expect(followOffset(10, base, 390, first) - offset).toBeLessThan(10);
        }
        expect(caughtBase(-71, 390, { previous: true, next: false })).toBeCloseTo(-unbandedPull(71, 390), 6);
        expect(followOffset(0, caughtBase(-71, 390, { previous: true, next: false }), 390, { previous: true, next: false })).toBeCloseTo(-71, 6);
        // Where there's a photograph that way, the offset is the drag's start as it is.
        expect(caughtBase(71, 390, { previous: true, next: true })).toBe(71);
        expect(caughtBase(-71, 390, first)).toBe(-71);
        expect(unbandedPull(rubberBand(170, 390), 390)).toBeCloseTo(170, 6);
        expect(unbandedPull(0, 390)).toBe(0);
        expect(Number.isFinite(unbandedPull(390, 390))).toBe(true);
    });

    it('meets the rubber band toward an end, and only toward it', () => {
        expect(followOffset(170, 0, 390, { previous: false, next: true })).toBeCloseTo(rubberBand(170, 390));
        expect(followOffset(-170, 0, 390, { previous: false, next: true })).toBe(-170);
        expect(followOffset(-170, 0, 390, { previous: true, next: false })).toBeCloseTo(-rubberBand(170, 390));
        expect(followOffset(170, 0, 390, { previous: true, next: false })).toBe(170);
    });
});

describe('settleOf', () => {
    const parse = (easing: string) => (/^cubic-bezier\(([^)]+)\)$/.exec(easing)?.[1] ?? '').split(',').map(Number);

    it('settles onward in 280 ms at rest down to 200 ms for a fast release, and back in 240 ms down to 200', () => {
        expect([SETTLE_SLOW, SETTLE_FAST, RETURN_SLOW]).toEqual([280, 200, 240]);
        expect(settleOf('commit', 300, 0).duration).toBe(280);
        expect(settleOf('commit', 300, 0.2).duration).toBe(280);
        expect(settleOf('commit', 300, 0.7).duration).toBe(240);
        expect(settleOf('commit', 300, 1.2).duration).toBe(200);
        expect(settleOf('commit', 300, 5).duration).toBe(200);
        expect(settleOf('return', 40, 0).duration).toBe(240);
        expect(settleOf('return', 40, 3).duration).toBe(200);
        // A speed away from where it goes counts as at rest.
        expect(settleOf('commit', 300, -2).duration).toBe(280);
        // Faster never takes longer.
        let last = Infinity;
        for (let speed = 0; speed <= 2; speed += 0.05) {
            const { duration } = settleOf('commit', 300, speed);
            expect(duration).toBeLessThanOrEqual(last);
            last = duration;
        }
    });

    it('opens at the release speed and lands with no overshoot: every control point inside the unit square', () => {
        for (const [distance, speed] of [
            [300, 0],
            [300, 0.6],
            [300, 1.3],
            [40, 3],
            [400, 10],
            [1, 0.5],
        ]) {
            const { duration, easing } = settleOf('commit', distance, speed);
            const [x1, y1, x2, y2] = parse(easing);
            for (const value of [x1, y1, x2, y2]) {
                expect(value).toBeGreaterThanOrEqual(0);
                expect(value).toBeLessThanOrEqual(1);
            }
            expect([x2, y2]).toEqual([0.36, 1]);
            // The opening slope matches the finger's speed in the curve's units, with no floor: at rest it opens flat.
            const wanted = (speed * duration) / distance;
            if (wanted * 0.22 <= 1) expect(y1 / x1).toBeCloseTo(wanted, 2);
            else {
                expect(y1).toBe(1);
                expect(x1).toBeCloseTo(Math.max(0.04, 1 / wanted), 3);
            }
        }
    });

    it.each([0.3, 0.6, 1.5])('starts a settle at the release speed, %d px/ms, never faster', (speed) => {
        // A commit on a 406 px pitch let go 64 px out, and a slide back from 40 px.
        for (const [kind, distance] of [
            ['commit', 342],
            ['return', 40],
        ] as const) {
            const { duration, easing } = settleOf(kind, distance, speed);
            const [x1, y1] = parse(easing);
            // The curve's opening slope, back in CSS px per ms.
            const start = y1 === 1 ? Infinity : ((y1 / x1) * distance) / duration;
            if (y1 < 1) expect(start, `${kind} at ${speed}`).toBeCloseTo(speed, 2);
            // A short slide back can't open that fast inside the unit square, so it opens as fast as the square allows.
            else expect(x1).toBeCloseTo(Math.max(0.04, distance / (speed * duration)), 3);
        }
    });

    it('opens a move by a control or a key, which has no finger speed, at the mockup\'s slope', () => {
        expect(CONTROL_SLOPE).toBe(1.5);
        const [x1, y1] = parse(settleOf('commit', 406, 0, CONTROL_SLOPE).easing);
        expect(y1 / x1).toBeCloseTo(1.5, 2);
        // A release at rest opens flat, from a standstill.
        expect(parse(settleOf('commit', 342, 0).easing).slice(0, 2)).toEqual([0.22, 0]);
    });

    it('keeps the 16 px gap the neighbors peek in through', () => {
        expect(PEEK_GAP).toBe(16);
    });
});

describe('reduceSwipe, with motion (9a)', () => {
    const move = (x: number, t: number, y = 300): SwipeInput => ({ type: 'move', pointerId: 1, x, y, t });
    const lift = (x: number, t: number, y = 300): SwipeInput => ({ type: 'up', pointerId: 1, x, y, t });

    it('commits a short fast flick at the lift, and gives the release its speed', () => {
        const result = [down(1, 200, 300), move(195, 0), move(185, 10), move(175, 20), lift(170, 30)].reduce<{ state: SwipeState; release?: unknown; step: string | null }>(
            (acc, input) => reduceSwipe(acc.state, input),
            { state: SWIPE_IDLE, step: null },
        );
        expect(result.step).toBe('next');
        expect(result.release).toMatchObject({ step: 'next', dx: -30, followed: true });
        expect((result.release as { velocity: number }).velocity).toBeCloseTo(-25 / 30);
    });

    it('springs back a short slow drag: a release, and no step', () => {
        const inputs = [down(1, 200, 300), move(195, 0), move(185, 100), move(170, 200), lift(170, 400)];
        let state = SWIPE_IDLE;
        let last: ReturnType<typeof reduceSwipe> | undefined;
        for (const input of inputs) {
            last = reduceSwipe(state, input);
            state = last.state;
        }
        expect(last?.step).toBeNull();
        expect(last?.release).toMatchObject({ step: null, dx: -30, velocity: 0, followed: true });
    });

    it('releases a gesture with no step when a second finger lands, so the photograph it held slides back', () => {
        const held = [down(1, 200, 300), move(195, 0), move(170, 50), move(114, 100)].reduce((state, input) => reduceSwipe(state, input).state, SWIPE_IDLE);
        const second = reduceSwipe(held, down(2, 260, 320, { primary: false }));
        expect(second.step).toBeNull();
        expect(second.release).toEqual({ step: null, dx: 0, dy: 0, velocity: 0, followed: true });
        expect(second.state).toEqual({ down: [1, 2], start: null });
        // Neither lift moves or releases again.
        const after = reduceSwipe(reduceSwipe(second.state, lift(60, 200)).state, { type: 'up', pointerId: 2, x: 300, y: 320, t: 210 });
        expect(after.release).toBeUndefined();
        expect(after.state).toEqual(SWIPE_IDLE);
        // A gesture never claimed sideways releases too, and says so.
        const unclaimed = reduceSwipe(reduceSwipe(SWIPE_IDLE, down(1, 200, 300)).state, down(2, 260, 320, { primary: false }));
        expect(unclaimed.release).toMatchObject({ step: null, followed: false });
        // A finger down with no gesture in flight releases nothing.
        expect(reduceSwipe({ down: [1], start: null }, down(2, 260, 320, { primary: false })).release).toBeUndefined();
    });

    it('releases a cancelled gesture with no step, and says whether the photograph followed it', () => {
        const followed = reduceSwipe(run([down(1, 200, 300), move(180, 0)]).state, cancel(1));
        expect(followed.release).toEqual({ step: null, dx: 0, dy: 0, velocity: 0, followed: true });
        const still = reduceSwipe(run([down(1, 200, 300)]).state, cancel(1));
        expect(still.release).toMatchObject({ followed: false });
        // A cancel of a pointer it never followed releases nothing.
        expect(reduceSwipe(run([down(1, 200, 300)]).state, cancel(5)).release).toBeUndefined();
    });

    it('ignores the moves of a pointer it doesn\'t follow', () => {
        const from = run([down(1, 200, 300)]).state;
        expect(reduceSwipe(from, { type: 'move', pointerId: 2, x: 0, y: 0, t: 1 }).state).toBe(from);
    });

    it('settles the axis once: a touch claimed sideways stays claimed, and one gone down the page never follows', () => {
        const claimed = run([down(1, 200, 300), move(185, 0, 305), move(185, 16, 400)]).state.start;
        expect([claimed?.claimedAt, claimed?.vertical]).toEqual([185, false]);
        const vertical = run([down(1, 200, 300), move(198, 0, 320), move(100, 16, 320)]).state.start;
        expect([vertical?.claimedAt, vertical?.vertical]).toEqual([null, true]);
    });
});
