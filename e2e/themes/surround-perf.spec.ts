import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { catalogCodeVersion, DEFAULT_CATALOG_CACHE, perfCatalog } from '../../lib/perf/catalogCache';
import { DROPPED_FLOOR, selfTestProblems, type SelfTestResult } from '../../lib/perf/selfTest';
import { BUDGET_VARIANT_BYTES } from '../../lib/perf/fixture';
import { waitForHydration } from '../support/hydration';
import { expect, test } from '../support/test';
import { phase, serve, standInPrints, VARIANT_REQUEST, variantFormat, type Server } from './perfServer';

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
// A theme change recolours every entry, seconds of main thread on the throttled phone, which the base, never switched,
// doesn't pay. So each page settles before its own sweep, and the head's settle after each switch is in the table and
// gated: past PERF_SETTLE_MAX_MS (5,000 by default) the run fails, and a page that hasn't settled in 90 s fails it at
// once, by name, rather than sweeping (the scroll regression's review, M3).
//
// The published catalog is built once and copied per run (lib/perf/catalogCache.ts), into PERF_CATALOG_CACHE or
// ~/.cache/photography-perf, keyed by its photos, seed, variant sizes and the catalog code's git tree.
//
//   PARITY_BASE_DIR=<built base> PERF_PORTS=3375,3376 [PERF_ROUNDS=3] [PERF_SELFTEST=1] [PERF_SETTLE_MAX_MS=5000] [PERF_PHOTOS=5000] npx playwright test -c e2e/themes/perf.config.ts

/**
 * The series' photos: 5,000 by default, the stress case. PERF_PHOTOS=200 with PERF_SETTLE_MAX_MS=500 is the realistic
 * series' settle check (the scroll regression's PR). The catalog cache keys on the count, so each count builds its own.
 */
const PHOTOS = (() => {
    const value = process.env.PERF_PHOTOS ?? '5000';
    if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`PERF_PHOTOS is a whole number of photos above 0, not ${JSON.stringify(value)}`);
    return Number(value);
})();
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
/** The longest the head may take to settle after a switch, in ms: a whole number above 0. */
const SETTLE_MAX_MS = (() => {
    const value = process.env.PERF_SETTLE_MAX_MS ?? '5000';
    if (!/^\d+$/.test(value) || Number(value) <= 0) throw new Error(`PERF_SETTLE_MAX_MS is a whole number of ms above 0, not ${JSON.stringify(value)}`);
    return Number(value);
})();
/** A page that hasn't settled by then never will: the run fails there, by name, instead of sweeping it. */
const SETTLE_CAP_MS = 90_000;
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
    const rafP95 = await Promise.race([swept, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('the sweep ran past 2 minutes')), 120_000)))]).finally(() => clearTimeout(timer));
    const trace = JSON.parse((await browser.stopTracing()).toString('utf8')) as { traceEvents?: { name: string; ph: string; dur?: number; args?: { chrome_frame_reporter?: { state?: string } } }[] };
    const events = trace.traceEvents ?? [];
    const raster = events.filter((event) => event.name === 'RasterTask' && typeof event.dur === 'number').reduce((sum, event) => sum + (event.dur ?? 0), 0) / 1000;
    const dropped =
        events.filter((event) => event.name === 'DroppedFrame').length +
        events.filter((event) => event.name === 'PipelineReporter' && event.ph === 'b' && event.args?.chrome_frame_reporter?.state === 'STATE_DROPPED').length;
    return { rafP95, raster: +raster.toFixed(1), dropped };
}

/**
 * Waits until the page's frames run at the display's pace again, 20 in a row under 50 ms, and returns how long that
 * took, in ms. Past SETTLE_CAP_MS it rejects, so a page that never settles fails the run instead of being swept.
 */
async function settle(page: Page, label: string) {
    const settled = await page.evaluate(
        (cap) =>
            new Promise<number | null>((resolve) => {
                const started = performance.now();
                let calm = 0;
                let last = started;
                const frame = (now: number) => {
                    calm = now - last < 50 ? calm + 1 : 0;
                    last = now;
                    if (calm >= 20) resolve(Math.round(now - started));
                    else if (now - started > cap) resolve(null);
                    else requestAnimationFrame(frame);
                };
                requestAnimationFrame(frame);
            }),
        SETTLE_CAP_MS,
    );
    if (settled === null) throw new Error(`${label}: the page hadn't settled after ${SETTLE_CAP_MS / 1000} s`);
    return settled;
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

/** The run's copy of the cached published catalog (lib/perf/catalogCache.ts), and its one series. */
let catalog: { root: string; slug: string } | undefined;
const servers: Server[] = [];
let temp = '';
let prints: Record<string, Buffer> = {};

test.beforeAll(async () => {
    // Setup's own cap: the catalog, its publish and the two servers.
    test.setTimeout(20 * 60_000);
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'surround-perf-'));
    const library = path.join(temp, 'library');
    const siteConfig = path.join(temp, 'site-config');
    fs.mkdirSync(library);
    fs.mkdirSync(siteConfig);
    prints = await standInPrints(12, 8);
    // Built and published once, then copied per run: setup was most of a run, and under load it ran perf4 out of time.
    phase(`the ${PHOTOS}-photo published catalog`);
    const cached = await perfCatalog({ photos: PHOTOS, seed: 6, variantBytes: BUDGET_VARIANT_BYTES, code: catalogCodeVersion(process.cwd()) }, path.join(temp, 'catalog'), process.env.PERF_CATALOG_CACHE ?? DEFAULT_CATALOG_CACHE);
    phase(cached.from === 'cache' ? 'the catalog, copied from the cache' : 'the catalog, built and cached');
    catalog = { root: cached.root, slug: cached.slug };
    phase('the base and head servers');
    servers.push(await serve(BASE!, ports[0] ?? 3375, catalog.root, library, siteConfig), await serve(process.cwd(), ports[1] ?? 3376, catalog.root, library, siteConfig));
});

