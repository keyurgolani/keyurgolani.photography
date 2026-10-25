import { devices, type Browser, type BrowserContextOptions, type Page, type Request } from '@playwright/test';
import { publish } from '../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../lib/catalog/testing';
import { BUDGET_FIXTURE, BUDGET_VARIANT_BYTES } from '../lib/perf/fixture';
import { startCatalogServer, type CatalogServer } from './support/catalogServer';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';

// #6's first viewports in the browser, on the 5,000-photograph budget library
// (100 series, a featured one of 250) published to a second `next start`. For
// Home, Work, a series, and the Viewer, on a desktop and a phone, it counts
// what the first load asks for (the document, /media images, /api data),
// checks each image asks for the rung its sizes and the device need and no
// more, adds up the image bytes the server declares, and checks the server
// HTML already holds the lead photograph and its preload. Variant files are
// sparse, so every image fails to decode: that's the failed-derivative case,
// and each screen's boxes and navigation have to hold through it. Nothing
// here looks at pixels.
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
    catalog = await createTestCatalog(BUDGET_FIXTURE);
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
 * the first load, `api` the /api requests. `lead` is the largest rung the
 * lead photograph may ask for, from its sizes at that device's width and
 * pixel ratio, and `rest` the largest any other image may (null where there's
 * no other). The payload target is the lead at its rung plus the rest of
 * the cap at theirs, at the fixture's declared AVIF sizes (BUDGET_VARIANT_BYTES).
 * Lazy images count when Chromium starts them, 1,250 to 2,500 px ahead of the
 * viewport, so Work's and the series' caps leave room for that margin while
 * staying far under their hundred entries.
 */
const POLICY: Record<Screen, { images: number; api: number; lead: Record<Profile, number>; rest: Record<Profile, number> | null }> = {
    // 100vw: 1280 px, or 412 px at 2.625. The opening, then the next once it shows: two at most.
    home: { images: 2, api: 1, lead: { desktop: 1920, phone: 1200 }, rest: { desktop: 1920, phone: 1200 } },
    // 60vw above 768 px, else 100vw. Only covers near the first viewport, never the hundred.
    work: { images: 16, api: 0, lead: { desktop: 800, phone: 1200 }, rest: { desktop: 800, phone: 1200 } },
    // The cover at its 82vh-capped width, then thumbnails at 20vw or 50vw.
    series: { images: 40, api: 0, lead: { desktop: 1200, phone: 1200 }, rest: { desktop: 400, phone: 800 } },
    // One photograph, at 80vw or 100vw capped by the screen's height. Nothing else.
    viewer: { images: 1, api: 0, lead: { desktop: 1200, phone: 1200 }, rest: null },
};

interface MediaRequest {
    photoId: string;
    /** The rung's nominal width: 400, 800, 1200, or 1920. */
    rung: number;
    format: string;
    url: string;
    /** What the server said it sent. */
    bytes: number;
}

interface Measured {
    page: Page;
    document: { transfer: number };
    media: MediaRequest[];
    api: string[];
    /** Home's intro portraits, through /_next/image. Not catalog images, but part of the first load. */
    portraits: number;
    other: number;
}

const MEDIA = /^\/media\/(ph_[^/]+)\/[^/]+\/[^/]+\/w(\d+)\.(avif|webp)$/;

/** Open `path` in a fresh context, wait until the first load is quiet, and sort what it asked for. */
async function measure(browser: Browser, profile: Profile, path: string): Promise<Measured> {
    const context = await browser.newContext(PROFILES[profile]);
    const page = await context.newPage();
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
    await Promise.all(finished);

    const all = [...seen.map((entry) => ({ ...entry, failed: false })), ...failed.map((request) => ({ request, bytes: 0, transfer: 0, failed: true }))];
    const media: MediaRequest[] = [];
    const api: string[] = [];
    let other = 0;
    let portraits = 0;
    let document = { transfer: 0 };
    for (const { request, bytes, transfer } of all) {
        const url = new URL(request.url());
        const match = MEDIA.exec(url.pathname);
        if (request.resourceType() === 'document') document = { transfer };
        else if (match) media.push({ photoId: match[1], rung: Number(match[2]), format: match[3], url: url.pathname, bytes });
        else if (url.pathname.startsWith('/api/')) api.push(url.pathname);
        else if (url.pathname === '/_next/image') portraits += 1;
        else other += 1;
    }
    return { page, document, media, api, portraits, other };
}

