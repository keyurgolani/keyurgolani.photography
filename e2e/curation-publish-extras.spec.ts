import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { readRevisionFile } from '../lib/catalog/repository';
import { rollback } from '../lib/catalog/rollback';
import { readAuthoredRecord } from '../lib/catalog/working-layer';
import { createPublishFixture, fixBoth, publishFromCli, reopenBreakwater, SALT_ROADS, type PublishFixture } from '../test/helpers/publishFixture';
import { READY_TIMEOUT } from './support/catalogServer';
import { signIn, startCuratorServer, type CuratorServer } from './support/curatorServer';
import { waitForHydration } from './support/hydration';
import { checkSurface } from './support/surface';
import { expect, test } from './support/test';

// A9 (#182) on the Publish screen, against a real data root its own curator
// server serves, on both #1 projects: Use the published value from a stale
// order's row, the watch's stale announcement and "Base moved" with the
// page's clock run forward, the r1, r2, rollback walk of the revision
// numbers, and #1's checks with the new control on the screen. The data root
// is rebuilt before each test, so the server keeps running. Test values only.

const HOOK_TIMEOUT = READY_TIMEOUT + 90_000;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-publish-extras-'));
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };

let fixture: PublishFixture;
let curator: CuratorServer | undefined;

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    fixture = await createPublishFixture({ dir: DIR });
    const base = Number(process.env.E2E_CURATION_PORT);
    const pinned = Number.isInteger(base) && base > 0 ? base + 2 * test.info().parallelIndex : undefined;
    curator = await startCuratorServer(fixture.root, pinned, { library: fixture.library });
});

test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await curator?.stop();
    fs.rmSync(DIR, { recursive: true, force: true });
});

test.beforeEach(async () => {
    test.setTimeout(120_000);
    fixture = await createPublishFixture({ dir: DIR });
});

const origin = () => {
    if (!curator) throw new Error('The curator server did not start');
    return curator.origin;
};

async function open(page: Page): Promise<void> {
    await signIn(page, origin(), (curator as CuratorServer).passphrase);
    await page.goto(`${origin()}/curation/publish`);
    await waitForHydration(page);
}

const bar = (page: Page) => page.locator('main form[data-sticky-bar]');
const liveRegion = (page: Page) => page.locator('main > [role="status"]');
const named = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(': ', '\\s*: ')}$`);
const USE_ORDER = named('Use the published value: the order of Salt Roads');
const MOVED = 'Pier lamps moves from position 7 to 2 in Salt Roads';

test('puts the published order back from the stale row, says so where focus lands, and the row leaves the ledger', async ({ page }) => {
    await open(page);
    await expect(page.getByText(MOVED)).toBeVisible();
    await expect(page.getByText('This puts back the whole published order of Salt Roads.')).toBeVisible();
    await page.getByRole('button', { name: USE_ORDER }).click();
    const notice = page.locator('#reverted-notice');
    await expect(notice).toHaveText('The published order of Salt Roads is back in the draft. Validate again before you publish.');
    await expect(notice).toBeFocused();
    await expect(page.getByText(MOVED)).toHaveCount(0);
    const live = await readRevisionFile(fixture.root, fixture.revisions[1]);
    const record = await readAuthoredRecord(fixture.root, 'series', SALT_ROADS);
    expect(record?.kind === 'series' ? record.photoIds : null).toEqual(live?.content.series.find((series) => series.id === SALT_ROADS)?.photoIds);
});

test('announces a row that went stale after the page loaded, once a minute passes, in the one live region', async ({ page }) => {
    await page.clock.install();
    await open(page);
    await expect(liveRegion(page)).toHaveCount(1);
    await expect(liveRegion(page)).toHaveText('');
    await reopenBreakwater(fixture);
    await page.clock.fastForward(60_000);
    await expect(liveRegion(page)).toHaveText(/went stale after this page loaded: .*Breakwater, first light.*Load the updated ledger to review/);
    // Said once: the next minute's answer names nothing new, so the region keeps the same words.
    await page.clock.fastForward(60_000);
    await expect(liveRegion(page)).toHaveText(/went stale after this page loaded/);
});

test('says Base moved once another revision went live, and offers only Load the updated ledger', async ({ page }) => {
    await page.clock.install();
    await open(page);
    await fixBoth(fixture);
    await publishFromCli(fixture);
    await page.clock.fastForward(60_000);
    await expect(liveRegion(page)).toHaveText('Base moved. Revision 3 went live after this page loaded. Load the updated ledger.');
    await expect(page.getByText(/^Base moved\. Revision 3 went live after this page loaded, so this compares the draft against revision 2\.$/)).toBeVisible();
    await expect(page.getByText('Current public revision 3')).toBeVisible();
    await expect(bar(page).getByRole('link', { name: 'Load the updated ledger' })).toBeVisible();
    await expect(page.locator('main button[value="validate"]')).toHaveCount(0);
});

test('names the revisions through r1, r2 and a rollback to r1: revision 1 is live and the draft publishes as revision 3', async ({ page }) => {
    const [r1, r2] = fixture.revisions;
    const back = await rollback({ dataRoot: fixture.root, revisionId: r1, expectedActiveRevisionId: r2, actor: 'e2e', reason: 'the revision walk', logger: quiet });
    expect(back.outcome, back.message).toBe('ROLLED_BACK');
    await open(page);
    await expect(page.getByText('Current public revision 1')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Preview catalog revision 3');
    await expect(bar(page).locator('button[value="publish"]')).toHaveText('Publish revision 3');
});

test.describe('the #1 checks with Use the published value', () => {
    for (const [width, height] of [
        [1440, 900],
        [390, 844],
    ] as const) {
        test(`pass on the Publish screen at ${width} px`, async ({ page }) => {
            await page.setViewportSize({ width, height });
            await open(page);
            await checkSurface(page, {
                controls: [
                    page.getByRole('link', { name: /Open full preview/ }),
                    page.locator('main [id$="-open"]'),
                    page.getByRole('button', { name: /mark reviewed/ }),
                    page.getByRole('button', { name: USE_ORDER }),
                    bar(page).locator('button[value="validate"]'),
                    bar(page).locator('button[value="publish"]'),
                ],
                chrome: [bar(page)],
            });
        });
    }
});
