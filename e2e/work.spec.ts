import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Locator, Page, Request, Route } from '@playwright/test';
import { publish } from '../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../lib/catalog/testing';
import { catalogPaths } from '../lib/catalog/working-layer';
import { assetDir } from '../lib/media/path';
import { startCatalogServer, READY_TIMEOUT, type CatalogServer } from './support/catalogServer';
import { expectHoverRulesGated } from './support/hover';
import { waitForHydration } from './support/hydration';
import { expectFocusRingVisible, expectRingNotClipped } from './support/focus';
import { measure } from './support/measure';
import { checkSurface } from './support/surface';
import { expectMinTargetSize } from './support/targets';
import { expect, test } from './support/test';
import { expectSingleTapActivates } from './support/touch';

// Work (#3) on a published catalog, on both #1 projects: authored order and
// the published series only, nothing unpublished in the HTML or the RSC
// payload, the /gallery 308, the #1 surface checks, Enter and a single tap on
// an entry, and the cover fallback. Each entry is a heading link named by its
// title, its statement and count its description, its ::after the whole
// entry's target and ring in every theme (#171, B3). Each project's worker
// publishes its own fixture catalog and serves it from a second `next start`,
// so the harness server stays unpublished for every other spec. Try again
// after a missing pointer has a server of its own, which has never loaded.

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
/** The revision the fixture's publish activated. */
let revisionId: string | null = null;

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
    revisionId = outcome.revisionId;
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
/** Each entry's one link, its title in its h2. */
const entries = (page: Page) => page.getByRole('main').getByRole('listitem').getByRole('link');
const entry = (page: Page, slug: string) => page.getByRole('main').locator(`a[href="/work/${slug}"]`);
/** The entry's list item: its cover, title, statement and count. */
const items = (page: Page) => page.getByRole('main').getByRole('listitem');
// `has` is queried inside each list item, so it names the link from there: `entry`'s main, which no list item holds,
// would match none, and every wait on the item would run out (B3's CI).
const item = (page: Page, slug: string) => items(page).filter({ has: page.locator(`a[href="/work/${slug}"]`) });
/** Where an entry draws its target and its ring: the link's ::after, stretched over the whole entry. */
const STRETCHED = { pseudo: '::after' } as const;
const countLabel = (count: number) => (count === 1 ? '1 photograph' : `${count} photographs`);

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

