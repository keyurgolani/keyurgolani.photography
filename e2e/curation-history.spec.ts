import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { listActivations } from '../lib/catalog/repository';
import { readActivePointer } from '../lib/catalog/working-layer';
import {
    createHistoryFixture,
    createPublishFixture,
    editBehindThePage,
    fixBoth,
    holdCatalogLock,
    publishFromCli,
    SALT_ROADS_IDS,
    SALT_ROADS_TITLES,
    setAssetsAside,
    type PublishFixture,
} from '../test/helpers/publishFixture';
import { startCatalogServer, READY_TIMEOUT, type CatalogServer } from './support/catalogServer';
import { signIn, startCuratorServer, type CuratorServer } from './support/curatorServer';
import { waitForHydration } from './support/hydration';
import { checkSurface } from './support/surface';
import { expect, test } from './support/test';

// #15's 15-4: History and restore on #16's Publish screen, on both #1
// projects, against a real data root its own curator server serves. Each
// test rebuilds the data root in place: the History fixture (revisions 1 to
// 3, nothing pending) or 16-3's (revision 2 live and a draft). The walk:
// anonymous denial that replays the restore action itself; restore done;
// refused by today's checks; changed under you; lock held; a restore while
// a draft is pending, with its conflict in the ledger; History following a
// publish from this screen, paused while it waits; the dialog's keyboard and
// focus; no JavaScript; and #1's checks. Test values only.

const HOOK_TIMEOUT = 2 * READY_TIMEOUT + 90_000;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-history-'));

let fixture: PublishFixture;
let curator: CuratorServer | undefined;
let web: CatalogServer | undefined;

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    fixture = await createHistoryFixture({ dir: DIR });
    // E2E_CURATION_PORT pins two ports per worker. Spec files run in turn on a worker, so this one reuses the Publish spec's pair.
    const base = Number(process.env.E2E_CURATION_PORT);
    const pinned = Number.isInteger(base) && base > 0 ? base + 2 * test.info().parallelIndex : undefined;
    curator = await startCuratorServer(fixture.root, pinned, { library: fixture.library });
    web = await startCatalogServer(fixture.root, pinned === undefined ? undefined : pinned + 1, { library: fixture.library });
});

test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await curator?.stop();
    await web?.stop();
    fs.rmSync(DIR, { recursive: true, force: true });
});

test.beforeEach(async () => {
    test.setTimeout(120_000);
    fixture = await createHistoryFixture({ dir: DIR });
});

const origin = () => {
    if (!curator) throw new Error('The curator server did not start');
    return curator.origin;
};

async function open(page: Page, query = ''): Promise<void> {
    await signIn(page, origin(), (curator as CuratorServer).passphrase);
    await page.goto(`${origin()}/curation/publish${query}`);
    await waitForHydration(page);
}

const dialog = (page: Page) => page.locator('dialog#restore-dialog');
const restoreLink = (page: Page, revision: number) => page.locator('#history').getByRole('link', { name: `Restore revision ${revision}`, exact: true });
const submit = (page: Page) => page.locator('#restore-submit');
const answer = (page: Page) => page.locator('#restore-result-heading');

/** Open revision N's dialog from its entry, and check it opened as a modal with focus on its heading. */
async function openDialog(page: Page, revision: number): Promise<void> {
    await restoreLink(page, revision).click();
    await expect(page.locator('#restore-heading')).toBeFocused();
    await expect(page.locator('#restore-heading')).toHaveText(`Restore revision ${revision}?`);
    expect(await dialog(page).evaluate((element) => element.matches(':modal'))).toBe(true);
}

async function confirm(page: Page, reason = 'The new order reads wrong.'): Promise<void> {
    await page.locator('#restore-reason').fill(reason);
    await submit(page).click();
}

