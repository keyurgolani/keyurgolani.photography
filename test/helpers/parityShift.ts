/**
 * The Dark parity gate's exact shift (e2e/themes/computed.ts, Allowance.shift): data and logic only, with no
 * Playwright import, so the unit tests under test/ can check it and the image build, which leaves e2e/ out, can
 * type-check them.
 */

/** A box as the gate reads it: x, y, width and height, in CSS px. */
export type Box = readonly [number, number, number, number];
/** The exact move a box must make, x and y in CSS px. */
export type Shift = readonly [number, number];

/** The largest difference between two boxes' x, y, width and height. */
export const boxDelta = (a: Box, b: Box) => Math.max(...a.map((value, i) => Math.abs(value - b[i])));

export interface ShiftCheck {
    /** How far the head's box is from the base's, as the gate measures any move. */
    delta: number;
    /** How far the head's box is from where the shift says it must be. Anything above 0 fails: no tolerance band. */
    off: number;
}

/**
 * Whether a rect is no box at all: x, y, width and height all 0, as an element with display: none reads wherever the
 * page is scrolled. A zero-size box at a real position (an empty <picture>, a <source>, next-route-announcer) is in the
 * page's flow and scrolls with it, so it's a box.
 */
const noBox = (box: Box) => box.every((value) => value === 0);

/**
 * The head's box against the base's moved by exactly `shift`, its size unchanged. No box in either build, as Next's
 * hidden metadata <div hidden> under body, has nothing to scroll: it must be exactly where the base has it. Every
 * other box, zero-size or not, and one that is no box in one build only, must make the exact move.
 */
export function checkShift(base: Box, head: Box, shift: Shift): ShiftCheck {
    const still = noBox(base) && noBox(head);
    const expected: Box = still ? base : [base[0] + shift[0], base[1] + shift[1], base[2], base[3]];
    return { delta: boxDelta(base, head), off: boxDelta(expected, head) };
}

/**
 * The gate's line for a box under a shift, its two boxes, the move, the shift and how far off it is. An off too small
 * to show in three decimals is given unrounded, since any off fails the gate and the line must say it isn't 0.
 */
export function shiftLine(path: string, base: Box, head: Box, shift: Shift, { delta, off }: ShiftCheck): string {
    const box = (b: Box) => b.map((v) => +v.toFixed(3)).join(' ');
    const by = off > 0 && +off.toFixed(3) === 0 ? off : +off.toFixed(3);
    return `${path}: ${box(base)} against ${box(head)} (${+delta.toFixed(3)} px, the sanctioned shift ${shift[0]} ${shift[1]}, off by ${by} px)`;
}