test('Work lists only the published series, in authored order, each one heading link named by its title, its statement and count its description', async ({ page }) => {
    await openWork(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bodies of work');
    await expect(entries(page)).toHaveCount(PUBLISHED.length);
    for (const [index, series] of PUBLISHED.entries()) {
        const link = entries(page).nth(index);
        await expect(link).toHaveAttribute('href', `/work/${series.slug}`);
        await expect(link).toHaveAccessibleName(series.title);
        await expect(link).toHaveText(series.title);
        await expect(link).toHaveAccessibleDescription(`${statements()[index]} ${countLabel(series.count)}`);
        // The link is the h2's own text, and the entry's only link.
        await expect(items(page).nth(index).getByRole('heading', { level: 2 })).toHaveText(series.title);
        await expect(items(page).nth(index).getByRole('heading', { level: 2 }).getByRole('link')).toHaveCount(1);
        await expect(items(page).nth(index).getByRole('link')).toHaveCount(1);
        await expect(items(page).nth(index)).toContainText(statements()[index]);
        await expect(items(page).nth(index)).toContainText(countLabel(series.count));
        // The cover is outside the link, with an empty alt.
        await expect(link.locator('img, [data-cover]')).toHaveCount(0);
        for (const image of await items(page).nth(index).locator('img').all()) await expect(image).toHaveAttribute('alt', '');
        // Visible at rest, without hover.
        await expect(link).toBeVisible();
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
    await checkSurface(page, { entries: entries(page), pseudo: '::after', controls: [primary(page).locator('a, button')] });
    await expectHoverRulesGated(page);
    await expect(page.locator('main nav')).toHaveCount(0);
    await expect(primary(page).locator('[aria-current="page"]')).toHaveText(['Work']);
    await expect(page.locator('[data-surface]')).toHaveCount(0);
});

/** Clicks the middle of `target` with the mouse, wherever the hit lands, as a visitor's click does. */
async function clickMiddleOf(page: Page, target: Locator): Promise<void> {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error(`${target} is not rendered`);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

type Edges = { left: number; top: number; right: number; bottom: number };
/** Whether `outer` holds `inner` grown by `by` px on every side, to half a pixel. */
const holds = (outer: Edges, inner: Edges, by = 0) =>
    outer.left <= inner.left - by + 0.5 && outer.top <= inner.top - by + 0.5 && outer.right >= inner.right + by - 0.5 && outer.bottom >= inner.bottom + by - 0.5;

/** The five choices: System paints Light or Dark from the device, and the other four paint themselves. */
const THEMES = ['system', 'light', 'bright', 'dark', 'black'] as const;
/** Each painted theme's surround room, sm below 40rem and md above (styles/themes.css). Dark and Black have none. */
const ROOM: Record<string, { sm: number; md: number }> = { dark: { sm: 0, md: 0 }, black: { sm: 0, md: 0 }, light: { sm: 7, md: 12 }, bright: { sm: 6, md: 12 } };

for (const theme of THEMES) {
    test(`in ${theme}, the whole entry is its link's target, cover, surround and copy, and the ring is the token's, inset on it and unclipped`, async ({ page }) => {
        await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
        await openWork(page);
        await expect(page.locator('html')).toHaveAttribute('data-theme-choice', theme);
        const painted = (await page.locator('html').getAttribute('data-theme')) ?? '';
        const width = page.viewportSize()?.width ?? 0;
        const room = ROOM[painted][width < 640 ? 'sm' : 'md'];
        for (const series of PUBLISHED) {
            const link = entry(page, series.slug);
            const listItem = item(page, series.slug);
            await listItem.scrollIntoViewIfNeeded();
            const target = (await measure(link, STRETCHED)).box;
            const parts = await listItem.evaluate((el) => {
                const box = (node: Element | null) => {
                    const r = (node ?? el).getBoundingClientRect();
                    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
                };
                return { entry: box(el), cover: box(el.querySelector('[data-cover]')) };
            });
            // The target holds the whole list item, and the cover with its surround's room on every side.
            expect(holds(target, parts.entry), `${series.slug}'s target holds its entry: ${JSON.stringify({ target, entry: parts.entry })}`).toBe(true);
            expect(holds(target, parts.cover, room), `${series.slug}'s target holds its cover and its ${room} px surround`).toBe(true);
            // Every point of the entry in view lands on the link: the cover, the title, the statement, the count, and between.
            const misses = await listItem.evaluate((el, slug) => {
                const r = el.getBoundingClientRect();
                const link = el.querySelector(`a[href="/work/${slug}"]`);
                const missed: string[] = [];
                for (let i = 0; i < 7; i++) {
                    for (let j = 0; j < 7; j++) {
                        const x = r.left + ((i + 0.5) * r.width) / 7;
                        const y = r.top + ((j + 0.5) * r.height) / 7;
                        if (y < 0 || y > innerHeight || x < 0 || x > innerWidth) continue;
                        const hit = document.elementFromPoint(x, y);
                        if (!hit || hit.closest('a') !== link) missed.push(`${Math.round(x)},${Math.round(y)} on ${hit?.tagName.toLowerCase() ?? 'nothing'}`);
                    }
                }
                return missed;
            }, series.slug);
            expect(misses, `${series.slug}: every point of the entry is its link's`).toEqual([]);
            await expectMinTargetSize(link, 44, STRETCHED);
            await expectFocusRingVisible(link, STRETCHED);
            await expectRingNotClipped(link, STRETCHED);
            // Inset: the outline lies inside the target, so the screen's edge, a neighbour or the print never covers it.
            const ring = await measure(link, STRETCHED);
            expect(ring.outline.offset + ring.outline.width, `${series.slug}'s ring is inset`).toBeLessThanOrEqual(0);
            // The link's own box draws no second ring round the title.
            const own = await measure(link);
            expect(own.outline.style, `${series.slug}'s title draws no ring of its own`).toBe('none');
            expect(own.boxShadow, `${series.slug}'s title draws no band of its own`).toBe('none');
            // The ring never paints over the copy (B3's review, 1): every line of the title, statement and count lies
            // inside the target shrunk by what the ring paints, its outline and band (width plus offset). Keyboard focus
            // can move the page: an entry partly off screen is revealed in the frame after the focus (B10), so the
            // target and the copy are both measured once focus has settled, at one scroll position. The target measured
            // above, before the focus, is from before that scroll.
            const scrollAt = await listItem.evaluate(
                () => new Promise<number>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(window.scrollY)))),
            );
            const focused = (await measure(link, STRETCHED)).box;
            const painted = await link.evaluate((el) => {
                const style = getComputedStyle(el);
                return parseFloat(style.getPropertyValue('--focus-ring-width')) + parseFloat(style.getPropertyValue('--focus-ring-offset'));
            });
            const clear = { left: focused.left + painted, top: focused.top + painted, right: focused.right - painted, bottom: focused.bottom - painted };
            const { lines, scrollY } = await listItem.evaluate((el) => {
                const found: { text: string; left: number; top: number; right: number; bottom: number }[] = [];
                const walker = document.createTreeWalker(el.querySelector('h2')?.parentElement ?? el, NodeFilter.SHOW_TEXT);
                for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                    if (!node.textContent?.trim()) continue;
                    const range = document.createRange();
                    range.selectNodeContents(node);
                    for (const r of range.getClientRects()) found.push({ text: node.textContent.trim().slice(0, 24), left: r.left, top: r.top, right: r.right, bottom: r.bottom });
                }
                return { lines: found, scrollY: window.scrollY };
            });
            expect(scrollY, `${series.slug}: the target and the copy are measured at one scroll position`).toBe(scrollAt);
            expect(lines.length, `${series.slug} has copy to check`).toBeGreaterThan(0);
            const covered = lines.filter((line) => !holds(clear, line)).map((line) => `"${line.text}" at ${JSON.stringify(line)} against ${JSON.stringify(clear)}`);
            expect(covered, `${series.slug}: the ring paints over none of the copy`).toEqual([]);
        }
    });
}

