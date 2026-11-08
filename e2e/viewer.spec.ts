import type { Locator, Page, Request, Route } from '@playwright/test';
import { expectHoverRulesGated } from './support/hover';
import { waitForHydration } from './support/hydration';
import { expectReflow } from './support/reflow';
import { checkSurface } from './support/surface';
import { expect, test } from './support/test';
import { fitSizes } from '../components/viewer/viewerSizes';
import { expectSingleTapActivates } from './support/touch';
import { FACTS_ONLY, HARBOR, P, SENTINELS, SITE_URL, href, id, useViewerCatalog } from './support/viewerCatalog';

// The Viewer (#7) on a published catalog, on both #1 projects: a direct load,
// the series and position, Previous and Next inside the series that stop at
// the ends and replace the history entry, the collapsed technical details,
// the #1 checks, keyboard and touch, share metadata on SITE_URL, each
// theme's own Viewer, and nothing outside the allowlist in
// the HTML or the RSC payload. Each project's worker publishes its own
// fixture and serves it from a second `next start`, so the harness server
// stays unpublished for every other spec. Close points at #5's series
// page, which isn't on this branch, so only its href is checked. The fixture
// lives in support/viewerCatalog.ts, shared with #9's viewer-modal.spec.ts.

test.describe.configure({ mode: 'serial' });

const origin = useViewerCatalog();

const header = (page: Page) => page.locator('[data-surface="viewer"] > header');
const close = (page: Page) => header(page).getByRole('link', { name: 'Close' });
const zoom = (page: Page) => header(page).getByRole('button', { name: 'Zoom' });
// Buttons that outlive every move (#9), so focus stays on them.
const previous = (page: Page) => page.getByRole('main').getByRole('button', { name: 'Previous photograph' });
const next = (page: Page) => page.getByRole('main').getByRole('button', { name: 'Next photograph' });
const technical = (page: Page) => page.getByRole('main').getByRole('button', { name: /^(Show|Hide) technical details$/ });
const photograph = (page: Page) => page.getByRole('main').locator('picture img');

/** The header's heading as a screen reader hears it (#7), its aria-label: "{series title}, photograph N of T". */
const seriesHeading = (title: string) => new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, photograph \\d+ of \\d+$`);

async function openViewer(page: Page, photoId: string): Promise<void> {
    await page.goto(`${origin()}${href(photoId)}`);
    await waitForHydration(page);
    await expect(header(page).getByRole('heading', { level: 1 })).toHaveAccessibleName(seriesHeading('Fixture harbor'));
}

/**
 * Everything on the page the browser keeps in place while it scrolls (fixed or sticky), marked, for checkSurface's
 * chrome: none may cover a control's focus ring. The Viewer has none of its own today (#7, decided: no sticky
 * header, since the fixed stage keeps the controls in view), so this catches one added later.
 */
async function fixedChrome(page: Page): Promise<Locator[]> {
    const count = await page.evaluate(() => {
        let found = 0;
        for (const element of document.body.querySelectorAll('*')) {
            const { position } = getComputedStyle(element);
            const pinned = (position === 'fixed' || position === 'sticky') && element.localName !== 'dialog';
            if (pinned) {
                element.setAttribute('data-e2e-fixed', '');
                found += 1;
            } else element.removeAttribute('data-e2e-fixed');
        }
        return found;
    });
    return count === 0 ? [] : [page.locator('[data-e2e-fixed]')];
}

/** The image URLs a page asked for, so a test can see none went past /media. */
function imageRequests(page: Page): string[] {
    const urls: string[] = [];
    page.on('request', (request: Request) => {
        if (request.resourceType() === 'image') urls.push(new URL(request.url()).pathname);
    });
    return urls;
}

test('a direct load renders the whole Viewer: series, position, photograph, authored copy, and Close, with no SiteNav', async ({ page, request }) => {
    const response = await request.get(`${origin()}${href(P[0])}`, { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/<h1[^>]*aria-label="Fixture harbor, photograph 1 of 3"[^>]*><span aria-hidden="true">Fixture harbor<\/span><\/h1>/);
    expect(html).toContain('01 / 03');
    expect(html).toContain('Fixture authored caption.');

    const images = imageRequests(page);
    await openViewer(page, P[0]);
    await expect(header(page)).toContainText('01 / 03');
    // Close names this photograph, so the series focuses its entry (B5).
    await expect(close(page)).toHaveAttribute('href', `/work/harbor?photo=${P[0]}`);
    await expect(page.getByRole('heading', { level: 2 })).toHaveText('Fixture harbor at dusk');
    await expect(page.getByText('Fixture authored caption.')).toBeVisible();
    // With a caption the reading area shows only the caption (#7): the description is the image's alt, said once.
    await expect(page.getByText('Fixture description of the harbor.', { exact: true })).toHaveCount(0);
    await expect(page.locator('nav[aria-label="Primary"]')).toHaveCount(0);
    await expect(page.locator('[data-surface="viewer"]')).toHaveCount(1);
    await expect(photograph(page)).toHaveAttribute('alt', 'Fixture description of the harbor.');
    await expect.poll(() => photograph(page).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    // The photograph is the largest object on the first screen.
    const box = await photograph(page).boundingBox();
    const viewport = page.viewportSize();
    expect(box && viewport && box.width * box.height).toBeGreaterThan((viewport?.width ?? 0) * (viewport?.height ?? 0) * 0.2);
    expect(images.length).toBeGreaterThan(0);
    for (const url of images) expect(url).toMatch(/^\/media\//);
});

test('a former series slug answers 308 to the canonical URL, and nothing it can\'t serve tells one case from another', async ({ request }) => {
    const moved = await request.get(`${origin()}${href(P[1], 'sentinel-old-slug')}`, { maxRedirects: 0 });
    expect(moved.status()).toBe(308);
    expect(moved.headers()['location']).toBe(href(P[1]));
    const missing = [href(P[4], 'draft'), href(P[5], 'sentinel-hidden'), href(P[4], 'no-such-series'), href(id(99)), href(id(99).toUpperCase()), '/work/harbor/photo/IMG_0001.jpg'];
    for (const path of missing) {
        const response = await request.get(`${origin()}${path}`, { maxRedirects: 0 });
        expect(response.status(), path).toBe(404);
        const html = await response.text();
        // A notFound() inside a nested segment sends Next's error shell, with the not-found title, and the page in its payload.
        expect(html, path).toContain('<title>Page not found · Keyur Golani Photography</title>');
        // The payload echoes the requested path, so a segment the visitor sent isn't a leak.
        const leaks = ['Fixture harbor', 'Fixture ridge', 'data-surface="viewer"', ...SENTINELS].filter((text) => !path.includes(text));
        for (const text of leaks) expect(html, `${path}: ${text}`).not.toContain(text);
    }
});

test('a letter-case variant, or a photograph moved to another series, answers 308 to the canonical URL, keeping the query (#7, decided)', async ({ request }) => {
    for (const [path, location] of [
        [href(P[0], 'Harbor'), href(P[0])],
        [href(P[0].toUpperCase()), href(P[0])],
        [href(P[1], 'SENTINEL-OLD-SLUG'), href(P[1])],
        // P[0] is in harbor and P[3] in ridge, so each asked for under the other moves to its own.
        [href(P[0], 'ridge'), href(P[0])],
        [href(P[3]), href(P[3], 'ridge')],
        [`${href(P[3], 'Harbor')}?utm_source=mail&tag=one&tag=two`, `${href(P[3], 'ridge')}?utm_source=mail&tag=one&tag=two`],
        [`${href(P[1], 'sentinel-old-slug')}?photo=${P[1]}`, `${href(P[1])}?photo=${P[1]}`],
        // A published photo's one home, from any slug in shape: unknown, draft, and hidden slugs answer alike.
        [href(P[0], 'no-such-series'), href(P[0])],
        [href(P[0], 'draft'), href(P[0])],
        [href(P[0], 'sentinel-hidden'), href(P[0])],
    ]) {
        const response = await request.get(`${origin()}${path}`, { maxRedirects: 0 });
        expect(response.status(), path).toBe(308);
        expect(response.headers()['location'], path).toBe(location);
        expect(response.headers()['cache-control'], path).toContain('no-store');
        // One hop, then the Viewer: no redirect loops.
        const followed = await request.get(new URL(location, origin()).toString(), { maxRedirects: 0 });
        expect(followed.status(), `${path} -> ${location}`).toBe(200);
    }
    // The Location is built from the canonical path, so a query can't send it off the site.
    const away = await request.get(`${origin()}${href(P[0], 'Harbor')}?next=//evil.example/x`, { maxRedirects: 0 });
    expect(away.headers()['location']).toBe(`${href(P[0])}?next=%2F%2Fevil.example%2Fx`);
});