/** The answer's whole box sits inside the dialog body's visible part, above the actions. */
async function expectAnswerInView(page: Page): Promise<void> {
    const box = await page.locator('#restore-result').boundingBox();
    const bar = await dialog(page).locator('form > div').last().boundingBox();
    const viewport = page.viewportSize();
    if (!box || !bar || !viewport) throw new Error('No layout');
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(bar.y + 1);
}

test('anonymous requests get the boundary, the restore action itself included, and nothing is written', async ({ page, request }) => {
    const anonymous = await request.get(`${origin()}/curation/publish`, { maxRedirects: 0 });
    expect([302, 303, 307, 404]).toContain(anonymous.status());
    expect(await anonymous.text()).not.toContain('Restore revision');
    // Capture the post the dialog sends, with its action ID, from a signed-in page, and stop it there.
    await open(page);
    await openDialog(page, 2);
    let captured: { headers: Record<string, string>; body: Buffer } | null = null;
    await page.route(`${origin()}/curation/publish**`, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        captured = { headers: route.request().headers(), body: route.request().postDataBuffer() ?? Buffer.alloc(0) };
        await route.abort();
    });
    await confirm(page);
    await expect.poll(() => captured).not.toBeNull();
    const sent = captured as unknown as { headers: Record<string, string>; body: Buffer };
    expect(sent.headers['next-action']).toBeTruthy();
    const before = (await listActivations(fixture.root)).length;
    // The same action, replayed without the session: the boundary refuses it before it runs.
    const replay = await request.post(`${origin()}/curation/publish`, {
        headers: { 'next-action': sent.headers['next-action'], 'content-type': sent.headers['content-type'], origin: origin(), accept: 'text/x-component' },
        data: sent.body,
        maxRedirects: 0,
    });
    expect([401, 403, 404]).toContain(replay.status());
    // And with the session, from another site.
    const foreign = await page.request.post(`${origin()}/curation/publish`, {
        headers: { 'next-action': sent.headers['next-action'], 'content-type': sent.headers['content-type'], origin: 'https://attacker.example', accept: 'text/x-component' },
        data: sent.body,
        maxRedirects: 0,
    });
    expect([403, 404]).toContain(foreign.status());
    expect((await listActivations(fixture.root)).length).toBe(before);
    expect((await readActivePointer(fixture.root))?.revisionId).toBe((fixture as PublishFixture & { live: string }).live);
});

