// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ifNoneMatchHits, opaqueTag, parseIfNoneMatch } from '../conditional';

describe('parseIfNoneMatch', () => {
    it('reads *, one tag, and a list of strong and weak tags', () => {
        expect(parseIfNoneMatch('*')).toEqual({ any: true });
        expect(parseIfNoneMatch(' * ')).toEqual({ any: true });
        expect(parseIfNoneMatch('"a"')).toEqual({ any: false, tags: ['"a"'] });
        expect(parseIfNoneMatch('W/"a"')).toEqual({ any: false, tags: ['"a"'] });
        expect(parseIfNoneMatch('"a", W/"b",\t"c"')).toEqual({ any: false, tags: ['"a"', '"b"', '"c"'] });
        expect(parseIfNoneMatch('""')).toEqual({ any: false, tags: ['""'] });
    });

    it('keeps a comma inside a tag, and skips empty list elements', () => {
        expect(parseIfNoneMatch('"a,b", "c"')).toEqual({ any: false, tags: ['"a,b"', '"c"'] });
        expect(parseIfNoneMatch(', "a",, "b" ,')).toEqual({ any: false, tags: ['"a"', '"b"'] });
    });

    it('answers null for an absent, empty, or malformed header', () => {
        for (const value of [null, undefined, '', '  ', ',', 'a', '"a', 'a"', 'w/"a"', 'W/ "a"', 'W/a', '"a" "b"', '"a" b', '"a", *', '*, "a"', '**', '"a\u0001"', '"a"b"']) {
            expect(parseIfNoneMatch(value), JSON.stringify(value)).toBeNull();
        }
    });
});

describe('ifNoneMatchHits', () => {
    const tag = 'W/"abc"';

    it('matches by weak comparison, in a list, or for *', () => {
        expect(opaqueTag(tag)).toBe('"abc"');
        expect(opaqueTag('"abc"')).toBe('"abc"');
        for (const header of ['W/"abc"', '"abc"', '"x", W/"abc"', 'W/"x", "abc", "y"', '*']) {
            expect(ifNoneMatchHits(header, tag), header).toBe(true);
            expect(ifNoneMatchHits(header, '"abc"'), header).toBe(true);
        }
    });

    it('misses a different, malformed, or absent tag', () => {
        for (const header of [null, '', 'W/"abd"', '"ABC"', '"abc ', 'abc', '"x", "y"', '"abc" junk', 'W/"abc", *']) {
            expect(ifNoneMatchHits(header, tag), String(header)).toBe(false);
        }
    });
});
