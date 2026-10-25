import fs from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { publish } from '../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../lib/catalog/testing';
import { assetDir } from '../lib/media/path';
import { startCatalogServer, READY_TIMEOUT, type CatalogServer } from './support/catalogServer';
import { expectHoverRulesGated } from './support/hover';
import { waitForHydration } from './support/hydration';
import { checkSurface } from './support/surface';
import { expect, test } from './support/test';
import { expectSingleTapActivates } from './support/touch';

// A series page (#5) on a published catalog, on both #1 projects: the 200,
// the 308 from a former slug, one not-found for every case (catalog and
// legacy mode alike), canonical and share metadata on SITE_URL, the title,
// statement, facts, cover, chapters, and authored sequence, the cover's box,
// focal point, and crop at desktop and mobile sizes, nothing unpublished in
// the HTML or the RSC payload, the #1 surface checks, Enter and a single tap
// on an entry, and an entry whose image /media can't serve.
// Each project's worker publishes its own fixture and serves it from a
// second `next start`, so the harness server stays in legacy mode.

test.describe.configure({ mode: 'serial' });

/** Above the catalog, the publish, and a server start, so a slow start fails in startCatalogServer, which stops its child. */
const HOOK_TIMEOUT = READY_TIMEOUT + 60_000;
const SITE_URL = 'https://photos.example.test';
const SITE_NAME = 'Keyur Golani Photography';

const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = Array.from({ length: 9 }, (_, n) => id(n + 1));

/** Harbor's authored order, which neither spec order nor ID order gives. Its cover is P[1], third. A chapter starts there. */
const HARBOR = [P[2], P[0], P[1], P[3], P[4]];
/** Its files are removed after the publish, so /media can't serve this entry's image. */
const BROKEN = P[3];
/** Harbor's cover focal point, off center so the CSS has to carry it. */
const HARBOR_FOCAL = { x: 0.2, y: 0.8 };
/** A capture day on a harbor photograph. The page shows years only. */
const CAPTURE_DAY = '2019-05-06';
/** The two covers' shapes: harbor's 3:2 cover crops at its focal point, the tall series' portrait cover is authored `contain`. */
const COVERS = [
    { slug: 'harbor', width: 900, height: 600, fit: 'cover', position: `${HARBOR_FOCAL.x * 100}% ${HARBOR_FOCAL.y * 100}%` },
    { slug: 'tall', width: 600, height: 900, fit: 'contain', position: '50% 50%' },
] as const;
/** Desktop sizes where the cover's 82svh cap applies. The first is the desktop project's own. */
const DESKTOP_SIZES = [
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
];

/** Strings only unpublished series and fields outside the page's allowlist carry. */
const SENTINELS = [
    'SENTINEL draft title',
    'sentinel-draft',
    'sentinel-old-draft',
    'SENTINEL hidden title',
    'sentinel-hidden',
    'sentinel-old-hidden',
    'old-harbor',
    'SENTINEL caption',
    'SENTINEL credit',
    'private/SENTINEL-source.jpg',
    '#5e7173',
    // The draft and hidden series' photos, and their IDs, which would reach the RSC payload as React keys.
    P[6],
    P[7],
    'ser_e2e-draft',
    'ser_e2e-hidden',
    CAPTURE_DAY,
];

/** Every path that must answer exactly like an unknown slug on the catalog server. */
const NOT_FOUND_PATHS = ['/work/no-such-series', '/work/sentinel-draft', '/work/sentinel-old-draft', '/work/sentinel-hidden', '/work/sentinel-old-hidden', '/work/Harbor', '/work/ser_e2e-harbor'];