test('a visitor on a photo the Viewer can\'t serve sees the not-found page', async ({ page }) => {
    const response = await page.goto(`${origin()}${href(P[4], 'draft')}`);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
    await expect(page.locator('[data-surface]')).toHaveCount(0);
});

test('nothing outside the allowlist reaches the served HTML or the RSC payload of a move', async ({ page, request }) => {
    for (const photoId of HARBOR) {
        const html = await (await request.get(`${origin()}${href(photoId)}`)).text();
        expect(html, 'the check reads a rendered Viewer').toContain('Fixture harbor');
        for (const sentinel of SENTINELS) expect(html, `${photoId}: ${sentinel}`).not.toContain(sentinel);
        expect(html).not.toMatch(/_next\/image|api\/image/);
    }

    // Each RSC fetch of a Viewer URL passes through here, so its body is read before the navigation drops it.
    const payloads: string[] = [];
    await page.route(
        (url) => url.pathname.startsWith('/work/harbor/photo/'),
        async (route) => {
            if (route.request().headers()['rsc'] !== '1') return route.fallback();
            // The idle prefetch (9a) is one of these too. A navigation can cancel one in flight, and then there's no body.
            let fetched: { response: Awaited<ReturnType<typeof route.fetch>>; body: string };
            try {
                const response = await route.fetch();
                fetched = { response, body: await response.text() };
            } catch {
                return;
            }
            payloads.push(fetched.body);
            await route.fulfill({ response: fetched.response, body: fetched.body }).catch(() => undefined);
        },
    );
    await openViewer(page, P[1]);
    await previous(page).click();
    await expect(page).toHaveURL(`${origin()}${href(P[0])}`);
    await expect(page.getByRole('heading', { level: 2 })).toHaveText('Fixture harbor at dusk');
    expect(payloads.length, 'the move fetched the Viewer as an RSC payload').toBeGreaterThan(0);
    const rsc = payloads.join('\n');
    expect(rsc, 'the payload holds the Viewer').toContain('Fixture authored caption.');
    for (const sentinel of SENTINELS) expect(rsc, sentinel).not.toContain(sentinel);
    expect(rsc).not.toMatch(/_next\/image|api\/image/);
});

