// The one padding rule for a visible position (#4, #7): Home's counter and its
// failure line, and the Viewer's header. No imports, so any client component
// and its tests can read it.

/** The digits a position pads to: the total's, never under the mockup's two. */
function width(total: number): number {
    return Math.max(2, String(Math.trunc(Math.abs(total))).length);
}

/** One number padded to the digits of the total: 3 of 120 is `003`. */
export function padPosition(value: number, total: number): string {
    return String(value).padStart(width(total), '0');
}

/** The mockup's `NN / NN`, padded to the digits of the total: `03 / 12`, `007 / 120`. For the eye only; a screen reader gets the spelled-out form. */
export function positionLabel(position: number, total: number): string {
    return `${padPosition(position, total)} / ${padPosition(total, total)}`;
}
