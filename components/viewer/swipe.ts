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
 * The move a finished gesture asks for, from its net travel: at least
 * SWIPE_DISTANCE across and SWIPE_RATIO times as far across as down. The
 * path and the speed don't count. Toward the left is Next, as a page turns.
 */
export function swipeStep(dx: number, dy: number): ViewerStep | null {
    const across = Math.abs(dx);
    if (across < SWIPE_DISTANCE || across < SWIPE_RATIO * Math.abs(dy)) return null;
    return dx < 0 ? 'next' : 'previous';
}

export type SwipeInput =
    /** A pointer went down. `eligible` when it's on the photograph, unzoomed. `primary` when no other pointer of its kind is down. */
    | { type: 'down'; pointerId: number; x: number; y: number; primary: boolean; eligible: boolean }
    | { type: 'up'; pointerId: number; x: number; y: number }
    /** `pointercancel` or lost pointer capture. */
    | { type: 'cancel'; pointerId: number }
    /** A route change, zoom, or unmount: drop the gesture. */
    | { type: 'reset' };

export interface SwipeState {
    /** The pointers down now, so a second finger ends the gesture and can't start one. */
    readonly down: readonly number[];
    /** The one gesture being followed, from where it started, or null. */
    readonly start: { readonly pointerId: number; readonly x: number; readonly y: number } | null;
}

export const SWIPE_IDLE: SwipeState = { down: [], start: null };

/**
 * One step of the recognizer. A gesture starts with the only pointer down,
 * on the photograph, unzoomed, and moves the Viewer only when that pointer
 * lifts past the threshold. A second pointer anywhere (a pinch, or a tap on
 * a control) ends it, and nothing starts until every pointer is up. A cancel
 * or lost capture ends it without a move. A reset drops the gesture but
 * keeps count of the fingers still down. A primary pointer means no other
 * is down, so it clears any the browser never reported lifting.
 */
export function reduceSwipe(state: SwipeState, input: SwipeInput): { state: SwipeState; step: ViewerStep | null } {
    switch (input.type) {
        case 'down': {
            const others = (input.primary ? [] : state.down).filter((pointerId) => pointerId !== input.pointerId);
            const start = others.length === 0 && input.eligible ? { pointerId: input.pointerId, x: input.x, y: input.y } : null;
            return { state: { down: [...others, input.pointerId], start }, step: null };
        }
        case 'up': {
            const down = state.down.filter((pointerId) => pointerId !== input.pointerId);
            const { start } = state;
            if (start === null || start.pointerId !== input.pointerId) return { state: { down, start }, step: null };
            return { state: { down, start: null }, step: swipeStep(input.x - start.x, input.y - start.y) };
        }
        case 'cancel': {
            const down = state.down.filter((pointerId) => pointerId !== input.pointerId);
            const start = state.start?.pointerId === input.pointerId ? null : state.start;
            return { state: { down, start }, step: null };
        }
        case 'reset':
            return { state: { down: state.down, start: null }, step: null };
    }
}
