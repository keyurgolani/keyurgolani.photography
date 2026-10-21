import { describe, expect, it } from 'vitest';
import { photoEntryName, photoImageAlt, type PhotoAlt } from '../photoName';

const heron: PhotoAlt = { kind: 'described', text: 'A heron lifting off a gray lake' };
const decorative: PhotoAlt = { kind: 'decorative' };
/** Shapes the type rules out but a JSON record can still carry, such as #14's drafts. */
const untyped = (alt: object) => alt as unknown as PhotoAlt;

describe('photoEntryName', () => {
    it('leads with the description, then the position', () => {
        expect(photoEntryName({ alt: heron, position: 2, total: 10 })).toBe('A heron lifting off a gray lake, photograph 2 of 10');
    });

    it('is the position alone for a decorative photo', () => {
        expect(photoEntryName({ alt: decorative, position: 2, total: 10 })).toBe('Photograph 2 of 10');
    });

    it('is the position alone on a legacy surface with no alt', () => {
        expect(photoEntryName({ position: 10, total: 10 })).toBe('Photograph 10 of 10');
    });

    it('falls back to the position when a description is blank', () => {
        expect(photoEntryName({ alt: { kind: 'described', text: '  ' }, position: 1, total: 3 })).toBe('Photograph 1 of 3');
    });

    it.each(['.', ',', ';', ':', '. ', ' ;\n'])('drops a trailing %j before the position', (ending) => {
        const alt: PhotoAlt = { kind: 'described', text: `A heron lifting off a gray lake${ending}` };
        expect(photoEntryName({ alt, position: 2, total: 10 })).toBe('A heron lifting off a gray lake, photograph 2 of 10');
    });

    it('falls back to the position when a description is only punctuation', () => {
        expect(photoEntryName({ alt: { kind: 'described', text: ' . ' }, position: 1, total: 3 })).toBe('Photograph 1 of 3');
    });

    it('uses a description marked reviewed', () => {
        expect(photoEntryName({ alt: { ...heron, reviewed: true }, position: 2, total: 10 })).toBe('A heron lifting off a gray lake, photograph 2 of 10');
    });

    it('falls back to the position for a draft marked reviewed: false', () => {
        expect(photoEntryName({ alt: untyped({ ...heron, reviewed: false }), position: 2, total: 10 })).toBe('Photograph 2 of 10');
    });

    it.each([42, null, undefined, ['A heron']])('falls back to the position, without throwing, when the text is %j', (text) => {
        expect(photoEntryName({ alt: untyped({ kind: 'described', text }), position: 2, total: 10 })).toBe('Photograph 2 of 10');
    });

    it('gives each position in a set its own name', () => {
        const names = Array.from({ length: 12 }, (_, index) => photoEntryName({ position: index + 1, total: 12 }));
        expect(new Set(names).size).toBe(12);
    });
});

describe('photoImageAlt', () => {
    it('is the description alone', () => {
        expect(photoImageAlt({ alt: heron, position: 2, total: 10 })).toBe('A heron lifting off a gray lake');
    });

    it('keeps the punctuation the description ends with, trimmed', () => {
        expect(photoImageAlt({ alt: { kind: 'described', text: ' A heron lifting off a gray lake. ' }, position: 2, total: 10 })).toBe(
            'A heron lifting off a gray lake.',
        );
    });

    it('is empty for a decorative photo', () => {
        expect(photoImageAlt({ alt: decorative, position: 2, total: 10 })).toBe('');
    });

    it('is the position on a legacy surface with no alt', () => {
        expect(photoImageAlt({ position: 1, total: 2 })).toBe('Photograph 1 of 2');
    });

    it('falls back to the position when a description is blank', () => {
        expect(photoImageAlt({ alt: { kind: 'described', text: '' }, position: 3, total: 3 })).toBe('Photograph 3 of 3');
    });

    it('falls back to the position for a draft marked reviewed: false', () => {
        expect(photoImageAlt({ alt: untyped({ ...heron, reviewed: false }), position: 3, total: 3 })).toBe('Photograph 3 of 3');
    });

    it('falls back to the position, without throwing, when the text is not a string', () => {
        expect(photoImageAlt({ alt: untyped({ kind: 'described', text: 42 }), position: 3, total: 3 })).toBe('Photograph 3 of 3');
    });
});

describe.each([
    ['photoEntryName', photoEntryName],
    ['photoImageAlt', photoImageAlt],
])('%s', (_, build) => {
    it.each([
        ['a position under 1', { position: 0, total: 3 }],
        ['a position past the total', { position: 4, total: 3 }],
        ['a total under 1', { position: 1, total: 0 }],
        ['a fractional total', { position: 1, total: 2.5 }],
        ['a total that is not a number', { position: 1, total: Number.NaN }],
        ['an infinite total', { position: 1, total: Number.POSITIVE_INFINITY }],
        ['a fractional position', { position: 1.5, total: 3 }],
        ['a position that is not a number', { position: Number.NaN, total: 3 }],
        ['a position under 1 with a description', { alt: heron, position: 0, total: 3 }],
        ['a position past the total for a decorative photo', { alt: decorative, position: 4, total: 3 }],
    ])('throws on %s', (_, input) => {
        expect(() => build(input)).toThrow(RangeError);
    });

    it('names the total, not the position, when the total is 0', () => {
        expect(() => build({ position: 1, total: 0 })).toThrow('A photo set needs a whole-number total of at least 1, not 0.');
    });
});
