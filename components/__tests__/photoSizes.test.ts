import { describe, expect, it } from 'vitest';
import { heightCappedSizes, ONE_RUNG_DOWN, photoSizes } from '../photoSizes';

describe('heightCappedSizes', () => {
    it('switches to the height cap once the viewport is wider than the photograph allows', () => {
        // A 3:2 photograph at most 82vh tall is 123vh wide, which is less than 100vw past 1.23:1.
        expect(heightCappedSizes(2400, 1600, 82, [{ vw: 100 }])).toBe('(min-aspect-ratio: 1230/1000) 123vh, 100vw');
        // A 2:3 one binds much sooner.
        expect(heightCappedSizes(1600, 2400, 82, [{ vw: 100 }])).toBe('(min-aspect-ratio: 547/1000) 54.67vh, 100vw');
    });

    it('caps each width rule in order, the media ones first and the last with none', () => {
        expect(heightCappedSizes(2400, 1600, 100, [{ media: '(min-width: 48rem)', vw: 80 }, { vw: 100 }])).toBe(
            '(min-width: 48rem) and (min-aspect-ratio: 1875/1000) 150vh, (min-width: 48rem) 80vw, (min-aspect-ratio: 1500/1000) 150vh, 100vw',
        );
    });

    it('takes a rule\'s fixed offset off the height cap, times the shape', () => {
        // 7.5rem off a 3:2 photograph's height is 11.25rem off its width; a 2:3 one's is 5rem.
        expect(heightCappedSizes(2400, 1600, 100, [{ media: '(max-height: 39.99rem)', vw: 80, offsetRem: 7.5 }, { vw: 100 }])).toBe(
            '(max-height: 39.99rem) and (min-aspect-ratio: 1875/1000) calc(150vh - 11.25rem), (max-height: 39.99rem) 80vw, (min-aspect-ratio: 1500/1000) 150vh, 100vw',
        );
        expect(heightCappedSizes(1600, 2400, 100, [{ vw: 100, offsetRem: 7.5 }])).toBe('(min-aspect-ratio: 667/1000) calc(66.67vh - 5rem), 100vw');
    });
});

// #6's size rule: the width a photograph needs is the larger of the box's width and the box's height times the
// photograph's shape for a cover crop, and the smaller for a contain one.
describe('photoSizes', () => {
    const landscape = { width: 2400, height: 1600 };
    const portrait = { width: 1600, height: 2400 };

    it('asks a cover crop in a box of fixed shape for the photograph at the box\'s height when that is wider', () => {
        // A 3:2 photograph covering a 4:3 box is 1.125 boxes wide; a 2:3 one is cut to the box's width.
        expect(photoSizes(landscape, 'cover', [{ vw: 100, ratio: 4 / 3 }])).toBe('112.5vw');
        expect(photoSizes(portrait, 'cover', [{ vw: 100, ratio: 4 / 3 }])).toBe('100vw');
        // In a 4:5 box a 3:2 photograph is 1.875 boxes wide.
        expect(photoSizes(landscape, 'cover', [{ vw: 40, ratio: 4 / 5 }])).toBe('75vw');
    });

    it('asks a contain crop for the narrower of the two', () => {
        expect(photoSizes(landscape, 'contain', [{ vw: 100, ratio: 4 / 3 }])).toBe('100vw');
        // A 2:3 photograph shown whole in a 4:3 box is half its width.
        expect(photoSizes(portrait, 'contain', [{ vw: 100, ratio: 4 / 3 }])).toBe('50vw');
    });

    it('takes the box\'s fixed share off times the same factor', () => {
        expect(photoSizes(landscape, 'cover', [{ vw: 100, lessRem: 2, ratio: 4 / 3 }])).toBe('calc(112.5vw - 2.25rem)');
        expect(photoSizes(portrait, 'contain', [{ vw: 100, lessRem: 2, ratio: 4 / 3 }])).toBe('calc(50vw - 1rem)');
    });

    it('in a box the screen sizes, switches to the height past the photograph\'s shape, one way for cover and the other for contain', () => {
        // Home's slide, the viewport: a 3:2 photograph covers it at 150vh wide on any screen narrower than 3:2.
        expect(photoSizes(landscape, 'cover', [{ vw: 100, heightVh: 100 }])).toBe('(min-aspect-ratio: 1500/1000) 100vw, 150vh');
        expect(photoSizes(portrait, 'cover', [{ vw: 100, heightVh: 100 }])).toBe('(min-aspect-ratio: 667/1000) 100vw, 66.67vh');
        // Shown whole, the height caps it on any screen wider than its shape, as heightCappedSizes() has it.
        expect(photoSizes(landscape, 'contain', [{ vw: 100, heightVh: 82 }])).toBe(heightCappedSizes(2400, 1600, 82, [{ vw: 100 }]));
    });

    it('scales a box\'s lengths, for the one rung smaller rule 5 allows, and only that box\'s', () => {
        expect(ONE_RUNG_DOWN).toBeCloseTo(2 / 3);
        expect(photoSizes(landscape, 'cover', [{ media: '(min-width: 768px)', vw: 40, ratio: 4 / 5 }, { vw: 100, lessRem: 2, ratio: 4 / 3, scale: ONE_RUNG_DOWN }])).toBe(
            '(min-width: 768px) 75vw, calc(75vw - 1.5rem)',
        );
        // The switch stays where the box's width and the photograph at its height meet; only the lengths shrink.
        expect(photoSizes(landscape, 'cover', [{ vw: 100, heightVh: 100, scale: 0.5 }])).toBe('(min-aspect-ratio: 1500/1000) 50vw, 75vh');
    });

    it('takes each box in order, the media ones first and the last with none', () => {
        expect(
            photoSizes(landscape, 'cover', [
                { media: '(min-width: 768px)', vw: 40, ratio: 4 / 5 },
                { vw: 100, lessRem: 2, ratio: 4 / 3 },
            ]),
        ).toBe('(min-width: 768px) 75vw, calc(112.5vw - 2.25rem)');
        expect(
            photoSizes(landscape, 'contain', [
                { media: '(min-width: 485px)', vw: 93.4, heightVh: 82 },
                { vw: 100, lessRem: 2, heightVh: 82 },
            ]),
        ).toBe('(min-width: 485px) and (min-aspect-ratio: 1317/1000) 123vh, (min-width: 485px) 93.4vw, (min-aspect-ratio: 1230/1000) 123vh, calc(100vw - 2rem)');
    });
});
