// The Viewer's swipe rule (#9), with no DOM, so a unit test reads it alone.
import type { ViewerStep } from './viewerKeys';

/** A swipe moves only after this much horizontal travel, in CSS px. */
export const SWIPE_DISTANCE = 48;
/** And only when the horizontal travel is at least this many times the vertical. */
export const SWIPE_RATIO = 1.25;
/** Above this page scale the visitor has pinched in, and a sideways drag pans the page instead of moving. */
export const PINCH_SCALE = 1.01;

/** Travel in CSS px before a touch's axis is settled, about the browser's own slop before it picks a pan's axis. */
export const CLAIM_SLOP = 10;

/** A flick moves on less travel than SWIPE_DISTANCE: at least this many CSS px across (9a)... */
export const FLICK_DISTANCE = 24;
/** ...when the finger is still going at least this fast, in CSS px per ms, the same way, as it lifts. */
export const FLICK_SPEED = 0.5;
/** The release speed is the finger's travel over its last this many ms. Older samples are dropped. */
export const VELOCITY_WINDOW = 80;
/**
 * A lift this many ms or more after the finger's last move means it had stopped, so the release speed is zero, as
 * Android's VelocityTracker assumes (its ASSUME_POINTER_STOPPED_TIME). A lift sooner than that, at the last move's
 * place, adds no sample: the speed is the finger's up to its last move, not diluted by the frame the lift waited for.
 */
export const POINTER_STOPPED = 40;

/** The band between the photograph and the one peeking in beside it while it follows the finger, in CSS px: the site gutter on a phone. */
export const PEEK_GAP = 16;
/** iOS's rubber-band constant: past an end, the photograph gives this share of a pull that's small next to the stage. */
export const RUBBER_BAND = 0.55;

/** The settle onward: this long when the finger lets go at rest... */
export const SETTLE_SLOW = 280;
/** ...down to this long for a release at SETTLE_FAST_SPEED or faster. */
export const SETTLE_FAST = 200;
/** Sliding back after a drag that doesn't move: at rest, down to the same SETTLE_FAST. */
export const RETURN_SLOW = 240;
/** Below this release speed toward the rest, in CSS px per ms, the settle takes its longest. */
export const SETTLE_REST_SPEED = 0.2;
/** At or above this one, its shortest. */
export const SETTLE_FAST_SPEED = 1.2;
/** The curve's closing control point, `cubic-bezier(x1, y1, 0.36, 1)`: an ease-out that lands with no overshoot. */
export const SETTLE_X2 = 0.36;
/** The opening slope of a release at rest, so even a slow settle starts by moving and eases in to its stop. */
const REST_SLOPE = 1.5;
/** Where the opening control point sits across when the release speed leaves room for it. */
const OPENING_X = 0.22;

/**
 * Whether the Viewer claims the touch it follows from the browser, by its net
 * travel so far: null until it's gone CLAIM_SLOP, then true for more across
 * than down (the browser's own test for a horizontal pan, which the stage's
 * `pan-y` never scrolls), false otherwise. The swipe cancels a claimed
 * touch's moves, so the browser doesn't start an inertial fling at the lift.
 * Chromium starts that fling even where `touch-action` forbids the pan, and
 * it's invisible, but a tap during it only stops the fling: the next tap on
 * Close or Next right after a swipe would do nothing.
 */
export function claimsTouch(dx: number, dy: number): boolean | null {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < CLAIM_SLOP) return null;
    return Math.abs(dx) > Math.abs(dy);
}

/** Whether the page is pinch-zoomed, from `visualViewport.scale`, which is undefined where the browser has none. */
export function isPinched(scale: number | undefined): boolean {
    return (scale ?? 1) > PINCH_SCALE;
}

/**
 * The move a finished gesture asks for, from its net travel and the
 * finger's speed across as it lifts (`velocity`, CSS px per ms, signed as
 * `dx` is): at least SWIPE_DISTANCE across, or a flick of at least
 * FLICK_DISTANCE still going FLICK_SPEED or faster the same way, and either
 * way SWIPE_RATIO times as far across as down. The path doesn't count, so a
 * drag out and back short of the rule doesn't move. Toward the left is Next,
 * as a page turns.
 */
export function swipeStep(dx: number, dy: number, velocity = 0): ViewerStep | null {
    const across = Math.abs(dx);
    if (across < SWIPE_RATIO * Math.abs(dy)) return null;
    const flick = across >= FLICK_DISTANCE && Math.sign(velocity) === Math.sign(dx) && Math.abs(velocity) >= FLICK_SPEED;
    if (across < SWIPE_DISTANCE && !flick) return null;
    return dx < 0 ? 'next' : 'previous';
}

/** One look at the finger: where it was across, and when, in ms. */
export interface Sample {
    readonly x: number;
    readonly t: number;
}

