import { devices, type Browser, type BrowserContextOptions, type Page, type Request } from '@playwright/test';
import sharp from 'sharp';
import { TONE_IDLE_TIMEOUT_MS } from '../components/badgePlace';
import { TONE_SETTLE_MS } from '../components/home/useCopyTone';
import { publish } from '../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../lib/catalog/testing';
import { BUDGET_FIXTURE, BUDGET_VARIANT_BYTES } from '../lib/perf/fixture';
import { declaredMediaBytes, MAX_TONE_REREADS_PER_IMAGE } from '../lib/perf/report';
import { startCatalogServer, type CatalogServer } from './support/catalogServer';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';

// #6's first viewports in the browser, on the 5,000-photograph budget library
// (100 series, the featured one of 100 first; lib/perf/fixture.ts) published
// to a second `next start`. For
// Home, Work, a series, and the Viewer, on a desktop and a phone, it counts
// what the first load asks for (the document, /media images, /api data),
// checks each image asks for the rung its sizes and the device need and no
// more, adds up the image bytes the server declares, and checks the server
// HTML already holds the lead photograph and its preload. Variant files are
// sparse, and each AVIF file starts with a real AVIF of its size
// (decodableAvif), so every image decodes and the first load is the success
// path the policy counts: a browser that takes AVIF asks for nothing else. The
// rescue, an AVIF file that fails and takes its one WebP retry, is a case of
// its own at the end. Nothing here looks at pixels.
//
// The library is about 45,000 files and takes minutes to write and publish,
// so this runs once, on the desktop project, and opens the phone as its own
// context.

test.describe.configure({ mode: 'serial' });

const HOOK_TIMEOUT = 15 * 60_000;
const KIB = 1024;

let catalog: TestCatalog | undefined;
let server: CatalogServer | undefined;
/** Each screen's numbers, attached to the run and printed, for the PR's table. */
const report: Record<string, unknown> = {};

test.beforeAll(async () => {
    test.skip(test.info().project.name !== 'desktop', 'One library per run: the phone opens as a context of its own.');
    test.setTimeout(HOOK_TIMEOUT);
    catalog = await createTestCatalog({ ...BUDGET_FIXTURE, decodableAvif: true });
    const outcome = await publish({ dataRoot: catalog.root, actor: 'e2e', confirmLaunch: true, logger: { log: () => undefined } });
    expect(outcome.outcome, outcome.message).toBe('PUBLISHED');
    // Above the ports the other catalog specs take when E2E_CATALOG_PORT pins them.
    const base = Number(process.env.E2E_CATALOG_PORT);
    server = await startCatalogServer(catalog.root, Number.isInteger(base) && base > 0 ? base + 10 + test.info().parallelIndex : undefined);
});

test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    if (Object.keys(report).length > 0) await test.info().attach('first-viewport.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    await server?.stop();
    await catalog?.cleanup();
});

const origin = () => {
    if (!server) throw new Error('The catalog server did not start');
    return server.origin;
};
const featured = () => {
    const series = catalog?.series[0];
    if (!series) throw new Error('No featured series');
    return series;
};

const PROFILES = {
    desktop: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    phone: devices['Pixel 7'],
} satisfies Record<string, BrowserContextOptions>;
type Profile = keyof typeof PROFILES;

type Screen = 'home' | 'work' | 'series' | 'viewer';
const SCREENS: Screen[] = ['home', 'work', 'series', 'viewer'];
const pathOf = (screen: Screen) =>
    ({ home: '/', work: '/work', series: `/work/${featured().slug}`, viewer: `/work/${featured().slug}/photo/${featured().photoIds[0]}` })[screen];

/**
 * The first-viewport policy, per screen. `images` caps the /media requests of
 * the first load where the screen has a fixed number to show, and `api` the
 * /api requests. Work and the series show a list, so they're held by where
 * each request sits instead (`reach`): every image asked for belongs to an
 * entry whose top is within REACH px under the first viewport, which is as
 * far ahead as Chromium starts a lazy image, and an entry past that is never
 * asked for. `lead` is the largest rung the lead photograph may ask for, from
 * its sizes at that device's width and pixel ratio, and `rest` the largest
 * any other image may (null where there's no other). Where `images` is set,
 * the payload target is the lead at its rung plus the rest of the cap at
 * theirs, at the fixture's declared AVIF sizes (BUDGET_VARIANT_BYTES).
 */