test('Previous and Next stay inside the series and stop at the ends', async ({ page }) => {
    await openViewer(page, P[0]);
    // An end stays a focusable button, unavailable through aria-disabled (#9), never the disabled attribute.
    await expect(previous(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(previous(page)).not.toHaveAttribute('disabled');
    await next(page).click();
    await expect(page).toHaveURL(`${origin()}${href(P[1])}`);
    await expect(header(page)).toContainText('02 / 03');
    await expect(previous(page)).not.toHaveAttribute('aria-disabled');
    await next(page).click();
    await expect(page).toHaveURL(`${origin()}${href(P[2])}`);
    await expect(header(page)).toContainText('03 / 03');
    await expect(next(page)).toHaveAttribute('aria-disabled', 'true');
    // Pressing an end changes neither the photograph nor the URL. Playwright won't click an aria-disabled
    // control, so the press comes from the keyboard, as it would for anyone who can't reach it otherwise.
    await next(page).press('Enter');
    await expect(page).toHaveURL(`${origin()}${href(P[2])}`);
    await expect(header(page)).toContainText('03 / 03');
    // The one-photo series has neither, and nothing but Close links anywhere.
    await page.goto(`${origin()}${href(P[3], 'ridge')}`);
    await waitForHydration(page);
    await expect(previous(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(next(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('main').getByRole('link')).toHaveText(['Close']);
});

test('moves replace the history entry, so one Back leaves the Viewer for the page that opened it', async ({ page }) => {
    await page.goto(`${origin()}/`);
    await waitForHydration(page);
    await openViewer(page, P[0]);
    const length = await page.evaluate(() => history.length);
    await next(page).click();
    await expect(page).toHaveURL(`${origin()}${href(P[1])}`);
    await next(page).click();
    await expect(page).toHaveURL(`${origin()}${href(P[2])}`);
    await previous(page).click();
    await expect(page).toHaveURL(`${origin()}${href(P[1])}`);
    expect(await page.evaluate(() => history.length)).toBe(length);
    await page.goBack();
    await expect(page).toHaveURL(`${origin()}/`);
    // And Forward comes back to where the visitor left it.
    await page.goForward();
    await expect(page).toHaveURL(`${origin()}${href(P[1])}`);
    await expect(header(page)).toContainText('02 / 03');
});

// #6 gap 30: a photograph the visitor moves past before it finished stops loading (stopFetching.ts). Its /media
// response is held, so it's still on its way at the second Next. The first photograph is the server's preloaded lead,
// which can't be stopped, so the race is on the second. Under reduced motion, where nothing slides and there are no
// peeks, so it stops at once; the test after this one is the same with motion on. Chromium reports a stopped request
// as ERR_ABORTED.
test('a photograph passed before it finished loading stops loading', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'The abort is read from Chromium\'s network events.');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const held: Route[] = [];
    await page.route((url) => url.pathname.startsWith(`/media/${P[1]}/`), (route) => void held.push(route));
    const failed: { pathname: string; error: string }[] = [];
    page.on('requestfailed', (request) => failed.push({ pathname: new URL(request.url()).pathname, error: request.failure()?.errorText ?? '' }));
    await openViewer(page, P[0]);
    await next(page).click();
    await expect(page).toHaveURL(`${origin()}${href(P[1])}`);
    await expect.poll(() => held.length, 'the second photograph was asked for and is held').toBeGreaterThan(0);
    expect(await photograph(page).evaluate((image: HTMLImageElement) => image.naturalWidth), 'nothing painted yet').toBe(0);
    const asked = held.map((route) => new URL(route.request().url()).pathname);

    await next(page).click();
    await expect(page).toHaveURL(`${origin()}${href(P[2])}`);
    await expect(header(page)).toContainText('03 / 03');
    await expect
        .poll(() => failed.filter((request) => asked.includes(request.pathname)).map((request) => request.error), 'the passed photograph was stopped')
        .toContainEqual(expect.stringMatching(/ERR_ABORTED/));

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    for (const route of held) await route.continue().catch(() => undefined);
});

// The same with motion on, for a mouse visitor, who never puts a finger on the photograph: the passed photograph
// slides out beside the next one, then leaves the stage, so it stops loading once that slide lands. Only a visitor
// whose finger has been on the photograph keeps the photographs they've seen beside it, to drag back in.
test('with motion on, a photograph passed before it finished loading stops loading once the next one has slid in', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'The abort is read from Chromium\'s network events.');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const held: Route[] = [];
    await page.route((url) => url.pathname.startsWith(`/media/${P[1]}/`), (route) => void held.push(route));
    const failed: { pathname: string; error: string }[] = [];
    page.on('requestfailed', (request) => failed.push({ pathname: new URL(request.url()).pathname, error: request.failure()?.errorText ?? '' }));
    await openViewer(page, P[0]);
    await next(page).click();
    await expect(page).toHaveURL(`${origin()}${href(P[1])}`);
    await expect.poll(() => held.length, 'the second photograph was asked for and is held').toBeGreaterThan(0);
    // The photograph itself: the one passed may still be sliding out beside it.
    expect(await page.locator('[data-viewer-current] img').evaluate((image: HTMLImageElement) => image.naturalWidth), 'nothing painted yet').toBe(0);
    const asked = held.map((route) => new URL(route.request().url()).pathname);

    await next(page).click();
    await expect(page).toHaveURL(`${origin()}${href(P[2])}`);
    await expect(header(page)).toContainText('03 / 03');
    // Its slide out over, the passed photograph isn't beside the stage any more.
    await expect(page.locator('[data-viewer-peek]'), 'no peek once the slide has landed').toHaveCount(0);
    await expect
        .poll(() => failed.filter((request) => asked.includes(request.pathname)).map((request) => request.error), 'the passed photograph was stopped')
        .toContainEqual(expect.stringMatching(/ERR_ABORTED/));

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    for (const route of held) await route.continue().catch(() => undefined);
});

/** Where the reading area's title line sits on screen: the title (when shown), and the first line of the caption or the description. */
async function titleLine(page: Page) {
    return page.locator('[data-surface="viewer"]').evaluate((root) => {
        const box = (element: Element | null) => {
            if (element === null) return null;
            const { top, bottom } = element.getBoundingClientRect();
            return { top, bottom };
        };
        const reading = root.querySelector('section[aria-labelledby]');
        const title = reading?.querySelector('h2:not(.sr-only)') ?? null;
        const lead = reading?.querySelector('h2 ~ p, h2 ~ div p:not(:first-child)') ?? null;
        const leadTop = lead?.getBoundingClientRect().top ?? NaN;
        const lineHeight = lead ? parseFloat(getComputedStyle(lead).lineHeight) : NaN;
        return {
            innerHeight,
            stage: box(root.querySelector('[data-viewer-stage]')),
            frame: box(root.querySelector('[data-viewer-stage] figure')),
            reading: box(reading ?? null),
            title: box(title),
            leadText: lead?.textContent ?? null,
            leadLineBottom: leadTop + lineHeight,
        };
    });
}

/**
 * The reading area's pieces as the first screen cuts them: the title (when shown), the caption, the Description label
 * and its text, and the technical toggle. Only running text (the caption and the description) may run across the fold.
 * `lead` marks the pieces in the title line's block (the title and the caption), which comes first. `block` is the
 * reading area's child each piece sits in, so a test can tell the first block shown from the ones after it.
 */
async function foldPieces(page: Page) {
    return page.locator('[data-surface="viewer"] section[aria-labelledby]').evaluate((reading) => {
        const lead = reading.firstElementChild;
        const blocks = [...reading.children];
        const pieces = [...reading.querySelectorAll('h2:not(.sr-only), :scope > p, :scope > div > p, :scope > div > button')];
        return pieces.map((element) => {
            const { top, bottom } = element.getBoundingClientRect();
            const running = element.tagName === 'P' && (element.parentElement === reading || element.previousElementSibling !== null);
            const block = blocks.findIndex((child) => child === element || child.contains(element));
            return { text: element.textContent?.trim().slice(0, 40) ?? '', top, bottom, running, lead: element.parentElement === lead, block };
        });
    });
}

test('on a wide screen, the first screen ends on whole elements for every mix of title and caption, keeps the title line when there is one, and the same stage for all', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'The wide layout.');
    // The title and the caption are both optional: both, a title alone, a caption alone (the one-photo series), neither.
    const mixes = [
        { name: 'title and caption', photoId: P[0], slug: 'harbor', series: 'Fixture harbor', title: true },
        { name: 'title only', photoId: P[2], slug: 'harbor', series: 'Fixture harbor', title: true },
        { name: 'caption only', photoId: P[3], slug: 'ridge', series: 'Fixture ridge', title: false },
        { name: 'neither', photoId: P[1], slug: 'harbor', series: 'Fixture harbor', title: false },
        // Neither, and no description either: the technical toggle is the first block, and keeps its 44 px.
        { name: 'facts only', photoId: FACTS_ONLY, slug: 'facts', series: 'Fixture facts', title: false },
    ];
    for (const size of [
        { width: 1440, height: 900 },
        { width: 1366, height: 768 },
        { width: 1280, height: 800 },
        // A small tablet held upright, where the stage padding and the reading area's top padding both scale with the width.
        { width: 800, height: 1024, narrow: true },
        { width: 820, height: 1180, narrow: true },
    ]) {
        await page.setViewportSize({ width: size.width, height: size.height });
        const stages: unknown[] = [];
        for (const mix of mixes) {
            const at = `${size.width} by ${size.height}, ${mix.name}`;
            await page.goto(`${origin()}${href(mix.photoId, mix.slug)}`);
            await waitForHydration(page);
            await expect(header(page).getByRole('heading', { level: 1 })).toHaveAccessibleName(seriesHeading(mix.series));
            const line = await titleLine(page);
            const pieces = await foldPieces(page);
            // The facts-only photograph's reading area is its toggle alone.
            expect(pieces.length, `${at}: the reading area has pieces`).toBeGreaterThan(mix.photoId === FACTS_ONLY ? 0 : 1);
            expect(line.frame && line.reading && line.frame.bottom <= line.reading.top, `${at}: the photograph sits above the reading area`).toBe(true);
            // Nothing but running text is cut by the fold: no title, label, or control straddles the bottom edge.
            for (const piece of pieces) {
                if (piece.running) continue;
                const straddles = piece.top < line.innerHeight && piece.bottom > line.innerHeight;
                expect(straddles, `${at}: "${piece.text}" (${Math.round(piece.top)} to ${Math.round(piece.bottom)}) runs across the fold at ${line.innerHeight}`).toBe(false);
            }
            if (mix.title) {
                // The title line shows: the title, and the caption's first line when there is one, with the fold in the gap after it.
                expect(line.title && line.title.top >= 0 && line.title.bottom <= line.innerHeight, `${at}: the title shows`).toBe(true);
                if (mix.photoId === P[0]) {
                    expect(line.leadText).toBe('Fixture authored caption.');
                    expect(line.leadLineBottom, `${at}: the caption's first line shows`).toBeLessThanOrEqual(line.innerHeight);
                }
                // The fold falls in the gap after the title line: the caption's first line, or the title alone.
                const after = pieces[mix.photoId === P[0] ? 2 : 1];
                expect(after.top, `${at}: "${after.text}", after the title line, starts under the fold`).toBeGreaterThanOrEqual(line.innerHeight);
            } else {
                // No title (9a's fixed stage): the stage doesn't grow into the title line's room. The first block the
                // reading area shows takes that room instead, a caption or, with neither, the Description, and shows in
                // the first screen. Everything after it starts under the fold.
                expect(line.reading && line.reading.top, `${at}: the reading area starts on screen`).toBeLessThan(line.innerHeight);
                const first = Math.min(...pieces.map((piece) => piece.block));
                const shown = pieces.filter((piece) => piece.block === first);
                expect(shown.length, `${at}: the first block has pieces`).toBeGreaterThan(0);
                expect(shown[0].top, `${at}: "${shown[0].text}" shows`).toBeLessThan(line.innerHeight);
                for (const piece of shown) if (!piece.running) expect(piece.bottom, `${at}: "${piece.text}" shows whole`).toBeLessThanOrEqual(line.innerHeight);
                if (mix.photoId === FACTS_ONLY) {
                    expect(shown.map((piece) => piece.text), at).toEqual(['Show technical details']);
                    // The block takes the title line's height, and the button in it doesn't stretch to it.
                    expect(shown[0].bottom - shown[0].top, `${at}: the toggle keeps its height`).toBeCloseTo(44, 0);
                } else {
                    const rest = pieces.filter((piece) => piece.block !== first);
                    expect(rest.length, `${at}: the reading area has pieces after its first block`).toBeGreaterThan(0);
                    for (const piece of rest) expect(piece.top, `${at}: "${piece.text}" starts under the fold`).toBeGreaterThanOrEqual(line.innerHeight);
                }
            }
            // The photograph still holds the screen, where the screen is wider than it is tall.
            if (!size.narrow) expect(line.frame && line.frame.bottom - line.frame.top).toBeGreaterThan(line.innerHeight * 0.6);
            stages.push(line.stage);
        }
        // One stage for every mix, whatever the reading area holds.
        for (const stage of stages.slice(1)) expect(stage, `${size.width} by ${size.height}`).toEqual(stages[0]);
    }
});

