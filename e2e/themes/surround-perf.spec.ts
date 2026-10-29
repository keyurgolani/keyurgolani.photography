import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from '@playwright/test';
import sharp from 'sharp';
import { publish } from '../../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../../lib/catalog/testing';
import { BUDGET_VARIANT_BYTES } from '../../lib/perf/fixture';
import { waitForHydration } from '../support/hydration';
import { expect, test } from '../support/test';

// The perf run for the sequence's surround (spec §13, PR map item 3), on a 5,000-photo series with every page shown by
// Show more, every slot a real print: the catalog's variant files are sparse, so each image request is answered with
// one tiny valid file of its format, and every slot decodes and wears its window cut, mat and print edge.
//
// It runs non-exclusive on a shared machine, so it gates on ratios, not milliseconds. The base (next before the themes,
// PARITY_BASE_DIR) and the head serve the same catalog side by side, and each sweep of the head (a scroll from the top
// to the end, in Black and in the three themes with a surround) is paired with a base sweep taken right beside it, the
// order alternating by round, with the machine's load on every row. Each sweep is traced, and the gate is the median
// ratio of the compositor's total raster time and of its dropped frames (#124's review, M1); the main thread's rAF p95
// is reported beside them, since it snaps to whole frames. A desktop at 1440, DPR 1, and a phone at 390, DPR 3 with
// the CPU throttled 4x, where a blur's raster cost is highest.
//
//   PARITY_BASE_DIR=<built base> PERF_PORTS=3375,3376 npx playwright test -c e2e/themes/perf.config.ts

const PHOTOS = 5_000;
const ROUNDS = 3;
const THEMES = { black: 'black', light: 'light', charcoal: 'dark', bright: 'bright' } as const;
type Choice = keyof typeof THEMES;
const DEVICES = {
    desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, throttle: 1, steps: 600 },
    phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, throttle: 4, steps: 300 },
} as const;
/** The head may cost this much more than the base beside it: Black about nothing, a surround a little. */
const BOUND = { black: 1.25, surround: 1.5 };
const TRACE_CATEGORIES = ['cc', 'viz', 'gpu', 'disabled-by-default-devtools.timeline.frame'];
const BASE = process.env.PARITY_BASE_DIR;
const ports = (process.env.PERF_PORTS ?? '').split(',').map(Number).filter(Boolean);

test.skip(!BASE, 'Set PARITY_BASE_DIR to a built checkout of the base.');

interface Server {
    origin: string;
    stop: () => Promise<void>;
}

