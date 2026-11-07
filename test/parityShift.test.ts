import { describe, expect, it } from 'vitest';
import { checkShift, shiftLine, type Box, type Shift } from './helpers/parityShift';

// The Dark parity gate's exact shift (#171, e2e/themes/computed.ts): a sanctioned scroll moves a box by exactly its
// distance, with no tolerance band. A box moved by any other distance, by a fraction too, sideways, or not at all,
// or whose size changed, is off. The gate fails a box that's off at all, and compares every style as before.

// Chromium's boxes are in 1/64 px, as the gate reads them.
const BOXES: Box[] = [
    [0, 0, 1440, 1191.140625],
    [0, 56, 1440, 1135.140625],
    [47.515625, 298.953125, 771.21875, 633.140625],
];
const SHIFT: Shift = [0, -160];
const moved = (box: Box, dy: number, dx = 0): Box => [box[0] + dx, box[1] + dy, box[2], box[3]];

describe("the parity gate's exact shift", () => {
    it('finds a box moved by exactly the shift on it, and gives the move', () => {
        for (const box of BOXES) expect(checkShift(box, moved(box, -160), SHIFT)).toEqual({ delta: 160, off: 0 });
    });

    it.each([-159, -161, -160.015625, -159.984375, 0])('finds a box moved by %s px off by the difference', (dy) => {
        for (const box of BOXES) expect(checkShift(box, moved(box, dy), SHIFT).off).toBe(Math.abs(dy + 160));
    });

    it('finds a box moved sideways too off', () => {
        expect(checkShift(BOXES[2], moved(BOXES[2], -160, 1), SHIFT).off).toBe(1);
    });

    it('finds a box the head resized off', () => {
        const box = BOXES[2];
        expect(checkShift(box, [box[0], box[1] - 160, box[2], box[3] + 1], SHIFT).off).toBe(1);
    });

    it('names the box, its move, the shift and how far off it is', () => {
        const box = BOXES[2];
        const head = moved(box, -161);
        expect(shiftLine('body>main', box, head, SHIFT, checkShift(box, head, SHIFT))).toBe('body>main: 47.516 298.953 771.219 633.141 against 47.516 137.953 771.219 633.141 (161 px, the sanctioned shift 0 -160, off by 1 px)');
    });
});
