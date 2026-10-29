import { READY_TIMEOUT, startCatalogServer, type CatalogServer } from './support/catalogServer';
import { createCarryOverFixture, type CarryOverFixture } from './support/carry-over';
import { signIn, startCuratorServer, type CuratorServer } from './support/curatorServer';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';

// `photos carry-over` through to the visitor pages: a real library goes
// through the watcher, the carry-over, and the launch publish (see
// e2e/support/carry-over.ts), and then `web` shows today's photographs in
// one series, Gallery, on Home, Work, the series page and the Viewer, each
// named by its place exactly once. A photograph added after the launch is
// the only one the Inbox asks about.

test.describe.configure({ mode: 'serial' });

const HOOK_TIMEOUT = 2 * READY_TIMEOUT + 120_000;

let fixture: CarryOverFixture | undefined;
let web: CatalogServer | undefined;
let curator: CuratorServer | undefined;

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    fixture = await createCarryOverFixture();
    const base = Number(process.env.E2E_CURATION_PORT);
    const pinned = Number.isInteger(base) && base > 0 ? base + 2 * test.info().parallelIndex : undefined;
    web = await startCatalogServer(fixture.root, pinned, { library: fixture.library });
    curator = await startCuratorServer(fixture.root, pinned === undefined ? undefined : pinned + 1, { library: fixture.library });
});

test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await web?.stop();
    await curator?.stop();
    await fixture?.cleanup();
});

const data = () => {
    if (!fixture) throw new Error('The carry-over fixture was not made');
    return fixture;
};
const origin = () => {
    if (!web) throw new Error('The web server did not start');
    return web.origin;
};

test('the carry-over planned and published every photograph the legacy Gallery listed, with none gone', () => {
    expect(data().output.dryRun).toContain('Dry run: nothing was written.');
    expect(data().output.dryRun).toContain('"Photograph N of 12", and get no description');
    expect(data().output.dryRun).toMatch(/\n {2}10\. place-\d\d\.jpg \(ph_[^)]+\): "Photograph 10 of 12", no description yet/);
    expect(data().output.apply).toContain('Carried over: wrote 14 records.');
    expect(data().gone).toBe(0);
});

test('Home opens on Gallery, its photograph named by its place', async ({ page }) => {
    await page.goto(`${origin()}/`);
    await waitForHydration(page);
    await expect(page.getByRole('img', { name: 'Photograph 1 of 12', exact: true }).first()).toBeAttached();
    await expect(page.getByRole('img', { name: /, photograph \d+ of 12/i })).toHaveCount(0);
});

test('Work lists Gallery alone, with its title and count and no statement', async ({ page }) => {
    await page.goto(`${origin()}/work`);
    const items = page.getByRole('main').getByRole('listitem');
    await expect(items).toHaveCount(1);
    await expect(items.getByRole('heading', { level: 2 })).toHaveText('Gallery');
    await expect(items.locator('p')).toHaveText(['12 photographs']);
});

test('the series page has the h1 and the facts, no statement, and names each photograph by its place once', async ({ page }) => {
    await page.goto(`${origin()}/work/gallery`);
    await waitForHydration(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Gallery');
    // The header holds the h1 and the facts only: no statement block, so no empty band between them.
    await expect(page.locator('article > header > *')).toHaveCount(2);
    await expect(page.locator('article > header > section[aria-labelledby="series-facts"]')).toBeVisible();
    for (const [index] of data().order.entries()) {
        await expect(page.getByRole('link', { name: `Photograph ${index + 1} of 12`, exact: true })).toHaveCount(1);
    }
    await expect(page.getByRole('link', { name: /Photograph \d+ of 12, photograph/i })).toHaveCount(0);
});

test('the Viewer names the photograph once, as the legacy Gallery did, with no pending copy', async ({ page }) => {
    await page.goto(`${origin()}/work/gallery/photo/${data().order[10]}`);
    await waitForHydration(page);
    await expect(page.getByRole('img', { name: 'Photograph 11 of 12', exact: true })).toHaveCount(1);
    // The reading section's heading names an untitled photograph by its place too, as it does for any photograph
    // without a title. Every name in the tree says the place once: none repeats it, as a description would.
    const tree = await page.locator('body').ariaSnapshot();
    const lines = tree.split('\n').filter((line) => /Photograph 11 of 12/.test(line));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.match(/photograph 11 of 12/gi), line).toHaveLength(1);
    expect(tree).not.toMatch(/photograph 11 of 12, photograph/i);
    await expect(page.locator('[data-description="pending"]')).toHaveCount(0);
});

test('the Inbox asks only about the photograph added after the launch', async ({ page }) => {
    if (!curator) throw new Error('The curator server did not start');
    await signIn(page, curator.origin, curator.passphrase);
    await page.goto(`${curator.origin}/curation/inbox`);
    await waitForHydration(page);
    const list = page.getByRole('list', { name: 'Requires judgment' });
    await expect(list.getByRole('link')).toHaveCount(1);
    await expect(list.getByRole('link')).toContainText('later.jpg');
});
