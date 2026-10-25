import { describe, expect, it } from 'vitest';
import { heightCappedSizes } from '../photoSizes';

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
});
