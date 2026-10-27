import { BREAKWATER, createPublishFixture, type PublishFixture } from '../test/helpers/publishFixture';
import { READY_TIMEOUT } from './support/catalogServer';
import { signIn, startCuratorServer, type CuratorServer } from './support/curatorServer';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';

// #16's Publish screen (16-3): the panel's frame opens the most affected
// series page inside the preview and scrolls its own window to the changed
// photograph, and loading it never scrolls the Publish page itself. Round 2
// of the mockup showed a `#photo-` fragment did in Chromium, and the Viewer
// brought its own Close and Zoom into an inert frame, so the frame scrolls
// itself. This runs on WebKit too. Test values only.

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
    // The series page, not the Viewer, which would bring its own Close and Zoom that the inert frame can't use.
    await expect(page.locator('iframe')).toHaveAttribute('src', /\/curation\/preview\/rev_[0-9a-f]{64}\/site\/work\/low-tide-hours$/);
    // The frame's own window comes to rest on the new photograph's entry.
    const settled = async () => {
        const frame = page.frames().find((entry) => entry !== page.mainFrame());
        return (
            (await frame?.evaluate((id) => {
                const entry = document.getElementById(id);
                if (!entry) return false;
                const { top } = entry.getBoundingClientRect();
                return window.scrollY > 0 && top >= 0 && top < window.innerHeight;
            }, `photo-${BREAKWATER}`)) ?? false
        );
    };
    await expect.poll(settled).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