test('restores: the done notice takes focus on the page that loads, the new entry is live, and the replaced one can come back', async ({ page }) => {
    await open(page);
    await expect(page.locator('#history h3').first()).toHaveText('Revision 3');
    await openDialog(page, 2);
    await expect(dialog(page).getByText('Visitors see revision 3 now.', { exact: false })).toBeVisible();
    await expect(dialog(page).locator('dt', { hasText: 'Live now' })).toBeVisible();
    await confirm(page);
    await page.waitForURL(/\?restored=4#history-result-heading$/);
    await expect(page.locator('#history-result-heading')).toHaveText('Revision 2 is live again');
    await expect(page.locator('#history-result-heading')).toBeFocused();
    const [, r2] = fixture.revisions;
    expect((await readActivePointer(fixture.root))?.revisionId).toBe(r2);
    await expect(page.locator('#entry-4-title')).toHaveText('Revision 2');
    await expect(page.locator('#entry-4').getByText('“The new order reads wrong.”')).toBeVisible();
    await expect(restoreLink(page, 3)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nothing to publish');
    await expect(page.getByText('Revision 3 is kept. Restore it from History, below.')).toBeVisible();
});

test("refuses a revision today's checks refuse, with the reason in view and the way to the updated list", async ({ page }) => {
    await open(page);
    await openDialog(page, 2);
    const [, r2] = fixture.revisions;
    const undo = await setAssetsAside(fixture, r2, SALT_ROADS_IDS[3]);
    try {
        await confirm(page);
        await expect(answer(page)).toHaveText("Revision 2 can't come back");
        await expect(answer(page)).toBeFocused();
        await expect(dialog(page).getByText(`1 of its photographs no longer has its image files: ${SALT_ROADS_TITLES[3]}.`)).toBeVisible();
        await expectAnswerInView(page);
        await expect(dialog(page).getByRole('link', { name: 'Load the updated page' })).toBeVisible();
    } finally {
        undo();
    }
});

test('says what went live while the dialog was open, with the facts it was opened against, and restores nothing', async ({ page }) => {
    await open(page);
    await openDialog(page, 2);
    await editBehindThePage(fixture);
    await publishFromCli(fixture);
    const before = (await listActivations(fixture.root)).length;
    await confirm(page);
    await expect(answer(page)).toHaveText('Revision 4 went live while this was open');
    await expect(answer(page)).toBeFocused();
    await expectAnswerInView(page);
    await expect(dialog(page).getByText('keyur published it at', { exact: false })).toBeVisible();
    await expect(dialog(page).getByText('This page loaded while revision 3 was live.')).toBeVisible();
    await expect(dialog(page).locator('dt', { hasText: 'Live when you opened this' })).toBeVisible();
    await expect(dialog(page).getByText('What it would have changed, against revision 3')).toBeVisible();
    await expect(dialog(page).getByRole('link', { name: 'Load the updated page' })).toBeVisible();
    await expect(dialog(page).getByRole('link', { name: 'Close and reload' })).toHaveCount(0);
    await expect(page.locator('#restore-reason')).toHaveAttribute('readonly', '');
    expect((await listActivations(fixture.root)).length).toBe(before);
});

test('answers lock held at once, keeps the reason, and Restore is the retry', async ({ page }) => {
    await open(page);
    await openDialog(page, 2);
    const release = await holdCatalogLock(fixture);
    try {
        await confirm(page, 'Hold on.');
        await expect(answer(page)).toHaveText('Another publish or restore is running');
        await expect(dialog(page).getByText(/Nothing changed, and revision 3 stays live\./)).toBeVisible();
        await expect(page.locator('#restore-reason')).toHaveValue('Hold on.');
        await expect(submit(page)).toHaveText('Restore revision 2');
    } finally {
        await release();
    }
    await submit(page).click();
    await page.waitForURL(/\?restored=\d+/);
    await expect(page.locator('#history-result-heading')).toHaveText('Revision 2 is live again');
});

test('restores with a draft pending: the dialog warns, the draft stays, and the done notice leads to the conflict', async ({ page }) => {
    fixture = await createPublishFixture({ dir: DIR });
    await open(page);
    await openDialog(page, 1);
    await expect(dialog(page).getByText(/^Your draft stays, and this screen then compares it against revision 1\./)).toBeVisible();
    await confirm(page);
    await page.waitForURL(/\?restored=\d+/);
    await expect(page.locator('#history-result-heading')).toHaveText('Revision 1 is live again');
    await expect(page.getByText(/in your draft clash(es)? with revision 1\./)).toBeVisible();
    await page.getByRole('link', { name: 'Go to the change: Salt Roads' }).click();
    const row = page.locator('li', { has: page.locator('p[id$="-summary"]:focus') });
    await expect(row.getByText('Conflicts with the live revision')).toBeVisible();
    await expect(row.getByText('Blocks publishing')).toBeVisible();
    await expect(row.getByText('photos edit', { exact: false })).toBeVisible();
});

test('follows a publish from this screen: Restore waits while it runs, then the new revision is live with no Restore', async ({ page }) => {
    fixture = await createPublishFixture({ dir: DIR });
    await fixBoth(fixture);
    await open(page);
    const bar = page.locator('main form[data-sticky-bar]');
    await bar.locator('button[value="validate"]').click();
    await expect(page.locator('#result-heading')).toHaveText('Catalog revision is valid');
    // Hold the publish in flight long enough to see History pause.
    await page.route(`${origin()}/curation/publish**`, async (route) => {
        if (route.request().method() === 'POST') await new Promise((resolve) => setTimeout(resolve, 2500));
        await route.continue();
    });
    await bar.locator('button[value="publish"]').click();
    await expect(restoreLink(page, 1)).toHaveAttribute('aria-disabled', 'true');
    await expect(restoreLink(page, 1)).toHaveAttribute('aria-describedby', 'history-paused');
    await expect(page.locator('#history-paused')).toHaveText('Restore waits until this publish answers.');
    await expect(page.locator('#result-heading')).toHaveText('Revision 3 published atomically');
    await expect(page.locator('#history-paused')).toHaveCount(0);
    await expect(page.locator('#history h3').first()).toHaveText('Revision 3');
    await expect(page.locator('#history li').first().getByText('Live now')).toBeVisible();
    await expect(restoreLink(page, 3)).toHaveCount(0);
    await expect(restoreLink(page, 2)).toBeVisible();
    await expect(page.getByText('Revision 2 is kept. Restore it from History, below.')).toBeVisible();
});

test('the dialog by keyboard: focus on its heading, Tab stays out of the page, an empty reason, Escape returns focus', async ({ page }) => {
    await open(page);
    await restoreLink(page, 2).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#restore-heading')).toBeFocused();
    for (let i = 0; i < 10; i++) {
        await page.keyboard.press('Tab');
        // Inside the dialog, or out to the browser's own controls (body), never on the page behind it.
        expect(await page.evaluate(() => document.activeElement === document.body || Boolean(document.querySelector('dialog[open]')?.contains(document.activeElement)))).toBe(true);
    }
    await submit(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#restore-reason')).toBeFocused();
    await expect(page.locator('#restore-reason')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText("Say why in a few words. It's saved with the entry.")).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(restoreLink(page, 2)).toBeFocused();
    // The one live region in main, and none left behind by the dialog.
    await expect(page.locator('main > [role="status"]')).toHaveCount(1);
    await expect(page.locator('[role="status"]')).toHaveCount(1);
    // The panel's line jumps to History and takes focus there.
    await page.getByRole('link', { name: 'History, below' }).click();
    await expect(page.locator('#history-heading')).toBeFocused();
});

test.describe('without JavaScript', () => {
    test('reads History, opens the dialog from its link, and a post is refused with nothing written', async ({ page: signedIn, browser }) => {
        await signIn(signedIn, origin(), (curator as CuratorServer).passphrase);
        const context = await browser.newContext({ javaScriptEnabled: false, storageState: await signedIn.context().storageState() });
        const page = await context.newPage();
        await page.goto(`${origin()}/curation/publish`);
        await expect(page.locator('#history h3').first()).toHaveText('Revision 3');
        await restoreLink(page, 2).click();
        await expect(page).toHaveURL(/\?restore=2#restore-heading$/);
        await expect(page.locator('#restore-heading')).toHaveText('Restore revision 2?');
        await page.locator('#restore-reason').fill('No script.');
        const before = (await listActivations(fixture.root)).length;
        const posted = page.waitForResponse((response) => response.request().method() === 'POST');
        await submit(page).click();
        expect((await posted).status()).toBe(403);
        expect((await listActivations(fixture.root)).length).toBe(before);
        await context.close();
    });
});

test.describe('the #1 checks', () => {
    for (const [width, height] of [
        [1440, 900],
        [390, 844],
    ] as const) {
        test(`pass on History and on the dialog at ${width} px`, async ({ page }) => {
            await page.setViewportSize({ width, height });
            await open(page);
            await checkSurface(page, { controls: [page.locator('#history a[id^="restore-"]')] });
            await restoreLink(page, 1).focus();
            await page.keyboard.press('Enter');
            await expect(page.locator('#restore-heading')).toBeFocused();
            await checkSurface(page, { controls: [dialog(page).getByRole('button', { name: 'Cancel' }), submit(page)] });
        });
    }
});
