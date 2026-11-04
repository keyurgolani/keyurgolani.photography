import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { publish } from '../lib/catalog/publish';
import { createTestCatalog, type TestCatalog, type TestPhotoSpec, type TestSeriesSpec } from '../lib/catalog/testing';
import { BUDGET_VARIANT_BYTES } from '../lib/perf/fixture';
import { startCatalogServer, READY_TIMEOUT, type CatalogServer } from './support/catalogServer';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';

// #6's size rule in the browser, for Work's covers, the series cover and Home's slide, at four widths: the width a
// photograph needs is the larger of its box's width and the box's height times the photograph's shape for
// `object-fit: cover`, and the smaller for `contain`. Times the device's pixel ratio it maps to the smallest rung at
// or above it, capped at the largest. Each image's `sizes` has to ask for that rung or one smaller, and Home's slide
// for that rung exactly. The box, the fit and the shape are read from the rendered page, so the check follows the
// stylesheet, not the module that wrote the sizes. Then layout shift through load, and through one Show more on the
// series, stays at or below 0.05 (#6's rule 8).
//
// One published fixture with decodable files: landscape, portrait and 3:1 panorama photographs, cropped to cover and
// shown whole, on a second `next start`. Each viewport opens as its own context of the desktop project. Bytes are the
// fixture's declared AVIF and WebP sizes for the rungs asked for (lib/perf/fixture.ts), as first-viewport.spec.ts
// counts them, since the decodable files are flat colour.

// In order, but each test runs whatever failed before it, so one red screen still reports the rest. Each opens up
// to a dozen fresh contexts.
test.describe.configure({ mode: 'default', timeout: 5 * 60_000 });

const HOOK_TIMEOUT = READY_TIMEOUT + 3 * 60_000;
const KIB = 1024;
const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Shape = 'landscape' | 'portrait' | 'panorama';
const SHAPES: Record<Shape, { width: number; height: number }> = {
    landscape: { width: 2400, height: 1600 },
    portrait: { width: 1600, height: 2400 },
    panorama: { width: 3000, height: 1000 },
};
type Look = { shape: Shape; crop: 'cover' | 'contain' };
const looks: Look[] = [
    { shape: 'landscape', crop: 'cover' },
    { shape: 'portrait', crop: 'cover' },
    { shape: 'panorama', crop: 'cover' },
    { shape: 'landscape', crop: 'contain' },
    { shape: 'portrait', crop: 'contain' },
];
const spec = (photoId: string, look: Look): TestPhotoSpec => ({ id: photoId, ...SHAPES[look.shape], ...(look.crop === 'contain' ? { crop: 'contain' } : {}) });

/** The featured series: long enough for one Show more (pages of 100), opening on a landscape photograph, then a portrait one. */
const LONG = Array.from({ length: 130 }, (_, n) => id(n + 1));
/** Work's other entries, by their cover: every shape and crop, on wide and narrow spans both. */
const COVERS: Look[] = [
    { shape: 'portrait', crop: 'cover' },
    { shape: 'landscape', crop: 'contain' },
    { shape: 'panorama', crop: 'cover' },
    { shape: 'portrait', crop: 'contain' },
    { shape: 'landscape', crop: 'cover' },
    { shape: 'panorama', crop: 'contain' },
    { shape: 'portrait', crop: 'cover' },
];
const others = COVERS.map((look, index) => ({ look, slug: `sizes-${index + 2}-${look.shape}-${look.crop}`, photoIds: [id(201 + 2 * index), id(202 + 2 * index)] }));
const lookOf = new Map<string, Look>([
    ...LONG.map((photoId, n) => [photoId, looks[n % looks.length]] as const),
    ...others.flatMap(({ look, photoIds }) => [[photoIds[0], look] as const, [photoIds[1], { shape: 'landscape', crop: 'cover' } as Look] as const]),
]);

