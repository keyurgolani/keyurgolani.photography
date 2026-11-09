import type { TestCatalog } from '../lib/catalog/testing';
import { startCatalogServer, READY_TIMEOUT, type CatalogServer } from './support/catalogServer';
import { publishEmptyHomeFixture } from './support/homeFixture';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';

// #4's empty state in the browser: a revision with nothing featured, which
// publish() refuses, so publishEmptyHomeFixture() writes it with #13's
// writers. Its own `next start`, since the config's catalog server serves a
// featured series.

test.describe.configure({ mode: 'serial' });

const HOOK_TIMEOUT = READY_TIMEOUT + 60_000;

let catalog: TestCatalog | undefined;
let server: CatalogServer | undefined;
let revisionId = '';

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    ({ catalog, revisionId } = await publishEmptyHomeFixture());
    // Above the ports home-variety.spec.ts and first-viewport.spec.ts take when E2E_CATALOG_PORT pins them.
    const base = Number(process.env.E2E_CATALOG_PORT);
    server = await startCatalogServer(catalog.root, Number.isInteger(base) && base > 0 ? base + 20 + test.info().parallelIndex : undefined);
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

test('with nothing featured, Home is the empty state: its one heading, the navigation up, no intro and no photograph', async ({ page }) => {
    await page.goto(`${origin()}/`);
    await waitForHydration(page);
    const main = page.locator('main');
    await expect(page.locator('[data-home-state]')).toHaveAttribute('data-home-state', 'empty');
    await expect(main).toHaveAttribute('data-catalog-revision', revisionId);
    await expect(main).toHaveAttribute('data-home-intro', 'settled');
    await expect(main).toHaveAttribute('data-home-loading', 'false');
    await expect(main).toHaveAttribute('data-chrome-holds', /\bno-photo\b/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nothing is featured right now.');
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.locator('img[src^="/media/"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Next photograph' })).toHaveCount(0);
});
