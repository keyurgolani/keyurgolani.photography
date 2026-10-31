import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser } from '@playwright/test';
import { catalogCodeVersion, DEFAULT_CATALOG_CACHE, perfCatalog } from '../../lib/perf/catalogCache';
import { BUDGET_VARIANT_BYTES } from '../../lib/perf/fixture';
import { LCP_BOUND, LCP_LOADS, lcpTable, lcpVerdicts, totalBlockingTime, type LcpSample } from '../../lib/perf/lcp';
import { expect, test } from '../support/test';
import { phase, readOnlyTree, serve, standInPrints, VARIANT_REQUEST, variantFormat, type Server } from './perfServer';

// The perf run's lab LCP (the themes scope, item 7; lib/perf/lcp.ts judges it). Each visitor route, loaded cold, on a
// desktop at 1440 and a phone at 390 (DPR 3, the CPU throttled 4x), from v1.2.0's build and from the head in every
// theme choice: System (on a light device, so it paints Light through the choice's own path), Light, Bright, Dark and
// Black. Five loads each, interleaved per route and rotated by load, so the machine's load hits both builds alike and
// neither always goes first. The gate: the head's median LCP at most 1.10 × v1.2.0's or v1.2.0's + 16 ms, whichever is
// more, and at most 2,500 ms. TBT, from long tasks after first contentful paint until the load goes quiet, is
// reported beside it with no gate.
//
// Both serve the perf catalog (lib/perf/catalogCache.ts, the surround run's, shared through the cache) and every image
// request is answered with one flat print of its format, large enough that the photograph is the largest paint, so
// LCP times the page, not the disk. v1.2.0 is served from a copy of its build (perfServer.ts, readOnlyTree), so its
// tree is only read and never rebuilt.
//
//   PERF_V120_DIR=<built v1.2.0> PERF_LCP_PORTS=3377,3378 [PERF_LCP_ROUTES=Home,About] npx playwright test -c e2e/themes/perf.config.ts lcp

const PHOTOS = 5_000;
const V120 = process.env.PERF_V120_DIR;
const ports = (process.env.PERF_LCP_PORTS ?? '').split(',').map(Number).filter(Boolean);
const THEMES = ['system', 'light', 'bright', 'dark', 'black'] as const;
const VARIANTS = ['base', ...THEMES] as const;
type Variant = (typeof VARIANTS)[number];
const DEVICES = {
    desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, throttle: 1 },
    phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, throttle: 4 },
} as const;
type Device = keyof typeof DEVICES;
/** A load is over once nothing new has painted or blocked for this long after `load`, or at the cap. */
const QUIET_MS = 1500;
const QUIET_CAP_MS = 6000;

test.skip(!V120, 'Set PERF_V120_DIR to the built v1.2.0 tree.');

let catalog: { root: string; slug: string; photoId: string } | undefined;
const servers: Server[] = [];
let temp = '';
let prints: Record<string, Buffer> = {};

test.beforeAll(async () => {
    test.setTimeout(15 * 60_000);
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcp-perf-'));
    const library = path.join(temp, 'library');
    const siteConfig = path.join(temp, 'site-config');
    fs.mkdirSync(library);
    fs.mkdirSync(siteConfig);
    // About's stand-in portrait, as the e2e suite's server has it.
    const written = spawnSync(path.join(process.cwd(), 'node_modules', '.bin', 'tsx'), ['e2e/support/write-site-config.ts', siteConfig], { cwd: process.cwd(), encoding: 'utf8' });
    if (written.status !== 0) throw new Error(`The site config wasn't written: ${written.stderr}`);
    prints = await standInPrints(1920, 1280);
    phase(`lcp: the ${PHOTOS}-photo published catalog`);
    const cached = await perfCatalog({ photos: PHOTOS, seed: 6, variantBytes: BUDGET_VARIANT_BYTES, code: catalogCodeVersion(process.cwd()) }, path.join(temp, 'catalog'), process.env.PERF_CATALOG_CACHE ?? DEFAULT_CATALOG_CACHE);
    phase(`lcp: v1.2.0's build, copied to serve`);
    const v120 = readOnlyTree(V120!, path.join(temp, 'v120'));
    phase('lcp: the v1.2.0 and head servers');
    servers.push(await serve(v120, ports[0] ?? 3377, cached.root, library, siteConfig), await serve(process.cwd(), ports[1] ?? 3378, cached.root, library, siteConfig));
    // The Viewer's photograph: the series' first entry, as the head links it.
    const html = await (await fetch(`${servers[1].origin}/work/${cached.slug}`)).text();
    const photoId = new RegExp(`/work/${cached.slug}/photo/([A-Za-z0-9_-]+)`).exec(html)?.[1];
    if (!photoId) throw new Error(`No photograph linked from /work/${cached.slug}`);
    catalog = { root: cached.root, slug: cached.slug, photoId };
});