let catalog: TestCatalog | undefined;
let server: CatalogServer | undefined;
/** Every screen's numbers at every width, attached to the run and printed, for the PR's table. */
const report: Record<string, unknown> = {};

test.beforeAll(async () => {
    test.skip(test.info().project.name !== 'desktop', 'One fixture per run: each width opens as a context of its own.');
    test.setTimeout(HOOK_TIMEOUT);
    const series: TestSeriesSpec[] = [
        { id: 'ser_e2e-sizes-long', slug: 'sizes-long', title: 'Sizes, the featured series', photoIds: LONG },
        ...others.map(({ slug, photoIds }) => ({ id: `ser_e2e-${slug}`, slug, title: `Sizes, ${slug}`, photoIds })),
    ];
    catalog = await createTestCatalog({
        seed: 174,
        withAssets: true,
        photos: [...lookOf.entries()].map(([photoId, look]) => spec(photoId, look)),
        series,
        featuredSeriesIds: ['ser_e2e-sizes-long'],
    });
    const outcome = await publish({ dataRoot: catalog.root, actor: 'e2e', confirmLaunch: true, logger: { log: () => undefined } });
    expect(outcome.outcome, outcome.message).toBe('PUBLISHED');
    // Above the ports first-viewport.spec.ts and the other catalog specs take when E2E_CATALOG_PORT pins them.
    const base = Number(process.env.E2E_CATALOG_PORT);
    server = await startCatalogServer(catalog.root, Number.isInteger(base) && base > 0 ? base + 20 + test.info().parallelIndex : undefined);
});

test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    if (Object.keys(report).length > 0) await test.info().attach('image-sizes.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    await server?.stop();
    await catalog?.cleanup();
});

const origin = () => {
    if (!server) throw new Error('The catalog server did not start');
    return server.origin;
};

// Dark, as the suite's own projects paint it (playwright.config.ts), so Home's slide is the viewport.
const WIDTHS = {
    390: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'dark' },
    768: { viewport: { width: 768, height: 1024 }, deviceScaleFactor: 2, isMobile: false, hasTouch: true, colorScheme: 'dark' },
    1280: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, colorScheme: 'dark' },
    1440: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, colorScheme: 'dark' },
} satisfies Record<number, BrowserContextOptions>;
type Width = keyof typeof WIDTHS;

type Screen = 'home' | 'work' | 'series';
const PATHS: Record<Screen, string[]> = {
    home: ['/'],
    work: ['/work'],
    // The featured series' landscape cover, and a portrait and a panorama one.
    series: ['/work/sizes-long', `/work/${others[0].slug}`, `/work/${others[2].slug}`],
};
/** The images the rule covers: Home's mounted slides, every Work cover, the series cover. */
const TARGETS: Record<Screen, string> = {
    home: '[data-photo-id] img',
    work: 'main ul > li img',
    series: '#series-cover img',
};

interface Seen {
    photoId: string;
    sizes: string;
    /** The length `sizes` picks at this viewport, and its CSS px. */
    length: string;
    sizesPx: number;
    /** The rendered box and fit, and the photograph's shape. */
    box: { width: number; height: number };
    fit: string;
    shape: number;
    /** Each candidate's nominal rung and its width descriptor. */
    candidates: { rung: number; width: number }[];
    /** The rung the browser took, from currentSrc, or null for a lazy image that hasn't started. */
    picked: number | null;
}