/** Each entry's target, the link's ::after, in Work order. */
const targets = async (page: Page) => Promise.all(PUBLISHED.map((series) => measure(entry(page, series.slug), STRETCHED).then((m) => m.box)));

// B3's review, 1: the target grows past the copy by the ring's width and offset, so it must still stay on screen at the
// narrowest phone, inside the gutter where the theme has one, and two neighbours' must never meet at the narrowest
// column gap, at 768.
test.describe('the grown target', () => {
    test.skip(({ isMobile }) => isMobile, 'It sets its own sizes. The desktop project covers it.');

    for (const theme of THEMES) {
        test(`in ${theme}, the grown target stays inside the gutter at 375, and neighbours' targets never meet at 768`, async ({ page }) => {
            await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
            await page.setViewportSize({ width: 375, height: 812 });
            await openWork(page);
            const painted = (await page.locator('html').getAttribute('data-theme')) ?? '';
            const viewport = await page.evaluate(() => document.documentElement.clientWidth);
            for (const [index, box] of (await targets(page)).entries()) {
                // Black's covers meet the screen's edge, so its target does too, and no further.
                const margin = painted === 'black' ? 0 : 1;
                expect(box.left, `entry ${index + 1}'s target on the left`).toBeGreaterThanOrEqual(margin);
                expect(viewport - box.right, `entry ${index + 1}'s target on the right`).toBeGreaterThanOrEqual(margin);
            }
            await page.setViewportSize({ width: 768, height: 1024 });
            await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => a instanceof CSSTransition && a.playState === 'running').length)).toBe(0);
            const boxes = await targets(page);
            // Two to a row: the 1st and 2nd, the 3rd and 4th.
            for (const [left, right] of [[0, 1], [2, 3]] as const) {
                expect(Math.abs(boxes[left].top - boxes[right].top), `entries ${left + 1} and ${right + 1} share a row`).toBeLessThan(1);
                expect(boxes[right].left - boxes[left].right, `entries ${left + 1} and ${right + 1}'s targets never meet`).toBeGreaterThanOrEqual(0);
            }
        });
    }
});

