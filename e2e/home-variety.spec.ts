import type { Locator, Page } from '@playwright/test';
import type { TestCatalog } from '../lib/catalog/testing';
import { VARIETY_SERIES, VARIETY_UNFEATURED, varietyAltOf } from './support/catalog-home';
import { startCatalogServer, READY_TIMEOUT, type CatalogServer } from './support/catalogServer';
import { expectHomeImmersive } from './support/home';
import { publishHomeVarietyFixture } from './support/homeFixture';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';

// v1.5.0's Home: three featured series in one loop, starting on the one the
// server render picks. The pick is random in production; this spec's own
// `next start` sets PHOTOGRAPHY_TEST_HOME_PICK (test-only, read in
// lib/catalog/homePick.ts), so each load below starts on the exact series
// the script names, with nothing left to chance. The tests run in order on
// one server, and each document load of `/` takes the next index.

// Several full loads per test, each waiting for Home to settle immersive, as e2e/support/home.ts does.
test.describe.configure({ mode: 'serial', timeout: 120_000 });

/** Above the fixture, the publish, and a server start, so a slow start fails in startCatalogServer, which stops its child. */
const HOOK_TIMEOUT = READY_TIMEOUT + 60_000;
const INTERVAL = 12_000;

/** The scripted starts, one per load of `/` in the order the tests make them: 3, 1, 2, 2; then 1; then 2. */
const SCRIPT = '2,0,1,1,0,1';
const [ONE, TWO, THREE] = VARIETY_SERIES;

let catalog: TestCatalog | undefined;
let server: CatalogServer | undefined;

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    ({ catalog } = await publishHomeVarietyFixture());
    // E2E_CATALOG_PORT pins a port per worker, for a machine that hands out ranges. The config's
    // catalog Home server listens on E2E_CATALOG_PORT itself, so the workers start one above it.
    const base = Number(process.env.E2E_CATALOG_PORT);
    server = await startCatalogServer(catalog.root, Number.isInteger(base) && base > 0 ? base + 1 + test.info().parallelIndex : undefined, { env: { PHOTOGRAPHY_TEST_HOME_PICK: SCRIPT } });
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

type Series = (typeof VARIETY_SERIES)[number];

const heading = (page: Page) => page.getByRole('heading', { level: 1 });
const enter = (page: Page) => page.getByRole('link', { name: 'Enter the series', exact: true });
const next = (page: Page) => page.getByRole('button', { name: 'Next photograph', exact: true });
const previous = (page: Page) => page.getByRole('button', { name: 'Previous photograph', exact: true });
const position = (page: Page) => page.getByRole('group', { name: 'Slideshow' }).getByText(/^\d{2,} \/ \d{2,}$/);
const status = (page: Page) => page.locator('[data-chrome-region="sequence"] [role="status"]');
/** The carousel's visually hidden live region: Home's one announcement, the series' name only at a crossing (#4). */
const said = (page: Page) => page.locator('[data-home-carousel] > p[aria-live]');
const stage = (page: Page) => page.locator('[data-playback]');
const shownSlide = (page: Page) => page.locator('[data-photo-id][aria-hidden="false"]');
const pad = (n: number) => String(n).padStart(2, '0');
/** An attribute of one HTML tag, by its lowercase name, unescaped as far as the checks here need. */
const attribute = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'i'))?.[1]?.replaceAll('&amp;', '&');
const at = (series: Series, photoId: string) => `${pad((series.photoIds as readonly string[]).indexOf(photoId) + 1)} / ${pad(series.photoIds.length)}`;
/** What the carousel's live region says with `photoId` on screen: the slide and its description, after the series' name if it crossed. */
const line = (series: Series, photoId: string, { crossed = false } = {}) =>
    `${crossed ? `Now showing ${series.title}. ` : ''}${(series.photoIds as readonly string[]).indexOf(photoId) + 1} of ${series.photoIds.length}, ${varietyAltOf(photoId)}`;

/** Expects `photoId` of `series` on screen, loaded, with the chrome naming that series. */
async function expectOn(page: Page, series: Series, photoId: string) {
    await expect(shownSlide(page)).toHaveAttribute('data-photo-id', photoId);
    const image = shownSlide(page).locator('img');
    await expect(image).toHaveAttribute('alt', varietyAltOf(photoId));
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
    await expect(shownSlide(page)).toHaveCSS('opacity', '1');
    await expect(heading(page)).toHaveText(series.title);
    await expect(page.locator('[data-chrome-region="story"] p')).toHaveText(series.shortStatement);
    await expect(enter(page)).toHaveAttribute('href', `/work/${series.slug}`);
    await expect(position(page)).toHaveText(at(series, photoId));
}

