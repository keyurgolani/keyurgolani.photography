import { describe, expect, it } from 'vitest';
import { compare, failures, type Walk, type Walked } from '../e2e/themes/computed';

// The Dark parity gate's exact shift (#171): a sanctioned scroll moves every box by exactly its distance, with no
// tolerance band. A box moved by any other distance, by a fraction too, or not moved at all, fails; so does any style.

const element = (path: string, rect: Walked['rect'], styles = ['color: rgb(1, 2, 3)']): Walked => ({ path, styles, pseudos: {}, rect, slot: false });
const walk = (elements: Walked[]): Walk => ({ tokens: { root: {}, body: {} }, elements, resolved: { body: 'body' }, folded: [], foldedPinned: [] });

// Chromium's boxes are in 1/64 px, as the gate reads them.
const BASE = [element('body', [0, 0, 1440, 1191.140625]), element('body>main:nth-of-type(1)', [0, 56, 1440, 1135.140625]), element('body>main:nth-of-type(1)>ul:nth-of-type(1)>li:nth-of-type(1)', [47.515625, 298.953125, 771.21875, 633.140625])];
const moved = (dy: number, dx = 0) => BASE.map((e) => element(e.path, [e.rect[0] + dx, e.rect[1] + dy, e.rect[2], e.rect[3]]));
const SHIFT = Object.fromEntries(BASE.map((e) => [e.path, [0, -160] as const]));

describe("the parity gate's exact shift", () => {
    it('passes boxes moved by exactly the sanctioned shift, and lists each one', () => {
        const c = compare(walk(BASE), walk(moved(-160)), {}, {}, SHIFT);
        expect(failures(c)).toEqual([]);
        expect(c.deltas).toHaveLength(BASE.length);
        expect(c.largest).toBe(160);
    });

    it.each([-159, -161, -160.015625, -159.984375, 0])('fails boxes moved by %s px, not -160', (dy) => {
        const c = compare(walk(BASE), walk(moved(dy)), {}, {}, SHIFT);
        expect(c.geometry).toHaveLength(BASE.length);
        expect(c.geometry.every((line) => line.includes(`off by ${+Math.abs(dy + 160).toFixed(3)} px`))).toBe(true);
    });

    it('fails a box moved sideways too', () => {
        expect(compare(walk(BASE), walk(moved(-160, 1)), {}, {}, SHIFT).geometry).toHaveLength(BASE.length);
    });

    it('fails a box the shift names that the head resized', () => {
        const head = moved(-160);
        head[2] = element(head[2].path, [head[2].rect[0], head[2].rect[1], head[2].rect[2], head[2].rect[3] + 1]);
        expect(compare(walk(BASE), walk(head), {}, {}, SHIFT).geometry).toHaveLength(1);
    });

    it('still fails a style under the shift', () => {
        const head = moved(-160);
        head[1] = element(head[1].path, head[1].rect, ['color: rgb(1, 2, 4)']);
        expect(compare(walk(BASE), walk(head), {}, {}, SHIFT).styles).toHaveLength(1);
    });

    it('fails the same 160 px move on boxes it doesn\'t name', () => {
        expect(compare(walk(BASE), walk(moved(-160))).geometry).toHaveLength(BASE.length);
    });
});