test.afterAll(async () => {
    test.setTimeout(5 * 60_000);
    await Promise.all(servers.map((server) => server.stop()));
    // Nothing is deleted: the run's folder (the catalog copy, v1.2.0's build copy) goes to the Trash, or stays.
    const trash = path.join(os.homedir(), '.Trash');
    try {
        if (temp && fs.existsSync(trash)) fs.renameSync(temp, path.join(trash, `${path.basename(temp)}-${Date.now()}`));
    } catch {
        // On another volume than the Trash (EXDEV): it stays where it is.
    }
});

/** One cold load: a fresh context, so nothing is cached. Its LCP, and its TBT from long tasks after first paint. */
async function load(browser: Browser, origin: string, route: string, device: Device, variant: Variant): Promise<{ lcp: number; tbt: number }> {
    const spec = DEVICES[device];
    const context = await browser.newContext({
        viewport: spec.viewport,
        deviceScaleFactor: spec.deviceScaleFactor,
        isMobile: spec.isMobile,
        hasTouch: spec.hasTouch,
        colorScheme: variant === 'system' ? 'light' : 'dark',
    });
    try {
        if (variant !== 'base') await context.addInitScript((theme) => localStorage.setItem('theme', theme), variant);
        await context.addInitScript(() => {
            const perf = { lcp: Number.NaN, fcp: Number.NaN, tasks: [] as [number, number][], last: 0 };
            (window as unknown as { __perf: typeof perf }).__perf = perf;
            const watch = (type: string, take: (entry: PerformanceEntry) => void) => {
                try {
                    new PerformanceObserver((list) => {
                        for (const entry of list.getEntries()) take(entry);
                        perf.last = performance.now();
                    }).observe({ type, buffered: true });
                } catch {
                    // Not supported: its numbers stay empty, and the gate names them.
                }
            };
            watch('largest-contentful-paint', (entry) => (perf.lcp = entry.startTime));
            watch('longtask', (entry) => perf.tasks.push([entry.startTime, entry.duration]));
            watch('paint', (entry) => {
                if (entry.name === 'first-contentful-paint') perf.fcp = entry.startTime;
            });
        });
        const page = await context.newPage();
        await page.route(VARIANT_REQUEST, (route) => {
            const format = variantFormat(route.request().url());
            return route.fulfill({ body: prints[format], contentType: `image/${format}` });
        });
        if (spec.throttle !== 1) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: spec.throttle });
        const response = await page.goto(`${origin}${route}`, { waitUntil: 'load', timeout: 60_000 });
        // A load that isn't a 200 has no LCP to count: the gate names the cell, and the run goes on.
        expect.soft(response?.status(), `${route} from ${origin}`).toBe(200);
        if (response?.status() !== 200) return { lcp: Number.NaN, tbt: 0 };
        const loaded = Date.now();
        for (;;) {
            await page.waitForTimeout(250);
            const quiet = await page.evaluate((ms) => performance.now() - (window as unknown as { __perf: { last: number } }).__perf.last >= ms, QUIET_MS);
            if (quiet || Date.now() - loaded >= QUIET_CAP_MS) break;
        }
        const perf = await page.evaluate(() => (window as unknown as { __perf: { lcp: number; fcp: number; tasks: [number, number][] } }).__perf);
        return { lcp: perf.lcp, tbt: totalBlockingTime(perf.tasks.map(([start, duration]) => ({ start, duration })), Number.isFinite(perf.fcp) ? perf.fcp : 0) };
    } finally {
        await context.close();
    }
}

