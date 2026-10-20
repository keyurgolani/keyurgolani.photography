import { describe, expect, it } from 'vitest';
import { photoEntryName, photoImageAlt, type PhotoAlt } from '../photoName';

const heron: PhotoAlt = { kind: 'described', text: 'A heron lifting off a gray lake' };
const decorative: PhotoAlt = { kind: 'decorative' };

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

    it('gives each position in a set its own name', () => {
        const names = Array.from({ length: 12 }, (_, index) => photoEntryName({ position: index + 1, total: 12 }));
        expect(new Set(names).size).toBe(12);
    });
});

describe('photoImageAlt', () => {
    it('is the description alone', () => {
        expect(photoImageAlt({ alt: heron, position: 2, total: 10 })).toBe('A heron lifting off a gray lake');
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
});

describe.each([
    ['photoEntryName', photoEntryName],
    ['photoImageAlt', photoImageAlt],
])('%s', (_, build) => {
    it.each([
        ['a position under 1', { position: 0, total: 3 }],
        ['a position past the total', { position: 4, total: 3 }],
        ['a total under 1', { position: 1, total: 0 }],
        ['a fractional position', { position: 1.5, total: 3 }],
        ['a position that is not a number', { position: Number.NaN, total: 3 }],
    ])('throws on %s', (_, input) => {
        expect(() => build(input)).toThrow(RangeError);
    });
});
