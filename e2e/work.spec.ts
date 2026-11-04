import fs from 'node:fs';
import type { Locator, Page, Route } from '@playwright/test';
import { publish } from '../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../lib/catalog/testing';
import { assetDir } from '../lib/media/path';
import { startCatalogServer, READY_TIMEOUT, type CatalogServer } from './support/catalogServer';
import { expectHoverRulesGated } from './support/hover';
import { waitForHydration } from './support/hydration';
import { checkSurface } from './support/surface';
import { expect, test } from './support/test';
import { expectSingleTapActivates } from './support/touch';

// Work (#3) on a published catalog, on both #1 projects: authored order and
// the published series only, nothing unpublished in the HTML or the RSC
// payload, the /gallery 308, the #1 surface checks, Enter and a single tap on
// an entry, and the cover fallback. Each project's worker publishes its own
// fixture catalog and serves it from a second `next start`, so the harness
// server stays unpublished for every other spec.

test.describe.configure({ mode: 'serial' });

/** Above the catalog, the publish, and a server start, so a slow start fails in startCatalogServer, which stops its child. */
const HOOK_TIMEOUT = READY_TIMEOUT + 60_000;

const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = Array.from({ length: 8 }, (_, n) => id(n + 1));

/** Strings only unpublished series and fields outside Work's allowlist carry. */
const SENTINELS = [
    'SENTINEL draft title',
    'SENTINEL draft short',
    'SENTINEL hidden title',
    'sentinel-hidden',
    'SENTINEL long statement',
    'sentinel-old-slug',
    'SENTINEL caption',
    'SENTINEL alt',
    'SENTINEL location',
    'SENTINEL chapter',
    'private/SENTINEL-source.jpg',
    '#5e7173',
    // The draft and hidden series' photos, and their IDs, which would reach the RSC payload as React keys.
    P[6],
    P[7],
    'ser_e2e-draft',
    'ser_e2e-hidden',
];

/** The published series in authored Work order, which neither spec order nor ID order gives. */
const PUBLISHED = [
    { slug: 'harbor', title: 'Fixture harbor', count: 2 },
    { slug: 'ridge', title: 'Fixture ridge', count: 1 },
    { slug: 'field', title: 'Fixture field', count: 2 },
    { slug: 'quarry', title: 'Fixture quarry', count: 1 },
] as const;
/** Its cover's files are removed after the publish, so /media can't serve them. */
const BROKEN_COVER = 'quarry';
/** The first cover's authored focal point, off center so the CSS has to carry it. */
const FIRST_FOCAL = { x: 0.25, y: 0.75 };
/** Its cover is authored `contain`. */
const CONTAIN_COVER = 'ridge';