test('on a wide screen under 40rem tall, a phone held sideways or a laptop at 150%, the photograph keeps the whole first screen', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'The wide layout.');
    for (const size of [
        { width: 844, height: 390 },
        { width: 915, height: 412 },
        { width: 960, height: 600 },
    ]) {
        await page.setViewportSize(size);
        await openViewer(page, P[0]);
        const line = await titleLine(page);
        // All the header (3.5rem) and the stage chrome (4rem) leave, with no room kept for the title line.
        expect(line.frame && line.frame.bottom - line.frame.top, `${size.width} by ${size.height}`).toBeCloseTo(size.height - 120, 0);
    }
});

test('on a phone, the stage takes the screen less a fixed reading allowance, with the photograph centered in it, and the reading area runs on to the foot of the page', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'The narrow layout.');
    await page.setViewportSize({ width: 390, height: 844 });
    const layouts = [];
    // A reading area with a title and a caption, and one with neither: different lengths, the same stage (9a).
    for (const photoId of [P[0], P[1]]) {
        await openViewer(page, photoId);
        layouts.push(
            await page.locator('[data-surface="viewer"]').evaluate((root) => {
                const rect = (selector: string) => {
                    const box = root.querySelector(selector)?.getBoundingClientRect();
                    return box ? { top: box.top + scrollY, bottom: box.bottom + scrollY, height: box.height } : null;
                };
                return {
                    innerHeight,
                    scrollHeight: document.documentElement.scrollHeight,
                    header: rect('header'),
                    stage: rect('[data-viewer-stage]'),
                    frame: rect('[data-viewer-stage] figure'),
                    next: rect('[data-viewer-step="next"]'),
                    reading: rect('section[aria-labelledby]'),
                };
            }),
        );
    }
    for (const layout of layouts) {
        const { stage, frame, reading, header: bar, next: arrow } = layout;
        expect(stage && frame && reading && bar && arrow, 'the pieces').toBeTruthy();
        if (!(stage && frame && reading && bar && arrow)) continue;
        // The header, the stage, the arrows' row, and the reading area's start fill the first screen, from the screen alone.
        // One row: the 44 px controls, the padding, and the accent rule. A second row would add another 44.
        expect(bar.height, 'the header keeps its one row').toBeLessThanOrEqual(60.5);
        expect(stage.height, 'the stage is the screen less the header, the arrows, and the allowance').toBeGreaterThan(layout.innerHeight * 0.6);
        expect(reading.top, 'the reading area starts in the first screen').toBeLessThan(layout.innerHeight);
        expect(reading.top, 'and keeps its allowance there').toBeLessThanOrEqual(layout.innerHeight - 80);
        expect(arrow.bottom).toBeLessThanOrEqual(reading.top);
        // The reading area runs on to the foot of the page, with no empty ground under it.
        expect(reading.bottom, 'the reading area reaches the foot of the page').toBeCloseTo(Math.max(layout.innerHeight, layout.scrollHeight), 0);
        const above = frame.top - stage.top;
        const below = stage.bottom - frame.bottom;
        // The stage keeps its top padding and none at the bottom, where the arrows' row sits.
        expect(Math.abs(above - below)).toBeLessThan(40);
        expect(below, 'the stage took the spare height').toBeGreaterThan(40);
    }
    expect(layouts[1].stage, 'the same stage for a long and a short reading area').toEqual(layouts[0].stage);
    expect(layouts[1].reading?.top).toBeCloseTo(layouts[0].reading?.top ?? NaN, 1);
});

