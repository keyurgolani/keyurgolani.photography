import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { catalogCodeVersion, DEFAULT_CATALOG_CACHE, perfCatalog } from '../../lib/perf/catalogCache';
import { BUDGET_VARIANT_BYTES } from '../../lib/perf/fixture';
import { checkDiskFloor, makeRunTemp, removeRunTemp } from '../../lib/perf/runFiles';
import { tracedToFile, type TraceEvent } from '../themes/perfTrace';
import { phase, readOnlyTree, serve, standInPrints, VARIANT_REQUEST, variantFormat, type Server } from '../themes/perfServer';

// photo-perf-scroll (2026-10-31): the surround's phone scroll alone (e2e/themes/surround-perf.spec.ts @ 5a825824),
// for a bisect point. Copied into the tools worktree's e2e/scroll/ by the runner; the master copy is in the notes.
//   pairs   (default): base and head side by side, PERF_THEMES (dark), PERF_ROUNDS pairs each, order alternating.
//   profile (SCROLL_PROFILE_DIR set): one traced sweep per tree, alone in the browser, with the timeline categories,
//            and on the head one traced theme switch before it (from Dark to PERF_THEMES' first other theme).
// Same sweep, expand, device, throttle and trace categories as the surround, so the numbers compare with perf5's.
//
// Its writes are capped (the 2026-10-31 disk fill, notes/photo-perf-scroll/disk-0704.md): nothing starts under the disk
// floor (PERF_DISK_MIN_GB, 20 GB); the catalog is served read-only from the cache, never copied; a profile trace streams
// to a file under PERF_TRACE_MAX_MB (150) and fails its phase past it; only its summary JSON is kept, the raw trace
// too with PERF_KEEP_TRACE=1; and the run's temp folder is removed in place when it ends, passed or failed.

const PHOTOS = 5_000;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, throttle: 4, steps: 120 };
const THEMES = (process.env.PERF_THEMES ?? 'dark').split(',');
const ROUNDS = Number(process.env.PERF_ROUNDS ?? '3');
const LABEL = process.env.SCROLL_LABEL ?? 'head';
const OUT = process.env.SCROLL_OUT;
const PROFILE_DIR = process.env.SCROLL_PROFILE_DIR;
const BASE = process.env.PARITY_BASE_DIR;
const HEAD = process.env.HEAD_DIR;
const ports = (process.env.PERF_PORTS ?? '3391,3392').split(',').map(Number);
const SURROUND_CATEGORIES = ['cc', 'viz', 'gpu', 'disabled-by-default-devtools.timeline.frame'];
const PROFILE_CATEGORIES = [
    ...SURROUND_CATEGORIES,
    'devtools.timeline',
    'disabled-by-default-devtools.timeline',
    // Not disabled-by-default-devtools.timeline.stack or v8.execute: they made each trace about 125 MB.
    'blink.user_timing',
    'disabled-by-default-v8.cpu_profiler',
    'loading',
];

test.skip(!BASE || !HEAD, 'Set PARITY_BASE_DIR and HEAD_DIR to built trees.');


interface Sweep {
    rafP95: number;
    frames: number;
    raster: number;
    dropped: number;
    rasterByProcess: Record<string, { ms: number; tasks: number }>;
    /** Per process, the heaviest event names by total duration (for the round-2 raster artefact). */
    topByProcess: Record<string, string>;
    /** The trace's own extent against the sweep's: a trace that stops early (its buffer full) records too little. */
    traceEvents: number;
    traceSpanMs: number;
    wallMs: number;
}

/**
 * A traced sweep. With `file`, the trace streams there under the cap and goes once its events are read (perfTrace.ts);
 * without one, it's the surround's own light trace, held in memory and never written.
 */
async function sweep(browser: Browser, page: Page, steps: number, categories: string[], file?: string): Promise<Sweep> {
    if (file) {
        const { result, events } = await tracedToFile(browser, categories, file, () => scroll(page, steps));
        return summarise(events, result);
    }
    await browser.startTracing(page, { categories });
    let swept: [number, number, number];
    try {
        swept = await scroll(page, steps);
    } catch (error) {
        // Stopped either way, so a failed sweep never leaves Chrome tracing.
        await browser.stopTracing().catch(() => undefined);
        throw error;
    }
    const buffer = await browser.stopTracing();
    return summarise((JSON.parse(buffer.toString('utf8')) as { traceEvents?: TraceEvent[] }).traceEvents ?? [], swept);
}

