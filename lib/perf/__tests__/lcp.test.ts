import { describe, expect, it } from 'vitest';
import { LCP_BOUND, lcpTable, lcpVerdicts, median, totalBlockingTime, type LcpSample } from '../lcp';

const shape = { routes: ['Home'], devices: ['desktop'], themes: ['dark'], loads: 3 };
const loads = (variant: string, lcps: number[], tbt = 0): LcpSample[] => lcps.map((lcp) => ({ route: 'Home', device: 'desktop', variant, lcp, tbt }));

describe('median', () => {
    it('takes the middle of an odd count and the upper middle of an even one', () => {
        expect(median([5, 1, 3])).toBe(3);
        expect(median([4, 1, 3, 2])).toBe(3);
        expect(median([])).toBeNaN();
    });
});

describe('totalBlockingTime', () => {
    it('counts what each task runs past 50 ms after first contentful paint, clipping a task that spans it', () => {
        // Before the paint: nothing. Spanning it at 100: 120 ms after it, so 70. After it: 80 − 50 = 30, and 40 ms: none.
        expect(totalBlockingTime([{ start: 0, duration: 90 }, { start: 60, duration: 160 }, { start: 300, duration: 80 }, { start: 400, duration: 40 }], 100)).toBe(100);
    });
});

describe('lcpVerdicts', () => {
    it('passes a head within 1.10 × the base and under 2,500 ms, on the medians', () => {
        const { verdicts, problems } = lcpVerdicts([...loads('base', [1000, 900, 5000]), ...loads('dark', [1090, 3000, 800])], shape);
        expect(problems).toEqual([]);
        expect(verdicts).toHaveLength(1);
        expect(verdicts[0]).toMatchObject({ baseLcp: 1000, headLcp: 1090, pass: true, why: [] });
    });

    it('fails a head past the ratio, and one past the ceiling even when the base is as slow', () => {
        const slower = lcpVerdicts([...loads('base', [1000, 1000, 1000]), ...loads('dark', [1110, 1110, 1110])], shape).verdicts[0];
        expect(slower.pass).toBe(false);
        expect(slower.why.join()).toContain(`over ${LCP_BOUND.ratio}`);
        const late = lcpVerdicts([...loads('base', [2600, 2600, 2600]), ...loads('dark', [2600, 2600, 2600])], shape).verdicts[0];
        expect(late.pass).toBe(false);
        expect(late.why).toEqual([`2600 ms, over ${LCP_BOUND.ceilingMs} ms`]);
    });

    it('names a cell short of its loads or with a load that reported no LCP, and never passes a cell with none', () => {
        const { verdicts, problems } = lcpVerdicts([...loads('base', [1000, 1000]), ...loads('dark', [Number.NaN, Number.NaN, Number.NaN])], shape);
        expect(problems).toEqual(['Home, desktop, base: 2 of 3 loads', 'Home, desktop, dark: 3 loads with no LCP']);
        expect(verdicts[0].pass).toBe(false);
        expect(lcpTable(verdicts)).toContain('| Home | desktop | dark | 1000 | – | – | fail: no × the base');
    });

    it('wants every route, device and theme', () => {
        const { verdicts, problems } = lcpVerdicts([], { routes: ['Home', 'Work'], devices: ['desktop', 'phone'], themes: ['dark', 'black'], loads: 5 });
        expect(verdicts).toHaveLength(8);
        expect(verdicts.every((v) => !v.pass)).toBe(true);
        expect(problems).toContain('Work, phone, black: 0 of 5 loads');
    });
});
