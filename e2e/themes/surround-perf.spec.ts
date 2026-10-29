import type { Page } from '@playwright/test';
import { publish } from '../../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../../lib/catalog/testing';
import { BUDGET_VARIANT_BYTES } from '../../lib/perf/fixture';
import { startCatalogServer, type CatalogServer } from '../support/catalogServer';
import { waitForHydration } from '../support/hydration';
import { expect, test } from '../support/test';

// The perf run for the sequence's surround (spec §13, PR map item 3): a 5,000-photo series, every page shown with
// Show more, in Black (no surround, today's) and in each theme whose sm surround carries a blurred shadow (Light and
// Dark) or none (Bright). It times each Show more's render and a scroll from the top to the end of the sequence, frame
// by frame, and writes the numbers for the PR. The variant files are sparse, so every image fails to decode and each
// entry shows its fallback box, which wears the same surround: the shadows are the work being timed. Run alone, under
// an exclusive lock, since it measures time:
//
//   KGN_HEAVY_EXCLUSIVE=1 kgn-heavy.sh ... npx playwright test -c e2e/themes/perf.config.ts

const PHOTOS = 5_000;
const THEMES = ['black', 'light', 'charcoal', 'bright'] as const;

let catalog: TestCatalog | undefined;
let server: CatalogServer | undefined;
const report: Record<string, unknown> = {};

test.beforeAll(async () => {
    test.setTimeout(20 * 60_000);
    catalog = await createTestCatalog({ photos: PHOTOS, series: [{ photos: PHOTOS }], seed: 6, variantBytes: BUDGET_VARIANT_BYTES });
    const outcome = await publish({ dataRoot: catalog.root, actor: 'e2e', confirmLaunch: true, logger: { log: () => undefined } });
    expect(outcome.outcome, outcome.message).toBe('PUBLISHED');
    server = await startCatalogServer(catalog.root, Number(process.env.PERF_PORT) || undefined);
});

test.afterAll(async () => {
    test.setTimeout(5 * 60_000);
    await test.info().attach('surround-perf.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    console.log(JSON.stringify(report, null, 2));
    await server?.stop();
    await catalog?.cleanup();
});

/** Frame times while scrolling the page from the top to the end in even steps, one per frame. */
function scrollSweep(page: Page) {
    return page.evaluate(
        () =>
            new Promise<{ frames: number; p50: number; p95: number; max: number; over50: number }>((resolve) => {
                window.scrollTo(0, 0);
                const end = document.documentElement.scrollHeight - innerHeight;
                const step = Math.max(40, end / 600);
                const deltas: number[] = [];
                let last = performance.now();
                const tick = (now: number) => {
                    deltas.push(now - last);
                    last = now;
                    if (window.scrollY >= end - 1) {
                        deltas.sort((a, b) => a - b);
                        const at = (q: number) => +deltas[Math.min(deltas.length - 1, Math.floor(q * deltas.length))].toFixed(2);
                        resolve({ frames: deltas.length, p50: at(0.5), p95: at(0.95), max: +deltas[deltas.length - 1].toFixed(2), over50: deltas.filter((d) => d > 50).length });
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

for (const theme of THEMES) {
    test(`a ${PHOTOS}-photo sequence in ${theme}: Show more to the end, then a scroll from the top`, async ({ page }) => {
        test.setTimeout(15 * 60_000);
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
        await page.goto(`${server!.origin}/work/${catalog!.series[0].slug}`);
        await waitForHydration(page);
        const entries = page.locator('section[aria-labelledby="series-sequence"] ol > li');
        const button = page.getByRole('button', { name: 'Show more' });
        const renders: number[] = [];
        while (await button.isVisible().catch(() => false)) {
            const before = await entries.count();
            const started = Date.now();
            await button.click();
            await expect.poll(() => entries.count(), { timeout: 30_000 }).toBeGreaterThan(before);
            // The appended rows painted.
            await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            renders.push(Date.now() - started);
        }
        await expect(entries).toHaveCount(PHOTOS);
        const sorted = [...renders].sort((a, b) => a - b);
        const sweep = await scrollSweep(page);
        report[theme] = {
            entries: PHOTOS,
            showMore: { presses: renders.length, p50ms: sorted[Math.floor(sorted.length / 2)], maxms: sorted[sorted.length - 1] },
            scroll: sweep,
        };
        // A lenient bound for the record: no theme's scroll should stall for whole frames at a time.
        expect.soft(sweep.over50, `${theme}: frames over 50 ms while scrolling`).toBeLessThan(Math.max(5, sweep.frames * 0.05));
    });
}