test(`lab LCP on every route, device and theme: the head against v1.2.0, ${LCP_LOADS} cold loads each`, async ({ browser }) => {
    // 5 routes × 2 devices × 6 builds or themes × 5 loads: 300 cold loads, about 4 s each.
    test.setTimeout(35 * 60_000);
    const [base, head] = servers;
    const { slug, photoId } = catalog!;
    const every: Record<string, string> = { Home: '/', Work: '/work', 'A series': `/work/${slug}`, 'The Viewer, cold': `/work/${slug}/photo/${photoId}`, About: '/about' };
    // PERF_LCP_ROUTES=Home,About re-measures those alone (a change that touches only them); a name it doesn't know fails.
    const only = process.env.PERF_LCP_ROUTES?.split(',').map((name) => name.trim()).filter(Boolean);
    for (const name of only ?? []) expect(Object.keys(every), `PERF_LCP_ROUTES names ${name}`).toContain(name);
    const routes = only ? Object.fromEntries(Object.entries(every).filter(([name]) => only.includes(name))) : every;
    const samples: LcpSample[] = [];
    const loads: string[] = [];
    for (const [name, route] of Object.entries(routes)) {
        for (const device of Object.keys(DEVICES) as Device[]) {
            phase(`lcp: ${name}, ${device}`);
            loads.push(`${name}, ${device}: load ${os.loadavg()[0].toFixed(1)} at the start`);
            for (let round = 0; round < LCP_LOADS; round++) {
                // Rotated by round, so v1.2.0 and each theme take every place in the order.
                const order = VARIANTS.map((_, i) => VARIANTS[(i + round) % VARIANTS.length]);
                for (const variant of order) {
                    const { lcp, tbt } = await load(browser, variant === 'base' ? base.origin : head.origin, route, device, variant);
                    samples.push({ route: name, device, variant, lcp, tbt });
                }
            }
        }
    }
    const { verdicts, problems } = lcpVerdicts(samples, { routes: Object.keys(routes), devices: Object.keys(DEVICES), themes: THEMES });
    const report = [
        `Lab LCP, the head against v1.2.0: median of ${LCP_LOADS} cold loads. Pass: at most ${LCP_BOUND.ratio} × v1.2.0's median or its median + ${LCP_BOUND.floorMs} ms, whichever is more, and at most ${LCP_BOUND.ceilingMs} ms. TBT is reported only.`,
        'The phone is 390 × 844 at DPR 3 with the CPU throttled 4x; the desktop 1440 × 900 at DPR 1. System runs on a light device. v1.2.0 has one look, Dark.',
        '',
        lcpTable(verdicts),
        '',
        ...(problems.length ? ['Problems:', ...problems.map((problem) => `- ${problem}`), ''] : []),
        ...loads,
        '',
        '| Route | Device | Build or theme | LCP ms per load | TBT ms per load |',
        '|---|---|---|---|---|',
        ...Object.keys(routes).flatMap((route) =>
            Object.keys(DEVICES).flatMap((device) =>
                VARIANTS.map((variant) => {
                    const runs = samples.filter((s) => s.route === route && s.device === device && s.variant === variant);
                    return `| ${route} | ${device} | ${variant === 'base' ? 'v1.2.0' : variant} | ${runs.map((s) => Math.round(s.lcp)).join(', ')} | ${runs.map((s) => Math.round(s.tbt)).join(', ')} |`;
                }),
            ),
        ),
    ].join('\n');
    fs.mkdirSync(path.join(process.cwd(), 'test-results', 'perf'), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), 'test-results', 'perf', 'lcp.md'), `${report}\n`);
    console.log(report);
    expect(problems, 'every cell has all its loads, each with an LCP').toEqual([]);
    for (const v of verdicts) expect.soft(v.pass, `${v.route}, ${v.device}, ${v.theme}: ${v.why.join('; ')}`).toBe(true);
});