// Work's revision marker (#171, B3): the list carries the revision its entries came from, as Home's main (B6) and the
// series page's main (B4) do, for B12's freshness rows.
test('the series list carries the served revision, the one /api/ready names', async ({ page, request }) => {
    await openWork(page);
    expect(revisionId, 'the publish named its revision').toMatch(/^rev_/);
    await expect(page.getByRole('main').getByRole('list')).toHaveAttribute('data-catalog-revision', revisionId ?? '');
    await expect(page.locator('[data-catalog-revision]')).toHaveCount(1);
    const ready = (await (await request.get(`${origin()}/api/ready`)).json()) as { revisionId: string | null };
    expect(ready.revisionId).toBe(revisionId);
    // In the server HTML too, so B12 reads it without a script.
    const html = await (await request.get(`${origin()}/work`)).text();
    expect(html).toMatch(new RegExp(`<ul [^>]*data-catalog-revision="${revisionId}"`));
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

// B3's body, item 93, in B10: the browser scrolls only the focused title into view, so Shift+Tab back up the list
// could leave a cover's top above the screen, and Tab down it, where Chromium centres the title, could too. Keyboard
// focus on an entry brings the whole entry into view, in the frame after the browser's own scroll. The room is the
// screen less html's scroll paddings, as expectNotObscured() measures it: an entry that fits it scrolls into it, one
// that fits the screen but not the room meets the screen's edge, and one taller than the screen keeps its title.
test.describe('Tab down and Shift+Tab back up Work', () => {
    test.skip(({ isMobile }) => isMobile, 'It sets its own sizes. The desktop project covers it.');

    /**
     * Where the focused entry sits once its reveal has run, two frames after the focus, with no wait for a scroll: its
     * target and ring, the link's ::after (B3), which reaches past the entry by max(--work-room, 6 px), its cover's
     * top, its title, and the room between the root scroll paddings, as expectNotObscured() measures it.
     */
    async function placed(page: Page, slug: string) {
        const link = entry(page, slug);
        await expect(link).toBeFocused();
        const parts = await item(page, slug).evaluate(
            (li) =>
                new Promise<{ cover: number; title: { top: number; bottom: number } }>((done) =>
                    requestAnimationFrame(() =>
                        requestAnimationFrame(() => {
                            const title = (li.querySelector('h2 a') ?? li).getBoundingClientRect();
                            done({ cover: (li.querySelector('[data-cover]') ?? li).getBoundingClientRect().top, title: { top: title.top, bottom: title.bottom } });
                        }),
                    ),
                ),
        );
        const { box: ring, viewport } = await measure(link, STRETCHED);
        const room = viewport.height - viewport.scrollPaddingTop - viewport.scrollPaddingBottom;
        return { ...parts, ring: { top: ring.top, bottom: ring.bottom }, viewport, room, height: ring.bottom - ring.top };
    }

    /** The ring fully on screen, and the cover's top with it, when the ring fits the screen, and the title in view when it doesn't. */
    function expectRevealed(slug: string, way: string, at: Awaited<ReturnType<typeof placed>>) {
        const what = `${slug} on ${way}, its ring ${Math.round(at.height)} px tall in a ${Math.round(at.room)} px room and a ${at.viewport.height} px screen: ${JSON.stringify(at)}`;
        if (at.height <= at.viewport.height) {
            expect(at.ring.top, `${what}: the ring's top`).toBeGreaterThanOrEqual(-0.5);
            expect(at.ring.bottom, `${what}: the ring's foot`).toBeLessThanOrEqual(at.viewport.height + 0.5);
            expect(at.cover, `${what}: the cover's top`).toBeGreaterThanOrEqual(-0.5);
        } else {
            expect(at.title.top, `${what}: the title's top`).toBeGreaterThanOrEqual(-0.5);
            expect(at.title.bottom, `${what}: the title's foot`).toBeLessThanOrEqual(at.viewport.height + 0.5);
        }
    }

    for (const size of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }, { width: 375, height: 812 }]) {
        test(`at ${size.width} by ${size.height}, each entry is on screen, ring and cover top and all, when its link has focus, on Tab down and on Shift+Tab back up`, async ({ page }) => {
            await page.setViewportSize(size);
            await openWork(page);
            // By the keyboard past SiteNav to the first entry, so focus is keyboard focus.
            const first = `/work/${PUBLISHED[0].slug}`;
            for (let press = 0; press < 20; press++) {
                await page.keyboard.press('Tab');
                if ((await page.evaluate(() => document.activeElement?.getAttribute('href'))) === first) break;
            }
            expectRevealed(PUBLISHED[0].slug, 'Tab', await placed(page, PUBLISHED[0].slug));
            for (const series of PUBLISHED.slice(1)) {
                await page.keyboard.press('Tab');
                expectRevealed(series.slug, 'Tab', await placed(page, series.slug));
            }
            // From the foot of the page, back up.
            await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
            for (const series of PUBLISHED.slice(0, -1).reverse()) {
                await page.keyboard.press('Shift+Tab');
                expectRevealed(series.slug, 'Shift+Tab', await placed(page, series.slug));
            }
        });
    }
});