/** `next start` from `tree` on 127.0.0.1, on the catalog. */
async function serve(tree: string, port: number, root: string, library: string, siteConfig: string): Promise<Server> {
    const kept = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PHOTOGRAPHY_') && !name.startsWith('CURAT') && name !== 'SITE_URL'));
    const child: ChildProcess = spawn(process.execPath, [path.join(tree, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
        cwd: tree,
        env: { ...kept, NODE_ENV: 'production', ALLOW_PROVISIONAL_COPY: '1', NEXT_TELEMETRY_DISABLED: '1', PHOTOGRAPHY_DATA_DIR: root, PHOTOGRAPHY_LIBRARY_DIR: library, PHOTOGRAPHY_SITE_CONFIG_DIR: siteConfig },
        detached: true,
        stdio: 'ignore',
    });
    const kill = (signal: NodeJS.Signals) => {
        try {
            if (child.pid) process.kill(-child.pid, signal);
        } catch {
            // Gone already.
        }
    };
    process.once('exit', () => kill('SIGKILL'));
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        if ((await fetch(`${origin}/api/ready`).then((r) => r.status, () => 0)) === 200) {
            return {
                origin,
                stop: () =>
                    new Promise<void>((resolve) => {
                        if (child.exitCode !== null) return resolve();
                        const force = setTimeout(() => kill('SIGKILL'), 5000);
                        child.once('exit', () => {
                            clearTimeout(force);
                            resolve();
                        });
                        kill('SIGTERM');
                    }),
            };
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    kill('SIGKILL');
    throw new Error(`${tree} never answered on ${port}`);
}

/** One valid tiny file per format, which every variant request is answered with. */
async function tinyPrints(): Promise<Record<string, Buffer>> {
    const source = sharp({ create: { width: 12, height: 8, channels: 3, background: { r: 120, g: 132, b: 128 } } });
    return { webp: await source.clone().webp().toBuffer(), avif: await source.clone().avif().toBuffer(), jpeg: await source.clone().jpeg().toBuffer() };
}

interface Sweep {
    rafP95: number;
    raster: number;
    dropped: number;
}

/** A traced scroll from the top to the end in even steps, one per frame. Raster in ms, summed; dropped frames, counted. */
async function sweep(browser: Browser, page: Page, steps: number): Promise<Sweep> {
    await browser.startTracing(page, { categories: TRACE_CATEGORIES });
    const rafP95 = await page.evaluate(
        (count) =>
            new Promise<number>((resolve) => {
                window.scrollTo(0, 0);
                const end = document.documentElement.scrollHeight - innerHeight;
                const step = Math.max(40, end / count);
                const deltas: number[] = [];
                let last = 0;
                const tick = (now: number) => {
                    deltas.push(now - last);
                    last = now;
                    if (window.scrollY >= end - 1) {
                        deltas.sort((a, b) => a - b);
                        resolve(+deltas[Math.min(deltas.length - 1, Math.floor(0.95 * deltas.length))].toFixed(2));
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
    const trace = JSON.parse((await browser.stopTracing()).toString('utf8')) as { traceEvents?: { name: string; ph: string; dur?: number; args?: { chrome_frame_reporter?: { state?: string } } }[] };
    const events = trace.traceEvents ?? [];
    const raster = events.filter((event) => event.name === 'RasterTask' && typeof event.dur === 'number').reduce((sum, event) => sum + (event.dur ?? 0), 0) / 1000;
    const dropped =
        events.filter((event) => event.name === 'DroppedFrame').length +
        events.filter((event) => event.name === 'PipelineReporter' && event.ph === 'b' && event.args?.chrome_frame_reporter?.state === 'STATE_DROPPED').length;
    return { rafP95, raster: +raster.toFixed(1), dropped };
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
    // Load every lazy print by passing it once, so the sweeps time raster, not loading.
    await page.evaluate(async () => {
        for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight) {
            window.scrollTo(0, y);
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        await Promise.all([...document.images].filter((image) => !image.complete).map((image) => new Promise((resolve) => {
            image.onload = image.onerror = resolve;
        })));
    });
    expect(await page.locator('[data-photo="unavailable"]').count(), 'every slot is a print, none a missing-image box').toBe(0);
    return renders;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const ratio = (head: number, base: number) => (head + 1) / (base + 1);

let catalog: TestCatalog | undefined;
const servers: Server[] = [];
let temp = '';
let prints: Record<string, Buffer> = {};

test.beforeAll(async () => {
    test.setTimeout(30 * 60_000);
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'surround-perf-'));
    const library = path.join(temp, 'library');
    const siteConfig = path.join(temp, 'site-config');
    fs.mkdirSync(library);
    fs.mkdirSync(siteConfig);
    prints = await tinyPrints();
    catalog = await createTestCatalog({ photos: PHOTOS, series: [{ photos: PHOTOS }], seed: 6, root: path.join(temp, 'catalog'), variantBytes: BUDGET_VARIANT_BYTES });
    const outcome = await publish({ dataRoot: catalog.root, actor: 'e2e', confirmLaunch: true, logger: { log: () => undefined } });
    expect(outcome.outcome, outcome.message).toBe('PUBLISHED');
    servers.push(await serve(BASE!, ports[0] ?? 3375, catalog.root, library, siteConfig), await serve(process.cwd(), ports[1] ?? 3376, catalog.root, library, siteConfig));
});

test.afterAll(async () => {
    test.setTimeout(5 * 60_000);
    await Promise.all(servers.map((server) => server.stop()));
    // Nothing is deleted: the run's folder (its 5,000-photo catalog) goes to the Trash, or stays where it is.
    const trash = path.join(os.homedir(), '.Trash');
    if (temp && fs.existsSync(trash)) fs.renameSync(temp, path.join(trash, `${path.basename(temp)}-${Date.now()}`));
});

test(`a ${PHOTOS}-photo sequence of real prints: the head's scroll, in every theme, against the base beside it`, async ({ browser }) => {
    test.setTimeout(120 * 60_000);
    const [base, head] = servers;
    const url = (origin: string) => `${origin}/work/${catalog!.series[0].slug}`;
    const rows: string[] = [];
    const notes: string[] = [];
    const ratios: Record<string, { raster: number[]; dropped: number[] }> = {};

    for (const [device, spec] of Object.entries(DEVICES)) {
        const open = async (origin: string) => {
            const context = await browser.newContext({ viewport: spec.viewport, deviceScaleFactor: spec.deviceScaleFactor, colorScheme: 'dark', reducedMotion: 'reduce' });
            await context.addInitScript(() => localStorage.setItem('theme', 'dark'));
            const page = await context.newPage();
            await page.route(/\/w\d+\.(webp|avif|jpe?g)(\?|$)/, (route) => {
                const format = /\.(webp|avif|jpe?g)/.exec(route.request().url())![1].replace('jpg', 'jpeg');
                return route.fulfill({ body: prints[format], contentType: `image/${format}` });
            });
            const renders = await expand(page, url(origin));
            const cdp = await context.newCDPSession(page);
            return { page, renders, cdp };
        };
        const basePage = await open(base.origin);
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

        await throttle(true);
        for (let round = 1; round <= ROUNDS; round++) {
            for (const theme of Object.keys(THEMES) as Choice[]) {
                await paint(theme);
                const load = os.loadavg()[0].toFixed(1);
                // The order alternates by round, so neither build always sweeps first.
                const pair = round % 2 === 1 ? [basePage, headPage] : [headPage, basePage];
                const [first, second] = [await sweep(browser, pair[0].page, spec.steps), await sweep(browser, pair[1].page, spec.steps)];
                const [b, h] = round % 2 === 1 ? [first, second] : [second, first];
                const key = `${device} ${theme}`;
                ratios[key] ??= { raster: [], dropped: [] };
                ratios[key].raster.push(h.raster / b.raster);
                ratios[key].dropped.push(ratio(h.dropped, b.dropped));
                rows.push(`| ${device} | ${round} | ${theme === 'charcoal' ? 'dark' : theme} | ${load} | ${b.raster} | ${h.raster} | ${(h.raster / b.raster).toFixed(2)} | ${b.dropped} / ${h.dropped} | ${b.rafP95} / ${h.rafP95} |`);
            }
        }
        await throttle(false);
        await basePage.page.context().close();
        await headPage.page.context().close();
    }

    const verdict = Object.entries(ratios).map(([key, value]) => ({ key, raster: +median(value.raster).toFixed(2), dropped: +median(value.dropped).toFixed(2) }));
    const table = [
        ...notes,
        '',
        '| Device | Round | Head theme | Load (1 min) | Base raster ms | Head raster ms | Raster ratio | Dropped frames, base / head | rAF p95 ms, base / head |',
        '|---|---|---|---|---|---|---|---|---|',
        ...rows,
        '',
        '| Device, head theme | Median raster ratio | Median dropped-frame ratio, (head + 1) / (base + 1) |',
        '|---|---|---|',
        ...verdict.map((v) => `| ${v.key.replace('charcoal', 'dark')} | ${v.raster} | ${v.dropped} |`),
        '',
        `Bounds: Black ${BOUND.black}, a theme with a surround ${BOUND.surround}, on both medians.`,
    ].join('\n');
    fs.mkdirSync(path.join(process.cwd(), 'test-results', 'perf'), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), 'test-results', 'perf', 'surround-perf.md'), `${table}\n`);
    console.log(table);
    for (const v of verdict) {
        const bound = v.key.endsWith('black') ? BOUND.black : BOUND.surround;
        expect.soft(v.raster, `${v.key}: the head's raster time against the base's`).toBeLessThanOrEqual(bound);
        expect.soft(v.dropped, `${v.key}: the head's dropped frames against the base's`).toBeLessThanOrEqual(bound);
    }
});