test('the header\'s Close icon and Zoom label sit on the gutter Previous and Next line up on, with room for the focus ring', async ({ page }, testInfo) => {
    // As in the approved header, whose buttons have no inline padding: the icon and the label carry the edge, not the box.
    const size = testInfo.project.name === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 };
    await page.setViewportSize(size);
    await openViewer(page, P[1]);
    const edges = await page.locator('[data-surface="viewer"]').evaluate((root) => {
        const [close, zoom] = root.querySelectorAll('header > a, header > button');
        const text = document.createRange();
        const label = [...zoom.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
        if (label) text.selectNodeContents(label);
        const ring = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--focus-ring-width')) + parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--focus-ring-offset'));
        return {
            innerWidth: document.documentElement.clientWidth,
            ring,
            closeBox: close.getBoundingClientRect().left,
            closeIcon: close.querySelector('svg')!.getBoundingClientRect().left,
            zoomBox: zoom.getBoundingClientRect().right,
            zoomLabel: label ? text.getBoundingClientRect().right : NaN,
            previous: root.querySelector('[data-viewer-step="previous"]')!.getBoundingClientRect().left,
            next: root.querySelector('[data-viewer-step="next"]')!.getBoundingClientRect().right,
        };
    });
    expect(edges.closeIcon, 'Close\'s icon starts on the gutter').toBeCloseTo(edges.previous, 0);
    expect(edges.zoomLabel, 'Zoom\'s label ends on the gutter').toBeCloseTo(edges.next, 0);
    // The box keeps its padding inward, and the ring drawn outside it stays on screen.
    expect(edges.closeBox, 'Close\'s ring stays on screen').toBeGreaterThanOrEqual(edges.ring);
    expect(edges.innerWidth - edges.zoomBox, 'Zoom\'s ring stays on screen').toBeGreaterThanOrEqual(edges.ring);
});

