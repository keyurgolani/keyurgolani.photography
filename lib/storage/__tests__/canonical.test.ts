// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { canonicalJson, sameCanonical } from '../canonical';

/**
 * sameCanonical() answers what comparing canonicalJson() would, null
 * standing in for an absent value, without building the text for values
 * that are already the same JSON.
 */

const viaText = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

describe('sameCanonical()', () => {
    const cases: [string, unknown, unknown][] = [
        ['equal records in another key order', { a: 1, b: { c: [1, 2], d: 'x' } }, { b: { d: 'x', c: [1, 2] }, a: 1 }],
        ['an absent optional and a missing key', { a: 1, b: undefined }, { a: 1 }],
        ['absent and null', undefined, null],
        ['text in NFD and NFC', 'Café', 'Café'],
        ['a key in NFD and NFC', { 'é': 1 }, { 'é': 1 }],
        ['another number', { a: 1 }, { a: 2 }],
        ['another order', [1, 2], [2, 1]],
        ['an extra key', { a: 1 }, { a: 1, b: 2 }],
        ['an array and an object', [1], { 0: 1 }],
        ['a string and a number', '1', 1],
        ['null and an empty object', null, {}],
    ];
    for (const [name, a, b] of cases) {
        it(`agrees with canonicalJson() for ${name}`, () => {
            expect(sameCanonical(a, b)).toBe(viaText(a, b));
            expect(sameCanonical(b, a)).toBe(viaText(a, b));
        });
    }

    it('still refuses what canonicalJson() refuses, once the values differ', () => {
        expect(() => sameCanonical({ a: Number.NaN }, { a: 1 })).toThrow(TypeError);
    });
});
