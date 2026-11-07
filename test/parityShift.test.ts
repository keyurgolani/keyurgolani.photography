import { describe, expect, it } from 'vitest';
import { checkShift, shiftLine, type Box, type Shift } from './helpers/parityShift';
import { compare, failures, type Walk, type Walked } from './helpers/parityWalk';

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

    // A box with no area in either build, as Next's hidden metadata <div hidden> under body, has nothing to scroll:
    // display: none gives it 0 0 0 0 wherever the page is. It's compared exactly, unshifted.
    describe('a box with no area in either build', () => {
        const NONE: Box = [0, 0, 0, 0];

        it('is where the base has it, unshifted', () => {
            expect(checkShift(NONE, NONE, SHIFT)).toEqual({ delta: 0, off: 0 });
        });

        it('is off if it moves, by the shift or by anything else', () => {
            expect(checkShift(NONE, [0, -160, 0, 0], SHIFT).off).toBe(160);
            expect(checkShift(NONE, [0, 1, 0, 0], SHIFT).off).toBe(1);
            expect(checkShift([12, 30, 0, 0], [12, 30.015625, 0, 0], SHIFT).off).toBe(0.015625);
        });

        it('takes the shift once it has area in either build', () => {
            // A box that gains a width or a height in the head, or had one in the base, must make the exact move.
            expect(checkShift(NONE, [0, 0, 1, 0], SHIFT).off).toBe(160);
            expect(checkShift(NONE, [0, -160, 0, 1], SHIFT).off).toBe(1);
            expect(checkShift([0, 300, 10, 0], [0, 140, 10, 0], SHIFT)).toEqual({ delta: 160, off: 0 });
            expect(checkShift([0, 300, 0, 10], [0, 300, 0, 10], SHIFT).off).toBe(160);
        });

        it('is off as a size change when it has area in one build and none in the other, even at the exact shift', () => {
            // Area in the base, none in the head, where the shift puts it: off by the size it lost.
            expect(checkShift([0, 300, 10, 12], [0, 140, 0, 0], SHIFT).off).toBe(12);
            // None in the base, area in the head, where the shift puts it: off by the size it gained.
            expect(checkShift(NONE, [0, -160, 8, 3], SHIFT).off).toBe(8);
        });
    });

    it('names the box, its move, the shift and how far off it is', () => {
        const box = BOXES[2];
        const head = moved(box, -161);
        expect(shiftLine('body>main', box, head, SHIFT, checkShift(box, head, SHIFT))).toBe('body>main: 47.516 298.953 771.219 633.141 against 47.516 137.953 771.219 633.141 (161 px, the sanctioned shift 0 -160, off by 1 px)');
    });
});

// The same rule through the gate's own comparison (test/helpers/parityWalk.ts, re-exported by e2e/themes/computed.ts),
// on walks of the page as the gate reads them, with Next's hidden metadata div under body.
describe("the parity gate's comparison under a shift", () => {
    const at = (path: string, rect: Walked['rect'], styles = ['color: rgb(1, 2, 3)']): Walked => ({ path, styles, pseudos: {}, rect, slot: false });
    const walkOf = (elements: Walked[]): Walk => ({ tokens: { root: {}, body: {} }, elements, resolved: { body: 'body' }, folded: [], foldedPinned: [] });
    const HIDDEN = 'body>div:nth-of-type(1)';
    const page = (dy: number, hidden: Walked['rect'] = [0, 0, 0, 0]) => [...BOXES.map((box, i) => at(`body>p:nth-of-type(${i + 1})`, [...moved(box, dy)] as Walked['rect'])), at(HIDDEN, hidden)];
    const named = (elements: Walked[]) => Object.fromEntries(elements.map((element) => [element.path, SHIFT]));
    const shifts = named(page(0));

    it('passes every box moved by exactly the shift, lists each one that moved, and leaves the hidden div unlisted', () => {
        const c = compare(walkOf(page(0)), walkOf(page(-160)), {}, {}, shifts);
        expect(failures(c)).toEqual([]);
        expect(c.deltas).toHaveLength(BOXES.length);
        expect(c.deltas.some((line) => line.startsWith(HIDDEN))).toBe(false);
        expect(c.largest).toBe(160);
    });

    it('fails every box with area when nothing moved, each 160 px off', () => {
        const c = compare(walkOf(page(0)), walkOf(page(0)), {}, {}, shifts);
        expect(c.geometry).toHaveLength(BOXES.length);
        expect(c.geometry.every((line) => line.endsWith('off by 160 px)'))).toBe(true);
    });

    it.each([-159, -161, -160.015625])('fails every box with area moved by %s px', (dy) => {
        const c = compare(walkOf(page(0)), walkOf(page(dy)), {}, {}, shifts);
        expect(c.geometry).toHaveLength(BOXES.length);
        expect(c.geometry.every((line) => line.endsWith(`off by ${+Math.abs(dy + 160).toFixed(3)} px)`))).toBe(true);
    });

    it('fails the hidden div if it moves, or gains a size', () => {
        expect(compare(walkOf(page(0)), walkOf(page(-160, [0, -160, 0, 0])), {}, {}, shifts).geometry).toEqual([`${HIDDEN}: 0 0 0 0 against 0 -160 0 0 (160 px, the sanctioned shift 0 -160, off by 160 px)`]);
        expect(compare(walkOf(page(0)), walkOf(page(-160, [0, -160, 4, 2])), {}, {}, shifts).geometry).toHaveLength(1);
    });

    it('still fails a style under the shift', () => {
        const head = page(-160);
        head[1] = at(head[1].path, head[1].rect, ['color: rgb(1, 2, 4)']);
        const c = compare(walkOf(page(0)), walkOf(head), {}, {}, shifts);
        expect(c.styles).toEqual(['body>p:nth-of-type(2) color: rgb(1, 2, 3) against rgb(1, 2, 4)']);
        expect(c.geometry).toEqual([]);
    });

    it('fails the same 160 px move on a box the shift doesn\'t name', () => {
        const only = { [`body>p:nth-of-type(1)`]: SHIFT, [HIDDEN]: SHIFT };
        const c = compare(walkOf(page(0)), walkOf(page(-160)), {}, {}, only);
        expect(c.geometry).toHaveLength(BOXES.length - 1);
        expect(c.geometry.every((line) => line.endsWith('(160 px)'))).toBe(true);
    });
});
