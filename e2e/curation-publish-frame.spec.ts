import { createPublishFixture, type PublishFixture } from '../test/helpers/publishFixture';
import { READY_TIMEOUT } from './support/catalogServer';
import { signIn, startCuratorServer, type CuratorServer } from './support/curatorServer';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';

// #16's Publish screen (16-3): the panel's frame opens the changed
// photograph's Viewer inside the preview, and loading it never scrolls the
// Publish page itself. Round 2 of the mockup showed a `#photo-` fragment did
// in Chromium, so the frame takes the Viewer, and this runs on WebKit too.
// Test values only.

const HOOK_TIMEOUT = READY_TIMEOUT + 90_000;

let fixture: PublishFixture | undefined;
let curator: CuratorServer | undefined;

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    fixture = await createPublishFixture();
    const base = Number(process.env.E2E_CURATION_PORT);
    const pinned = Number.isInteger(base) && base > 0 ? base + 2 * test.info().parallelIndex : undefined;
    curator = await startCuratorServer(fixture.root, pinned, { library: fixture.library });
});

test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await curator?.stop();
    await fixture?.cleanup();
});

test('the frame opens on the new photograph and leaves the Publish page where it was', async ({ page }) => {
    if (!curator) throw new Error('The curator server did not start');
    await signIn(page, curator.origin, curator.passphrase);
    await page.goto(`${curator.origin}/curation/publish`);
    await waitForHydration(page);
    const frame = page.frameLocator('iframe');
    await expect(frame.getByText('Breakwater, first light').first()).toBeVisible();
    await expect(page.locator('iframe')).toHaveAttribute('src', /\/curation\/preview\/rev_[0-9a-f]{64}\/site\/work\/low-tide-hours\/photo\/ph_/);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