let catalog: TestCatalog | undefined;
let server: CatalogServer | undefined;

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    // Small photos: the variants are never enlarged, so the fixture encodes fast.
    const photo = (n: number) => ({ id: P[n], width: 900, height: 600 });
    catalog = await createTestCatalog({
        seed: 31,
        withAssets: true,
        photos: [
            {
                ...photo(0),
                caption: 'SENTINEL caption',
                alt: { kind: 'described', text: 'SENTINEL alt', reviewed: true },
                location: 'SENTINEL location',
                sourcePath: 'private/SENTINEL-source.jpg',
                accent: '#5e7173',
                focalPoint: FIRST_FOCAL,
            },
            photo(1),
            { ...photo(2), crop: 'contain' },
            photo(3),
            photo(4),
            photo(5),
            photo(6),
            photo(7),
        ],
        series: [
            { id: 'ser_e2e-field', slug: 'field', title: 'Fixture field', photoIds: [P[3], P[4]] },
            {
                id: 'ser_e2e-harbor',
                slug: 'harbor',
                title: 'Fixture harbor',
                statement: 'SENTINEL long statement',
                slugAliases: ['sentinel-old-slug'],
                accent: '#5e7173',
                chapters: [{ id: 'chapter-one', title: 'SENTINEL chapter', startPhotoId: P[0] }],
                photoIds: [P[0], P[1]],
            },
            { id: 'ser_e2e-draft', slug: 'draft', title: 'SENTINEL draft title', shortStatement: 'SENTINEL draft short', photoIds: [P[6]], visibility: 'draft' },
            { id: 'ser_e2e-ridge', slug: 'ridge', title: 'Fixture ridge', photoIds: [P[2]] },
            { id: 'ser_e2e-hidden', slug: 'sentinel-hidden', title: 'SENTINEL hidden title', photoIds: [P[7]], visibility: 'hidden' },
            { id: 'ser_e2e-quarry', slug: 'quarry', title: 'Fixture quarry', photoIds: [P[5]] },
        ],
        seriesOrder: ['ser_e2e-harbor', 'ser_e2e-draft', 'ser_e2e-ridge', 'ser_e2e-hidden', 'ser_e2e-field', 'ser_e2e-quarry'],
    });
    const outcome = await publish({ dataRoot: catalog.root, actor: 'e2e', confirmLaunch: true, logger: { log: () => undefined } });
    expect(outcome.outcome, outcome.message).toBe('PUBLISHED');
    // The quarry cover's derivative set goes missing, as after a partial derivative failure.
    const cover = catalog.content.photos.find((record) => record.id === P[5]);
    if (!cover) throw new Error('The quarry cover is not in the published content');
    fs.rmSync(assetDir({ photoId: cover.id, assetRevision: cover.assetRevision, profileId: catalog.profileId }, catalog.root), { recursive: true, force: true });
    // E2E_CATALOG_PORT pins a port per worker, for a machine that hands out ranges. The config's
    // catalog Home server listens on E2E_CATALOG_PORT itself, so the workers start one above it, as series.spec.ts does.
    const base = Number(process.env.E2E_CATALOG_PORT);
    server = await startCatalogServer(catalog.root, Number.isInteger(base) && base > 0 ? base + 1 + test.info().parallelIndex : undefined);
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
const entries = (page: Page) => page.getByRole('main').getByRole('listitem').getByRole('link');
const entry = (page: Page, slug: string) => page.getByRole('main').locator(`a[href="/work/${slug}"]`);

async function openWork(page: Page): Promise<void> {
    await page.goto(`${origin()}/work`);
    await waitForHydration(page);
    await expect(entries(page)).toHaveCount(PUBLISHED.length);
}

test('/gallery answers 308 to bare /work, and /work renders, once a revision is served', async ({ request }) => {
    const gallery = await request.get(`${origin()}/gallery`, { maxRedirects: 0 });
    expect(gallery.status()).toBe(308);
    expect(gallery.headers()['location']).toBe('/work');
    const work = await request.get(`${origin()}/work`, { maxRedirects: 0 });
    expect(work.status()).toBe(200);
});

