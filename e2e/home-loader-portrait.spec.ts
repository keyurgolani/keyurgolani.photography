import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { HOME_LOADING_TIMEOUT_MS } from '../components/home/homeChromeConfig';
import type { TestCatalog } from '../lib/catalog/testing';
import { startCatalogServer, READY_TIMEOUT, type CatalogServer } from './support/catalogServer';
import { expectHomeImmersive } from './support/home';
import { publishHomeFixture } from './support/homeFixture';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';

// Home's intro when About's portrait isn't there: missing when Home renders,
// or taken away while the server runs, so the URL Home was given answers 404.
// Either way the intro plays without a portrait and settles within Home's
// 6 s loading bound, onto the photograph, with no badge and no broken image.
// The harness's servers share one site config folder that the other specs
// need, so this spec serves the catalog Home fixture from a second
// `next start` with a site config folder of its own, and moves its portrait
// aside and back.

test.describe.configure({ mode: 'serial' });

/** Above the fixture, the publish, and a server start, so a slow start fails in startCatalogServer, which stops its child. */
const HOOK_TIMEOUT = READY_TIMEOUT + 60_000;
/** Timer lateness on a busy CI runner. The bound itself is measured from Home's hydration, which comes after the intro mounts. */
const SLACK_MS = 500;

let siteConfig: string | undefined;
let catalog: TestCatalog | undefined;
let server: CatalogServer | undefined;

const about = () => path.join(siteConfig!, 'about');
const aside = () => path.join(siteConfig!, 'about-aside');
/** Takes the portrait away, as an owner removing the file on the host does: the reader stats the folder per request. */
const removePortrait = () => fs.renameSync(about(), aside());
const restorePortrait = () => {
    if (fs.existsSync(aside())) fs.renameSync(aside(), about());
};

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    const shared = process.env.E2E_SITE_CONFIG_DIR;
    if (!shared) throw new Error('playwright.config.ts sets E2E_SITE_CONFIG_DIR and writes the stand-in portrait there');
    // The stand-in portrait the harness wrote, in a folder only this spec's server reads.
    siteConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-site-config-home-'));
    fs.cpSync(path.join(shared, 'about'), about(), { recursive: true });
    ({ catalog } = await publishHomeFixture());
    // E2E_CATALOG_PORT pins a port per worker, for a machine that hands out ranges. The config's
    // catalog Home server listens on E2E_CATALOG_PORT itself, so the workers start one above it.
    const base = Number(process.env.E2E_CATALOG_PORT);
    server = await startCatalogServer(catalog.root, Number.isInteger(base) && base > 0 ? base + 1 + test.info().parallelIndex : undefined, { siteConfig });
});

test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await server?.stop();
    await catalog?.cleanup();
    if (siteConfig) fs.rmSync(siteConfig, { recursive: true, force: true });
});

test.afterEach(() => restorePortrait());

const origin = () => {
    if (!server) throw new Error('The catalog server did not start');
    return server.origin;
};

const main = (page: Page) => page.locator('main[data-interface-state]');

/** Records, on the page's own clock, when React hydrated Home, every intro phase Home reported, and when it settled. */
async function recordIntro(page: Page) {
    await page.addInitScript(() => {
        const record = { hydrated: null as number | null, settled: null as number | null, phases: [] as string[] };
        (window as unknown as { __intro: typeof record }).__intro = record;
        new MutationObserver(() => {
            if (record.hydrated === null && document.documentElement.hasAttribute('data-hydrated')) record.hydrated = performance.now();
            const phase = document.querySelector('main[data-home-intro]')?.getAttribute('data-home-intro');
            if (phase && record.phases.at(-1) !== phase) record.phases.push(phase);
            if (phase === 'settled' && record.settled === null) record.settled = performance.now();
        }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-hydrated', 'data-home-intro'] });
    });
}

/** The intro played and settled within Home's loading bound, onto the photograph, with no badge and no broken image. */
async function expectSettledWithinBound(page: Page) {
    await expect(main(page)).toHaveAttribute('data-home-intro', 'settled', { timeout: HOME_LOADING_TIMEOUT_MS + SLACK_MS });
    const intro = await page.evaluate(() => (window as unknown as { __intro: { hydrated: number | null; settled: number | null; phases: string[] } }).__intro);
    expect(intro.phases[0], 'the intro played').toBe('loading');
    expect(intro.hydrated).not.toBeNull();
    expect(intro.settled! - intro.hydrated!, 'ms from hydration to settled').toBeLessThanOrEqual(HOME_LOADING_TIMEOUT_MS + SLACK_MS);
    await expect(page.locator('[class*="grainOverlay"]')).toHaveCount(0);
    await expectHomeImmersive(page);
    await expect(page.locator('[data-home-badge]')).toHaveCount(0);
    const broken = await page.locator('main img').evaluateAll((images) => images.filter((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth === 0).length);
    expect(broken, 'broken images').toBe(0);
}

test('with no portrait when Home renders, the intro plays without one and settles within the loading bound', async ({ page }) => {
    removePortrait();
    await recordIntro(page);
    const portraitRequests: string[] = [];
    page.on('request', (request) => {
        if (new URL(request.url()).pathname.startsWith('/about/portrait/')) portraitRequests.push(request.url());
    });
    await page.goto(`${origin()}/`);
    await waitForHydration(page);
    await expect(page.locator('[class*="portrait"]')).toHaveCount(0);
    await expectSettledWithinBound(page);
    expect(portraitRequests, 'Home asks for no portrait it was never given').toEqual([]);
});

test('with the portrait removed while the server runs, its URL answers 404 and the intro still settles within the loading bound', async ({ page }) => {
    await recordIntro(page);
    // Home renders with the portrait, then its file goes before the browser fetches it.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const statuses: number[] = [];
    await page.route('**/about/portrait/**', async (route) => {
        await held;
        const response = await route.fetch();
        statuses.push(response.status());
        await route.fulfill({ response });
    });
    // The held portrait holds the load event, so this waits for the document alone.
    await page.goto(`${origin()}/`, { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await expect(main(page)).toHaveAttribute('data-home-intro', 'loading');
    await expect(page.locator('[class*="portrait"]')).toHaveCount(1);
    removePortrait();
    release();
    await expect.poll(() => statuses.length).toBeGreaterThan(0);
    expect(statuses.every((status) => status === 404), `the portrait's answers: ${statuses.join(', ')}`).toBe(true);
    await expect(page.locator('[class*="portrait"]')).toHaveCount(0);
    await expectSettledWithinBound(page);
});
