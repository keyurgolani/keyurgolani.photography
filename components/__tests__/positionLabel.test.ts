import { describe, expect, it } from 'vitest';
import { padPosition, positionLabel } from '../positionLabel';

// The one padding rule Home's counter and the Viewer's header share (#4, #7): each number padded to the digits of the
// total, never under the mockup's two.
describe('positionLabel', () => {
    it.each([
        [3, 9, '03 / 09'],
        [9, 9, '09 / 09'],
        [3, 10, '03 / 10'],
        [10, 10, '10 / 10'],
        [7, 100, '007 / 100'],
        [100, 100, '100 / 100'],
        [7, 120, '007 / 120'],
        [120, 120, '120 / 120'],
    ])('pads %i of %i as %s', (position, total, label) => {
        expect(positionLabel(position, total)).toBe(label);
    });

    it('pads one number to the total\'s digits, for a line that names a single position', () => {
        expect([padPosition(3, 9), padPosition(3, 10), padPosition(3, 100), padPosition(12, 120), padPosition(1200, 1200)]).toEqual(['03', '03', '003', '012', '1200']);
    });
});