type Policy = { api: number; lead: Record<Profile, number>; rest: Record<Profile, number> | null } & ({ images: number } | { reach: true });
const POLICY: Record<Screen, Policy> = {
    // heroSizes(): the slide covers the viewport, so 1280 px wide, or on the phone the photograph at 915 px tall (1,372 px
    // wide for 3:2, 610 for 2:3) at 2.625. The opening, then the next once it shows: two at most.
    home: { images: 2, api: 1, lead: { desktop: 1920, phone: 1920 }, rest: { desktop: 1920, phone: 1920 } },
    // coverSizes(): 7/12 of the column at 3:2 for a wide entry, 5/12 at 4:5 for a narrow one above 768 px, the column at 4:3
    // below, each times what a cover crop overhangs. A 3:2 cover in a narrow box is 1.875 boxes wide, so 874 px. Under
    // 768 px, the rung under the rule's (rule 5): the phone's 1,122 device px ask for 748. Only covers near the first
    // viewport, never the hundred.
    work: { reach: true, api: 0, lead: { desktop: 800, phone: 800 }, rest: { desktop: 1200, phone: 800 } },
    // The cover at its 82vh-capped width, then thumbnails at 20vw or 50vw, only near the first viewport.
    series: { reach: true, api: 0, lead: { desktop: 1200, phone: 1200 }, rest: { desktop: 400, phone: 800 } },
    // One photograph, at 80vw or 100vw capped by the screen's height. Nothing else.
    viewer: { images: 1, api: 0, lead: { desktop: 1200, phone: 1200 }, rest: null },
};

/** How far under the first viewport a lazy image may start, in px: Chromium's own lazy-loading margin. */
const REACH = 3_000;

/** The entry on a list screen that each photograph's image belongs to: a series entry by its ID, a Work entry by its series' cover. */
function entrySelectors(screen: 'work' | 'series'): Map<string, string> {
    if (!catalog) throw new Error('No catalog');
    if (screen === 'series') return new Map(featured().photoIds.map((photoId) => [photoId, `#photo-${photoId}`]));
    // The entry's list item, cover and copy, since its link is the title under the cover (#171, B3).
    return new Map(catalog.series.flatMap((series) => (series.cover ? [[series.cover.photoId, `main li:has(a[href="/work/${series.slug}"])`] as const] : [])));
}

interface MediaRequest {
    photoId: string;
    /** The rung's nominal width: 400, 800, 1200, or 1920. */
    rung: number;
    format: string;
    /** The pathname, by which images are told apart. */
    url: string;
    /** The pathname and query, by which a re-read is matched to the file it reads. */
    href: string;
    /** What the server said it sent. */
    bytes: number;
}

/** A /media fetch() as the page's Resource Timing saw it: a copy-tone re-read, and whether it touched the network. */
interface ToneRead {
    /** Pathname and query. */
    url: string;
    transferSize: number;
    deliveryType: string;
    encodedBodySize: number;
}

interface Measured {
    page: Page;
    document: { transfer: number };
    media: MediaRequest[];
    /**
     * Home's copy-tone sampler's fetch() of the file its slide shows (components/badgePlace.ts's canvasSampler), from
     * the cache only (`only-if-cached`): a second read of an image already loaded. Not an image request. `reads` are
     * the ones that finished and `refused` the ones that failed, by pathname and query, as Playwright saw them;
     * `timing` is each one the page's Resource Timing recorded, in the settled snapshot.
     */
    reads: string[];
    refused: string[];
    timing: ToneRead[];
    api: string[];
    /** About's portrait, which Home's intro and badge show: the variants asked for. Not catalog images, but part of the first load. */
    portraits: string[];
    other: number;
}

