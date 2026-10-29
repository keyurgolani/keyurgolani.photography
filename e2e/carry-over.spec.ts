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

test('the carry-over named what it could not carry, carried the rest, and only the photos accepted by name left the site', () => {
    expect(data().output.dryRunExit).toBe(1);
    expect(data().output.dryRun).toContain('Dry run: nothing was written.');
    expect(data().output.dryRun).toContain("Photos on the site today that can't carry over (2):");
    expect(data().output.dryRun).toMatch(/\n {2}unready\.jpg \(ph_[^)]+\): its catalog derivative set isn't ready yet\./);
    expect(data().output.dryRun).toContain('In the library but not on the site today, left as they are (1):');
    expect(data().output.dryRun).toMatch(/\n {2}broken\.jpg \(ph_[^)]+\): the watcher can't read it\./);
    expect(data().output.dryRun).toMatch(/\n {2}thumbless\.jpg \(ph_[^)]+\): its seven legacy derivatives aren't all built, so the Gallery doesn't show it today, though the site still counts it as on it\./);
    expect(data().output.dryRun).toContain('--apply refuses until then.');
    expect(data().output.apply).toContain('Accepted by name with --allow-missing, so they leave the site at the launch: thumbless.jpg, unready.jpg.');
    expect(data().output.apply).toContain('GONE_COUNT 2, all accepted by name');
    expect(data().output.dryRun).toContain('"Photograph N of 12", and get no description');
    expect(data().output.dryRun).toMatch(/\n {2}10\. place-\d\d\.jpg \(ph_[^)]+\): "Photograph 10 of 12", no description yet/);
    expect(data().output.apply).toContain('Carried over: wrote 14 records.');
    expect(data().gone).toBe(2);
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
    const tree = await page.locator('body').ariaSnapshot();
    // Named once, on the image: no header position, heading, or region says it again.
    const lines = tree.split('\n').filter((line) => /Photograph 11 of 12/i.test(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\s*- img "Photograph 11 of 12"/);
    await expect(page.getByRole('heading', { name: 'Photograph 11 of 12' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Photograph 11 of 12' })).toHaveCount(0);
    await expect(page.locator('[data-description="pending"]')).toHaveCount(0);
});

test('the Inbox asks about the photograph added after the launch and the ones not carried, never a carried one', async ({ page }) => {
    if (!curator) throw new Error('The curator server did not start');
    await signIn(page, curator.origin, curator.passphrase);
    await page.goto(`${curator.origin}/curation/inbox`);
    await waitForHydration(page);
    const list = page.getByRole('list', { name: 'Requires judgment' });
    // later.jpg came after the launch. unready.jpg and thumbless.jpg were accepted by name, and broken.jpg wasn't on the
    // site, so the carry-over left their items as they were.
    await expect(list.getByRole('link').filter({ hasText: 'later.jpg' })).toHaveCount(1);
    for (const name of ['unready.jpg', 'thumbless.jpg', 'broken.jpg']) await expect(list.getByRole('link').filter({ hasText: name })).not.toHaveCount(0);
    await expect(list.getByRole('link').filter({ hasText: /place-\d\d\.jpg/ })).toHaveCount(0);
});