/** Reads each target image's sizes, box, fit and candidates, and evaluates its sizes the way the browser does. */
async function readImages(page: Page, selector: string): Promise<Seen[]> {
    return page.evaluate((target) => {
        const probe = document.createElement('div');
        probe.style.cssText = 'position: absolute; left: 0; top: 0; height: 0; visibility: hidden;';
        document.body.append(probe);
        const px = (length: string) => {
            probe.style.width = length;
            return probe.getBoundingClientRect().width;
        };
        // A source size is a media condition and a length, or a length alone. The lengths here are a vw, vh or rem
        // value, or a calc() of them; the conditions hold no commas.
        const evaluate = (sizes: string) => {
            for (const raw of sizes.split(',')) {
                const entry = raw.trim();
                const at = entry.endsWith(')') && entry.includes('calc(') ? entry.lastIndexOf('calc(') : entry.lastIndexOf(' ') + 1;
                const media = entry.slice(0, at).trim();
                const length = entry.slice(at).trim();
                if (media === '' || window.matchMedia(media).matches) return { length, sizesPx: px(length) };
            }
            return { length: '100vw', sizesPx: window.innerWidth };
        };
        const rungOf = (url: string) => Number(/\/w(\d+)\.(?:avif|webp)(?:$|\?)/.exec(new URL(url, location.href).pathname)?.[1] ?? NaN);
        const seen = [...document.querySelectorAll<HTMLImageElement>(target)].map((img) => {
            const source = img.parentElement?.querySelector<HTMLSourceElement>('source[type="image/avif"]');
            const sizes = source?.getAttribute('sizes') ?? img.getAttribute('sizes') ?? '';
            const candidates = (source?.getAttribute('srcset') ?? '')
                .split(',')
                .map((part) => part.trim().split(/\s+/))
                .filter((part) => part.length === 2)
                .map(([url, descriptor]) => ({ rung: rungOf(url), width: Number.parseInt(descriptor, 10) }));
            const photo = img.closest('[data-photo-id]')?.getAttribute('data-photo-id') ?? /\/media\/(ph_[^/]+)\//.exec(source?.getAttribute('srcset') ?? '')?.[1] ?? '';
            return {
                photoId: photo,
                sizes,
                ...evaluate(sizes),
                // Layout boxes, so Home's slow zoom (a transform) doesn't count.
                box: { width: img.offsetWidth, height: img.offsetHeight },
                fit: getComputedStyle(img).objectFit,
                shape: Number(img.getAttribute('width')) / Number(img.getAttribute('height')),
                candidates,
                picked: img.currentSrc ? rungOf(img.currentSrc) : null,
            };
        });
        probe.remove();
        return seen;
    }, selector);
}

/** The smallest candidate at or above `pixels`, else the largest: the rung, by its nominal name. */
function rungFor(candidates: Seen['candidates'], pixels: number): number {
    const sorted = [...candidates].sort((a, b) => a.width - b.width);
    return (sorted.find((candidate) => candidate.width >= pixels - 0.5) ?? sorted[sorted.length - 1]).rung;
}

/** #6's rule: what the photograph needs in its box, in device px. */
function needed(image: Seen, dpr: number): number {
    const { width, height } = image.box;
    const atHeight = height * image.shape;
    return (image.fit === 'contain' ? Math.min(width, atHeight) : Math.max(width, atHeight)) * dpr;
}

interface Load {
    page: Page;
    images: Seen[];
    /** The /media files the first load asked for, with their nominal rung and format. */
    media: { photoId: string; rung: number; format: string }[];
}

async function open(browser: Browser, width: Width, path: string, selector: string): Promise<Load> {
    const context = await browser.newContext(WIDTHS[width]);
    const page = await context.newPage();
    const media: Load['media'] = [];
    page.on('request', (request) => {
        const match = /^\/media\/(ph_[^/]+)\/[^/]+\/[^/]+\/w(\d+)\.(avif|webp)$/.exec(new URL(request.url()).pathname);
        if (match) media.push({ photoId: match[1], rung: Number(match[2]), format: match[3] });
    });
    await page.goto(`${origin()}${path}`);
    await waitForHydration(page);
    await page.waitForLoadState('networkidle');
    return { page, images: await readImages(page, selector), media };
}

const short = (photoId: string) => photoId.slice(-3);
const describeLook = (photoId: string) => {
    const look = lookOf.get(photoId);
    return look ? `${look.shape} ${look.crop}` : photoId;
};

