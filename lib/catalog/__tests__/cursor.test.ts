// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decodeSeriesCursor, encodeSeriesCursor, MAX_CURSOR_LENGTH, type SeriesCursor } from '../cursor';

const REVISION = `rev_${'a'.repeat(64)}`;
const CURSOR: SeriesCursor = { revisionId: REVISION, seriesId: 'ser_fixture-a', offset: 100 };
const b64 = (text: string) => Buffer.from(text, 'latin1').toString('base64url');

describe('the series cursor', () => {
    it('round-trips, and the same position always gives the same string', () => {
        const text = encodeSeriesCursor(CURSOR);
        expect(decodeSeriesCursor(text)).toEqual(CURSOR);
        expect(encodeSeriesCursor({ ...CURSOR })).toBe(text);
        expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('is opaque, and the longest one fits well under the length cap', () => {
        const longest = encodeSeriesCursor({ revisionId: `rev_${'f'.repeat(64)}`, seriesId: `ser_${'z'.repeat(63)}`, offset: 9_999_999 });
        expect(longest.length).toBeLessThan(MAX_CURSOR_LENGTH);
        expect(encodeSeriesCursor(CURSOR)).not.toContain('ser_');
    });

    it('differs for each revision, series, and offset', () => {
        const texts = new Set([
            encodeSeriesCursor(CURSOR),
            encodeSeriesCursor({ ...CURSOR, revisionId: `rev_${'b'.repeat(64)}` }),
            encodeSeriesCursor({ ...CURSOR, seriesId: 'ser_fixture-b' }),
            encodeSeriesCursor({ ...CURSOR, offset: 200 }),
        ]);
        expect(texts.size).toBe(4);
    });

    it('refuses to encode a position it could never decode', () => {
        expect(() => encodeSeriesCursor({ ...CURSOR, revisionId: 'rev_a' })).toThrow(TypeError);
        expect(() => encodeSeriesCursor({ ...CURSOR, seriesId: 'fixture-a' })).toThrow(TypeError);
        for (const offset of [0, -1, 1.5, 10_000_000, Number.NaN]) expect(() => encodeSeriesCursor({ ...CURSOR, offset })).toThrow(RangeError);
    });

    it.each([
        ['not a string', 42],
        ['empty', ''],
        ['one over the length cap', 'A'.repeat(MAX_CURSOR_LENGTH + 1)],
        ['standard base64 characters', `${encodeSeriesCursor(CURSOR)}+`],
        ['a slash', `${encodeSeriesCursor(CURSOR).slice(0, 10)}/${encodeSeriesCursor(CURSOR).slice(10)}`],
        ['padding', `${b64(`1.${REVISION}.ser_fixture-a.10`)}=`],
        ['percent-encoding', encodeURIComponent(`${encodeSeriesCursor(CURSOR)}=`)],
        ['another version', b64(`2.${REVISION}.ser_fixture-a.100`)],
        ['a short revision ID', b64('1.rev_aaaa.ser_fixture-a.100')],
        ['an uppercase revision ID', b64(`1.rev_${'A'.repeat(64)}.ser_fixture-a.100`)],
        ['a series ID without its prefix', b64(`1.${REVISION}.fixture-a.100`)],
        ['offset 0', b64(`1.${REVISION}.ser_fixture-a.0`)],
        ['a leading zero', b64(`1.${REVISION}.ser_fixture-a.0100`)],
        ['a negative offset', b64(`1.${REVISION}.ser_fixture-a.-100`)],
        ['eight digits', b64(`1.${REVISION}.ser_fixture-a.10000000`)],
        ['a fractional offset', b64(`1.${REVISION}.ser_fixture-a.100.5`)],
        ['an extra field', b64(`1.${REVISION}.ser_fixture-a.100.x`)],
        ['a trailing newline', b64(`1.${REVISION}.ser_fixture-a.100\n`)],
        ['non-ASCII bytes', b64(`1.${REVISION}.ser_fixture-é.100`)],
        ['JSON', b64(JSON.stringify(CURSOR))],
    ])('decodes nothing from %s', (_case, text) => {
        expect(decodeSeriesCursor(text)).toBeNull();
    });

    it('decodes nothing from a cursor with stray bits in its last character', () => {
        const text = encodeSeriesCursor(CURSOR);
        // Each base64url character carries 6 bits; when the byte count isn't a multiple of 3 the last one has unused bits.
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        const last = alphabet.indexOf(text.at(-1) as string);
        const variants = alphabet.split('').filter((char, index) => index !== last && Buffer.from(text.slice(0, -1) + char, 'base64url').equals(Buffer.from(text, 'base64url')));
        expect(variants.length).toBeGreaterThan(0);
        for (const char of variants) expect(decodeSeriesCursor(text.slice(0, -1) + char)).toBeNull();
    });
});