/** One document load of `/`: its server HTML, then the hydrated page, which must agree on the series it starts on. */
async function load(page: Page, expected: Series) {
    const hydrationErrors: string[] = [];
    page.on('console', (message) => {
        if (message.type() === 'error' && /hydrat|did not match/i.test(message.text())) hydrationErrors.push(message.text());
    });
    const response = await page.goto(`${origin()}/`);
    const html = (await response?.text()) ?? '';
    // The server render picked the series: its title, its link, the opening photograph's slide, and the head's preload for it.
    expect(html).toContain(`>${expected.title}</h1>`);
    expect(html).toContain(`href="/work/${expected.slug}"`);
    expect(html).toContain(`data-photo-id="${expected.openingPhotoId}"`);
    const preloads = [...html.matchAll(/<link\b[^>]*>/g)]
        .map(([tag]) => tag)
        .filter((tag) => attribute(tag, 'rel') === 'preload' && attribute(tag, 'as') === 'image' && attribute(tag, 'imagesrcset')?.startsWith('/media/'));
    expect(preloads.map((tag) => attribute(tag, 'imagesrcset')?.split('/')[2])).toEqual([expected.openingPhotoId]);
    for (const other of VARIETY_SERIES.filter((series) => series.id !== expected.id)) expect(html).not.toContain(`>${other.title}</h1>`);
    expect(html).not.toContain(VARIETY_UNFEATURED.title);
    await waitForHydration(page);
    await expectHomeImmersive(page);
    await expectOn(page, expected, expected.openingPhotoId);
    expect(hydrationErrors).toEqual([]);
}

/** Presses `key` until `target` has focus, so the focus is keyboard focus. */
async function tabTo(page: Page, target: Locator, limit = 15) {
    for (let press = 0; press < limit; press++) {
        if (await target.evaluate((element) => element === document.activeElement)) return;
        await page.keyboard.press('Tab');
    }
    await expect(target).toBeFocused();
}

/** Lets React finish the work a step scheduled. Its scheduler posts messages, which the paused clock doesn't hold. */
const settle = (page: Page) =>
    page.evaluate(
        () =>
            new Promise<void>((resolve) => {
                let hops = 0;
                const channel = new MessageChannel();
                channel.port1.onmessage = () => (++hops < 3 ? channel.port2.postMessage(null) : resolve());
                channel.port2.postMessage(null);
            }),
    );

test('each load starts on the exact featured series the scripted pick names, on its own opening photograph', async ({ page }) => {
    for (const expected of [THREE, ONE, TWO, TWO]) await load(page, expected);
});

test('Next past a series\' last photograph shows the next series\' opening photograph, and the title, link and announcement change', async ({ page }) => {
    await load(page, ONE);
    // Keyboard focus in the chrome holds the slideshow, so only Next moves it.
    await tabTo(page, next(page));
    // One plays from its opening photograph, the second, to its last, then round to its first.
    for (const photoId of [ONE.photoIds[2], ONE.photoIds[0]]) {
        await page.keyboard.press('Enter');
        await expectOn(page, ONE, photoId);
    }
    await expect(said(page)).toHaveText(line(ONE, ONE.photoIds[0]));
    await expect(status(page)).toHaveText('');
    // One message at each crossing, in the carousel's polite region: the series' name, then the slide. The status
    // region keeps only failures.
    await page.keyboard.press('Enter');
    await expectOn(page, TWO, TWO.openingPhotoId);
    await expect(said(page)).toHaveAttribute('aria-live', 'polite');
    await expect(said(page)).toHaveText(line(TWO, TWO.openingPhotoId, { crossed: true }));
    await expect(status(page)).toHaveText('');
    await page.keyboard.press('Enter');
    await expectOn(page, TWO, TWO.photoIds[1]);
    await expect(said(page)).toHaveText(line(TWO, TWO.photoIds[1]));
    await page.keyboard.press('Enter');
    await expectOn(page, THREE, THREE.openingPhotoId);
    await expect(said(page)).toHaveText(line(THREE, THREE.openingPhotoId, { crossed: true }));
    await expect(status(page)).toHaveText('');
    // Previous steps back across the same boundary.
    await previous(page).focus();
    await page.keyboard.press('Enter');
    await expectOn(page, TWO, TWO.photoIds[1]);
    await expect(said(page)).toHaveText(line(TWO, TWO.photoIds[1], { crossed: true }));
    await expect(status(page)).toHaveText('');
    // Enter the series goes to the series on screen.
    await enter(page).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${origin()}/work/${TWO.slug}`);
});

test('under reduced motion nothing plays on its own, and Next still crosses into the next series', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await load(page, TWO);
    await expect(stage(page)).toHaveAttribute('data-playback', 'reduced-motion');
    await page.clock.install();
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
    await page.clock.runFor(INTERVAL * 3);
    await settle(page);
    await expect(shownSlide(page)).toHaveAttribute('data-photo-id', TWO.openingPhotoId);
    await expect(heading(page)).toHaveText(TWO.title);
    await page.clock.resume();
    await tabTo(page, next(page));
    await page.keyboard.press('Enter');
    await expectOn(page, TWO, TWO.photoIds[1]);
    await page.keyboard.press('Enter');
    await expectOn(page, THREE, THREE.openingPhotoId);
    await expect(stage(page)).toHaveAttribute('data-playback', 'reduced-motion');
});
