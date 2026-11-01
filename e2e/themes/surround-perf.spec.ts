import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { catalogCodeVersion, DEFAULT_CATALOG_CACHE, perfCatalog } from '../../lib/perf/catalogCache';
import { checkDiskFloor, makeRunTemp, removeRunTemp } from '../../lib/perf/runFiles';
import { tracedToFile, type TraceEvent } from './perfTrace';
import { DROPPED_FLOOR, selfTestProblems, type SelfTestResult } from '../../lib/perf/selfTest';
import { BUDGET_VARIANT_BYTES } from '../../lib/perf/fixture';
import { waitForHydration } from '../support/hydration';
import { expect, test } from '../support/test';
import { phase, readOnlyTree, serve, standInPrints, VARIANT_REQUEST, variantFormat, type Server } from './perfServer';

// The perf run for the sequence's surround (spec §13, PR map item 3), on a 5,000-photo series with every page shown by
// Show more, every slot a real print: the catalog's variant files are sparse, so each image request is answered with
// one tiny valid file of its format, and every slot decodes and wears its window cut, mat and print edge.
//
// It runs non-exclusive on a shared machine, so it gates on ratios, not milliseconds. The base (next before the themes,
// PARITY_BASE_DIR) and the head serve the same catalog side by side, and each sweep of the head (a scroll from the top
// to the end, in Dark, today's, in Black, which has no surround either, and in the two themes with one) is paired with a base sweep taken right beside it, the
// order alternating by round, with the machine's load on every row. Each sweep is traced, and the gate is the median
// ratio of the compositor's total raster time and of its dropped frames (#124's review, M1); the main thread's rAF p95
// is reported beside them, since it snaps to whole frames. A desktop at 1440, DPR 1, and a phone at 390, DPR 3 with
// the CPU throttled 4x, where a blur's raster cost is highest. The throttle slows the main thread only, not the raster
// workers, so the phone's raster cost grows with its DPR, not with the throttle.
//
// The gate tests each half on each device (#124's review, D2 and D8), and every sweep must have raster time to compare,
// since a trace with none would give a ratio near 1 and pass: the head in Dark with a deliberately heavy shadow on
// every slot must cost more than the surround bound in raster, and the head with a 40 ms task on every frame must drop
// more than the bound's share of frames, and at least 5% of the frames it swept (Delta 3). Every self-test must run,
// so a run that skipped them fails (lib/perf/selfTest.ts).
//
// PERF_ROUNDS is at least 3, and anything else fails the run (D7), so a run can't pass with no theme gated.
// PERF_SELFTEST=1 runs the self-tests alone, and its table says so; it passes only if they ran and failed as they must.
//
// The published catalog is built once and served read-only from the cache, never copied (lib/perf/catalogCache.ts), in
// PERF_CATALOG_CACHE or ~/.cache/photography-perf, keyed by its photos, seed, variant sizes and the catalog code's git
// tree. The run checks the disk first (PERF_DISK_MIN_GB) and removes its own temp folder in place when it ends.
//
//   PARITY_BASE_DIR=<built base> PERF_PORTS=3375,3376 [PERF_ROUNDS=3] [PERF_SELFTEST=1] npx playwright test -c e2e/themes/perf.config.ts