test('the Viewer passes the #1 checks with its fixed chrome, at both scroll ends and at 320 px with 200% text, and its controls reflow', async ({ page }) => {
    await openViewer(page, P[1]);
    const controls = [close(page), zoom(page), previous(page), next(page), technical(page)];
    // No fixed element covers a control (#7): checked at the top of the page and scrolled to its end.
    for (const end of ['top', 'bottom'] as const) {
        await page.evaluate((to) => window.scrollTo(0, to === 'top' ? 0 : document.documentElement.scrollHeight), end);
        await checkSurface(page, { controls, chrome: await fixedChrome(page) });
    }
    await expectHoverRulesGated(page);
    await expectReflow(page.locator('[data-surface="viewer"] a, [data-surface="viewer"] button:not([disabled])'));

    // And at 320 px with 200% text, where the header wraps and the page scrolls most.
    await page.setViewportSize({ width: 320, height: 640 });
    await page.evaluate(() => document.documentElement.style.setProperty('font-size', '200%'));
    try {
        for (const end of ['top', 'bottom'] as const) {
            await page.evaluate((to) => window.scrollTo(0, to === 'top' ? 0 : document.documentElement.scrollHeight), end);
            await checkSurface(page, { controls, chrome: await fixedChrome(page) });
        }
    } finally {
        await page.evaluate(() => document.documentElement.style.removeProperty('font-size'));
    }
});

test('a screen reader hears the description once, from the image, on a direct load with and without a caption (bug 9)', async ({ page }) => {
    // P[0] has a caption, so the reading area shows only the caption. P[1] has none, so the reading area shows the
    // description too, hidden from a screen reader with its label.
    for (const [photoId, description] of [
        [P[0], 'Fixture description of the harbor.'],
        [P[1], 'Fixture description of photograph 0002.'],
    ] as const) {
        await openViewer(page, photoId);
        await expect(photograph(page)).toHaveAttribute('alt', description);
        const tree = await page.locator('body').ariaSnapshot();
        const lines = tree.split('\n').filter((line) => line.includes(description));
        expect(lines, photoId).toHaveLength(1);
        expect(lines[0], photoId).toMatch(new RegExp(`^\\s*- img "${description.replace(/[.]/g, '\\.')}"`));
        await expect(page.getByRole('main').getByText('Description', { exact: true }), photoId).toHaveCount(photoId === P[1] ? 1 : 0);
    }
});

