import fs from 'node:fs';
import { expect, test, type BrowserContextOptions, type Request } from '@playwright/test';
import sharp from 'sharp';
import type { BrowserProfile, BrowserScreen } from '../../lib/perf/budgets';
import { browserChecks, declaredMediaBytes, openingPhotoId, type BrowserMeasurement, type BrowserRow } from '../../lib/perf/report';

// #6's browser budgets: each screen's first load at the refined table's two
// profiles, from navigation to `load` and the network going quiet (5 s at
// most), in a fresh context with no input. It measures the document as
// sent, the catalog images asked for, every other image, and when the
// opening photograph's request, the one the server preloads, started after
// the document finished, and holds each to lib/perf/budgets.ts through
// browserChecks(). The runner (run.ts) says which pages through
// BUDGETS_TARGETS and reads the rows from BUDGETS_BROWSER_OUT.
//
// In fixture mode the variant files are sparse, so `/media` answers with a
// small decodable image of the format asked for, and each image counts at
// the bytes the fixture declares for its rung and format
// (declaredMediaBytes()), as image-sizes.spec.ts counts them. Images decode,
// so this is a normal first load: no failure path, no WebP retry (B8). In
// report mode, on a copy of a real library, nothing is stubbed, images count
// at what the server sent, and nothing fails on a budget.

interface Targets {
    mode: 'fixture' | 'report';
    screens: { screen: BrowserScreen; path: string }[];
}

const targetsFile = process.env.BUDGETS_TARGETS;
const outFile = process.env.BUDGETS_BROWSER_OUT;
const targets: Targets = targetsFile ? JSON.parse(fs.readFileSync(targetsFile, 'utf8')) : { mode: 'fixture', screens: [] };
const fixture = targets.mode === 'fixture';

// Dark, the site's look the suite was written against, as playwright.config.ts's contexts get it.
const PROFILES: Record<BrowserProfile, BrowserContextOptions> = {
    phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'dark' },
    desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' },
};

const QUIET_MS = 5_000;

const rows: BrowserRow[] = [];
/** The stand-in `/media` answer per format: 16 px, solid, decodable. */
const stand: Record<'avif' | 'webp', Buffer> = { avif: Buffer.alloc(0), webp: Buffer.alloc(0) };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
    if (!targetsFile || !outFile) throw new Error('Run these through npm run test:budgets, which sets BUDGETS_TARGETS and BUDGETS_BROWSER_OUT.');
    const image = () => sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 64, g: 92, b: 120 } } });
    stand.avif = await image().avif({ quality: 50, effort: 0 }).toBuffer();
    stand.webp = await image().webp({ quality: 80 }).toBuffer();
});

test.afterAll(() => {
    if (outFile) fs.writeFileSync(outFile, `${JSON.stringify(rows, null, 2)}\n`);
});

for (const profile of Object.keys(PROFILES) as BrowserProfile[]) {
    for (const { screen, path } of targets.screens) {
        test(`${screen} on the ${profile}: the first load stays inside its budgets`, async ({ browser, baseURL }) => {
            const context = await browser.newContext(PROFILES[profile]);
            if (fixture) {
                await context.route('**/media/**', (route) => {
                    const format = new URL(route.request().url()).pathname.endsWith('.webp') ? 'webp' : 'avif';
                    return route.fulfill({ status: 200, contentType: `image/${format}`, body: stand[format], headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } });
                });
            }
            const page = await context.newPage();
            const seen: Promise<{ request: Request; pathname: string; bytes: number; transfer: number }>[] = [];
            page.on('requestfinished', (request) => {
                seen.push(
                    (async () => {
                        const [response, sizes] = await Promise.all([request.response(), request.sizes()]);
                        const pathname = new URL(request.url()).pathname;
                        const sent = Number(response?.headers()['content-length'] ?? sizes.responseBodySize);
                        return { request, pathname, bytes: fixture ? (declaredMediaBytes(pathname) ?? sent) : sent, transfer: sizes.responseBodySize };
                    })(),
                );
            });
            try {
                await page.goto(`${baseURL}${path}`, { waitUntil: 'load' });
                await page.waitForLoadState('networkidle', { timeout: QUIET_MS }).catch(() => undefined);
                const opening = openingPhotoId(await page.evaluate(() => document.querySelector('link[rel="preload"][as="image"][imagesrcset*="/media/"]')?.getAttribute('imagesrcset') ?? null));
                const finished = await Promise.all(seen);
                const doc = finished.find(({ request }) => request.resourceType() === 'document');
                if (!doc) throw new Error(`No document for ${path}`);
                const documentTiming = doc.request.timing();
                if (documentTiming.responseEnd < 0) throw new Error(`The document for ${path} has no response end in its timing, so the first image can't be timed.`);
                const documentEnd = documentTiming.startTime + documentTiming.responseEnd;
                const isMedia = (pathname: string) => pathname.startsWith('/media/');
                const media = finished.filter(({ pathname }) => isMedia(pathname));
                const others = finished.filter(({ request, pathname }) => request.resourceType() === 'image' && !isMedia(pathname));
                const openingStarts = media.filter(({ pathname }) => opening !== null && pathname.startsWith(`/media/${opening}/`)).map(({ request }) => request.timing().startTime);
                const measured: BrowserMeasurement = {
                    documentBytes: doc.transfer,
                    eagerImageBytes: media.reduce((sum, { bytes }) => sum + bytes, 0),
                    eagerImages: media.length,
                    otherImageBytes: others.reduce((sum, { bytes }) => sum + bytes, 0),
                    firstImageMs: openingStarts.length > 0 ? Math.round(Math.min(...openingStarts) - documentEnd) : null,
                };
                const checks = browserChecks(screen, profile, measured);
                rows.push(...checks);
                console.log(`[budgets] ${screen}/${profile} ${path} opening ${opening ?? 'none'} ${JSON.stringify(measured)}`);
                if (fixture) {
                    for (const row of checks) expect(row.over, `${screen}/${profile} ${row.metric}: ${row.value} against ${row.budget}`).toBe(false);
                    // A normal first load: Home asks for its opening photograph and the next, both decoding.
                    if (screen === 'home' && profile === 'desktop') expect(measured.eagerImages, 'Home\'s eager images on the desktop').toBe(2);
                }
            } finally {
                await context.close();
            }
        });
    }
}