const PHOTOS = 5_000;
const SELF_TEST_ONLY = (() => {
    const value = process.env.PERF_SELFTEST;
    if (value !== undefined && value !== '1') throw new Error(`PERF_SELFTEST is 1 or unset, not ${JSON.stringify(value)}`);
    return value === '1';
})();
/** The rounds the themes are gated on: a whole number, at least 3, outside the self-test (D7). */
const ROUNDS = (() => {
    if (SELF_TEST_ONLY) return 0;
    const value = process.env.PERF_ROUNDS ?? '3';
    if (!/^\d+$/.test(value) || Number(value) < 3) throw new Error(`PERF_ROUNDS is a whole number of at least 3, not ${JSON.stringify(value)}`);
    return Number(value);
})();
const THEMES = { dark: 'dark', black: 'black', light: 'light', bright: 'bright' } as const;
type Choice = keyof typeof THEMES;
const DEVICES = {
    desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, throttle: 1, steps: 200 },
    phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, throttle: 4, steps: 120 },
} as const;
/** The head may cost this much more than the base beside it: Dark about nothing, a surround a little. */
const BOUND = { dark: 1.25, surround: 1.5 };
/** Each theme's bound: Black, square prints on the ground with nothing around them, is held to Dark's. */
const THEME_BOUND: Record<Choice, number> = { dark: BOUND.dark, black: BOUND.dark, light: BOUND.surround, bright: BOUND.surround };
/** The self-test's head: a mat and a wide blur on every slot, well past any theme's surround. */
const HEAVY = '[data-photo] { box-shadow: 0 0 0 6px #888, 0 30px 60px -10px #000 !important; }';
/** The dropped-frame self-test's head: 40 ms of main-thread work on every frame, past a 16.7 ms budget. */
const LONG_TASK_MS = 40;
const TRACE_CATEGORIES = ['cc', 'viz', 'gpu', 'disabled-by-default-devtools.timeline.frame'];
/** The profile's categories: the gate's, plus the timeline, without the stack and v8.execute ones (about 125 MB a trace). */
const PROFILE_CATEGORIES = [...TRACE_CATEGORIES, 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing'];
/** A subset of a run's names from a comma list in `variable`, every name known, or all of them when it's unset. */
function subset<T extends string>(variable: string, all: readonly T[]): T[] {
    const value = process.env[variable];
    if (value === undefined) return [...all];
    const names = value.split(',').map((name) => name.trim()).filter(Boolean);
    const unknown = names.filter((name) => !(all as readonly string[]).includes(name));
    if (names.length === 0 || unknown.length > 0) throw new Error(`${variable} names some of ${all.join(', ')}, not ${JSON.stringify(value)}`);
    return names as T[];
}
/** PERF_DEVICES and PERF_THEMES narrow a rerun (the lead's phone Light rerun, 2026-10-31); a full gate sets neither. */
const SWEPT_DEVICES = subset('PERF_DEVICES', Object.keys(DEVICES) as (keyof typeof DEVICES)[]);
const SWEPT_THEMES = subset('PERF_THEMES', Object.keys(THEMES) as Choice[]);
/**
 * PERF_PROFILE_DIR with PERF_PROFILE_IF_OVER=<theme>: when that theme's median raster ratio on a device is past its
 * bound, one sweep each of the head in that theme, the head in Dark and the base is traced with the timeline (streamed
 * under PERF_TRACE_MAX_MB, e2e/themes/perfTrace.ts), and where the raster goes is kept as summary JSON, not the trace.
 */
const PROFILE_DIR = process.env.PERF_PROFILE_DIR;
const PROFILE_IF_OVER = process.env.PERF_PROFILE_IF_OVER as Choice | undefined;
if (PROFILE_IF_OVER !== undefined && !(PROFILE_IF_OVER in THEMES)) throw new Error(`PERF_PROFILE_IF_OVER is a theme, not ${JSON.stringify(PROFILE_IF_OVER)}`);
const BASE = process.env.PARITY_BASE_DIR;
const ports = (process.env.PERF_PORTS ?? '').split(',').map(Number).filter(Boolean);

test.skip(!BASE, 'Set PARITY_BASE_DIR to a built checkout of the base.');

interface Sweep {
    rafP95: number;
    raster: number;
    dropped: number;
}

/** A traced scroll from the top to the end in even steps, one per frame. Raster in ms, summed; dropped frames, counted. */
async function sweep(browser: Browser, page: Page, steps: number): Promise<Sweep> {
    await browser.startTracing(page, { categories: TRACE_CATEGORIES });
    let rafP95: number;
    try {
        rafP95 = await scroll(page, steps);
    } catch (error) {
        await browser.stopTracing().catch(() => undefined);
        throw error;
    }
    const trace = JSON.parse((await browser.stopTracing()).toString('utf8')) as { traceEvents?: TraceEvent[] };
    return summarise(trace.traceEvents ?? [], rafP95);
}

/** The scroll from the top to the end in even steps, one per frame; its rAF p95. */
async function scroll(page: Page, steps: number): Promise<number> {
    // The end is read every frame, since the page's height can settle under a theme change after the sweep starts
    // (perf5's first run hung in round 2: the scroll stopped short of an end read once). A scroll that stops moving,
    // or runs past five times its steps, fails by name instead of waiting forever, and so does a sweep past 2 minutes.
    const swept = page.evaluate(
        (count) =>
            new Promise<number>((resolve, reject) => {
                window.scrollTo(0, 0);
                const end = () => document.documentElement.scrollHeight - innerHeight;
                const step = Math.max(40, end() / count);
                const deltas: number[] = [];
                let last = 0;
                let still = 0;
                let at = -1;
                const tick = (now: number) => {
                    deltas.push(now - last);
                    last = now;
                    if (window.scrollY >= end() - 1) {
                        deltas.sort((a, b) => a - b);
                        resolve(+deltas[Math.min(deltas.length - 1, Math.floor(0.95 * deltas.length))].toFixed(2));
                        return;
                    }
                    still = window.scrollY === at ? still + 1 : 0;
                    at = window.scrollY;
                    if (still >= 30 || deltas.length > count * 5) {
                        reject(new Error(`the sweep stopped at ${Math.round(window.scrollY)} of ${Math.round(end())} px after ${deltas.length} frames`));
                        return;
                    }
                    window.scrollBy(0, step);
                    requestAnimationFrame(tick);
                };
                requestAnimationFrame((now) => {
                    last = now;
                    requestAnimationFrame(tick);
                });
            }),
        steps,
    );
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([swept, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('the sweep ran past 2 minutes')), 120_000)))]).finally(() => clearTimeout(timer));
}