test('Work lists only the published series, in authored order, each one link with its title, statement, and count', async ({ page }) => {
    await openWork(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bodies of work');
    await expect(entries(page)).toHaveCount(PUBLISHED.length);
    for (const [index, series] of PUBLISHED.entries()) {
        const link = entries(page).nth(index);
        await expect(link).toHaveAttribute('href', `/work/${series.slug}`);
        await expect(link.getByRole('heading', { level: 2 })).toHaveText(series.title);
        await expect(link).toContainText(`Fixture short statement`);
        await expect(link).toContainText(series.count === 1 ? '1 photograph' : `${series.count} photographs`);
        // Visible at rest, without hover.
        await expect(link.getByRole('heading', { level: 2 })).toBeVisible();
    }
    for (const sentinel of ['SENTINEL draft title', 'SENTINEL hidden title']) await expect(page.getByText(sentinel)).toHaveCount(0);
});

test('nothing unpublished reaches the served HTML or the RSC payload of a client-side move to Work', async ({ page, request }) => {
    const html = await (await request.get(`${origin()}/work`)).text();
    for (const series of PUBLISHED) expect(html, 'the check reads a rendered Work page').toContain(series.title);
    for (const sentinel of SENTINELS) expect(html, sentinel).not.toContain(sentinel);

    // Each RSC fetch of /work, prefetches included, passes through here, so its body is read before any navigation drops it.
    const payloads: string[] = [];
    await page.route(
        (url) => url.pathname === '/work',
        async (route) => {
            if (route.request().headers()['rsc'] !== '1') return route.fallback();
            const response = await route.fetch();
            const body = await response.text();
            payloads.push(body);
            await route.fulfill({ response, body });
        },
    );
    await page.goto(`${origin()}/about`);
    await waitForHydration(page);
    await primary(page).getByRole('link', { name: 'Work', exact: true }).click();
    await expect(page).toHaveURL(`${origin()}/work`);
    await expect(entries(page)).toHaveCount(PUBLISHED.length);
    expect(payloads.length, 'the move fetched /work as an RSC payload').toBeGreaterThan(0);
    const rsc = payloads.join('\n');
    expect(rsc, 'the payload holds Work').toContain(PUBLISHED[0].title);
    for (const sentinel of SENTINELS) expect(rsc, sentinel).not.toContain(sentinel);
});

test('Work passes the #1 checks, with SiteNav outside main, Work current, and no data-surface', async ({ page }) => {
    await openWork(page);
    await checkSurface(page, { entries: entries(page), controls: [primary(page).locator('a, button')] });
    await expectHoverRulesGated(page);
    await expect(page.locator('main nav')).toHaveCount(0);
    await expect(primary(page).locator('[aria-current="page"]')).toHaveText(['Work']);
    await expect(page.locator('[data-surface]')).toHaveCount(0);
});

test('Tab reaches the entries right after SiteNav, in order, and Enter opens the focused series', async ({ page }) => {
    await openWork(page);
    // The wordmark, Home, Work, About, and the theme toggle come first.
    for (let press = 0; press < 5; press++) await page.keyboard.press('Tab');
    const hrefs: (string | null)[] = [];
    for (let press = 0; press < PUBLISHED.length; press++) {
        await page.keyboard.press('Tab');
        hrefs.push(await page.evaluate(() => document.activeElement?.getAttribute('href') ?? null));
    }
    expect(hrefs).toEqual(PUBLISHED.map((series) => `/work/${series.slug}`));
    await entry(page, PUBLISHED[1].slug).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${origin()}/work/${PUBLISHED[1].slug}`);
});

test('one tap on an entry opens its series', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch, 'Touch runs on the mobile project.');
    await openWork(page);
    const target = entry(page, PUBLISHED[2].slug);
    await target.scrollIntoViewIfNeeded();
    await expectSingleTapActivates(target, () => expect(page).toHaveURL(`${origin()}/work/${PUBLISHED[2].slug}`));
});

/** The reserved box's width over height for the entry at `index`: 4:3 below 768 px, then wide 3:2 and narrow 4:5 alternating by row. */
const frameRatio = (index: number, width: number) => (width < 768 ? 4 / 3 : index % 4 === 0 || index % 4 === 3 ? 3 / 2 : 4 / 5);

test('each cover holds its reserved box before its image loads, cropped at its focal point, and contain keeps the whole photo', async ({ page }) => {
    // Hold every /media response, so the boxes are measured with no image painted.
    const held: Route[] = [];
    await page.route((url) => url.pathname.startsWith('/media/'), (route) => void held.push(route));
    // The held eager cover would keep the load event from firing.
    await page.goto(`${origin()}/work`, { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expect(entries(page)).toHaveCount(PUBLISHED.length);
    const first = entry(page, PUBLISHED[0].slug);
    await expect.poll(() => held.length, 'the eager cover was requested and is held').toBeGreaterThan(0);
    expect(await first.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth), 'nothing painted yet').toBe(0);

    const width = page.viewportSize()?.width ?? 0;
    for (const [index, series] of PUBLISHED.entries()) {
        const box = await entry(page, series.slug).locator('[data-cover]').boundingBox();
        expect(box, series.slug).not.toBeNull();
        expect(box?.height ?? 0, `${series.slug} keeps its height`).toBeGreaterThan(0);
        expect((box?.width ?? 0) / (box?.height ?? 1), `${series.slug} keeps its ratio`).toBeCloseTo(frameRatio(index, width), 1);
    }

    const fit = (link: Locator) => link.locator('img').evaluate((image) => ({ fit: getComputedStyle(image).objectFit, position: getComputedStyle(image).objectPosition }));
    expect(await fit(first)).toEqual({ fit: 'cover', position: `${FIRST_FOCAL.x * 100}% ${FIRST_FOCAL.y * 100}%` });
    expect((await fit(entry(page, CONTAIN_COVER))).fit).toBe('contain');

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    for (const route of held) await route.continue().catch(() => undefined);
    await expect.poll(() => coverLoaded(first)).toBe(true);
});

/** Whether `link`'s cover image has loaded and painted. */
const coverLoaded = (link: Locator) => link.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0);

test('covers load from /media, and a cover /media can\'t serve gives the text fallback, never a broken image', async ({ page }) => {
    await openWork(page);
    await expect.poll(() => coverLoaded(entry(page, PUBLISHED[0].slug))).toBe(true);
    const broken = entry(page, BROKEN_COVER);
    await broken.scrollIntoViewIfNeeded();
    await expect(broken.locator('[data-cover="unavailable"]')).toBeVisible();
    await expect(broken.locator('img')).toHaveCount(0);
    // The link and its copy stay intact.
    await expect(broken).toHaveAttribute('href', `/work/${BROKEN_COVER}`);
    await expect(broken.getByRole('heading', { level: 2 })).toHaveText('Fixture quarry');
    for (const series of PUBLISHED.filter((item) => item.slug !== BROKEN_COVER)) {
        const link = entry(page, series.slug);
        await link.scrollIntoViewIfNeeded();
        await expect.poll(() => coverLoaded(link)).toBe(true);
        expect(await link.locator('img').getAttribute('src')).toMatch(/^\/media\/ph_[^/]+\/sha256-[0-9a-f]{64}\/p_[0-9a-f]+\/w1200\.webp$/);
    }
});

/** Each published series' short statement, from the published content, in Work order. */
const statements = () =>
    PUBLISHED.map(({ slug }) => {
        const record = catalog?.content.series.find((series) => series.slug === slug);
        if (!record?.shortStatement) throw new Error(`${slug} has no short statement in the published content`);
        return record.shortStatement;
    });

/** The text as React writes it into HTML. */
const asHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

test('the server HTML holds the h1, and every published series title and short statement, in Work order', async ({ request }) => {
    const html = await (await request.get(`${origin()}/work`)).text();
    expect(html).toMatch(/<h1[^>]*>Bodies of work<\/h1>/);
    const titles = [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map(([, title]) => title);
    expect(titles).toEqual(PUBLISHED.map((series) => asHtml(series.title)));
    let from = 0;
    for (const [index, statement] of statements().entries()) {
        const at = html.indexOf(`>${asHtml(statement)}</p>`, from);
        expect(at, `${PUBLISHED[index].slug}'s short statement, after the one before it`).toBeGreaterThan(-1);
        from = at;
    }
});