for (const screen of Object.keys(PATHS) as Screen[]) {
    test(`${screen}: each image's sizes asks for the rung #6's size rule gives its box, at 390, 768, 1280 and 1440 px`, async ({ browser }) => {
        const failures: string[] = [];
        for (const width of Object.keys(WIDTHS).map(Number) as Width[]) {
            const dpr = WIDTHS[width].deviceScaleFactor;
            for (const path of PATHS[screen]) {
                const { page, images, media } = await open(browser, width, path, TARGETS[screen]);
                try {
                    expect(images.length, `${path} at ${width} px has images to check`).toBeGreaterThan(0);
                    const rows = images.map((image) => {
                        const rule = rungFor(image.candidates, needed(image, dpr));
                        const asked = rungFor(image.candidates, image.sizesPx * dpr);
                        return { image, rule, asked };
                    });
                    const bytes = media.reduce((sum, request) => sum + BUDGET_VARIANT_BYTES[`w${request.rung}` as 'w400'][request.format as 'avif'], 0);
                    report[`${screen} ${path} @${width}`] = {
                        sizes: [...new Set(images.map((image) => image.sizes))],
                        images: rows.map(({ image, rule, asked }) => ({
                            photo: `${short(image.photoId)} ${describeLook(image.photoId)}`,
                            box: `${Math.round(image.box.width)}x${Math.round(image.box.height)} ${image.fit}`,
                            length: image.length,
                            rule,
                            asked,
                            picked: image.picked,
                        })),
                        requests: media.map((request) => `${short(request.photoId)} w${request.rung}.${request.format}`),
                        declaredKiB: Number((bytes / KIB).toFixed(1)),
                    };
                    console.log(`[image-sizes] ${screen} ${path} @${width} ${JSON.stringify(report[`${screen} ${path} @${width}`])}`);

                    for (const { image, rule, asked } of rows) {
                        const ladder = [...new Set(image.candidates.map((candidate) => candidate.rung))].sort((a, b) => a - b);
                        const step = ladder.indexOf(rule) - ladder.indexOf(asked);
                        const where = `${path} @${width}: ${describeLook(image.photoId)} (${short(image.photoId)}) in ${Math.round(image.box.width)}x${Math.round(image.box.height)} ${image.fit}, sizes ${image.length}`;
                        // Home's slide takes the rule's rung exactly; anything else that rung or one smaller, never larger.
                        if (screen === 'home' ? step !== 0 : step < 0 || step > 1) failures.push(`${where} asks for w${asked}, the rule's rung is w${rule}`);
                        if (image.picked !== null && ladder.indexOf(image.picked) > ladder.indexOf(rule)) failures.push(`${where} loaded w${image.picked}, over the rule's w${rule}`);
                    }
                } finally {
                    await page.context().close();
                }
            }
        }
        expect(failures, failures.join('\n')).toEqual([]);
    });
}

test('Work: the first two covers load at once, only the first at high priority, the rest lazily (#3)', async ({ browser }) => {
    const { page } = await open(browser, 1280, '/work', TARGETS.work);
    try {
        const attributes = await page.locator(TARGETS.work).evaluateAll((images) => images.map((img) => [img.getAttribute('loading'), img.getAttribute('fetchpriority')]));
        // The second at low priority, so the lead has the link first (#172's LCP bar).
        expect(attributes).toEqual(attributes.map((_, index) => [index < 2 ? 'eager' : 'lazy', index === 0 ? 'high' : index === 1 ? 'low' : null]));
    } finally {
        await page.context().close();
    }
});