/** A sweep's numbers from its trace: raster in ms, summed; dropped frames, counted. */
function summarise(events: TraceEvent[], rafP95: number): Sweep {
    const raster = events.filter((event) => event.name === 'RasterTask' && typeof event.dur === 'number').reduce((sum, event) => sum + (event.dur ?? 0), 0) / 1000;
    const dropped =
        events.filter((event) => event.name === 'DroppedFrame').length +
        events.filter((event) => event.name === 'PipelineReporter' && event.ph === 'b' && event.args?.chrome_frame_reporter?.state === 'STATE_DROPPED').length;
    return { rafP95, raster: +raster.toFixed(1), dropped };
}

/** One profiled sweep: the gate's numbers, and where raster and the rest of the time went, by process and by event. */
async function profileSweep(browser: Browser, page: Page, steps: number, file: string) {
    const { result: rafP95, events, bytes } = await tracedToFile(browser, PROFILE_CATEGORIES, file, () => scroll(page, steps));
    const processName = new Map<number, string>();
    for (const event of events) if (event.ph === 'M' && event.name === 'process_name') processName.set(event.pid, String(event.args?.name ?? '?'));
    const where = (event: TraceEvent) => `${processName.get(event.pid) ?? '?'} ${event.pid}`;
    const rasterByProcess: Record<string, { ms: number; tasks: number }> = {};
    const byProcess = new Map<string, Map<string, number>>();
    for (const event of events) {
        if (event.ph !== 'X' || typeof event.dur !== 'number') continue;
        const key = where(event);
        if (event.name === 'RasterTask') {
            rasterByProcess[key] ??= { ms: 0, tasks: 0 };
            rasterByProcess[key].ms = +(rasterByProcess[key].ms + event.dur / 1000).toFixed(1);
            rasterByProcess[key].tasks++;
        }
        const names = byProcess.get(key) ?? new Map<string, number>();
        names.set(event.name, (names.get(event.name) ?? 0) + event.dur / 1000);
        byProcess.set(key, names);
    }
    const top = Object.fromEntries([...byProcess].map(([key, names]) => [key, [...names].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, ms]) => `${name} ${Math.round(ms)}`)]));
    return { ...summarise(events, rafP95), traceBytes: bytes, traceEvents: events.length, rasterByProcess, top };
}