test.afterAll(async () => {
    test.setTimeout(5 * 60_000);
    await Promise.all(servers.map((server) => server.stop()));
    // Nothing is deleted: the run's folder (its 5,000-photo catalog) goes to the Trash, or stays where it is.
    const trash = path.join(os.homedir(), '.Trash');
    try {
        if (temp && fs.existsSync(trash)) fs.renameSync(temp, path.join(trash, `${path.basename(temp)}-${Date.now()}`));
    } catch {
        // On another volume than the Trash (EXDEV): it stays where it is.
    }
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
    const settles: { key: string; ms: number }[] = [];
    const calibration: SelfTestResult[] = [];

    for (const [device, spec] of Object.entries(DEVICES)) {
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

        /**
         * A base sweep and a head sweep, the order alternating by round, each checked for raster time to compare. Each
         * page settles before its own sweep, so neither sweep times the other's leftover work, except under the
         * dropped-frame self-test's long task, which never lets the head settle, on purpose.
         */
        const pairOf = async (round: number, label: string, settled = true) => {
            phase(label);
            const pair = round % 2 === 1 ? [basePage, headPage] : [headPage, basePage];
            // Each sweep, tracing included, is bounded too, so a trace that never stops fails the pair by name.
            const bounded = (page: Page, which: string) => {
                let timer: NodeJS.Timeout | undefined;
                return Promise.race([sweep(browser, page, spec.steps), new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${label}: the ${which} sweep ran past 3 minutes`)), 180_000)))]).finally(() => clearTimeout(timer));
            };
            if (settled) await settle(pair[0].page, `${label}, before the first sweep`);
            const first = await bounded(pair[0].page, 'first');
            if (settled) await settle(pair[1].page, `${label}, before the second sweep`);
            const second = await bounded(pair[1].page, 'second');
            const [b, h] = round % 2 === 1 ? [first, second] : [second, first];
            expect(b.raster, `${label}: the base's trace carries raster time`).toBeGreaterThan(0);
            expect(h.raster, `${label}: the head's trace carries raster time`).toBeGreaterThan(0);
            return { b, h };
        };

        await throttle(true);
        for (let round = 1; round <= ROUNDS; round++) {
            phase(`${device}: round ${round} of ${ROUNDS}`);
            for (const theme of Object.keys(THEMES) as Choice[]) {
                const key = `${device} ${theme}`;
                await paint(theme);
                // Timed from the switch, before either sweep, and gated below.
                const settled = await settle(headPage.page, `${key}, round ${round}: the head after the switch`);
                settles.push({ key: `${key}, round ${round}`, ms: settled });
                const load = os.loadavg()[0].toFixed(1);
                // The order alternates by round, so neither build always sweeps first.
                const { b, h } = await pairOf(round, `${key}, round ${round}`);
                ratios[key] ??= { raster: [], dropped: [] };
                ratios[key].raster.push(h.raster / b.raster);
                ratios[key].dropped.push(ratio(h.dropped, b.dropped));
                rows.push(`| ${device} | ${round} | ${theme} | ${load} | ${settled} | ${b.raster} | ${h.raster} | ${(h.raster / b.raster).toFixed(2)} | ${b.dropped} / ${h.dropped} | ${b.rafP95} / ${h.rafP95} |`);
            }
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
            const { b, h } = await pairOf(round, `${device} dropped-frame self-test, round ${round}`, false);
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
        '| Device | Round | Head theme | Load (1 min) | Head settle ms | Base raster ms | Head raster ms | Raster ratio | Dropped frames, base / head | rAF p95 ms, base / head |',
        '|---|---|---|---|---|---|---|---|---|---|',
        ...rows,
        '',
        '| Device, head theme | Median raster ratio | Median dropped-frame ratio, (head + 1) / (base + 1) |',
        '|---|---|---|',
        ...verdict.map((v) => `| ${v.key} | ${v.raster} | ${v.dropped} |`),
        '',
        `Bounds: Dark and Black ${BOUND.dark}, a theme with a surround ${BOUND.surround}, on both medians. The head settles within ${SETTLE_MAX_MS} ms of each switch.`,
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
    expect.soft(selfTestProblems(calibration, { devices: Object.keys(DEVICES), bound: BOUND.surround }), 'the self-tests fail the gate as they must').toEqual([]);
    // Every device and theme was gated, unless this was the self-test alone (D7).
    expect(verdict, 'every device and theme has a verdict').toHaveLength(SELF_TEST_ONLY ? 0 : Object.keys(DEVICES).length * Object.keys(THEMES).length);
    for (const v of verdict) {
        const bound = THEME_BOUND[v.key.split(' ')[1] as Choice];
        expect.soft(v.raster, `${v.key}: the head's raster time against the base's`).toBeLessThanOrEqual(bound);
        expect.soft(v.dropped, `${v.key}: the head's dropped frames against the base's`).toBeLessThanOrEqual(bound);
    }
    for (const entry of settles) expect.soft(entry.ms, `${entry.key}: the head's settle after the switch, in ms`).toBeLessThanOrEqual(SETTLE_MAX_MS);
});