/** The scroll from the top to the end in even steps, one per frame: its rAF p95, its frames and its wall time. */
async function scroll(page: Page, steps: number): Promise<[number, number, number]> {
    const swept = page.evaluate(
        (count) =>
            new Promise<[number, number, number]>((resolve, reject) => {
                window.scrollTo(0, 0);
                const began = performance.now();
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
                        const n = deltas.length;
                        deltas.sort((a, b) => a - b);
                        resolve([+deltas[Math.min(n - 1, Math.floor(0.95 * n))].toFixed(2), n, Math.round(performance.now() - began)]);
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

/** A sweep's numbers from its trace's events. */
function summarise(events: TraceEvent[], [rafP95, frames, wallMs]: [number, number, number]): Sweep {
    const processName = new Map<number, string>();
    for (const event of events) if (event.ph === 'M' && event.name === 'process_name') processName.set(event.pid, String(event.args?.name ?? '?'));
    const rasterByProcess: Sweep['rasterByProcess'] = {};
    let raster = 0;
    for (const event of events) {
        if (event.name !== 'RasterTask' || typeof event.dur !== 'number') continue;
        raster += event.dur;
        const key = `${processName.get(event.pid) ?? '?'} ${event.pid}`;
        rasterByProcess[key] ??= { ms: 0, tasks: 0 };
        rasterByProcess[key].ms += event.dur / 1000;
        rasterByProcess[key].tasks++;
    }
    for (const value of Object.values(rasterByProcess)) value.ms = +value.ms.toFixed(1);
    const byName = new Map<string, Map<string, number>>();
    for (const event of events) {
        if (event.ph !== 'X' || typeof event.dur !== 'number') continue;
        const key = `${processName.get(event.pid) ?? '?'} ${event.pid}`;
        const names = byName.get(key) ?? new Map<string, number>();
        names.set(event.name, (names.get(event.name) ?? 0) + event.dur / 1000);
        byName.set(key, names);
    }
    const topByProcess: Sweep['topByProcess'] = {};
    for (const [key, names] of byName) topByProcess[key] = [...names].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, ms]) => `${name} ${Math.round(ms)}`).join('; ');
    const dropped =
        events.filter((event) => event.name === 'DroppedFrame').length +
        events.filter((event) => event.name === 'PipelineReporter' && event.ph === 'b' && event.args?.chrome_frame_reporter?.state === 'STATE_DROPPED').length;
    let first = Infinity;
    let last = -Infinity;
    for (const event of events as (TraceEvent & { ts?: number })[]) {
        if (event.ph === 'M' || typeof event.ts !== 'number' || event.ts <= 0) continue;
        first = Math.min(first, event.ts);
        last = Math.max(last, event.ts + (event.dur ?? 0));
    }
    return { rafP95, frames, raster: +(raster / 1000).toFixed(1), dropped, rasterByProcess, topByProcess, traceEvents: events.length, traceSpanMs: Math.round((last - first) / 1000), wallMs };
}

async function expand(page: Page, url: string) {
    await page.goto(url);
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    const entries = page.locator('section[aria-labelledby="series-sequence"] ol > li');
    const button = page.getByRole('button', { name: 'Show more' });
    while (await button.isVisible().catch(() => false)) {
        const before = await entries.count();
        await button.click();
        await expect.poll(() => entries.count(), { timeout: 60_000 }).toBeGreaterThan(before);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    await expect(entries).toHaveCount(PHOTOS);
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
    await expect(page.locator('[data-photo="unavailable"]')).toHaveCount(0);
}

let catalog: { root: string; slug: string } | undefined;
const servers: Server[] = [];
let temp = '';
let prints: Record<string, Buffer> = {};

test.beforeAll(async () => {
    test.setTimeout(20 * 60_000);
    checkDiskFloor(os.tmpdir());
    if (PROFILE_DIR) checkDiskFloor(path.dirname(PROFILE_DIR));
    temp = makeRunTemp('scroll-');
    const library = path.join(temp, 'library');
    const siteConfig = path.join(temp, 'site-config');
    fs.mkdirSync(library);
    fs.mkdirSync(siteConfig);
    prints = await standInPrints(12, 8);
    // Served from the cache in place, read-only, never copied (lib/perf/catalogCache.ts).
    const cached = await perfCatalog({ photos: PHOTOS, seed: 6, variantBytes: BUDGET_VARIANT_BYTES, code: catalogCodeVersion(process.cwd()) }, process.env.PERF_CATALOG_CACHE ?? DEFAULT_CATALOG_CACHE, path.join(temp, 'catalog'));
    catalog = { root: cached.root, slug: cached.slug };
    phase(`catalog from ${cached.from}, read-only at ${cached.root}; serving base ${BASE} (cloned .next) and head ${HEAD}`);
    const base = readOnlyTree(BASE!, path.join(temp, 'base-tree'));
    servers.push(await serve(base, ports[0], catalog.root, library, siteConfig), await serve(HEAD!, ports[1], catalog.root, library, siteConfig));
});

test.afterAll(async () => {
    test.setTimeout(5 * 60_000);
    await Promise.all(servers.map((server) => server.stop()));
    // The run's own temp folder goes, passed or failed, in place: a move to ~/.Trash is the same volume and frees nothing.
    removeRunTemp(temp);
});

test(`the phone scroll of a ${PHOTOS}-photo series, ${LABEL} against the base`, async ({ browser }) => {
    test.setTimeout(30 * 60_000);
    const [base, head] = servers;
    const url = (origin: string) => `${origin}/work/${catalog!.slug}`;
    const open = async (origin: string) => {
        const context = await browser.newContext({ viewport: PHONE.viewport, deviceScaleFactor: PHONE.deviceScaleFactor, colorScheme: 'dark', reducedMotion: 'reduce' });
        await context.addInitScript(() => localStorage.setItem('theme', 'dark'));
        const page = await context.newPage();
        await page.route(VARIANT_REQUEST, (route) => route.fulfill({ body: prints[variantFormat(route.request().url())], contentType: `image/${variantFormat(route.request().url())}` }));
        await expand(page, url(origin));
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: PHONE.throttle });
        return { page, cdp };
    };
    const paint = (page: Page, theme: string) =>
        page.evaluate((choice) => {
            document.documentElement.setAttribute('data-theme-choice', choice);
            document.documentElement.setAttribute('data-theme', choice);
        }, theme);
    const record = (row: object) => {
        const line = JSON.stringify({ label: LABEL, load: +os.loadavg()[0].toFixed(1), ...row });
        console.log(`[scroll] ${line}`);
        if (OUT) fs.appendFileSync(OUT, `${line}\n`);
    };

    /** Waits until the page's frames run at the display's pace again (20 in a row under 50 ms); returns how long. */
    const settle = (page: Page) =>
        page.evaluate(
            () =>
                new Promise<number>((resolve) => {
                    const started = performance.now();
                    let calm = 0;
                    let last = started;
                    const frame = (now: number) => {
                        calm = now - last < 50 ? calm + 1 : 0;
                        last = now;
                        if (calm >= 20 || now - started > 90_000) resolve(Math.round(now - started));
                        else requestAnimationFrame(frame);
                    };
                    requestAnimationFrame(frame);
                }),
        );

    if (PROFILE_DIR) {
        // One sweep per tree, alone in the browser, so the trace holds one renderer's work: the base's in Dark, and the
        // head's after one traced switch, from Dark to PERF_THEMES' first other theme. Each trace streams to a file
        // under the cap, and only its summary JSON is kept beside it (the raw trace too with PERF_KEEP_TRACE=1).
        fs.mkdirSync(PROFILE_DIR, { recursive: true });
        const keep = (name: string, summary: object) => {
            const file = path.join(PROFILE_DIR, `${name}.summary.json`);
            fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
            return file;
        };
        phase('profile base');
        const opened = await open(base.origin);
        const baseSweep = await sweep(browser, opened.page, PHONE.steps, PROFILE_CATEGORIES, path.join(PROFILE_DIR, 'base-dark.json'));
        record({ mode: 'profile', tree: 'base', theme: 'dark', summary: keep('base-dark', baseSweep), ...baseSweep });
        await opened.page.context().close();
        const theme = THEMES.find((choice) => choice !== 'dark') ?? 'dark';
        phase(`profile ${LABEL}, dark to ${theme}`);
        const headPage = await open(head.origin);
        if (theme !== 'dark') {
            const name = `${LABEL}-switch-dark-${theme}`;
            const { result: settled, events } = await tracedToFile(browser, PROFILE_CATEGORIES, path.join(PROFILE_DIR, `${name}.json`), async () => {
                await paint(headPage.page, theme);
                return settle(headPage.page);
            });
            const top = new Map<string, number>();
            for (const event of events) if (event.ph === 'X' && typeof event.dur === 'number') top.set(event.name, (top.get(event.name) ?? 0) + event.dur / 1000);
            const summary = { settleMs: settled, traceEvents: events.length, top: [...top].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([event, ms]) => `${event} ${Math.round(ms)}`) };
            record({ mode: 'switch', tree: LABEL, from: 'dark', theme, settleMs: settled, summary: keep(name, summary) });
        }
        const headSweep = await sweep(browser, headPage.page, PHONE.steps, PROFILE_CATEGORIES, path.join(PROFILE_DIR, `${LABEL}-${theme}.json`));
        record({ mode: 'profile', tree: LABEL, theme, summary: keep(`${LABEL}-${theme}`, headSweep), ...headSweep });
        await headPage.page.context().close();
        return;
    }

    // SCROLL_SETTLE=1: each sweep waits for its page to settle after the theme change, so it times the scroll alone.
    const SETTLE = process.env.SCROLL_SETTLE === '1';
    phase('the base expands');
    const b = await open(base.origin);
    phase(`the ${LABEL} expands`);
    const h = await open(head.origin);
    for (let round = 1; round <= ROUNDS; round++) {
        for (const theme of THEMES) {
            await paint(h.page, theme);
            const settleMs = SETTLE ? await settle(h.page) : undefined;
            phase(`${theme}, round ${round}${SETTLE ? `, the head settled in ${settleMs} ms` : ''}`);
            const order = round % 2 === 1 ? ['base', 'head'] : ['head', 'base'];
            const results: Record<string, Sweep> = {};
            for (const which of order) {
                if (SETTLE) await settle((which === 'base' ? b : h).page);
                results[which] = await sweep(browser, (which === 'base' ? b : h).page, PHONE.steps, SURROUND_CATEGORIES);
            }
            record({ mode: 'pair', settled: SETTLE, settleMs, theme, round, first: order[0], base: results.base, head: results.head });
        }
    }
    await b.page.context().close();
    await h.page.context().close();
});
