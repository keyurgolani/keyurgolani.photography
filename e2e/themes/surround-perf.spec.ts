import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { publish } from '../../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../../lib/catalog/testing';
import { BUDGET_VARIANT_BYTES } from '../../lib/perf/fixture';
import { waitForHydration } from '../support/hydration';
import { expect, test } from '../support/test';

// The perf run for the sequence's surround (spec §13, PR map item 3), on a 5,000-photo series with every page shown by
// Show more. It runs non-exclusive on a shared machine, so it gates on ratios, not milliseconds: the base (next before
// the themes, PARITY_BASE_DIR) and the head serve the same catalog side by side, and each scroll sweep of the head, in
// Black and in the three themes with a surround (Light's and Dark's carry a blurred shadow), is divided by a base sweep
// taken right beside it, over several interleaved rounds. The machine's load is recorded with every sweep. The variant
// files are sparse, so every image fails to decode and each entry shows its fallback box, which wears the same
// surround: the shadows are the work being timed.
//
//   PARITY_BASE_DIR=<built base> npx playwright test -c e2e/themes/perf.config.ts

const PHOTOS = 5_000;
const ROUNDS = 3;
const THEMES = { light: 'light', charcoal: 'dark', bright: 'bright', black: 'black' } as const;
/** The head may take this much longer per frame than the base beside it, at the 95th percentile: Black about none, a surround a little. */
const BOUND = { black: 1.25, surround: 1.5 };
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

/** Frame times while scrolling the page from the top to the end in even steps, one per frame. */
function sweep(page: Page) {
    return page.evaluate(
        () =>
            new Promise<{ frames: number; p50: number; p95: number; over50: number }>((resolve) => {
                window.scrollTo(0, 0);
                const end = document.documentElement.scrollHeight - innerHeight;
                const step = Math.max(40, end / 600);
                const deltas: number[] = [];
                let last = 0;
                const tick = (now: number) => {
                    deltas.push(now - last);
                    last = now;
                    if (window.scrollY >= end - 1) {
                        deltas.sort((a, b) => a - b);
                        const at = (q: number) => +deltas[Math.min(deltas.length - 1, Math.floor(q * deltas.length))].toFixed(2);
                        resolve({ frames: deltas.length, p50: at(0.5), p95: at(0.95), over50: deltas.filter((d) => d > 50).length });
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
    );
}

/** Opens the series and presses Show more until every entry is in; returns each press's time to render. */
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
    return renders;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

let catalog: TestCatalog | undefined;
const servers: Server[] = [];
let temp = '';

test.beforeAll(async () => {
    test.setTimeout(30 * 60_000);
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'surround-perf-'));
    const library = path.join(temp, 'library');
    const siteConfig = path.join(temp, 'site-config');
    fs.mkdirSync(library);
    fs.mkdirSync(siteConfig);
    catalog = await createTestCatalog({ photos: PHOTOS, series: [{ photos: PHOTOS }], seed: 6, variantBytes: BUDGET_VARIANT_BYTES });
    const outcome = await publish({ dataRoot: catalog.root, actor: 'e2e', confirmLaunch: true, logger: { log: () => undefined } });
    expect(outcome.outcome, outcome.message).toBe('PUBLISHED');
    servers.push(await serve(BASE!, ports[0] ?? 3375, catalog.root, library, siteConfig), await serve(process.cwd(), ports[1] ?? 3376, catalog.root, library, siteConfig));
});

test.afterAll(async () => {
    test.setTimeout(5 * 60_000);
    await Promise.all(servers.map((server) => server.stop()));
    await catalog?.cleanup();
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
});

test(`a ${PHOTOS}-photo sequence: the head's scroll, in every theme, against the base beside it`, async ({ browser }) => {
    test.setTimeout(60 * 60_000);
    const [base, head] = servers;
    const url = (origin: string) => `${origin}/work/${catalog!.series[0].slug}`;
    const open = async () => {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce' });
        await context.addInitScript(() => localStorage.setItem('theme', 'dark'));
        return context.newPage();
    };
    const basePage = await open();
    const headPage = await open();
    const renders = { base: await expand(basePage, url(base.origin)), head: await expand(headPage, url(head.origin)) };
    const paint = (theme: keyof typeof THEMES) =>
        headPage.evaluate(([choice, painted]) => {
            document.documentElement.setAttribute('data-theme-choice', choice);
            document.documentElement.setAttribute('data-theme', painted);
        }, [theme, THEMES[theme]] as const);

    const rows: string[] = [];
    const ratios: Record<string, number[]> = Object.fromEntries(Object.keys(THEMES).map((theme) => [theme, []]));
    for (let round = 1; round <= ROUNDS; round++) {
        for (const theme of Object.keys(THEMES) as (keyof typeof THEMES)[]) {
            // The base and the head, one right after the other, so the load they share is the same.
            const load = os.loadavg()[0].toFixed(1);
            const before = await sweep(basePage);
            await paint(theme);
            const after = await sweep(headPage);
            const ratio = after.p95 / before.p95;
            ratios[theme].push(ratio);
            rows.push(`| ${round} | ${theme === 'charcoal' ? 'dark' : theme} | ${load} | ${before.p95} | ${after.p95} | ${ratio.toFixed(2)} | ${before.over50} / ${after.over50} |`);
        }
    }
    const verdict = Object.fromEntries(Object.entries(ratios).map(([theme, values]) => [theme, +median(values).toFixed(2)]));
    const table = [
        `Show more, to all ${PHOTOS}: base ${renders.base.length} presses, median ${median(renders.base)} ms; head ${renders.head.length} presses, median ${median(renders.head)} ms (ratio ${(median(renders.head) / median(renders.base)).toFixed(2)})`,
        '',
        '| Round | Head theme | Load (1 min) | Base p95 ms | Head p95 ms | Ratio | Frames over 50 ms, base / head |',
        '|---|---|---|---|---|---|---|',
        ...rows,
        '',
        `Median ratios: ${Object.entries(verdict).map(([theme, value]) => `${theme === 'charcoal' ? 'Dark' : theme} ${value}`).join(', ')}. Bounds: Black ${BOUND.black}, a surround ${BOUND.surround}.`,
    ].join('\n');
    fs.mkdirSync(path.join(process.cwd(), 'test-results', 'perf'), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), 'test-results', 'perf', 'surround-perf.md'), `${table}\n`);
    console.log(table);
    for (const [theme, value] of Object.entries(verdict)) {
        expect.soft(value, `${theme}: the head's p95 frame against the base's`).toBeLessThanOrEqual(theme === 'black' ? BOUND.black : BOUND.surround);
    }
});