test('one tap on an entry opens its series', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch, 'Touch runs on the mobile project.');
    await openWork(page);
    const target = entry(page, PUBLISHED[2].slug);
    await target.scrollIntoViewIfNeeded();
    await expectSingleTapActivates(target, () => expect(page).toHaveURL(`${origin()}/work/${PUBLISHED[2].slug}`));
});

test('one tap on an entry\'s cover opens its series too, since the whole entry is the target', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch, 'Touch runs on the mobile project.');
    await openWork(page);
    const cover = item(page, PUBLISHED[1].slug).locator('[data-cover]');
    await cover.scrollIntoViewIfNeeded();
    const box = await cover.boundingBox();
    if (!box) throw new Error('The cover is not rendered');
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page).toHaveURL(`${origin()}/work/${PUBLISHED[1].slug}`);
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
    const first = item(page, PUBLISHED[0].slug);
    await expect.poll(() => held.length, 'the eager cover was requested and is held').toBeGreaterThan(0);
    expect(await first.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth), 'nothing painted yet').toBe(0);

    const width = page.viewportSize()?.width ?? 0;
    for (const [index, series] of PUBLISHED.entries()) {
        const box = await item(page, series.slug).locator('[data-cover]').boundingBox();
        expect(box, series.slug).not.toBeNull();
        expect(box?.height ?? 0, `${series.slug} keeps its height`).toBeGreaterThan(0);
        expect((box?.width ?? 0) / (box?.height ?? 1), `${series.slug} keeps its ratio`).toBeCloseTo(frameRatio(index, width), 1);
    }

    const fit = (link: Locator) => link.locator('img').evaluate((image) => ({ fit: getComputedStyle(image).objectFit, position: getComputedStyle(image).objectPosition }));
    expect(await fit(first)).toEqual({ fit: 'cover', position: `${FIRST_FOCAL.x * 100}% ${FIRST_FOCAL.y * 100}%` });
    expect((await fit(item(page, CONTAIN_COVER))).fit).toBe('contain');

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    for (const route of held) await route.continue().catch(() => undefined);
    await expect.poll(() => coverLoaded(first)).toBe(true);
});

/** Whether the entry's cover image has loaded and painted. */
const coverLoaded = (entryItem: Locator) => entryItem.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0);

test('covers load from /media, and a cover /media can\'t serve gives the text fallback, never a broken image', async ({ page }) => {
    await openWork(page);
    await expect.poll(() => coverLoaded(item(page, PUBLISHED[0].slug))).toBe(true);
    const broken = item(page, BROKEN_COVER);
    await broken.scrollIntoViewIfNeeded();
    await expect(broken.locator('[data-cover="unavailable"]')).toBeVisible();
    await expect(broken.locator('img')).toHaveCount(0);
    // The link and its copy stay intact.
    await expect(entry(page, BROKEN_COVER)).toHaveAccessibleName('Fixture quarry');
    await expect(broken.getByRole('heading', { level: 2 })).toHaveText('Fixture quarry');
    for (const series of PUBLISHED.filter((published) => published.slug !== BROKEN_COVER)) {
        const entryItem = item(page, series.slug);
        await entryItem.scrollIntoViewIfNeeded();
        await expect.poll(() => coverLoaded(entryItem)).toBe(true);
        expect(await entryItem.locator('img').getAttribute('src')).toMatch(/^\/media\/ph_[^/]+\/sha256-[0-9a-f]{64}\/p_[0-9a-f]+\/w1200\.webp$/);
    }
});

/** The photograph a published series' cover shows, from the published content. */
const coverPhotoOf = (slug: string) => {
    const photoId = catalog?.content.series.find((series) => series.slug === slug)?.cover?.photoId;
    if (!photoId) throw new Error(`${slug} has no cover in the published content`);
    return photoId;
};
/** The photograph a /media path serves: /media/<photoId>/<assetRevision>/<profileId>/<variant>. */
const mediaPhotoOf = (pathname: string) => pathname.split('/')[2] ?? '';
/** A series page, or anything under it: its RSC payload, a prefetch of it, its Viewer. */
const underSeries = (pathname: string) => pathname.startsWith('/work/');
/**
 * Resolves once `count` has held still for a second, so a request something starts late, a prefetch after hydration
 * or an image after a scroll, is seen before the test reads what was asked for. Playwright's networkidle fires once
 * per load, so after a scroll it wouldn't wait at all.
 */