for (const profile of Object.keys(PROFILES) as Profile[]) {
    for (const screen of SCREENS) {
        test(`${screen} on the ${profile}: the first viewport's requests, rungs, and bytes stay inside the policy`, async ({ browser }) => {
            const policy = POLICY[screen];
            const { page, document, media, api, portraits, other } = await measure(browser, profile, pathOf(screen));
            try {
                const bytes = media.reduce((sum, request) => sum + request.bytes, 0);
                // Every screen leads with the featured series' first photograph: Home's opening, Work's first cover, the series cover, the Viewer's photograph.
                const leadId = featured().photoIds[0];
                report[`${screen}/${profile}`] = {
                    documentKiB: Number((document.transfer / KIB).toFixed(1)),
                    images: media.length,
                    imageKiB: Number((bytes / KIB).toFixed(1)),
                    rungs: [...new Set(media.map((request) => request.rung))].sort((a, b) => a - b),
                    api: api.length,
                    portraits,
                    other,
                };
                console.log(`[first-viewport] ${screen}/${profile} ${JSON.stringify(report[`${screen}/${profile}`])}`);

                expect(media.length, 'the lead photograph is asked for').toBeGreaterThan(0);
                expect(media.length, 'images on the first load').toBeLessThanOrEqual(policy.images);
                expect(api.length, '/api requests on the first load').toBeLessThanOrEqual(policy.api);
                // The browser takes AVIF, so the AVIF-only preload is the request the <picture> makes, never a second format.
                for (const request of media) expect(request.format, request.url).toBe('avif');
                expect(new Set(media.map((request) => request.url)).size, 'no image is asked for twice').toBe(media.length);

                // Each image at no more than the rung its sizes ask for at this width and pixel ratio.
                expect(media.map((request) => request.photoId), 'the lead photograph is asked for').toContain(leadId);
                for (const request of media) {
                    const cap = request.photoId === leadId ? policy.lead[profile] : policy.rest?.[profile];
                    expect(cap, `${request.url} is on a screen that shows only its lead`).toBeDefined();
                    expect(request.rung, request.url).toBeLessThanOrEqual(cap!);
                }
                expect(portraits, 'the intro portraits, Home only').toBeLessThanOrEqual(screen === 'home' ? 2 : 0);

                // Payload: the lead at its rung, and the rest of the request cap at theirs, at the fixture's declared AVIF sizes.
                const avif = (rung: number) => BUDGET_VARIANT_BYTES[`w${rung}` as 'w1920'].avif;
                const target = avif(policy.lead[profile]) + (policy.images - 1) * (policy.rest === null ? 0 : avif(policy.rest[profile]));
                expect(bytes, 'image bytes on the first load').toBeLessThanOrEqual(target);
                // Home asks only for its opening photograph and the one after it, and for no other series' covers.
                if (screen === 'home') for (const request of media) expect(featured().photoIds.slice(0, 2)).toContain(request.photoId);
            } finally {
                await page.context().close();
            }
        });
    }
}

test('each server HTML holds its lead photograph and a preload carrying the same srcset and sizes', async ({ request }) => {
    for (const screen of SCREENS) {
        const html = await (await request.get(`${origin()}${pathOf(screen)}`)).text();
        const attribute = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag)?.[1];
        // Home's intro portraits have preloads of their own, through /_next/image; these are the catalog's.
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
    test('Home: the failure is offered, and the series and the site stay reachable', async ({ page }) => {
        await page.goto(`${origin()}/`);
        await waitForHydration(page);
        await expect(page.getByRole('status').filter({ hasText: 'couldn’t load' })).toBeVisible();
        await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
        await page.getByRole('link', { name: 'Enter the series', exact: true }).click();
        await expect(page).toHaveURL(`${origin()}/work/${featured().slug}`);
    });

    test('Work and the series: every failed image keeps its box, and an entry still opens', async ({ page }) => {
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
        await page.locator(`#photo-${featured().photoIds[0]}`).click();
        await expect(page).toHaveURL(`${origin()}/work/${featured().slug}/photo/${featured().photoIds[0]}`);
    });

    test('the Viewer: the box keeps the photograph\'s shape, and Next still moves', async ({ page }) => {
        await page.goto(`${origin()}${pathOf('viewer')}`);
        await waitForHydration(page);
        const missing = page.locator('[data-surface="viewer"] [data-photo="unavailable"]');
        await expect(missing).toBeVisible();
        const box = await missing.boundingBox();
        // The first photograph is 2400 by 1600.
        expect(box && box.width / box.height).toBeCloseTo(1.5, 1);
        await page.getByRole('link', { name: 'Next photograph' }).click();
        await expect(page).toHaveURL(`${origin()}/work/${featured().slug}/photo/${featured().photoIds[1]}`);
    });
});