test.describe('with JavaScript disabled', () => {
    test.use({ javaScriptEnabled: false });

    test('Work shows every entry with its title, statement, count, and cover, and an entry opens its series', async ({ page }) => {
        await page.goto(`${origin()}/work`);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bodies of work');
        await expect(entries(page)).toHaveCount(PUBLISHED.length);
        for (const [index, series] of PUBLISHED.entries()) {
            const link = entries(page).nth(index);
            await expect(link).toHaveAttribute('href', `/work/${series.slug}`);
            await expect(link.getByRole('heading', { level: 2 })).toHaveText(series.title);
            await expect(link).toContainText(statements()[index]);
            await expect(link).toContainText(series.count === 1 ? '1 photograph' : `${series.count} photographs`);
        }
        // The first cover is in the server HTML and loads without a script.
        await expect.poll(() => coverLoaded(entry(page, PUBLISHED[0].slug))).toBe(true);
        await expect(primary(page).getByRole('link', { name: 'Work', exact: true })).toHaveAttribute('aria-current', 'page');
        await entry(page, PUBLISHED[1].slug).click();
        await expect(page).toHaveURL(`${origin()}/work/${PUBLISHED[1].slug}`);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(PUBLISHED[1].title);
    });
});

/** Authored text in main that overflows its box, runs past the viewport, is clipped by an ancestor, or is cut short with an ellipsis or a line clamp. */
const clippedText = (page: Page) =>
    page.evaluate((slack) => {
        const problems: string[] = [];
        const root = document.documentElement;
        if (root.scrollWidth > root.clientWidth) problems.push(`the page scrolls sideways, ${root.scrollWidth} px wide in ${root.clientWidth}`);
        for (const el of Array.from(document.querySelectorAll<HTMLElement>('main h1, main h2, main p'))) {
            const name = `${el.tagName.toLowerCase()} "${(el.textContent ?? '').slice(0, 24)}"`;
            const style = getComputedStyle(el);
            if (el.scrollWidth > el.clientWidth + slack) problems.push(`${name} overflows its box sideways`);
            // Downwards only where the element clips its own overflow: the display heading's 0.9 leading lets its
            // glyphs run a few px past the line box, which clips nothing while overflow-y is visible.
            if (/^(hidden|clip|auto|scroll)$/.test(style.overflowY) && el.scrollHeight > el.clientHeight + slack) problems.push(`${name} is cut off by its own overflow-y ${style.overflowY}`);
            if (style.textOverflow === 'ellipsis' && style.overflowX !== 'visible') problems.push(`${name} ends in an ellipsis`);
            if (style.webkitLineClamp !== 'none' && style.webkitLineClamp !== '') problems.push(`${name} is clamped to ${style.webkitLineClamp} lines`);
            const box = el.getBoundingClientRect();
            if (box.left < -slack || box.right > root.clientWidth + slack) problems.push(`${name} runs past the side of the viewport`);
            for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
                const { overflowX, overflowY } = getComputedStyle(node);
                if (![overflowX, overflowY].some((value) => value === 'hidden' || value === 'clip')) continue;
                const clip = node.getBoundingClientRect();
                if (box.left < clip.left - slack || box.right > clip.right + slack || box.top < clip.top - slack || box.bottom > clip.bottom + slack) {
                    problems.push(`${name} is clipped by ${node.tagName.toLowerCase()}.${node.className.split(' ')[0]}`);
                }
            }
        }
        return problems;
    }, 0.5);