test('Tab runs Close, Zoom, Previous, Next, and the technical toggle, and Enter and Space work on each', async ({ page }) => {
    await openViewer(page, P[1]);
    const names: string[] = [];
    for (let press = 0; press < 5; press++) {
        await page.keyboard.press('Tab');
        names.push(await page.evaluate(() => {
            const active = document.activeElement as HTMLElement | null;
            return active?.getAttribute('aria-label') ?? active?.textContent?.trim() ?? '';
        }));
    }
    expect(names).toEqual(['Close', 'Zoom', 'Previous photograph', 'Next photograph', 'Show technical details']);

    // The toggle keeps focus and opens with Enter, closes with Space.
    const toggle = technical(page);
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();

    await zoom(page).focus();
    await page.keyboard.press('Enter');
    await expect(zoom(page)).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Space');
    await expect(zoom(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(zoom(page)).toBeFocused();

    // Previous and Next are buttons (#9), so each moves with Enter and with Space, and keeps focus.
    await next(page).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${origin()}${href(P[2])}`);
    await expect(next(page)).toBeFocused();
    await previous(page).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${origin()}${href(P[1])}`);
    await expect(previous(page)).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page).toHaveURL(`${origin()}${href(P[0])}`);
    await expect(previous(page)).toBeFocused();
    await next(page).focus();
    await page.keyboard.press('Space');
    await expect(page).toHaveURL(`${origin()}${href(P[1])}`);
    await expect(next(page)).toBeFocused();
    await close(page).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${origin()}/work/harbor?photo=${P[1]}`);
});

test('the technical details open apart from the photograph, and the first photograph\'s facts are its allowlisted ones', async ({ page }) => {
    await openViewer(page, P[0]);
    const toggle = technical(page);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const panel = page.locator(`[id="${await toggle.getAttribute('aria-controls')}"]`);
    await expect(panel).toBeHidden();
    await toggle.click();
    await expect(panel).toBeVisible();
    // One Camera row, the make said once (the model starts with it), and each fact in its unit (#7).
    await expect(panel.locator('dt')).toHaveText(['Camera', 'Aperture', 'ISO']);
    await expect(panel.locator('dd')).toHaveText(['Fixture Model', 'f/2.8', '200']);
    const [image, facts] = await Promise.all([photograph(page).boundingBox(), panel.boundingBox()]);
    if (!image || !facts) throw new Error('No box');
    const overlap = Math.min(image.y + image.height, facts.y + facts.height) - Math.max(image.y, facts.y);
    expect(overlap, 'the panel never covers the photograph').toBeLessThanOrEqual(0);
});

test('one tap moves to the next photograph, and one tap opens the technical details', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch, 'Touch runs on the mobile project.');
    await openViewer(page, P[0]);
    await expectSingleTapActivates(next(page), () => expect(page).toHaveURL(`${origin()}${href(P[1])}`));
    await expect(header(page)).toContainText('02 / 03');
    await waitForHydration(page);
    await expectSingleTapActivates(technical(page), () => expect(technical(page)).toHaveAttribute('aria-expanded', 'true'));
});

test('share metadata names the photo and its series, on SITE_URL, with a /media share image', async ({ page }) => {
    await openViewer(page, P[0]);
    await expect(page).toHaveTitle('Fixture harbor at dusk, Fixture harbor · Keyur Golani Photography');
    const meta = (property: string) => page.locator(`meta[property="${property}"]`).getAttribute('content');
    expect(await page.locator('link[rel="canonical"]').getAttribute('href')).toBe(`${SITE_URL}${href(P[0])}`);
    expect(await meta('og:url')).toBe(`${SITE_URL}${href(P[0])}`);
    expect(await meta('og:title')).toBe('Fixture harbor at dusk, Fixture harbor · Keyur Golani Photography');
    expect(await page.locator('meta[name="description"]').getAttribute('content')).toBe('Fixture authored caption.');
    expect(await meta('og:image')).toMatch(new RegExp(`^${SITE_URL}/media/${P[0]}/sha256-[0-9a-f]{64}/p_[0-9a-f]+/w1200\\.webp$`));
    expect(await meta('og:image:alt')).toBe('Fixture description of the harbor.');
    // The revision the page came from, neither seen nor heard, for #12's freshness checks.
    await expect(page.locator('meta[name="catalog-revision"]')).toHaveCount(1);
    expect(await page.locator('meta[name="catalog-revision"]').getAttribute('content')).toMatch(/^rev_[0-9a-f]{64}$/);
});

test('a failed AVIF file retries once with WebP, and the photograph shows (#6)', async ({ page }) => {
    const asked: string[] = [];
    await page.route(`**/media/${P[0]}/**`, (route) => {
        const { pathname } = new URL(route.request().url());
        asked.push(pathname);
        return pathname.endsWith('.avif') ? route.fulfill({ status: 404, body: '' }) : route.continue();
    });
    await openViewer(page, P[0]);
    await expect.poll(() => photograph(page).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    expect(await photograph(page).evaluate((image: HTMLImageElement) => new URL(image.currentSrc).pathname)).toMatch(/\.webp$/);
    await expect(page.locator('[data-surface="viewer"] [data-photo="unavailable"]')).toHaveCount(0);
    // At most the head's preload and the image's one AVIF try, then WebP, and no AVIF request after the retry began.
    const firstWebp = asked.findIndex((path) => path.endsWith('.webp'));
    expect(firstWebp, 'the retry asked for WebP').toBeGreaterThanOrEqual(0);
    expect(asked.slice(0, firstWebp).filter((path) => path.endsWith('.avif')).length).toBeLessThanOrEqual(2);
    expect(asked.slice(firstWebp).filter((path) => path.endsWith('.avif')), 'no AVIF request after the retry').toEqual([]);
});

test('a failed photograph says so, keeps its alt, and Retry loads the same variant again (#7)', async ({ page }) => {
    let failing = true;
    const asked: string[] = [];
    await page.route(`**/media/${P[1]}/**`, (route) => {
        asked.push(new URL(route.request().url()).pathname);
        return failing ? route.fulfill({ status: 404, body: '' }) : route.continue();
    });
    await openViewer(page, P[1]);
    const missing = page.locator('[data-surface="viewer"] [data-photo="unavailable"]');
    await expect(missing).toContainText('This photograph could not be loaded.');
    await expect(missing).toContainText('Fixture description of photograph 0002.');
    // The failed box carries the alt, so the reading area's copy stays hidden: heard once (bug 9).
    const tree = await page.locator('body').ariaSnapshot();
    expect(tree.split('\n').filter((line) => line.includes('Fixture description of photograph 0002.'))).toHaveLength(1);
    // The same rung as the failed request, in WebP or AVIF.
    const rung = (path: string) => /\/(w\d+)\.(?:avif|webp)$/.exec(path)?.[1];
    const failedRung = rung(asked[asked.length - 1]);
    failing = false;
    const retry = missing.getByRole('button', { name: 'Retry' });
    await retry.focus();
    await retry.press('Enter');
    await expect.poll(() => photograph(page).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await expect(missing).toHaveCount(0);
    expect(rung(new URL(await photograph(page).evaluate((image: HTMLImageElement) => image.currentSrc)).pathname)).toBe(failedRung);
    // Focus stays in the Viewer, on the photograph's box, not dropped to the page.
    expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-viewer-current') ?? false)).toBe(true);
});

/** Each theme's Viewer (spec §3 and §5, R2-P1-1): its ground and ink, and whether it keeps today's bands. */
const VIEWER_THEMES = {
    // Dark is today's Viewer; Black the print alone on black (the OLED spec), with no bands and no surround.
    dark: { paints: 'dark', ground: 'rgb(17, 21, 19)', ink: 'rgb(246, 244, 238)', bands: true, surround: false },
    light: { paints: 'light', ground: 'rgb(235, 229, 217)', ink: 'rgb(41, 35, 29)', bands: false, surround: true },
    bright: { paints: 'bright', ground: 'rgb(255, 255, 255)', ink: 'rgb(11, 11, 11)', bands: false, surround: true },
    black: { paints: 'black', ground: 'rgb(0, 0, 0)', ink: 'rgb(245, 245, 245)', bands: false, surround: false },
} as const;

/** The checks every theme's Viewer takes, once it is open: its ground and ink, its bands or none, and its print. */
async function expectViewerTheme(page: Page, want: (typeof VIEWER_THEMES)[keyof typeof VIEWER_THEMES]) {
    await expect(page.locator('html')).toHaveAttribute('data-theme', want.paints);
    const colors = await page.locator('[data-surface="viewer"]').evaluate((root) => {
        const style = getComputedStyle(root);
        return { ground: style.backgroundColor, ink: style.color, accent: style.getPropertyValue('--cc-accent').trim() };
    });
    expect(colors).toEqual({ ground: want.ground, ink: want.ink, accent: '#c08040' });
    const bands = await page.locator('[data-surface="viewer"]').evaluate((root) => getComputedStyle(root).backgroundImage);
    if (want.bands) expect(bands, "today's bands").toMatch(/^linear-gradient\(/);
    // The root's background is the bands' layer over the ground's, so every layer is none.
    else expect(bands.split(',').map((layer) => layer.trim()), 'no bands').toEqual(bands.split(',').map(() => 'none'));
    // The body behind the root is the same ground, so an overscroll never shows the site's.
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(want.ground);
    // No theme control: the Viewer renders no SiteNav.
    await expect(page.getByRole('button', { name: /^Theme:/ })).toHaveCount(0);

    const look = await page.locator('[data-viewer-current]').first().evaluate((frame) => {
        const image = frame.querySelector('img')!;
        const viewport = frame.closest('[data-zoomed], [class*="viewport"]')!;
        // What the theme's surround resolves to at this width: lg, or md on a phone.
        const probe = document.createElement('div');
        probe.style.boxShadow = `var(${innerWidth < 640 ? '--gah-surround-md' : '--gah-surround-lg'}, none)`;
        // And the room the box keeps for it, resolved to px (a custom property computes to its unresolved calc()).
        probe.style.width = 'var(--viewer-room)';
        probe.style.position = 'absolute';
        frame.append(probe);
        const surround = getComputedStyle(probe).boxShadow;
        const room = parseFloat(getComputedStyle(probe).width);
        probe.remove();
        const [f, v] = [frame.getBoundingClientRect(), viewport.getBoundingClientRect()];
        return {
            // The <picture>'s sources carry the sizes (ResponsivePhoto); the <img> is its w1200 fallback.
            sizes: [...new Set([...frame.querySelectorAll('source')].map((source) => source.getAttribute('sizes')))].join(' | '),
            ratio: frame instanceof HTMLElement ? frame.style.getPropertyValue('--ratio') : '',
            shadow: getComputedStyle(frame).boxShadow,
            surround,
            outline: getComputedStyle(image).outlineStyle,
            outlineColor: getComputedStyle(image).outlineColor,
            fit: getComputedStyle(image).objectFit,
            room,
            clear: Math.min(f.left - v.left, v.right - f.right, f.top - v.top, v.bottom - f.bottom),
        };
    });
    // The first-viewport check (spec §8): the room the box reserves is at most 50 px, and the image's sizes is
    // fitSizes() of the record's shape alone, theme-blind, so no theme can ask for a larger rung than Dark.
    expect(2 * look.room, 'the reserved room is at most 50 px').toBeLessThanOrEqual(50);
    const [w, h] = look.ratio.split('/').map(Number);
    expect(look.sizes, "the sizes the record's shape implies, in every theme").toBe(fitSizes(w, h));
    if (want.bands) {
        expect(look.shadow, "Dark's print has no surround").toBe('none');
        expect(look.outline, "today's hairline").toBe('solid');
        expect(look.fit, "today's fit").toBe('fill');
        return;
    }
    // Every theme but Dark: the hairline is transparent, and a stale ratio letterboxes, never crops or stretches
    // (P3-6). On Black's black the letterbox is invisible.
    expect(look.outlineColor, 'no hairline').toBe('rgba(0, 0, 0, 0)');
    expect(look.fit, 'a stale ratio letterboxes').toBe('contain');
    // Forced colours drop any surround, so the transparent hairline takes a system colour and the print keeps an
    // edge, Black's bare print too.
    await page.emulateMedia({ forcedColors: 'active' });
    expect(await page.locator('[data-viewer-current] img').first().evaluate((image) => getComputedStyle(image).outlineColor), 'an edge in forced colours').not.toBe('rgba(0, 0, 0, 0)');
    await page.emulateMedia({ forcedColors: 'none' });
    if (!want.surround) {
        // Black: nothing round the print.
        expect(look.shadow, "Black's print has no surround").toBe('none');
        expect(look.room, 'no room reserved').toBe(0);
        return;
    }
    expect(look.shadow, "the theme's surround").toBe(look.surround);
    // Not by accident: md comes from styles/themes.css (#124), and without it both would read none.
    expect(look.shadow, 'a themed print always wears a surround').not.toBe('none');
    // The box leaves its surround's thickness and the clear ground on every side of the stage.
    expect(look.room, 'the room is reserved').toBeGreaterThan(0);
    expect(look.clear, 'the mat fits inside the stage').toBeGreaterThanOrEqual(look.room - 0.5);
    // Zoomed, the scroller would clip the surround, so the print goes bare (P3-7).
    await zoom(page).click();
    await expect(page.locator('[data-zoomed]')).toHaveCount(1);
    expect(await page.locator('[data-zoomed] figure').first().evaluate((frame) => getComputedStyle(frame).boxShadow)).toBe('none');
}

// Each theme at the project's own size (1280 on desktop, a phone on the mobile projects), and on the desktop project at
// 1024, lg above the 48rem rule, and 1440 (#126's Delta 1, M2').
const VIEWER_SIZES = [undefined, { width: 1024, height: 768 }, { width: 1440, height: 900 }] as const;

for (const [choice, want] of Object.entries(VIEWER_THEMES)) {
    for (const size of VIEWER_SIZES) {
        test(`the Viewer in ${choice}${size ? ` at ${size.width}` : ''}: its own ground under the body too, and ${want.bands ? "today's bands and a bare print with its hairline" : want.surround ? 'a matted print with room for its mat, bare when zoomed' : 'a bare print on black, with no hairline'}`, async ({ page }, testInfo) => {
            if (size) {
                test.skip(testInfo.project.name !== 'desktop', 'The set widths run on the desktop project.');
                await page.setViewportSize(size);
            }
            await page.addInitScript((value) => localStorage.setItem('theme', value), choice);
            await openViewer(page, P[0]);
            await expectViewerTheme(page, want);
        });
    }
}

// System, with nothing stored: Light's Viewer on a light device, and Dark's, today's, on a dark one.
for (const scheme of ['light', 'dark'] as const) {
    test(`the Viewer in System on a ${scheme} device, with nothing stored, is ${scheme === 'light' ? "Light's" : "Dark's, today's"}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await openViewer(page, P[0]);
        await expect(page.locator('html')).toHaveAttribute('data-theme-choice', 'system');
        await expectViewerTheme(page, VIEWER_THEMES[scheme]);
    });
}