/** Opens the series and presses Show more until every entry is in, every one a decoded print; returns each press's time to render. */
async function expand(page: Page, url: string) {
    await page.goto(url);
    await waitForHydration(page);
    const entries = page.locator('section[aria-labelledby="series-sequence"] ol > li');
    const button = page.getByRole('button', { name: 'Show more' });
    const renders: number[] = [];
    while (await button.isVisible().catch(() => false)) {
        const before = await entries.count();
        const started = Date.now();
        await button.click();
        await expect.poll(() => entries.count(), { timeout: 60_000 }).toBeGreaterThan(before);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        renders.push(Date.now() - started);
    }
    await expect(entries).toHaveCount(PHOTOS);
    // Every print loads before a sweep, so the sweeps time raster, not loading: in this test only, every image goes
    // eager, since a lazy one off screen never starts and never fires (perf3 hung on that for an hour). The wait is
    // bounded, and a print still loading when it runs out fails the run by name.
    const pending = await page.evaluate(async () => {
        for (const image of document.images) image.loading = 'eager';
        const waits = [...document.images].filter((image) => !image.complete).map((image) => new Promise<string | null>((resolve) => {
            image.addEventListener('load', () => resolve(null), { once: true });
            image.addEventListener('error', () => resolve(null), { once: true });
            setTimeout(() => resolve(image.complete ? null : image.currentSrc || image.src), 60_000);
        }));
        return (await Promise.all(waits)).filter((url): url is string => url !== null);
    });
    expect(pending, 'every print loads inside 60 s').toEqual([]);
    // Polled, so a failed print's re-render has committed before it counts.
    await expect(page.locator('[data-photo="unavailable"]'), 'every slot is a print, none a missing-image box').toHaveCount(0);
    return renders;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const ratio = (head: number, base: number) => (head + 1) / (base + 1);

/** The cached published catalog the servers read (lib/perf/catalogCache.ts), and its one series. */
let catalog: { root: string; slug: string } | undefined;
const servers: Server[] = [];
let temp = '';
let prints: Record<string, Buffer> = {};

test.beforeAll(async () => {
    // Setup's own cap: the catalog, its publish and the two servers.
    test.setTimeout(20 * 60_000);
    // Nothing starts under the disk floor (PERF_DISK_MIN_GB, 20 GB), and the run's scratch is one folder of its own.
    checkDiskFloor(os.tmpdir());
    temp = makeRunTemp('surround-');
    const library = path.join(temp, 'library');
    const siteConfig = path.join(temp, 'site-config');
    fs.mkdirSync(library);
    fs.mkdirSync(siteConfig);
    prints = await standInPrints(12, 8);
    // Built and published once, then served from the cache, read-only and uncopied: setup was most of a run, and under
    // load it ran perf4 out of time; a copy of its sparse files filled the disk (2026-10-31).
    phase(`the ${PHOTOS}-photo published catalog`);
    const cached = await perfCatalog({ photos: PHOTOS, seed: 6, variantBytes: BUDGET_VARIANT_BYTES, code: catalogCodeVersion(process.cwd()) }, process.env.PERF_CATALOG_CACHE ?? DEFAULT_CATALOG_CACHE, path.join(temp, 'catalog'));
    phase({ cache: 'the catalog, served from the cache', built: 'the catalog, built and cached', uncached: 'the catalog, built uncached (catalog code not committed)' }[cached.from]);
    catalog = { root: cached.root, slug: cached.slug };
    phase('the base and head servers');
    // The base is served from a clone of its build, so its tree is only read (v1.2.0's included).
    const base = readOnlyTree(BASE!, path.join(temp, 'base-tree'));
    servers.push(await serve(base, ports[0] ?? 3375, catalog.root, library, siteConfig), await serve(process.cwd(), ports[1] ?? 3376, catalog.root, library, siteConfig));
});

test.afterAll(async () => {
    test.setTimeout(5 * 60_000);
    await Promise.all(servers.map((server) => server.stop()));
    // The run's own temp folder goes, passed or failed, in place: a move to ~/.Trash is the same volume and frees nothing.
    removeRunTemp(temp);
});

test(`a ${PHOTOS}-photo sequence of real prints: the head's scroll, in every theme, against the base beside it`, async ({ browser }) => {
    // Four themes over three rounds on two devices, and the self-tests: 64 traced sweeps of a 5,000-photo page.
    test.setTimeout(40 * 60_000);
    const [base, head] = servers;
    const url = (origin: string) => `${origin}/work/${catalog!.slug}`;
    const rows: string[] = [];
    const notes: string[] = [];
    const ratios: Record<string, { raster: number[]; dropped: number[] }> = {};
    const selfRows: string[] = [];
    const calibration: SelfTestResult[] = [];

    for (const device of SWEPT_DEVICES) {
        const spec = DEVICES[device];
        const open = async (origin: string) => {
            const context = await browser.newContext({ viewport: spec.viewport, deviceScaleFactor: spec.deviceScaleFactor, colorScheme: 'dark', reducedMotion: 'reduce' });
            await context.addInitScript(() => localStorage.setItem('theme', 'dark'));
            const page = await context.newPage();
            await page.route(VARIANT_REQUEST, (route) => {
                const format = variantFormat(route.request().url());
                return route.fulfill({ body: prints[format], contentType: `image/${format}` });
            });
            const renders = await expand(page, url(origin));
            const cdp = await context.newCDPSession(page);
            return { page, renders, cdp };
        };
        phase(`${device}: the base's Show more to all ${PHOTOS}`);
        const basePage = await open(base.origin);
        phase(`${device}: the head's Show more to all ${PHOTOS}`);
        const headPage = await open(head.origin);
        notes.push(`${device}: Show more to all ${PHOTOS}, median ${median(basePage.renders)} ms in the base, ${median(headPage.renders)} ms in the head`);
        const throttle = async (on: boolean) => {
            for (const { cdp } of [basePage, headPage]) await cdp.send('Emulation.setCPUThrottlingRate', { rate: on ? spec.throttle : 1 });
        };
        const paint = (theme: Choice) =>
            headPage.page.evaluate(([choice, painted]) => {
                document.documentElement.setAttribute('data-theme-choice', choice);
                document.documentElement.setAttribute('data-theme', painted);
            }, [theme, THEMES[theme]] as const);

        /** A base sweep and a head sweep, the order alternating by round, each checked for raster time to compare. */
        const pairOf = async (round: number, label: string) => {
            phase(label);
            const pair = round % 2 === 1 ? [basePage, headPage] : [headPage, basePage];
            // Each sweep, tracing included, is bounded too, so a trace that never stops fails the pair by name.
            const bounded = (page: Page, which: string) => {
                let timer: NodeJS.Timeout | undefined;
                return Promise.race([sweep(browser, page, spec.steps), new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${label}: the ${which} sweep ran past 3 minutes`)), 180_000)))]).finally(() => clearTimeout(timer));
            };
            const [first, second] = [await bounded(pair[0].page, 'first'), await bounded(pair[1].page, 'second')];
            const [b, h] = round % 2 === 1 ? [first, second] : [second, first];
            expect(b.raster, `${label}: the base's trace carries raster time`).toBeGreaterThan(0);
            expect(h.raster, `${label}: the head's trace carries raster time`).toBeGreaterThan(0);
            return { b, h };
        };

        await throttle(true);
        for (let round = 1; round <= ROUNDS; round++) {
            phase(`${device}: round ${round} of ${ROUNDS}`);
            for (const theme of SWEPT_THEMES) {
                await paint(theme);
                const load = os.loadavg()[0].toFixed(1);
                const key = `${device} ${theme}`;
                // The order alternates by round, so neither build always sweeps first.
                const { b, h } = await pairOf(round, `${key}, round ${round}`);
                ratios[key] ??= { raster: [], dropped: [] };
                ratios[key].raster.push(h.raster / b.raster);
                ratios[key].dropped.push(ratio(h.dropped, b.dropped));
                rows.push(`| ${device} | ${round} | ${theme} | ${load} | ${b.raster} | ${h.raster} | ${(h.raster / b.raster).toFixed(2)} | ${b.dropped} / ${h.dropped} | ${b.rafP95} / ${h.rafP95} |`);
            }
        }
        const over = PROFILE_IF_OVER && ratios[`${device} ${PROFILE_IF_OVER}`] && median(ratios[`${device} ${PROFILE_IF_OVER}`].raster) > THEME_BOUND[PROFILE_IF_OVER];
        if (PROFILE_DIR && over) {
            phase(`${device}: ${PROFILE_IF_OVER} is past its bound, so the head in it, the head in Dark and the base are profiled`);
            fs.mkdirSync(PROFILE_DIR, { recursive: true });
            const profile: Record<string, unknown> = {};
            await paint(PROFILE_IF_OVER);
            profile[`head ${PROFILE_IF_OVER}`] = await profileSweep(browser, headPage.page, spec.steps, path.join(PROFILE_DIR, `${device}-head-${PROFILE_IF_OVER}.json`));
            await paint('dark');
            profile['head dark'] = await profileSweep(browser, headPage.page, spec.steps, path.join(PROFILE_DIR, `${device}-head-dark.json`));
            profile['base'] = await profileSweep(browser, basePage.page, spec.steps, path.join(PROFILE_DIR, `${device}-base.json`));
            fs.writeFileSync(path.join(PROFILE_DIR, `${device}-profile.summary.json`), `${JSON.stringify(profile, null, 2)}\n`);
            notes.push(`${device}: profiled, summary in ${path.join(PROFILE_DIR, `${device}-profile.summary.json`)}`);
        }
        phase(`${device}: the self-tests`);
        // The self-tests, each in Dark against the base, once in each order. Each must fail its half of the gate.
        // Raster: a heavy shadow on every slot.
        await paint('dark');
        const heavy = await headPage.page.addStyleTag({ content: HEAVY });
        for (const round of [1, 2]) {
            const load = os.loadavg()[0].toFixed(1);
            const { b, h } = await pairOf(round, `${device} raster self-test, round ${round}`);
            calibration.push({ device, half: 'raster', ratio: +(h.raster / b.raster).toFixed(2) });
            selfRows.push(`| ${device} | heavy shadow | ${round} | ${load} | ${b.raster} / ${h.raster} | ${(h.raster / b.raster).toFixed(2)} | ${b.dropped} / ${h.dropped} | ${ratio(h.dropped, b.dropped).toFixed(2)} |`);
        }
        await heavy.evaluate((tag) => (tag as Element).remove());
        // Dropped frames: a long task on every frame, wall-clock, so the throttle doesn't change it.
        await headPage.page.evaluate((ms) => {
            const burn = () => {
                const until = performance.now() + ms;
                while (performance.now() < until) {
                    // Busy, on purpose.
                }
                if (!(window as { stopBurn?: boolean }).stopBurn) requestAnimationFrame(burn);
            };
            requestAnimationFrame(burn);
        }, LONG_TASK_MS);
        for (const round of [1, 2]) {
            const load = os.loadavg()[0].toFixed(1);
            const { b, h } = await pairOf(round, `${device} dropped-frame self-test, round ${round}`);
            calibration.push({ device, half: 'dropped frames', ratio: +ratio(h.dropped, b.dropped).toFixed(2), dropped: h.dropped, frames: spec.steps });
            selfRows.push(`| ${device} | ${LONG_TASK_MS} ms task per frame | ${round} | ${load} | ${b.raster} / ${h.raster} | ${(h.raster / b.raster).toFixed(2)} | ${b.dropped} / ${h.dropped} | ${ratio(h.dropped, b.dropped).toFixed(2)} |`);
        }
        await headPage.page.evaluate(() => void ((window as { stopBurn?: boolean }).stopBurn = true));
        await throttle(false);
        await basePage.page.context().close();
        await headPage.page.context().close();
    }

    const verdict = Object.entries(ratios).map(([key, value]) => ({ key, raster: +median(value.raster).toFixed(2), dropped: +median(value.dropped).toFixed(2) }));
    const table = [
        ...(SELF_TEST_ONLY ? ['Self-test only: no theme is gated.', ''] : []),
        ...notes,
        '',
        '| Device | Round | Head theme | Load (1 min) | Base raster ms | Head raster ms | Raster ratio | Dropped frames, base / head | rAF p95 ms, base / head |',
        '|---|---|---|---|---|---|---|---|---|',
        ...rows,
        '',
        '| Device, head theme | Median raster ratio | Median dropped-frame ratio, (head + 1) / (base + 1) |',
        '|---|---|---|',
        ...verdict.map((v) => `| ${v.key} | ${v.raster} | ${v.dropped} |`),
        '',
        `Bounds: Dark and Black ${BOUND.dark}, a theme with a surround ${BOUND.surround}, on both medians.`,
        '',
        `The self-tests, each in Dark: the head with \`${HEAVY}\` must cost more than ${BOUND.surround} in raster, and the head with a ${LONG_TASK_MS} ms task on every frame more than ${BOUND.surround}, and at least ${DROPPED_FLOOR * 100}% of the frames, in dropped frames, against the base.`,
        '',
        '| Device | Head | Round | Load (1 min) | Raster ms, base / head | Raster ratio | Dropped frames, base / head | Dropped-frame ratio |',
        '|---|---|---|---|---|---|---|---|',
        ...selfRows,
    ].join('\n');
    fs.mkdirSync(path.join(process.cwd(), 'test-results', 'perf'), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), 'test-results', 'perf', 'surround-perf.md'), `${table}\n`);
    console.log(table);
    // Every self-test ran, in both orders on each device, and each failed its half of the gate (lib/perf/selfTest.ts), so
    // a run that skipped them, the self-tests alone included, can't pass.
    expect.soft(selfTestProblems(calibration, { devices: SWEPT_DEVICES, bound: BOUND.surround }), 'the self-tests fail the gate as they must').toEqual([]);
    // Every device and theme was gated, unless this was the self-test alone (D7).
    expect(verdict, 'every device and theme has a verdict').toHaveLength(SELF_TEST_ONLY ? 0 : SWEPT_DEVICES.length * SWEPT_THEMES.length);
    for (const v of verdict) {
        const bound = THEME_BOUND[v.key.split(' ')[1] as Choice];
        expect.soft(v.raster, `${v.key}: the head's raster time against the base's`).toBeLessThanOrEqual(bound);
        expect.soft(v.dropped, `${v.key}: the head's dropped frames against the base's`).toBeLessThanOrEqual(bound);
    }
});