test.describe('at 320 px with 200% text', () => {
    test.skip(({ isMobile }) => isMobile, 'It sets its own size. The desktop project covers it.');

    // An entry, cover and text, is taller than a 320 by 640 window at 200%, so it scrolls: what has to hold is its
    // width, its neighbours, and its text.
    test('the entries reflow into one column, clear of each other, and no title, statement, or count is clipped or cut short', async ({ page }) => {
        await openWork(page);
        await page.setViewportSize({ width: 320, height: 640 });
        await page.evaluate(() => document.documentElement.style.setProperty('font-size', '200%'));
        // As expectReflow: a transition reports its start value until it ends, so measure once size and font have settled.
        await expect
            .poll(() => page.evaluate(() => document.getAnimations().filter((a) => a instanceof CSSTransition && a.playState === 'running').length))
            .toBe(0);
        const boxes = await entries(page).evaluateAll((links) => links.map((link) => link.getBoundingClientRect().toJSON() as DOMRect));
        const width = await page.evaluate(() => document.documentElement.clientWidth);
        for (const [index, box] of boxes.entries()) {
            expect(box.left, `entry ${index + 1}'s left edge`).toBeGreaterThanOrEqual(-0.5);
            expect(box.right, `entry ${index + 1}'s right edge`).toBeLessThanOrEqual(width + 0.5);
            if (index > 0) expect(box.top, `entry ${index + 1} starts below entry ${index}`).toBeGreaterThanOrEqual(boxes[index - 1].bottom - 0.5);
        }
        expect(await clippedText(page)).toEqual([]);
        // Synthetic: a long title and statement, with a 40-character unbroken token, swapped into the live page.
        const first = entry(page, PUBLISHED[0].slug);
        await first.getByRole('heading', { level: 2 }).evaluate((el) => (el.textContent = 'A much longer series title that wraps over several lines'));
        await first.locator('p').first().evaluate((el) => (el.textContent = `${'A short statement that runs long. '.repeat(4)}Supercalifragilisticexpialidocious12345`));
        expect(await clippedText(page)).toEqual([]);
    });
});