let catalog: TestCatalog | undefined;
let server: CatalogServer | undefined;

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    // Small photos: the variants are never enlarged, so the fixture encodes fast.
    const photo = (n: number) => ({ id: P[n], width: 900, height: 600 });
    catalog = await createTestCatalog({
        seed: 51,
        withAssets: true,
        photos: [
            { ...photo(0), title: 'Fixture harbor title', location: 'Fixture quay', caption: 'SENTINEL caption', credit: 'SENTINEL credit', sourcePath: 'private/SENTINEL-source.jpg', capturedAt: CAPTURE_DAY },
            photo(1),
            { ...photo(2), alt: { kind: 'decorative' } },
            photo(3),
            photo(4),
            photo(5),
            photo(6),
            photo(7),
            { id: P[8], width: 600, height: 900, crop: 'contain' },
        ],
        series: [
            {
                id: 'ser_e2e-harbor',
                slug: 'harbor',
                slugAliases: ['old-harbor'],
                title: 'Fixture harbor',
                shortStatement: 'Fixture harbor short statement.',
                statement: 'The first paragraph of the harbor.\n\nA second <b>paragraph</b>.',
                accent: '#5e7173',
                photoIds: HARBOR,
                cover: { photoId: P[1], focalPoint: HARBOR_FOCAL },
                chapters: [{ id: 'ch-tide', title: 'Fixture tide', startPhotoId: P[1] }],
            },
            { id: 'ser_e2e-single', slug: 'single', title: 'Fixture single', photoIds: [P[5]] },
            { id: 'ser_e2e-tall', slug: 'tall', title: 'Fixture tall', photoIds: [P[8]] },
            { id: 'ser_e2e-draft', slug: 'sentinel-draft', slugAliases: ['sentinel-old-draft'], title: 'SENTINEL draft title', photoIds: [P[6]], visibility: 'draft' },
            { id: 'ser_e2e-hidden', slug: 'sentinel-hidden', slugAliases: ['sentinel-old-hidden'], title: 'SENTINEL hidden title', photoIds: [P[7]], visibility: 'hidden' },
        ],
    });
    const outcome = await publish({ dataRoot: catalog.root, actor: 'e2e', confirmLaunch: true, logger: { log: () => undefined } });
    expect(outcome.outcome, outcome.message).toBe('PUBLISHED');
    // One entry's derivative set goes missing, as after a partial derivative failure.
    const broken = catalog.content.photos.find((record) => record.id === BROKEN);
    if (!broken) throw new Error('The broken entry is not in the published content');
    fs.rmSync(assetDir({ photoId: broken.id, assetRevision: broken.assetRevision, profileId: catalog.profileId }, catalog.root), { recursive: true, force: true });
    // E2E_CATALOG_PORT pins a port per worker, for a machine that hands out ranges. The config's
    // catalog Home server listens on E2E_CATALOG_PORT itself, so the workers start one above it.
    const base = Number(process.env.E2E_CATALOG_PORT);
    server = await startCatalogServer(catalog.root, Number.isInteger(base) && base > 0 ? base + 1 + test.info().parallelIndex : undefined, { siteUrl: SITE_URL });
});

test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await server?.stop();
    await catalog?.cleanup();
});

const origin = () => {
    if (!server) throw new Error('The catalog server did not start');
    return server.origin;
};
const primary = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const entries = (page: Page) => page.getByRole('main').locator('ol > li > a');
const entry = (page: Page, photoId: string) => page.locator(`#photo-${photoId}`);
const viewerPath = (photoId: string) => `/work/harbor/photo/${photoId}`;

