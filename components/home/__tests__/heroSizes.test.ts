import { describe, expect, it } from 'vitest';
import { heroSizes } from '../heroSizes';

// #6's size rule for Home's slide, which fills the viewport: a cover crop needs the wider of the viewport and the
// photograph at the viewport's height, a contain one the narrower. Never a flat 100vw, which asks a phone for a
// landscape photograph at a third of the width it's drawn at.
describe('heroSizes', () => {
    it('asks for the photograph at the viewport\'s height wherever the screen is narrower than its shape', () => {
        expect(heroSizes({ width: 2400, height: 1600 })).toBe('(min-aspect-ratio: 1500/1000) 100vw, 150vh');
        expect(heroSizes({ width: 3000, height: 1000 })).toBe('(min-aspect-ratio: 3000/1000) 100vw, 300vh');
        expect(heroSizes({ width: 1600, height: 2400 })).toBe('(min-aspect-ratio: 667/1000) 100vw, 66.67vh');
    });

    it('caps a contain crop at the viewport\'s height times its shape instead', () => {
        expect(heroSizes({ width: 2400, height: 1600 }, 'contain')).toBe('(min-aspect-ratio: 1500/1000) 150vh, 100vw');
    });
});
