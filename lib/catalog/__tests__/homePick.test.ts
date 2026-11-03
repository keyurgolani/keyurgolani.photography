// @vitest-environment node
import { randomInt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { homeStartPick, TEST_HOME_PICK_ENV } from '../homePick';

// The test-only start pick the e2e harness scripts. Production never sets it.

describe('homeStartPick', () => {
    it('is crypto.randomInt when the test-only variable is unset, empty, or malformed', () => {
        for (const value of [undefined, '', '  ', 'a', '1,', ',1', '1,,2', '-1', '1.5', '1 2', '0x1', '1234567']) {
            expect(homeStartPick({ [TEST_HOME_PICK_ENV]: value }), String(value)).toBe(randomInt);
        }
        expect(homeStartPick({})).toBe(randomInt);
    });

    it('answers the scripted indexes in turn, across renders, and starts again after the last', () => {
        const env = { [TEST_HOME_PICK_ENV]: '2,0,1' };
        const answers = Array.from({ length: 7 }, () => homeStartPick(env)(3));
        expect(answers).toEqual([2, 0, 1, 2, 0, 1, 2]);
    });

    it('wraps a scripted index to the number of featured series that resolve', () => {
        const env = { [TEST_HOME_PICK_ENV]: '5,4' };
        expect([homeStartPick(env)(3), homeStartPick(env)(3), homeStartPick(env)(2)]).toEqual([2, 1, 1]);
    });

    it('keeps each script\'s place apart', () => {
        const a = { [TEST_HOME_PICK_ENV]: '1,2' };
        const b = { [TEST_HOME_PICK_ENV]: ' 0,1,2 ' };
        expect([homeStartPick(a)(3), homeStartPick(b)(3), homeStartPick(a)(3), homeStartPick(b)(3)]).toEqual([1, 0, 2, 1]);
    });
});
