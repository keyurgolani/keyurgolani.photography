// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DROPPED_FLOOR, selfTestProblems, type SelfTestResult } from '../selfTest';

const devices = ['desktop', 'phone'] as const;
const passing = (): SelfTestResult[] =>
    devices.flatMap((device) => [
        { device, half: 'raster' as const, ratio: 3.1 },
        { device, half: 'raster' as const, ratio: 2.9 },
        { device, half: 'dropped frames' as const, ratio: 12, dropped: 40, frames: 200 },
        { device, half: 'dropped frames' as const, ratio: 11, dropped: 38, frames: 200 },
    ]);

describe('selfTestProblems', () => {
    it('passes self-tests that each failed their half of the gate', () => {
        expect(selfTestProblems(passing(), { devices, bound: 1.5 })).toEqual([]);
    });

    it('fails a run where the self-tests never ran, as a self-test-only run that skipped them would', () => {
        expect(selfTestProblems([], { devices, bound: 1.5 })).toEqual([
            'desktop, raster: 0 of 2 self-test runs',
            'desktop, dropped frames: 0 of 2 self-test runs',
            'phone, raster: 0 of 2 self-test runs',
            'phone, dropped frames: 0 of 2 self-test runs',
        ]);
    });

    it('fails a self-test head the gate would have passed', () => {
        const results = passing();
        results[1] = { ...results[1], ratio: 1.4 };
        expect(selfTestProblems(results, { devices, bound: 1.5 })).toEqual(['desktop, raster: ratio 1.4, not over 1.5']);
    });

    it("fails a dropped-frame head that drops a single frame, whatever its ratio (Delta 3's floor)", () => {
        expect(DROPPED_FLOOR).toBe(0.05);
        const results = passing();
        // (1 + 1) / (0 + 1) is 2, over the bound, from one frame.
        results[2] = { ...results[2], ratio: 2, dropped: 1, frames: 200 };
        expect(selfTestProblems(results, { devices, bound: 1.5 })).toEqual(['desktop, dropped frames: 1 dropped of 200 frames, under 10']);
        results[2] = { ...results[2], dropped: 10 };
        expect(selfTestProblems(results, { devices, bound: 1.5 })).toEqual([]);
    });

    it('fails a dropped-frame result with no frame count', () => {
        const results = passing();
        results[6] = { device: 'phone', half: 'dropped frames', ratio: 9 };
        expect(selfTestProblems(results, { devices, bound: 1.5 })).toEqual(['phone, dropped frames: no dropped of no frames, under 0']);
    });
});