async function settled(count: () => number): Promise<void> {
    let last = -1;
    await expect
        .poll(
            () => {
                const same = count() === last;
                last = count();
                return same;
            },
            { message: 'the page stopped asking for things', intervals: [1_000], timeout: 15_000 },
        )
        .toBe(true);
}

// #6 item 9 (B10): an entry's link prefetches its series only on intent, through IntentPrefetchLink. Coming into view
// prefetches nothing.
test('pointing at or focusing an entry prefetches that series, and only once the visitor does', async ({ page, isMobile }) => {
    const asked: string[] = [];
    page.on('request', (request) => {
        const { pathname } = new URL(request.url());
        if (underSeries(pathname)) asked.push(pathname);
    });
    const all: string[] = [];
    page.on('request', (request) => void all.push(request.url()));
    await openWork(page);
    await settled(() => all.length);
    expect(asked, 'nothing prefetched a series before the visitor pointed at or focused one').toEqual([]);
    await entry(page, PUBLISHED[1].slug).focus();
    await expect.poll(() => asked, 'focus prefetched the focused series').toContain(`/work/${PUBLISHED[1].slug}`);
    expect(new Set(asked), 'and no other').toEqual(new Set([`/work/${PUBLISHED[1].slug}`]));
    if (isMobile) return;
    // The stretched ::after takes the pointer anywhere on the entry, cover included. By the mouse, since a hover on the
    // cover's locator would refuse the link's ::after over it.
    const cover = item(page, PUBLISHED[2].slug).locator('[data-cover]');
    await cover.scrollIntoViewIfNeeded();
    const box = await cover.boundingBox();
    if (!box) throw new Error('The cover is not rendered');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => asked, 'a pointer on the cover prefetched its series').toContain(`/work/${PUBLISHED[2].slug}`);
    expect(new Set(asked)).toEqual(new Set([`/work/${PUBLISHED[1].slug}`, `/work/${PUBLISHED[2].slug}`]));
});

// #171's request check, moved from B1 to B10: it can't pass while each entry's Link prefetches its series as it
// comes into view, since this build prefetches force-dynamic pages.
test.describe('at 375 by 812', () => {
    test.skip(({ isMobile }) => isMobile, 'It sets its own size. The desktop project covers it.');
    test.use({ viewport: { width: 375, height: 812 } });

    test('Work makes no /api, series page or sequence request, and loads one cover per series', async ({ page }) => {
        const requests: string[] = [];
        /** Each /media request, and the status it was answered with, once it is. */
        const media = new Map<Request, number | null>();
        page.on('request', (request) => {
            const url = new URL(request.url());
            if (!url.protocol.startsWith('http')) return;
            requests.push(url.pathname);
            if (url.pathname.startsWith('/media/')) media.set(request, null);
        });
        page.on('response', (response) => {
            if (media.has(response.request())) media.set(response.request(), response.status());
        });
        await openWork(page);
        // Every entry comes into view, as a visitor scrolling through would bring it, with nothing pointed at, focused
        // or touched. Each cover settles: the image paints, or the box takes its text fallback.
        for (const series of PUBLISHED) {
            const entryItem = item(page, series.slug);
            await entryItem.scrollIntoViewIfNeeded();
            if (series.slug === BROKEN_COVER) await expect(entryItem.locator('[data-cover="unavailable"]')).toBeVisible();
            else await expect.poll(() => coverLoaded(entryItem), `${series.slug}'s cover paints`).toBe(true);
        }
        await settled(() => requests.length);

        expect(requests.filter((pathname) => pathname.startsWith('/api/')), 'no /api request').toEqual([]);
        // A series page, its payload or a prefetch of it, and its Viewer (the sequence) all sit under /work/<slug>.
        expect(requests.filter(underSeries), 'no series page or sequence request').toEqual([]);
        // Every image is a cover, and every cover is asked for. Each one that loads is asked for once, and answered.
        const covers = new Map(PUBLISHED.map((series) => [coverPhotoOf(series.slug), series.slug]));
        const bySeries = new Map<string, number[]>();
        for (const [request, status] of media) {
            const { pathname } = new URL(request.url());
            const slug = covers.get(mediaPhotoOf(pathname));
            expect(slug, `${pathname} is a series' cover`).toBeDefined();
            if (slug) bySeries.set(slug, [...(bySeries.get(slug) ?? []), status ?? 0]);
        }
        for (const series of PUBLISHED) {
            const statuses = bySeries.get(series.slug) ?? [];
            // The broken cover's files are gone, so whatever asks for it gets a 404 and nothing paints.
            if (series.slug === BROKEN_COVER) expect(statuses.length > 0 && statuses.every((status) => status === 404), `${series.slug}: ${statuses}`).toBe(true);
            else expect(statuses, `${series.slug} loads its cover once`).toEqual([200]);
        }
    });
});