/**
 * The finger's speed across as it lifts, in CSS px per ms, from its samples:
 * the travel between the oldest and newest sample within VELOCITY_WINDOW of
 * the newest (the lift), over the time between them. Zero when only one
 * sample is that recent (the finger held still before it lifted) or no
 * time passed between them, so a release the page can't time never flicks.
 */
export function releaseVelocity(samples: readonly Sample[]): number {
    if (samples.length < 2) return 0;
    const last = samples[samples.length - 1];
    const first = samples.find((sample) => last.t - sample.t <= VELOCITY_WINDOW) ?? last;
    const span = last.t - first.t;
    return span > 0 ? (last.x - first.x) / span : 0;
}

/** The samples to keep after `sample`: the newest, and every one still within VELOCITY_WINDOW of it. */
export function keepSamples(samples: readonly Sample[], sample: Sample): Sample[] {
    return [...samples.filter((kept) => sample.t - kept.t <= VELOCITY_WINDOW), sample];
}

/**
 * Past an end there's no photograph to bring in, so the pull meets iOS's
 * rubber band: `(1 - 1 / (over * c / d + 1)) * d`, with `c` RUBBER_BAND and
 * `d` the stage's width. It gives about `c` times a small pull, ever less
 * as the pull grows, and never the whole stage.
 */
export function rubberBand(over: number, width: number, c = RUBBER_BAND): number {
    if (!(width > 0) || over <= 0) return 0;
    return (1 - 1 / ((over * c) / width + 1)) * width;
}

/**
 * Where the photograph sits across while it follows the finger, in CSS px
 * from its rest: 1:1 with the finger from where the touch was claimed, so it
 * doesn't jump the claim's slop, plus `base`, where a settle the finger
 * caught had it. Toward an end with no photograph (`previous` or `next`
 * false), it meets the rubber band instead.
 */
export function followOffset(travel: number, base: number, width: number, { previous, next }: { previous: boolean; next: boolean }): number {
    const offset = base + travel;
    if (offset > 0 && !previous) return rubberBand(offset, width);
    if (offset < 0 && !next) return -rubberBand(-offset, width);
    return offset;
}

export type SettleKind = 'commit' | 'return';

export interface Settle {
    /** In ms. */
    duration: number;
    /** A CSS `cubic-bezier()`. */
    easing: string;
}

const round = (value: number) => Number(value.toFixed(3));

/**
 * How the photograph settles once the finger lets go: onward to the next
 * photograph (`commit`), in SETTLE_SLOW ms when let go at rest down to
 * SETTLE_FAST at SETTLE_FAST_SPEED or faster toward it, or back to its rest
 * (`return`) in RETURN_SLOW down to SETTLE_FAST. `distance` is how far it
 * has left to go, and `speed` the finger's toward there (negative, away
 * from it, counts as at rest). The curve is an ease-out whose opening slope
 * is that speed, so the photograph carries on as fast as the finger had it
 * and never jumps or stalls at the lift, and whose control points stay in
 * the unit square, so it never overshoots its stop.
 */
export function settleOf(kind: SettleKind, distance: number, speed: number): Settle {
    const toward = Math.max(0, speed);
    const longest = kind === 'commit' ? SETTLE_SLOW : RETURN_SLOW;
    const share = Math.min(1, Math.max(0, (toward - SETTLE_REST_SPEED) / (SETTLE_FAST_SPEED - SETTLE_REST_SPEED)));
    const duration = Math.round(longest - (longest - SETTLE_FAST) * share);
    // The curve's slope at its start, in units of the whole distance over the whole duration.
    const slope = Math.max(REST_SLOPE, distance > 0 ? (toward * duration) / distance : REST_SLOPE);
    let x1 = OPENING_X;
    let y1 = Math.min(1, x1 * slope);
    if (slope * x1 > 1) {
        y1 = 1;
        x1 = Math.max(0.04, 1 / slope);
    }
    return { duration, easing: `cubic-bezier(${round(x1)}, ${round(y1)}, ${SETTLE_X2}, 1)` };
}

export type SwipeInput =
    /**
     * A pointer went down. `eligible` when it's on the photograph, unzoomed. `primary` when no other pointer of its kind
     * is down. `t` is the event's time in ms; without one, a gesture's speed is unknown and only its distance counts.
     */
    | { type: 'down'; pointerId: number; x: number; y: number; t?: number; primary: boolean; eligible: boolean }
    /** The followed pointer moved. */
    | { type: 'move'; pointerId: number; x: number; y: number; t?: number }
    | { type: 'up'; pointerId: number; x: number; y: number; t?: number }
    /** `pointercancel` or lost pointer capture. */
    | { type: 'cancel'; pointerId: number }
    /** A route change, zoom, or unmount: drop the gesture. */
    | { type: 'reset' };

export interface SwipeGesture {
    readonly pointerId: number;
    /** Where it went down. */
    readonly x: number;
    readonly y: number;
    /** Where it went down and its recent moves across, for the release speed, when the events carry a time. */
    readonly samples: readonly Sample[];
    /**
     * Where the finger was across when the touch was claimed sideways (claimsTouch), so the photograph follows from
     * there; null until the axis settles that way. `vertical` once it settled down the page: the photograph never follows.
     */
    readonly claimedAt: number | null;
    readonly vertical: boolean;
    /** Whether the pointer has moved since it went down. */
    readonly moved: boolean;
}