/** The content of the first `<meta>` with `property` or `name`. */
const meta = (html: string, key: string) => new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`).exec(html)?.[1];

async function openHarbor(page: Page): Promise<void> {
    await page.goto(`${origin()}/work/harbor`);
    await waitForHydration(page);
    await expect(entries(page)).toHaveCount(HARBOR.length);
}

test('the canonical slug answers 200 and a former slug 308 to it, neither cacheable', async ({ request }) => {
    const ok = await request.get(`${origin()}/work/harbor`, { maxRedirects: 0 });
    expect(ok.status()).toBe(200);
    expect(ok.headers()['cache-control']).toContain('no-store');
    const moved = await request.get(`${origin()}/work/old-harbor`, { maxRedirects: 0 });
    expect(moved.status()).toBe(308);
    expect(moved.headers()['location']).toBe('/work/harbor');
    expect(moved.headers()['cache-control']).toContain('no-store');
});

test('every not-found case answers the same status, title, and page, in catalog and legacy mode', async ({ page, request, baseURL }) => {
    const answers: { url: string; status: number; headers: Record<string, string | undefined>; title: string | undefined; robots: string | undefined; body: string }[] = [];
    // The harness server is in legacy mode, where no series exists yet.
    const urls = [...NOT_FOUND_PATHS.map((path) => `${origin()}${path}`), `${baseURL}/work/harbor`];
    for (const url of urls) {
        const response = await request.get(url, { maxRedirects: 0 });
        const html = await response.text();
        await page.goto(url);
        await waitForHydration(page);
        answers.push({
            url,
            status: response.status(),
            headers: Object.fromEntries(['cache-control', 'content-type', 'vary'].map((name) => [name, response.headers()[name]])),
            title: /<title>([^<]*)<\/title>/.exec(html)?.[1],
            robots: meta(html, 'robots'),
            body: await page.locator('body').innerText(),
        });
    }
    const first = answers[0];
    expect(first.status).toBe(404);
    expect(first.headers['cache-control']).toContain('no-store');
    expect(first.title).toBe(`Page not found · ${SITE_NAME}`);
    expect(first.robots).toContain('noindex');
    expect(first.body).toContain('Page not found');
    for (const answer of answers) expect({ ...answer, url: first.url }, answer.url).toEqual(first);
});

test('the series has its title, statement, canonical link, and share metadata on SITE_URL', async ({ request }) => {
    const html = await (await request.get(`${origin()}/work/harbor`)).text();
    expect(html).toContain(`<title>Fixture harbor · ${SITE_NAME}</title>`);
    expect(meta(html, 'description')).toBe('Fixture harbor short statement.');
    expect(html).toContain(`<link rel="canonical" href="${SITE_URL}/work/harbor"/>`);
    expect(meta(html, 'og:url')).toBe(`${SITE_URL}/work/harbor`);
    expect(meta(html, 'og:site_name')).toBe(SITE_NAME);
    expect(meta(html, 'og:type')).toBe('website');
    const image = meta(html, 'og:image') ?? '';
    expect(image).toMatch(new RegExp(`^${SITE_URL.replaceAll('.', '\\.')}/media/${P[1]}/sha256-[0-9a-f]{64}/p_[0-9a-f]+/w1200\\.webp$`));
    expect(meta(html, 'og:image:alt')).toBeTruthy();
    expect(meta(html, 'twitter:card')).toBe('summary_large_image');
    expect(meta(html, 'twitter:image')).toBe(image);
    // The share image is a real file /media serves.
    const share = await request.get(`${origin()}${new URL(image).pathname}`);
    expect(share.status()).toBe(200);
    expect(share.headers()['content-type']).toContain('image/webp');
});

test('the page opens with the title, the statement as text, the derived facts apart, and the cover', async ({ page }) => {
    await openHarbor(page);
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { level: 1 })).toHaveText('Fixture harbor');
    await expect(main.getByText('The first paragraph of the harbor.')).toBeVisible();
    await expect(main.getByText('A second <b>paragraph</b>.')).toBeVisible();
    await expect(main.locator('b')).toHaveCount(0);
    const facts = main.getByRole('region', { name: 'From the published photographs' });
    await expect(facts.locator('dt')).toHaveText(['Photographs', 'Captured', 'Location']);
    await expect(facts.locator('dd[data-source="published-sequence"]')).toContainText('5');
    await expect(facts.locator('dd[data-source="photograph-records"]')).toContainText('Fixture quay');
    const cover = main.locator('figure img');
    await expect.poll(() => cover.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    expect(await cover.getAttribute('src')).toMatch(new RegExp(`^/media/${P[1]}/`));
    await expect(main.locator('figure figcaption')).toHaveText('Photograph 3 of 5');
});

type Box = { x: number; y: number; width: number; height: number } | null;

/** The image fills its own frame, within 1 px on each edge, so it never paints past the frame onto the text beside it. */
function expectFillsFrame(image: Box, frame: Box, label: string) {
    expect(image, `${label} image box`).not.toBeNull();
    expect(frame, `${label} frame box`).not.toBeNull();
    if (!image || !frame) return;
    for (const key of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(image[key] - frame[key]), `${label} image ${key} ${image[key]} vs frame ${frame[key]}`).toBeLessThanOrEqual(1);
    }
}

/** The cover's frame box, its image's box, and the image's computed fit and position. */
async function coverOf(page: Page) {
    const frame = page.getByRole('main').locator('figure [data-photo]');
    const box = await frame.boundingBox();
    const imageBox = await frame.locator('img').boundingBox();
    const image = await frame.locator('img').evaluate((element) => ({ fit: getComputedStyle(element).objectFit, position: getComputedStyle(element).objectPosition }));
    return { box, imageBox, ...image };
}

test('each cover keeps its own aspect ratio under the height cap, around its focal point or whole when authored contain', async ({ page }, testInfo) => {
    // The desktop project checks both desktop sizes (its own is the first), and a mobile project its own viewport.
    const sizes = testInfo.project.use.isMobile ? [page.viewportSize()] : DESKTOP_SIZES;
    for (const size of sizes) {
        if (!size) throw new Error('The project has no viewport');
        await page.setViewportSize(size);
        for (const cover of COVERS) {
            const label = `${cover.slug} at ${size.width}x${size.height}`;
            await page.goto(`${origin()}/work/${cover.slug}`);
            await waitForHydration(page);
            const { box, imageBox, fit, position } = await coverOf(page);
            expect(box, label).not.toBeNull();
            expectFillsFrame(imageBox, box, label);
            const height = box?.height ?? 0;
            expect(height, `${label} has a height`).toBeGreaterThan(0);
            // Within 1% of the photograph's ratio, so the box crops nothing away from its shape.
            const ratio = (box?.width ?? 0) / height;
            expect(Math.abs(ratio / (cover.width / cover.height) - 1), `${label} ratio ${ratio}`).toBeLessThan(0.01);
            expect(height, `${label} stays under 82svh`).toBeLessThanOrEqual(size.height * 0.82 + 1);
            expect({ fit, position }, label).toEqual({ fit: cover.fit, position: cover.position });
        }
    }
});

test('each sequence thumbnail keeps its 4:3 box and shows the whole photograph', async ({ page }) => {
    await openHarbor(page);
    for (const photoId of HARBOR) {
        const link = entry(page, photoId);
        await link.scrollIntoViewIfNeeded();
        const box = await link.locator('[data-photo]').boundingBox();
        expect(box?.height ?? 0, `${photoId} has a height`).toBeGreaterThan(0);
        expect((box?.width ?? 0) / (box?.height ?? 1), `${photoId} keeps 4:3`).toBeCloseTo(4 / 3, 1);
        if (photoId === BROKEN) continue;
        expectFillsFrame(await link.locator('img').boundingBox(), box, photoId);
        expect(await link.locator('img').evaluate((image) => getComputedStyle(image).objectFit), photoId).toBe('contain');
    }
});

test('the sequence keeps the authored order across its chapter, each entry a link to its canonical Viewer URL', async ({ page }) => {
    await openHarbor(page);
    for (const [index, photoId] of HARBOR.entries()) {
        const link = entries(page).nth(index);
        await expect(link).toHaveAttribute('href', viewerPath(photoId));
        await expect(link).toHaveAttribute('id', `photo-${photoId}`);
        await expect(link).toHaveAccessibleName(new RegExp(`photograph ${index + 1} of ${HARBOR.length}$`, 'i'));
        await expect(link.locator('[data-position]')).toHaveText(String(index + 1));
    }
    const chapter = page.getByRole('main').getByRole('region', { name: 'Fixture tide' });
    await expect(chapter.getByRole('heading', { level: 3 })).toHaveText('Fixture tide');
    await expect(chapter.locator('ol')).toHaveAttribute('start', '3');
    await expect(chapter.locator('ol > li > a')).toHaveCount(3);
    await expect(entry(page, P[0]).locator('xpath=..').locator('p')).toContainText('Fixture harbor title');
    const end = page.getByRole('main').getByRole('link', { name: 'All work' });
    await expect(end).toHaveAttribute('href', '/work');
});

test('an entry whose image /media can\'t serve keeps its place, text, and link, with the missing-image state', async ({ page }) => {
    await openHarbor(page);
    const broken = entry(page, BROKEN);
    await broken.scrollIntoViewIfNeeded();
    await expect(broken.locator('[data-photo="unavailable"]')).toBeVisible();
    await expect(broken.locator('img')).toHaveCount(0);
    await expect(broken).toHaveAttribute('href', viewerPath(BROKEN));
    await expect(broken).toHaveAccessibleName(/photograph 4 of 5$/i);
    for (const photoId of HARBOR.filter((item) => item !== BROKEN)) {
        const link = entry(page, photoId);
        await link.scrollIntoViewIfNeeded();
        await expect.poll(() => link.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    }
});

test('nothing unpublished reaches the served HTML or the RSC payload', async ({ request }) => {
    // The capture day is a real published fact the page shows only as its year.
    expect(catalog?.content.photos.map((photo) => photo.capturedAt)).toContain(CAPTURE_DAY);
    const html = await (await request.get(`${origin()}/work/harbor`)).text();
    expect(html, 'the check reads a rendered series page').toContain('Fixture harbor');
    for (const sentinel of SENTINELS) expect(html, sentinel).not.toContain(sentinel);
    const rsc = await request.get(`${origin()}/work/harbor`, { headers: { RSC: '1' } });
    expect(rsc.headers()['content-type']).toContain('text/x-component');
    const payload = await rsc.text();
    expect(payload, 'the payload holds the series').toContain('Fixture harbor');
    for (const sentinel of SENTINELS) expect(payload, sentinel).not.toContain(sentinel);
});

test('the page passes the #1 checks, with SiteNav outside main, Work current, and no data-surface', async ({ page }) => {
    await openHarbor(page);
    await checkSurface(page, {
        entries: entries(page),
        controls: [primary(page).locator('a, button'), page.getByRole('main').getByRole('link', { name: 'All work' })],
    });
    await expectHoverRulesGated(page);
    await expect(page.locator('main nav')).toHaveCount(0);
    await expect(primary(page).locator('[aria-current="page"]')).toHaveText(['Work']);
    await expect(page.locator('[data-surface]')).toHaveCount(0);
});

test('Tab reaches the entries right after SiteNav, in order, then All work, and Enter opens the focused photograph\'s Viewer URL', async ({ page }) => {
    await openHarbor(page);
    // The wordmark, Home, Work, About, and the theme toggle come first.
    for (let press = 0; press < 5; press++) await page.keyboard.press('Tab');
    const hrefs: (string | null)[] = [];
    for (let press = 0; press <= HARBOR.length; press++) {
        await page.keyboard.press('Tab');
        hrefs.push(await page.evaluate(() => document.activeElement?.getAttribute('href') ?? null));
    }
    expect(hrefs).toEqual([...HARBOR.map(viewerPath), '/work']);
    await entry(page, P[0]).focus();
    await page.keyboard.press('Enter');
    // #7's Viewer page isn't here yet, so the URL is the check.
    await expect(page).toHaveURL(`${origin()}${viewerPath(P[0])}`);
});

/** Whether `link` sits in the viewport. */
const inView = (link: Locator) => link.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= window.innerHeight;
});

test('one tap on an entry opens its Viewer URL', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch, 'Touch runs on the mobile project.');
    await openHarbor(page);
    const target = entry(page, P[4]);
    await target.scrollIntoViewIfNeeded();
    expect(await inView(target)).toBe(true);
    await expectSingleTapActivates(target, () => expect(page).toHaveURL(`${origin()}${viewerPath(P[4])}`));
});