test('Work at 375 px and DPR 2: no landscape or portrait cover asks for more than the 800w rung (#3)', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
    const page = await context.newPage();
    try {
        await page.goto(`${origin()}/work`);
        await waitForHydration(page);
        await page.waitForLoadState('networkidle');
        // A stated exception to #3's 800w cap: a 3:1 panorama cropped to cover is 2.25 boxes wide, so even a rung under
        // the rule's it asks for 1200w here. Panoramas are left out of this case, and only of this one.
        const images = (await readImages(page, TARGETS.work)).filter((image) => lookOf.get(image.photoId)?.shape !== 'panorama');
        expect(images.length).toBeGreaterThan(4);
        for (const image of images) {
            expect(rungFor(image.candidates, image.sizesPx * 2), `${describeLook(image.photoId)}: ${image.length}`).toBeLessThanOrEqual(800);
            if (image.picked !== null) expect(image.picked, describeLook(image.photoId)).toBeLessThanOrEqual(800);
        }
    } finally {
        await context.close();
    }
});

test('Work at 390 px and DPR 3: a 3:2 cover asks for w1200, the rung under the rule\'s w1920 (rule 5, #172\'s LCP bar)', async ({ browser }) => {
    const { page, images } = await open(browser, 390, '/work', TARGETS.work);
    try {
        const landscape = images.filter((image) => lookOf.get(image.photoId)?.shape === 'landscape' && image.fit === 'cover');
        expect(landscape.length).toBeGreaterThan(0);
        for (const image of landscape) {
            expect(rungFor(image.candidates, needed(image, 3)), 'the rule\'s rung').toBe(1920);
            expect(rungFor(image.candidates, image.sizesPx * 3), image.length).toBe(1200);
        }
    } finally {
        await page.context().close();
    }
});

/** Collects layout shifts from the first paint, each with whether input came just before it. */
async function watchShifts(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const shifts: { value: number; recent: boolean }[] = [];
        (window as unknown as { __shifts: typeof shifts }).__shifts = shifts;
        new PerformanceObserver((list) => {
            for (const entry of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) shifts.push({ value: entry.value, recent: entry.hadRecentInput });
        }).observe({ type: 'layout-shift', buffered: true });
    });
}

const shiftTotal = (page: Page) =>
    page.evaluate(() => (window as unknown as { __shifts: { value: number; recent: boolean }[] }).__shifts.filter((shift) => !shift.recent).reduce((sum, shift) => sum + shift.value, 0));

/** Scrolls to the end in viewport steps, so every lazy image starts and lands, and waits for the network. */
async function scrollThrough(page: Page): Promise<void> {
    for (let i = 0; i < 40; i++) {
        const done = await page.evaluate(() => {
            window.scrollBy(0, window.innerHeight * 0.9);
            return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1;
        });
        await page.waitForTimeout(100);
        if (done) break;
    }
    await page.waitForLoadState('networkidle');
}

for (const width of Object.keys(WIDTHS).map(Number) as Width[]) {
    test(`layout shift on Work through load, and on the series through load and one Show more, stays at or below 0.05 at ${width} px`, async ({ browser }) => {
        const context = await browser.newContext(WIDTHS[width]);
        const page = await context.newPage();
        await watchShifts(page);
        try {
            await page.goto(`${origin()}/work`);
            await waitForHydration(page);
            await scrollThrough(page);
            const work = await shiftTotal(page);

            await page.goto(`${origin()}/work/sizes-long`);
            await waitForHydration(page);
            await page.waitForLoadState('networkidle');
            const more = page.getByRole('button', { name: 'Show more photographs' });
            await more.focus();
            await page.keyboard.press('Enter');
            await expect(page.getByRole('main').locator('ol > li > a')).toHaveCount(LONG.length);
            await scrollThrough(page);
            const series = await shiftTotal(page);

            report[`layout shift @${width}`] = { work: Number(work.toFixed(4)), series: Number(series.toFixed(4)) };
            console.log(`[image-sizes] layout shift @${width} ${JSON.stringify(report[`layout shift @${width}`])}`);
            expect(work, 'Work').toBeLessThanOrEqual(0.05);
            expect(series, 'the series, through one Show more').toBeLessThanOrEqual(0.05);
        } finally {
            await context.close();
        }
    });
}