// #6 gap 31: an image Work started stops when Work unmounts on a route change. The second cover is eager and not
// preloaded from the head, so it starts at once and only its own element holds it. Its /media response is held, so
// it's still on its way when the visitor opens a series. Chromium reports a stopped request as ERR_ABORTED.
test('a cover still loading when a visitor opens a series stops loading', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'The abort is read from Chromium\'s network events.');
    const slow = coverPhotoOf(PUBLISHED[1].slug);
    const held: Route[] = [];
    await page.route((url) => url.pathname.startsWith(`/media/${slow}/`), (route) => void held.push(route));
    const failed: { pathname: string; error: string }[] = [];
    page.on('requestfailed', (request) => failed.push({ pathname: new URL(request.url()).pathname, error: request.failure()?.errorText ?? '' }));
    // The held cover would keep the load event from firing.
    await page.goto(`${origin()}/work`, { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expect(entries(page)).toHaveCount(PUBLISHED.length);
    await expect.poll(() => held.length, 'the second cover was asked for and is held').toBeGreaterThan(0);
    expect(await coverLoaded(item(page, PUBLISHED[1].slug)), 'nothing painted yet').toBe(false);
    const asked = held.map((route) => new URL(route.request().url()).pathname);

    await entry(page, PUBLISHED[0].slug).click();
    await expect(page).toHaveURL(`${origin()}/work/${PUBLISHED[0].slug}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(PUBLISHED[0].title);
    await expect
        .poll(() => failed.filter((request) => asked.includes(request.pathname)).map((request) => request.error), 'the held cover was stopped')
        .toContainEqual(expect.stringMatching(/ERR_ABORTED/));

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    for (const route of held) await route.continue().catch(() => undefined);
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
    // Each title is its h2's one link (#171, B3).
    const titles = [...html.matchAll(/<h2[^>]*><a [^>]*>([^<]*)<\/a><\/h2>/g)].map(([, title]) => title);
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
            await expect(link).toHaveAccessibleName(series.title);
            await expect(link).toHaveAccessibleDescription(`${statements()[index]} ${countLabel(series.count)}`);
            await expect(items(page).nth(index).getByRole('heading', { level: 2 })).toHaveText(series.title);
            await expect(items(page).nth(index)).toContainText(statements()[index]);
            await expect(items(page).nth(index)).toContainText(countLabel(series.count));
        }
        // The first cover is in the server HTML and loads without a script.
        await expect.poll(() => coverLoaded(item(page, PUBLISHED[0].slug))).toBe(true);
        await expect(primary(page).getByRole('link', { name: 'Work', exact: true })).toHaveAttribute('aria-current', 'page');
        // The stretched target is CSS, so it holds without a script: a click on the cover opens the series. By the
        // mouse, since the link's ::after takes the click, which a click on the cover's locator would refuse.
        await clickMiddleOf(page, item(page, PUBLISHED[1].slug).locator('[data-cover]'));
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
        const boxes = await items(page).evaluateAll((listItems) => listItems.map((listItem) => listItem.getBoundingClientRect().toJSON() as DOMRect));
        const width = await page.evaluate(() => document.documentElement.clientWidth);
        for (const [index, box] of boxes.entries()) {
            expect(box.left, `entry ${index + 1}'s left edge`).toBeGreaterThanOrEqual(-0.5);
            expect(box.right, `entry ${index + 1}'s right edge`).toBeLessThanOrEqual(width + 0.5);
            if (index > 0) expect(box.top, `entry ${index + 1} starts below entry ${index}`).toBeGreaterThanOrEqual(boxes[index - 1].bottom - 0.5);
        }
        expect(await clippedText(page)).toEqual([]);
        // Synthetic: a long title and statement, with a 40-character unbroken token, swapped into the live page.
        const first = item(page, PUBLISHED[0].slug);
        await first.getByRole('link').evaluate((el) => (el.textContent = 'A much longer series title that wraps over several lines'));
        await first.locator('p').first().evaluate((el) => (el.textContent = `${'A short statement that runs long. '.repeat(4)}Supercalifragilisticexpialidocious12345`));
        expect(await clippedText(page)).toEqual([]);
    });
});