const MEDIA = /^\/media\/(ph_[^/]+)\/[^/]+\/[^/]+\/w(\d+)\.(avif|webp)$/;
const PORTRAIT = /^\/about\/portrait\/[0-9a-f]{32}\/w(\d+)\.(avif|webp)$/;

/**
 * How long the copy tone's reads must stay unchanged before the snapshot: the sampler waits for the browser to be idle
 * for up to TONE_IDLE_TIMEOUT_MS before it reads, after a TONE_SETTLE_MS settle, so an earlier snapshot can miss a read.
 */
const TONE_QUIET_MS = TONE_IDLE_TIMEOUT_MS + TONE_SETTLE_MS;

/** Every /media fetch() the page's Resource Timing holds, by pathname and query. */
const toneTiming = (page: Page): Promise<ToneRead[]> =>
    page.evaluate(() =>
        (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
            .filter((entry) => entry.initiatorType === 'fetch' && new URL(entry.name).pathname.startsWith('/media/'))
            .map((entry) => {
                const url = new URL(entry.name);
                return { url: url.pathname + url.search, transferSize: entry.transferSize, deliveryType: (entry as PerformanceResourceTiming & { deliveryType?: string }).deliveryType ?? '', encodedBodySize: entry.encodedBodySize };
            }),
    );

/** A copy-tone read that came from the cache, of the whole file the fixture declares: the proof the read happened and stayed off the network. */
const fromCache = (read: ToneRead) => read.deliveryType === 'cache' && read.transferSize === 0 && read.encodedBodySize === declaredMediaBytes(new URL(read.url, 'http://x').pathname);

/**
 * Open `path` in a fresh context, wait until the first load is quiet and the copy tone's reads have settled, and sort
 * what it asked for. `prepare` runs before the load. `toneControl` first waits for one read from the cache (Home's
 * success path), so a snapshot can't pass by coming before the sampler.
 */
async function measure(browser: Browser, profile: Profile, path: string, { prepare, toneControl = false }: { prepare?: (page: Page) => Promise<void>; toneControl?: boolean } = {}): Promise<Measured> {
    const context = await browser.newContext(PROFILES[profile]);
    const page = await context.newPage();
    // Room for every request a load makes, as ci/perf/measure.mjs gives it, so the snapshot misses none.
    await page.addInitScript(() => performance.setResourceTimingBufferSize(2000));
    await prepare?.(page);
    let toneAsks = 0;
    page.on('request', (request) => {
        if (request.resourceType() === 'fetch' && new URL(request.url()).pathname.startsWith('/media/')) toneAsks += 1;
    });
    const finished: Promise<void>[] = [];
    const seen: { request: Request; bytes: number; transfer: number }[] = [];
    page.on('requestfinished', (request) => {
        finished.push(
            (async () => {
                const [response, sizes] = await Promise.all([request.response(), request.sizes()]);
                seen.push({ request, bytes: Number(response?.headers()['content-length'] ?? 0), transfer: sizes.responseBodySize });
            })(),
        );
    });
    const failed: Request[] = [];
    page.on('requestfailed', (request) => failed.push(request));
    await page.goto(`${origin()}${path}`);
    await waitForHydration(page);
    await page.waitForLoadState('networkidle');
    if (toneControl) {
        // The message carries the entries the poll last saw, so a red control leaves each read's url, transferSize,
        // deliveryType and encodedBodySize behind, not just a trace.
        let last: ToneRead[] = [];
        try {
            await expect
                .poll(
                    async () => {
                        last = await toneTiming(page);
                        return last.some(fromCache);
                    },
                    { message: 'one copy-tone read from the cache, of the whole file, with no transfer', timeout: 20_000 },
                )
                .toBe(true);
        } catch (error) {
            throw new Error(`One copy-tone read from the cache, of the whole file, with no transfer, never came. Resource Timing had ${JSON.stringify(last)}`, { cause: error });
        }
    }
    // Settled: the reads, as Resource Timing and Playwright both count them, unchanged for TONE_QUIET_MS.
    let count = -1;
    let since = Date.now();
    let settled = false;
    for (const deadline = Date.now() + 30_000; Date.now() < deadline; await page.waitForTimeout(250)) {
        const now = (await toneTiming(page)).length + toneAsks;
        if (now !== count) [count, since] = [now, Date.now()];
        else if (Date.now() - since >= TONE_QUIET_MS) {
            settled = true;
            break;
        }
    }
    // A snapshot of reads still coming isn't one: fail rather than judge it.
    expect(settled, "the copy tone's reads never settled").toBe(true);
    const timing = await toneTiming(page);
    await Promise.all(finished);

    const all = [...seen.map((entry) => ({ ...entry, failed: false })), ...failed.map((request) => ({ request, bytes: 0, transfer: 0, failed: true }))];
    const media: MediaRequest[] = [];
    const reads: string[] = [];
    const refused: string[] = [];
    const api: string[] = [];
    let other = 0;
    const portraits: string[] = [];
    let document = { transfer: 0 };
    for (const { request, bytes, transfer, failed: refusedRead } of all) {
        const url = new URL(request.url());
        const match = MEDIA.exec(url.pathname);
        if (request.resourceType() === 'document') document = { transfer };
        // Any fetch() of /media, matched or not, so none falls into `other`, where nothing asserts it.
        else if (url.pathname.startsWith('/media/') && request.resourceType() === 'fetch') (refusedRead ? refused : reads).push(url.pathname + url.search);
        else if (match) media.push({ photoId: match[1], rung: Number(match[2]), format: match[3], url: url.pathname, href: url.pathname + url.search, bytes });
        else if (url.pathname.startsWith('/api/')) api.push(url.pathname);
        else if (PORTRAIT.test(url.pathname)) portraits.push(url.pathname);
        else other += 1;
    }
    return { page, document, media, reads, refused, timing, api, portraits, other };
}

for (const profile of Object.keys(PROFILES) as Profile[]) {
    for (const screen of SCREENS) {
        test(`${screen} on the ${profile}: the first viewport's requests, rungs, and reach stay inside the policy`, async ({ browser }) => {
            const policy = POLICY[screen];
            const { page, document: doc, media, reads, refused, timing, api, portraits, other } = await measure(browser, profile, pathOf(screen), { toneControl: screen === 'home' });
            try {
                const bytes = media.reduce((sum, request) => sum + request.bytes, 0);
                // Every screen leads with the featured series' first photograph: Home's opening, Work's first cover, the series cover, the Viewer's photograph.
                const leadId = featured().photoIds[0];
                report[`${screen}/${profile}`] = {
                    documentKiB: Number((doc.transfer / KIB).toFixed(1)),
                    images: media.length,
                    imageKiB: Number((bytes / KIB).toFixed(1)),
                    rungs: [...new Set(media.map((request) => request.rung))].sort((a, b) => a - b),
                    api: api.length,
                    reads: timing.map(({ url, transferSize, deliveryType }) => ({ url, transferSize, deliveryType })),
                    portraits: portraits.length,
                    other,
                };
                console.log(`[first-viewport] ${screen}/${profile} ${JSON.stringify(report[`${screen}/${profile}`])}`);

                expect(media.length, 'the lead photograph is asked for').toBeGreaterThan(0);
                if ('images' in policy) expect(media.length, 'images on the first load').toBeLessThanOrEqual(policy.images);
                expect(api.length, '/api requests on the first load').toBeLessThanOrEqual(policy.api);
                // The browser takes AVIF, so the AVIF-only preload is the request the <picture> makes, never a second format.
                for (const request of media) expect(request.format, request.url).toBe('avif');
                expect(new Set(media.map((request) => request.url)).size, 'no image is asked for twice').toBe(media.length);
                // Only Home's copy tone reads a file again: only a file its images already loaded, by pathname and query,
                // at most MAX_TONE_REREADS_PER_IMAGE times each, and never over the network (transferSize 0).
                if (screen !== 'home') expect([reads, refused, timing], 'fetch() of /media off Home').toEqual([[], [], []]);
                const loaded = media.map((request) => request.href);
                for (const url of [...reads, ...refused, ...timing.map((read) => read.url)]) expect(loaded, `${url} is read again, not fetched new`).toContain(url);
                for (const read of timing) expect(read.transferSize, `${read.url} came from the cache`).toBe(0);
                for (const url of new Set(reads)) expect(reads.filter((read) => read === url).length, `${url}: re-reads`).toBeLessThanOrEqual(MAX_TONE_REREADS_PER_IMAGE);
                // The same cap on Resource Timing's list, which also holds a read Playwright saw refused.
                for (const url of new Set(timing.map((read) => read.url))) expect(timing.filter((read) => read.url === url).length, `${url}: re-reads in Resource Timing`).toBeLessThanOrEqual(MAX_TONE_REREADS_PER_IMAGE);

                // Each image at no more than the rung its sizes ask for at this width and pixel ratio.
                expect(media.map((request) => request.photoId), 'the lead photograph is asked for').toContain(leadId);
                for (const request of media) {
                    const cap = request.photoId === leadId ? policy.lead[profile] : policy.rest?.[profile];
                    expect(cap, `${request.url} is on a screen that shows only its lead`).toBeDefined();
                    expect(request.rung, request.url).toBeLessThanOrEqual(cap!);
                }
                // One small variant of About's portrait, for the intro and the badge, and only on Home.
                expect(portraits.length, "About's portrait, Home only").toBe(screen === 'home' ? 1 : 0);
                for (const url of portraits) expect(Number(PORTRAIT.exec(url)![1]), url).toBeLessThanOrEqual(800);

                if ('images' in policy) {
                    // Payload: the lead at its rung, and the rest of the request cap at theirs, at the fixture's declared AVIF sizes.
                    const avif = (rung: number) => BUDGET_VARIANT_BYTES[`w${rung}` as 'w1920'].avif;
                    const target = avif(policy.lead[profile]) + (policy.images - 1) * (policy.rest === null ? 0 : avif(policy.rest[profile]));
                    expect(bytes, 'image bytes on the first load').toBeLessThanOrEqual(target);
                } else if (screen === 'work' || screen === 'series') {
                    // Every image asked for belongs to an entry near the first viewport, and the entries far below are never asked for.
                    const selectors = entrySelectors(screen);
                    const ids = [...selectors.keys()];
                    const tops = await page.evaluate(
                        (pairs) => ({
                            height: window.innerHeight,
                            tops: Object.fromEntries(pairs.map(([id, selector]) => [id, (document.querySelector(selector)?.getBoundingClientRect().top ?? NaN) + window.scrollY])),
                        }),
                        [...selectors.entries()],
                    );
                    const limit = tops.height + REACH;
                    for (const request of media) {
                        expect(selectors.has(request.photoId), `${request.url} belongs to an entry on the page`).toBe(true);
                        expect(tops.tops[request.photoId], `${request.url}'s entry is within ${REACH} px under the first viewport`).toBeLessThanOrEqual(limit + 1);
                    }
                    const far = ids.filter((id) => tops.tops[id] > limit + 1);
                    // The 100th entry is far below on both devices, so this always has entries to check.
                    expect(far.length, 'entries far below the first viewport').toBeGreaterThan(0);
                    for (const request of media) expect(far, `${request.url} is near the first viewport`).not.toContain(request.photoId);
                }
                // Home asks only for its opening photograph and the one after it, and for no other series' covers.
                if (screen === 'home') for (const request of media) expect(featured().photoIds.slice(0, 2)).toContain(request.photoId);
            } finally {
                await page.context().close();
            }
        });
    }
}

// The rescue (#6): the Viewer's photograph, whose AVIF file fails, takes exactly one WebP retry, at the rung the AVIF
// was, and loads from it. Its AVIF file may be asked for twice, the preload and the image's own try, both the same file;
// nothing else is fetched. The WebP the route serves is a real one at that rung's size, since the fixture's are zeros.
test('the viewer on the desktop: an AVIF file that fails takes one WebP retry at the same rung, and nothing else is fetched', async ({ browser }) => {
    const leadId = featured().photoIds[0];
    const lead = catalog!.content.photos.find((photo) => photo.id === leadId);
    if (!lead) throw new Error('No lead photograph');
    const leadMedia = (url: URL) => MEDIA.exec(url.pathname)?.[1] === leadId;
    const { page, media, reads, api } = await measure(browser, 'desktop', pathOf('viewer'), { prepare: async (page) => {
        await page.route(
            (url) => leadMedia(url),
            async (route) => {
                const [, , rung, format] = MEDIA.exec(new URL(route.request().url()).pathname)!;
                if (format === 'avif') return route.fulfill({ status: 404, body: '' });
                const size = lead.variants[`w${rung}` as keyof typeof lead.variants].webp;
                const body = await sharp({ create: { width: size.width, height: size.height, channels: 3, background: { r: 90, g: 110, b: 130 } } }).webp().toBuffer();
                return route.fulfill({ status: 200, contentType: 'image/webp', headers: { 'content-length': String(body.length) }, body });
            },
        );
    } });
    try {
        const avif = media.filter((request) => request.format === 'avif');
        const webp = media.filter((request) => request.format === 'webp');
        expect(media.every((request) => request.photoId === leadId), 'only the lead photograph is asked for').toBe(true);
        expect(new Set(avif.map((request) => request.url)).size, 'one AVIF file').toBe(1);
        expect(avif.length, 'the preload and the image, at most').toBeLessThanOrEqual(2);
        expect(webp, 'one WebP retry').toHaveLength(1);
        expect(webp[0].rung, 'the retry at the rung the AVIF was').toBe(avif[0].rung);
        expect([reads, api]).toEqual([[], []]);
        // The retry rescued it: the photograph shows from WebP, and no failure stands in for it.
        await expect(page.locator('[data-viewer-current] img').first()).toHaveJSProperty('complete', true);
        expect(await page.locator('[data-viewer-current] img').first().evaluate((image: HTMLImageElement) => [image.naturalWidth > 0, new URL(image.currentSrc).pathname])).toEqual([true, webp[0].url]);
        await expect(page.locator('[data-surface="viewer"] [data-photo="unavailable"]')).toHaveCount(0);
    } finally {
        await page.context().close();
    }
});

// The copy tone with the browser's cache off (Home, on the phone): the sampler still runs, and its cache-only read is
// refused, so nothing it fetches finishes with a response. The one in-browser kill of a sampler that drops its cache
// option or uses force-cache, which would download the slide again here. No route, which would turn the cache off for
// everything and hide the difference.
test('home on the phone with the cache off: the copy tone reads nothing from the network', async ({ browser }) => {
    const { page, reads, refused, timing } = await measure(browser, 'phone', pathOf('home'), {
        prepare: async (page) => {
            const cdp = await page.context().newCDPSession(page);
            await cdp.send('Network.enable');
            await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
        },
    });
    try {
        report['home/phone, cache off'] = { reads, refused, timing };
        expect(refused.length, 'the sampler ran: its cache-only read was refused').toBeGreaterThan(0);
        expect(reads, 'no /media fetch() finished with a response').toEqual([]);
    } finally {
        await page.context().close();
    }
});

test('each server HTML holds its lead photograph and a preload carrying the same srcset and sizes', async ({ request }) => {
    for (const screen of SCREENS) {
        const html = await (await request.get(`${origin()}${pathOf(screen)}`)).text();
        const attribute = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag)?.[1];
        // Home's portrait has a preload of its own, from /about/portrait/; these are the catalog's.
        const preloads = [...html.matchAll(/<link\b[^>]*>/g)]
            .map((match) => match[0])
            .filter((tag) => attribute(tag, 'rel') === 'preload' && attribute(tag, 'as') === 'image' && attribute(tag, 'imagesrcset')?.startsWith('/media/'));
        expect(preloads, screen).toHaveLength(1);
        const [preload] = preloads;
        expect(attribute(preload, 'type'), screen).toBe('image/avif');
        expect(attribute(preload, 'href'), 'the srcset decides, never one file for every viewport').toBeUndefined();
        expect(attribute(preload, 'imagesrcset'), screen).toContain(featured().photoIds[0]);
        // The <picture> in the same HTML holds the same AVIF source.
        const sources = [...html.matchAll(/<source\b[^>]*>/g)].map((match) => match[0]).filter((tag) => attribute(tag, 'type') === 'image/avif');
        expect(
            sources.some((tag) => attribute(tag, 'srcset') === attribute(preload, 'imagesrcset') && attribute(tag, 'sizes') === attribute(preload, 'imagesizes')),
            screen,
        ).toBe(true);
    }
});

