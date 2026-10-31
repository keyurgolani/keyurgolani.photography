/**
 * The perf run's lab LCP gate, judged (e2e/themes/lcp.spec.ts). Each route is loaded cold, on a desktop at 1440 and a
 * phone at 390, from v1.2.0's build and from the head in each theme choice, the loads interleaved per route so the
 * machine's load hits both alike. The head passes a route, device and theme when its median LCP is at most the base's
 * median times LCP_BOUND.ratio and at most LCP_BOUND.ceilingMs (the themes scope, item 7). TBT is reported beside it,
 * against the same base, with no gate. Every cell needs all its loads, and every load an LCP, or the run fails: a
 * cell with no samples has nothing to compare and would otherwise pass.
 */

export const LCP_BOUND = { ratio: 1.1, ceilingMs: 2500 } as const;
/** Cold loads per route, device and build or theme: the median of 5. */
export const LCP_LOADS = 5;
/** Lighthouse's long-task threshold: TBT counts what each task runs past it. */
export const LONG_TASK_MS = 50;

export interface LcpSample {
    route: string;
    device: string;
    /** `base` for v1.2.0, or the head's theme choice. */
    variant: string;
    /** ms from navigation start; NaN when the load reported none. */
    lcp: number;
    /** ms. */
    tbt: number;
}

export interface LcpVerdict {
    route: string;
    device: string;
    theme: string;
    baseLcp: number;
    headLcp: number;
    ratio: number;
    baseTbt: number;
    headTbt: number;
    pass: boolean;
    /** Why it failed, or empty. */
    why: string[];
}

/** The middle value, or the upper of the two middles; NaN for none. */
export function median(values: readonly number[]): number {
    if (values.length === 0) return Number.NaN;
    return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

/**
 * Total blocking time: what each long task runs past 50 ms after first contentful paint, summed. A task that spans the
 * paint counts from the paint on, as Lighthouse clips it. The lab window ends when the load goes quiet, not at TTI.
 */
export function totalBlockingTime(tasks: readonly { start: number; duration: number }[], fcp: number): number {
    return tasks.reduce((sum, task) => sum + Math.max(0, task.start + task.duration - Math.max(task.start, fcp) - LONG_TASK_MS), 0);
}

/** Every route, device and head theme against the base's route and device, and every way the samples fall short. */
export function lcpVerdicts(samples: readonly LcpSample[], { routes, devices, themes, loads = LCP_LOADS }: { routes: readonly string[]; devices: readonly string[]; themes: readonly string[]; loads?: number }): { verdicts: LcpVerdict[]; problems: string[] } {
    const problems: string[] = [];
    const cell = (route: string, device: string, variant: string) => {
        const runs = samples.filter((sample) => sample.route === route && sample.device === device && sample.variant === variant);
        if (runs.length !== loads) problems.push(`${route}, ${device}, ${variant}: ${runs.length} of ${loads} loads`);
        const missing = runs.filter((sample) => !Number.isFinite(sample.lcp)).length;
        if (missing > 0) problems.push(`${route}, ${device}, ${variant}: ${missing} load${missing === 1 ? '' : 's'} with no LCP`);
        const measured = runs.filter((sample) => Number.isFinite(sample.lcp));
        return { lcp: median(measured.map((sample) => sample.lcp)), tbt: median(runs.map((sample) => sample.tbt)) };
    };
    const verdicts: LcpVerdict[] = [];
    for (const route of routes) {
        for (const device of devices) {
            const base = cell(route, device, 'base');
            for (const theme of themes) {
                const head = cell(route, device, theme);
                const ratio = head.lcp / base.lcp;
                const why: string[] = [];
                if (!(ratio <= LCP_BOUND.ratio)) why.push(`${Number.isFinite(ratio) ? ratio.toFixed(2) : 'no'} × the base, over ${LCP_BOUND.ratio}`);
                if (!(head.lcp <= LCP_BOUND.ceilingMs)) why.push(`${Number.isFinite(head.lcp) ? Math.round(head.lcp) : 'no'} ms, over ${LCP_BOUND.ceilingMs} ms`);
                verdicts.push({ route, device, theme, baseLcp: base.lcp, headLcp: head.lcp, ratio, baseTbt: base.tbt, headTbt: head.tbt, pass: why.length === 0, why });
            }
        }
    }
    return { verdicts, problems };
}

const ms = (value: number) => (Number.isFinite(value) ? String(Math.round(value)) : '–');

/** The verdicts as a Markdown table. */
export function lcpTable(verdicts: readonly LcpVerdict[]): string {
    return [
        '| Route | Device | Head theme | v1.2.0 LCP ms | Head LCP ms | Ratio | Verdict | v1.2.0 TBT ms | Head TBT ms |',
        '|---|---|---|---|---|---|---|---|---|',
        ...verdicts.map((v) => `| ${v.route} | ${v.device} | ${v.theme} | ${ms(v.baseLcp)} | ${ms(v.headLcp)} | ${Number.isFinite(v.ratio) ? v.ratio.toFixed(2) : '–'} | ${v.pass ? 'pass' : `fail: ${v.why.join('; ')}`} | ${ms(v.baseTbt)} | ${ms(v.headTbt)} |`),
    ].join('\n');
}