// #171 (B3), from the old Work browser suite: a missing pointer gives #21's 500 with Try again and no path, and once
// the pointer is back, Try again brings the entries back with no reload. It needs a server that has never loaded a
// revision: one that has serves its last revision while the pointer is missing (lib/catalog/public-reader.ts). So it
// has a catalog and a server of its own, and the rest of the file never sees its pointer go.
test.describe('with the pointer missing', () => {
    const MISSING = [
        { slug: 'cove', title: 'Fixture cove' },
        { slug: 'dune', title: 'Fixture dune' },
    ] as const;
    const missingId = (n: number) => `ph_00000000-0000-4000-8000-${String(n + 301).padStart(12, '0')}`;
    let own: TestCatalog | undefined;
    let missing: CatalogServer | undefined;
    let active = '';
    let aside = '';

    test.beforeAll(async () => {
        test.setTimeout(HOOK_TIMEOUT);
        // In a temp folder of its own: createTestCatalog refuses one inside the repo, which Playwright's output folder is. Nothing here deletes it.
        own = await createTestCatalog({
            root: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-missing-pointer-')), 'root'),
            seed: 47,
            withAssets: true,
            photos: [0, 1].map((n) => ({ id: missingId(n), width: 900, height: 600 })),
            series: MISSING.map((series, n) => ({ id: `ser_e2e-${series.slug}`, ...series, photoIds: [missingId(n)] })),
            seriesOrder: MISSING.map((series) => `ser_e2e-${series.slug}`),
        });
        const outcome = await publish({ dataRoot: own.root, actor: 'e2e', confirmLaunch: true, logger: { log: () => undefined } });
        expect(outcome.outcome, outcome.message).toBe('PUBLISHED');
        active = catalogPaths(own.root).active;
        aside = `${active}.aside`;
        // Moved aside, never deleted, before the server ever reads it.
        fs.renameSync(active, aside);
        // Above the ports the file's own servers take when E2E_CATALOG_PORT pins them, one per worker, as
        // curator-login.spec.ts does.
        const base = Number(process.env.E2E_CATALOG_PORT);
        const port = Number.isInteger(base) && base > 0 ? base + 1 + test.info().config.workers + test.info().parallelIndex : undefined;
        missing = await startCatalogServer(own.root, port, { unavailable: true });
    });

    test.afterAll(async () => {
        test.setTimeout(HOOK_TIMEOUT);
        await missing?.stop();
    });

    test('Work is the 500 with Try again and no path, and once the pointer is back Try again shows the entries, without a reload', async ({ page }) => {
        if (!own || !missing) throw new Error('The missing-pointer server did not start');
        const response = await page.request.get(`${missing.origin}/work`);
        expect(response.status()).toBe(500);
        const body = await response.text();
        for (const leak of [own.root, path.basename(own.root), 'catalog/active', 'ENOENT', 'active-unreadable', 'CatalogUnavailableError']) {
            expect(body, `the 500 says nothing of ${leak}`).not.toContain(leak);
        }

        await page.goto(`${missing.origin}/work`);
        await waitForHydration(page);
        const tryAgain = page.getByRole('main').getByRole('button', { name: 'Try again' });
        await expect(tryAgain).toBeVisible();
        await expect(entries(page)).toHaveCount(0);
        await expect(page.getByRole('main')).not.toContainText(own.root);
        // A mark on this document: a reload would drop it.
        await page.evaluate(() => Object.assign(window, { workSameDocument: true }));

        fs.renameSync(aside, active);
        await tryAgain.click();
        await expect(entries(page)).toHaveCount(MISSING.length);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bodies of work');
        for (const [index, series] of MISSING.entries()) await expect(entries(page).nth(index)).toHaveAccessibleName(series.title);
        await expect(page).toHaveURL(`${missing.origin}/work`);
        expect(await page.evaluate(() => (window as { workSameDocument?: boolean }).workSameDocument), 'Try again kept the document').toBe(true);
    });
});