/**
 * The finger's speed across at the lift: zero with no move since it went down, or when it lifted POINTER_STOPPED ms or
 * more after its last move; else releaseVelocity() up to the last move, and the lift itself only if it moved again.
 */
export function liftVelocity(gesture: SwipeGesture, lift: Sample): number {
    const last = gesture.samples[gesture.samples.length - 1];
    if (!gesture.moved || last === undefined || lift.t - last.t >= POINTER_STOPPED) return 0;
    return releaseVelocity(lift.x === last.x ? gesture.samples : keepSamples(gesture.samples, lift));
}

export interface SwipeState {
    /** The pointers down now, so a second finger ends the gesture and can't start one. */
    readonly down: readonly number[];
    /** The one gesture being followed, from where it started, or null. */
    readonly start: SwipeGesture | null;
}

export const SWIPE_IDLE: SwipeState = { down: [], start: null };

/** What a lift tells the photograph: the move it asks for (or null), its net travel, and the finger's speed across. */
export interface SwipeRelease {
    readonly step: ViewerStep | null;
    readonly dx: number;
    readonly dy: number;
    readonly velocity: number;
    /** Whether the touch was ever claimed sideways, so the photograph followed it. */
    readonly followed: boolean;
}

/** How far across the photograph follows the finger in `gesture`, from where it was claimed, or null while it doesn't. */
export function followTravel(gesture: SwipeGesture | null, x: number): number | null {
    if (gesture === null || gesture.claimedAt === null) return null;
    return x - gesture.claimedAt;
}

/**
 * One step of the recognizer. A gesture starts with the only pointer down,
 * on the photograph, unzoomed, and moves the Viewer only when that pointer
 * lifts past the rule (swipeStep). A second pointer anywhere (a pinch, or a
 * tap on a control) ends it, and nothing starts until every pointer is up. A
 * cancel or lost capture ends it without a move. A reset drops the gesture
 * but keeps count of the fingers still down. A primary pointer means no other
 * is down, so it clears any the browser never reported lifting. Its moves
 * settle the axis once, at CLAIM_SLOP (claimsTouch), and keep the samples the
 * release speed reads. Every lift and cancel of the followed pointer gives a
 * `release`, so the photograph knows to settle.
 */
export function reduceSwipe(state: SwipeState, input: SwipeInput): { state: SwipeState; step: ViewerStep | null; release?: SwipeRelease } {
    switch (input.type) {
        case 'down': {
            const others = (input.primary ? [] : state.down).filter((pointerId) => pointerId !== input.pointerId);
            // Where it went down is the speed's first sample, as on Android. A lift with no move after it never flicks.
            const samples = input.t === undefined ? [] : [{ x: input.x, t: input.t }];
            const start = others.length === 0 && input.eligible ? { pointerId: input.pointerId, x: input.x, y: input.y, samples, claimedAt: null, vertical: false, moved: false } : null;
            return { state: { down: [...others, input.pointerId], start }, step: null };
        }
        case 'move': {
            const { start } = state;
            if (start === null || start.pointerId !== input.pointerId) return { state, step: null };
            const samples = input.t === undefined ? start.samples : keepSamples(start.samples, { x: input.x, t: input.t });
            let { claimedAt, vertical } = start;
            if (claimedAt === null && !vertical) {
                const claim = claimsTouch(input.x - start.x, input.y - start.y);
                if (claim === true) claimedAt = input.x;
                else if (claim === false) vertical = true;
            }
            return { state: { down: state.down, start: { ...start, samples, claimedAt, vertical, moved: true } }, step: null };
        }
        case 'up': {
            const down = state.down.filter((pointerId) => pointerId !== input.pointerId);
            const { start } = state;
            if (start === null || start.pointerId !== input.pointerId) return { state: { down, start }, step: null };
            const dx = input.x - start.x;
            const dy = input.y - start.y;
            const velocity = input.t === undefined ? 0 : liftVelocity(start, { x: input.x, t: input.t });
            const step = swipeStep(dx, dy, velocity);
            return { state: { down, start: null }, step, release: { step, dx, dy, velocity, followed: start.claimedAt !== null } };
        }
        case 'cancel': {
            const down = state.down.filter((pointerId) => pointerId !== input.pointerId);
            const followed = state.start?.pointerId === input.pointerId ? state.start : null;
            const start = followed === null ? state.start : null;
            if (followed === null) return { state: { down, start }, step: null };
            return { state: { down, start }, step: null, release: { step: null, dx: 0, dy: 0, velocity: 0, followed: followed.claimedAt !== null } };
        }
        case 'reset':
            return { state: { down: state.down, start: null }, step: null };
    }
}
