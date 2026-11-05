import fs from 'node:fs';
import { expect, test, type BrowserContextOptions, type Request } from '@playwright/test';
import type { BrowserProfile, BrowserScreen } from '../../lib/perf/budgets';
import { browserChecks, type BrowserMeasurement, type BrowserRow } from '../../lib/perf/report';

// #6's browser budgets: each screen's first load at the refined table's two
// profiles, from navigation to `load` and the network going quiet (5 s at
// most), in a fresh context with no input. It measures the document as
// sent, the catalog images asked for at the bytes the server declares
// (variant files are sparse, so nothing decodes, and nothing here looks at
// pixels), every other image, and when the first catalog image's request
// started after the document finished, and holds each to lib/perf/budgets.ts
// through browserChecks(). The runner (run.ts) says which pages through
// BUDGETS_TARGETS and reads the rows from BUDGETS_BROWSER_OUT. In report
// mode, on a copy of a real library, it fails nothing.

interface Targets {
    mode: 'fixture' | 'report';
    screens: { screen: BrowserScreen; path: string }[];
}

const targetsFile = process.env.BUDGETS_TARGETS;
const outFile = process.env.BUDGETS_BROWSER_OUT;
const targets: Targets = targetsFile ? JSON.parse(fs.readFileSync(targetsFile, 'utf8')) : { mode: 'fixture', screens: [] };

const PROFILES: Record<BrowserProfile, BrowserContextOptions> = {
    phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
};

const MEDIA = /^\/media\/ph_[^/]+\/[^/]+\/[^/]+\/w\d+\.(?:avif|webp)$/;
const QUIET_MS = 5_000;

const rows: BrowserRow[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
    if (!targetsFile || !outFile) throw new Error('Run these through npm run test:budgets, which sets BUDGETS_TARGETS and BUDGETS_BROWSER_OUT.');
});

test.afterAll(() => {
    if (outFile) fs.writeFileSync(outFile, `${JSON.stringify(rows, null, 2)}\n`);
});

for (const profile of Object.keys(PROFILES) as BrowserProfile[]) {
    for (const { screen, path } of targets.screens) {
        test(`${screen} on the ${profile}: the first load stays inside its budgets`, async ({ browser, baseURL }) => {
            const context = await browser.newContext(PROFILES[profile]);
            const page = await context.newPage();
            const seen: Promise<{ request: Request; bytes: number; transfer: number }>[] = [];
            page.on('requestfinished', (request) => {
                seen.push(
                    (async () => {
                        const [response, sizes] = await Promise.all([request.response(), request.sizes()]);
                        return { request, bytes: Number(response?.headers()['content-length'] ?? sizes.responseBodySize), transfer: sizes.responseBodySize };
                    })(),
                );
            });
            try {
                await page.goto(`${baseURL}${path}`, { waitUntil: 'load' });
                await page.waitForLoadState('networkidle', { timeout: QUIET_MS }).catch(() => undefined);
                const finished = await Promise.all(seen);
                const document = finished.find(({ request }) => request.resourceType() === 'document');
                if (!document) throw new Error(`No document for ${path}`);
                const documentTiming = document.request.timing();
                const documentEnd = documentTiming.startTime + documentTiming.responseEnd;
                const media = finished.filter(({ request }) => MEDIA.test(new URL(request.url()).pathname));
                const others = finished.filter(({ request }) => request.resourceType() === 'image' && !MEDIA.test(new URL(request.url()).pathname));
                const starts = media.map(({ request }) => request.timing().startTime).sort((a, b) => a - b);
                const measured: BrowserMeasurement = {
                    documentBytes: document.transfer,
                    eagerImageBytes: media.reduce((sum, { bytes }) => sum + bytes, 0),
                    eagerImages: media.length,
                    otherImageBytes: others.reduce((sum, { bytes }) => sum + bytes, 0),
                    firstImageMs: starts.length > 0 ? Math.round(starts[0] - documentEnd) : null,
                };
                const checks = browserChecks(screen, profile, measured);
                rows.push(...checks);
                console.log(`[budgets] ${screen}/${profile} ${path} ${JSON.stringify(measured)}`);
                if (targets.mode === 'fixture') {
                    for (const row of checks) expect(row.over, `${screen}/${profile} ${row.metric}: ${row.value} against ${row.budget}`).toBe(false);
                }
            } finally {
                await context.close();
            }
        });
    }
}