test.describe('a failed derivative keeps its box and the way on', () => {
    // The library's AVIF files decode, so each case fails its own: every /media file, both formats, answers 404, on
    // every page the case goes to.
    test.beforeEach(async ({ page }) => {
        await page.route(
            (url) => url.pathname.startsWith('/media/'),
            (route) => route.fulfill({ status: 404, body: '' }),
        );
    });

    test('Home: the failure is offered, and the series and the site stay reachable', async ({ page }) => {
        await page.goto(`${origin()}/`);
        await waitForHydration(page);
        // The opening and the next both fail, so the walk stops there (#4): two images asked for, not the whole loop.
        await expect(page.locator('[data-home-state]')).toHaveAttribute('data-home-state', 'image-unavailable');
        await expect(page.getByRole('status').filter({ hasText: 'These photographs can’t be shown right now.' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
        await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
        await page.getByRole('link', { name: 'Enter the series', exact: true }).click();
        await expect(page).toHaveURL(`${origin()}/work/${featured().slug}`);
    });

    test('Work, the series, and the modal Viewer: every failed image keeps its box, and the way on still works', async ({ page }) => {
        await page.goto(`${origin()}/work`);
        await waitForHydration(page);
        const cover = page.locator('[data-cover="unavailable"]').first();
        await expect(cover).toBeVisible();
        const coverBox = await cover.boundingBox();
        expect(coverBox && coverBox.height).toBeGreaterThan(100);
        // The featured series is first in Work's order.
        await page.getByRole('link', { name: featured().title }).first().click();
        await expect(page).toHaveURL(`${origin()}/work/${featured().slug}`);
        await expect(page.locator('ol > li > a [data-photo="unavailable"]').first()).toBeVisible();
        // Fixed 4:3 thumbnail boxes, failed or not.
        const frames = await page.locator('ol > li > a > span:first-child').evaluateAll((spans) =>
            spans.slice(0, 10).map((span) => span.getBoundingClientRect()).map((box) => box.height / box.width),
        );
        for (const ratio of frames) expect(ratio).toBeCloseTo(0.75, 1);
        // From the series the Viewer opens as #9's modal, a client render: the failed box keeps its shape, and Next and Close still work.
        await page.locator(`#photo-${featured().photoIds[0]}`).click();
        await expect(page).toHaveURL(`${origin()}/work/${featured().slug}/photo/${featured().photoIds[0]}`);
        const dialog = page.getByRole('dialog');
        const missing = dialog.locator('[data-photo="unavailable"]');
        await expect(missing).toBeVisible();
        const box = await missing.boundingBox();
        expect(box && box.width / box.height).toBeCloseTo(1.5, 1);
        await dialog.getByRole('button', { name: 'Next photograph', exact: true }).click();
        await expect(page).toHaveURL(`${origin()}/work/${featured().slug}/photo/${featured().photoIds[1]}`);
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(page).toHaveURL(`${origin()}/work/${featured().slug}`);
    });

    test('the Viewer: the box keeps the photograph\'s shape, and Next still moves', async ({ page }) => {
        await page.goto(`${origin()}${pathOf('viewer')}`);
        await waitForHydration(page);
        const missing = page.locator('[data-surface="viewer"] [data-photo="unavailable"]');
        await expect(missing).toBeVisible();
        const box = await missing.boundingBox();
        // The first photograph is 2400 by 1600.
        expect(box && box.width / box.height).toBeCloseTo(1.5, 1);
        // A direct load is the full-page Viewer; once hydrated, #9's shell renders Next as a button.
        await page.getByRole('button', { name: 'Next photograph', exact: true }).click();
        await expect(page).toHaveURL(`${origin()}/work/${featured().slug}/photo/${featured().photoIds[1]}`);
    });
});
