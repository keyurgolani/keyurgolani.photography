/**
 * The perf run's self-tests, judged (e2e/themes/surround-perf.spec.ts): each half of the gate tests itself on each
 * device, in both orders, with a head made to fail it. A heavy shadow must cost more than the bound in raster, and a
 * long task on every frame must drop more than the bound's share of frames and at least DROPPED_FLOOR of the frames
 * swept (#124's code review, Delta 3: a ratio over one dropped frame is no test). Every self-test must have run, so a
 * run with none, the self-tests alone included, can't pass.
 */

export type Half = 'raster' | 'dropped frames';

export interface SelfTestResult {
    device: string;
    half: Half;
    /** The head against the base beside it: raster time, or dropped frames as (head + 1) / (base + 1). */
    ratio: number;
    /** The head's dropped frames and the frames it swept, for the dropped-frame half. */
    dropped?: number;
    frames?: number;
}

/** The least share of a sweep's frames the long-task head must drop. */
export const DROPPED_FLOOR = 0.05;

/** Every way the self-tests didn't fail the gate as they must, or none. */
export function selfTestProblems(results: readonly SelfTestResult[], { devices, orders = 2, bound }: { devices: readonly string[]; orders?: number; bound: number }): string[] {
    const problems: string[] = [];
    for (const device of devices) {
        for (const half of ['raster', 'dropped frames'] as const) {
            const runs = results.filter((result) => result.device === device && result.half === half);
            if (runs.length !== orders) problems.push(`${device}, ${half}: ${runs.length} of ${orders} self-test runs`);
            for (const run of runs) {
                if (!(run.ratio > bound)) problems.push(`${device}, ${half}: ratio ${run.ratio}, not over ${bound}`);
                if (half === 'dropped frames') {
                    const floor = Math.ceil(DROPPED_FLOOR * (run.frames ?? 0));
                    if (run.frames === undefined || run.dropped === undefined || run.dropped < floor) problems.push(`${device}, ${half}: ${run.dropped ?? 'no'} dropped of ${run.frames ?? 'no'} frames, under ${floor}`);
                }
            }
        }
    }
    return problems;
}
