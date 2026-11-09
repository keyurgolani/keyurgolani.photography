import { describe, expect, it } from 'vitest';
import { coverSizes } from '../seriesCopy';

// The series cover is drawn at its own shape, at most 82svh tall, in the column: the window less its two gutters,
// clamp(1rem, 3.3vw, 3rem) each (styles/tokens.css). #6's size rule then asks for the narrower of the column and the
// photograph at 82vh, the same rule Work's covers and Home's slide take.
describe('the series cover\'s sizes', () => {
    it('takes the gutters off the column, 2rem on a phone and 6.6vw past 485 px, and the 82vh cap where it binds', () => {
        expect(coverSizes({ width: 2400, height: 1600 })).toBe(
            '(min-width: 485px) and (min-aspect-ratio: 1317/1000) 123vh, (min-width: 485px) 93.4vw, (min-aspect-ratio: 1230/1000) 123vh, calc(100vw - 2rem)',
        );
        expect(coverSizes({ width: 1600, height: 2400 })).toBe(
            '(min-width: 485px) and (min-aspect-ratio: 585/1000) 54.67vh, (min-width: 485px) 93.4vw, (min-aspect-ratio: 547/1000) 54.67vh, calc(100vw - 2rem)',
        );
    });

    it('asks for the column without the photograph\'s dimensions', () => {
        expect(coverSizes(null)).toBe('(min-width: 485px) 93.4vw, calc(100vw - 2rem)');
    });
});
