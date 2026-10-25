// The Viewer's double-tap rule (#9c), with no DOM, so a unit test reads it alone. A double-tap on the photograph does
// what Zoom does. The stage's `touch-action: pan-y pinch-zoom` (StoryViewer.module.css) turns the browser's own
// double-tap zoom off, so the Viewer reads the two taps itself.

/** A tap is a touch that travels less than this, in CSS px, from where it went down. The swipe's own slop. */
export const TAP_SLOP = 10;
/** And lifts within this many ms of going down, so a press and hold isn't a tap. */
export const TAP_HOLD = 300;
/** The second tap goes down within this many ms of the first tap's lift. */
export const DOUBLE_TAP_INTERVAL = 300;
/** And within this many CSS px of where the first tap went down. */
export const DOUBLE_TAP_DISTANCE = 24;
/**
 * No tap counts for this many ms after a drag, a swipe, a cancel (the browser took the touch for a scroll or a pinch),
 * or the last scroll event of any scroll or fling. A tap during a fling only stops it, as on any phone, and the second
 * tap of a visitor who taps twice to stop one must not zoom.
 */
export const SETTLE = 300;

export type DoubleTapInput =
    /** `eligible` when it's a touch on the photograph and the page isn't pinch-zoomed. `primary` when no other touch is down. */
    | { type: 'down'; pointerId: number; x: number; y: number; t: number; primary: boolean; eligible: boolean }
    | { type: 'move'; pointerId: number; x: number; y: number }
    | { type: 'up'; pointerId: number; x: number; y: number; t: number }
    /** `pointercancel` or lost pointer capture. */
    | { type: 'cancel'; pointerId: number; t: number }
    /** Any scroll: the page, the modal, or the zoomed photograph's pan, including a fling after the finger lifts. */
    | { type: 'scroll'; t: number }
    /** A move by any route, or unmount: drop the taps. */
    | { type: 'reset' };

export interface DoubleTapState {
    /** The pointers down now, so a second finger ends the taps and can't start one. */
    readonly down: readonly number[];
    /** The touch that may be a tap, from where and when it went down, and whether it has gone past the slop. */
    readonly touch: { readonly pointerId: number; readonly x: number; readonly y: number; readonly t: number; readonly moved: boolean } | null;
    /** The first tap of a pair, from where it went down and when it lifted. */
    readonly first: { readonly x: number; readonly y: number; readonly t: number } | null;
    /** No touch can start a tap before this time. */
    readonly quietUntil: number;
}

export const DOUBLE_TAP_IDLE: DoubleTapState = { down: [], touch: null, first: null, quietUntil: -Infinity };

const apart = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * One step of the recognizer. It fires at the second tap's lift, when two taps on the photograph land within
 * DOUBLE_TAP_INTERVAL and DOUBLE_TAP_DISTANCE of each other. Anything else between them drops the first tap: a drag or
 * a swipe, a second finger, a cancel, a scroll, a touch off the photograph. A drag can't be a tap and a tap can't be a
 * swipe (TAP_SLOP is under the swipe's 48 px), so the two recognizers never both act on one touch.
 */
export function reduceDoubleTap(state: DoubleTapState, input: DoubleTapInput): { state: DoubleTapState; fire: boolean } {
    switch (input.type) {
        case 'down': {
            const others = (input.primary ? [] : state.down).filter((pointerId) => pointerId !== input.pointerId);
            const down = [...others, input.pointerId];
            if (others.length > 0 || !input.eligible || input.t < state.quietUntil) {
                return { state: { ...state, down, touch: null, first: null }, fire: false };
            }
            const point = { x: input.x, y: input.y };
            const { first } = state;
            const pairs = first !== null && input.t - first.t <= DOUBLE_TAP_INTERVAL && apart(first, point) <= DOUBLE_TAP_DISTANCE;
            return {
                state: { ...state, down, touch: { pointerId: input.pointerId, x: input.x, y: input.y, t: input.t, moved: false }, first: pairs ? first : null },
                fire: false,
            };
        }
        case 'move': {
            const { touch } = state;
            if (touch === null || touch.pointerId !== input.pointerId || touch.moved || apart(touch, input) < TAP_SLOP) return { state, fire: false };
            return { state: { ...state, touch: { ...touch, moved: true } }, fire: false };
        }
        case 'up': {
            const down = state.down.filter((pointerId) => pointerId !== input.pointerId);
            const { touch } = state;
            if (touch === null || touch.pointerId !== input.pointerId) return { state: { ...state, down }, fire: false };
            if (touch.moved || apart(touch, input) >= TAP_SLOP) {
                return { state: { ...state, down, touch: null, first: null, quietUntil: input.t + SETTLE }, fire: false };
            }
            if (input.t - touch.t > TAP_HOLD) return { state: { ...state, down, touch: null, first: null }, fire: false };
            if (state.first !== null) return { state: { ...state, down, touch: null, first: null }, fire: true };
            return { state: { ...state, down, touch: null, first: { x: touch.x, y: touch.y, t: input.t } }, fire: false };
        }
        case 'cancel': {
            const down = state.down.filter((pointerId) => pointerId !== input.pointerId);
            if (state.touch?.pointerId !== input.pointerId) return { state: { ...state, down }, fire: false };
            return { state: { ...state, down, touch: null, first: null, quietUntil: input.t + SETTLE }, fire: false };
        }
        case 'scroll':
            return { state: { ...state, touch: null, first: null, quietUntil: Math.max(state.quietUntil, input.t + SETTLE) }, fire: false };
        case 'reset':
            return { state: { ...state, touch: null, first: null }, fire: false };
    }
}
