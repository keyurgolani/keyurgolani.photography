import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { readActivePointer } from '../lib/catalog/working-layer';
import {
    blockRevisionFile,
    BREAKWATER_TITLE,
    createPublishFixture,
    editBehindThePage,
    fixBoth,
    holdCatalogLock,
    publishFromCli,
    reopenBreakwater,
    type PublishFixture,
} from '../test/helpers/publishFixture';
import { startCatalogServer, READY_TIMEOUT, type CatalogServer } from './support/catalogServer';
import { signIn, startCuratorServer, type CuratorServer } from './support/curatorServer';
import { waitForHydration } from './support/hydration';
import { checkSurface } from './support/surface';
import { expect, test } from './support/test';

// #16's Publish screen (16-3) on both #1 projects, against a real data root
// its own curator server serves: revision 2 is live, and the draft holds a
// suggested description nobody has reviewed and a stale review of an order.
// Each test rebuilds the data root in place, so the servers keep running.
// The walk: anonymous denial, blocked with its keyboard order, a fix from a
// row, validate then publish with `/` serving the new revision, blocked at
// publish, changed meanwhile, someone else published, already live, busy,
// failed, one live region, focus after each answer, no JavaScript, and #1's
// checks. Test values only; the passphrase is the harness's, never printed.

// Each worker builds its own data root and servers in beforeAll, and every test rebuilds the data root first, so the
// tests stand alone: one that fails doesn't skip the rest.

const HOOK_TIMEOUT = 2 * READY_TIMEOUT + 90_000;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-publish-'));

let fixture: PublishFixture;
let curator: CuratorServer | undefined;
let web: CatalogServer | undefined;

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    fixture = await createPublishFixture({ dir: DIR });
    // E2E_CURATION_PORT pins two ports per worker, for a machine that hands out ranges.
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
    fixture = await createPublishFixture({ dir: DIR });
});

const origin = () => {
    if (!curator) throw new Error('The curator server did not start');
    return curator.origin;
};
const webOrigin = () => {
    if (!web) throw new Error('The web server did not start');
    return web.origin;
};

async function open(page: Page): Promise<void> {
    await signIn(page, origin(), (curator as CuratorServer).passphrase);
    await page.goto(`${origin()}/curation/publish`);
    await waitForHydration(page);
}

const bar = (page: Page) => page.locator('main form[data-sticky-bar]');
// By value, not name: the name changes to "Validating…" or "Publishing revision 3…" while the press waits.
const validate = (page: Page) => bar(page).locator('button[value="validate"]');
const publishButton = (page: Page) => bar(page).locator('button[value="publish"]');
const result = (page: Page) => page.locator('#result-heading');

/** The element focus is on, by its text, or its id when it has none. */
async function focused(page: Page): Promise<string> {
    return page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        return (element?.textContent ?? '').replace(/\s+/g, ' ').trim() || element?.id || '';
    });
}

/**
 * An accessible name with a visually hidden suffix (": <record>"). The hidden
 * span is absolutely positioned, so name computation may put a space before it.
 */
const named = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(': ', '\\s*: ')}$`);

/** Press, and wait for the answer's heading to take focus. */
async function press(page: Page, button: Locator, heading: string | RegExp): Promise<void> {
    await button.click();
    await expect(result(page)).toHaveText(heading);
    await expect(result(page)).toBeFocused();
}

/** Delay every server action by `ms`, so a pending state stays on screen long enough to read. */
async function slowActions(page: Page, ms: number): Promise<void> {
    await page.route(`${origin()}/curation/publish**`, async (route) => {
        if (route.request().method() === 'POST') await new Promise((resolve) => setTimeout(resolve, ms));
        await route.continue();
    });
}

async function fixFromRows(page: Page): Promise<void> {
    await page.getByRole('link', { name: named(`Review and mark description ready: ${BREAKWATER_TITLE}`) }).click();
    await expect(page.locator('#fix-heading')).toBeFocused();
    await page.getByRole('button', { name: named(`Mark description ready: ${BREAKWATER_TITLE}`) }).click();
    // A finished fix reads the ledger again, and focus goes to the row's summary.
    const added = page.locator('p[id$="-summary"]', { hasText: `Add ${BREAKWATER_TITLE} to Low Tide Hours after photograph 04` });
    await expect(added).toBeFocused();
    await page.getByRole('button', { name: named('Still right, mark reviewed: Pier lamps position in Salt Roads') }).click();
    await expect(page.locator('p[id$="-summary"]', { hasText: 'Pier lamps moves from position 7 to 2 in Salt Roads' })).toBeFocused();
    await expect(page.getByText('Blocks publishing')).toHaveCount(0);
}

test('anonymous requests get the boundary, on the curator and on web, and write nothing', async ({ page, request }) => {
    const before = (await readActivePointer(fixture.root))?.revisionId;
    const anonymous = await request.get(`${origin()}/curation/publish`, { maxRedirects: 0 });
    expect([302, 303, 307, 404]).toContain(anonymous.status());
    expect(await anonymous.text()).not.toContain('Change ledger');
    await page.goto(`${origin()}/curation/publish`);
    await expect(page.getByRole('heading', { name: /Preview catalog revision/ })).toHaveCount(0);
    // A post as the screen's action would send it, without a session.
    const post = await request.post(`${origin()}/curation/publish`, { form: { intent: 'publish', draftId: 'rev_'.padEnd(68, '0') }, maxRedirects: 0 });
    expect([302, 303, 307, 403, 404, 405]).toContain(post.status());
    expect((await request.get(`${webOrigin()}/curation/publish`)).status()).toBe(404);
    expect((await readActivePointer(fixture.root))?.revisionId).toBe(before);
});

test('opens on the draft: the count line, the badges, one empty live region, and the panel on the new photograph', async ({ page }) => {
    await open(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Preview catalog revision 3');
    await expect(page.getByText(/changes for visitors: \d+ authored, \d+ derived\. 2 block publishing\./)).toBeVisible();
    await expect(page.getByText('Current public revision 2')).toBeVisible();
    await expect(page.locator('main > [role="status"]')).toHaveCount(1);
    await expect(page.locator('main > [role="status"]')).toHaveText('');
    await expect(page.locator('[role="status"]')).toHaveCount(1);
    await expect(page.getByText('Blocks publishing')).toHaveCount(2);
    await expect(page.locator('#publish-reason')).toHaveText('2 changes block publishing. Fix them, then validate.');
    await expect(publishButton(page)).toHaveAttribute('aria-disabled', 'true');
    // The frame opens on the new photograph's Viewer, inert, and loading it never scrolls the page.
    const frame = page.locator('iframe');
    await expect(frame).toHaveAttribute('src', /\/site\/work\/low-tide-hours\/photo\/ph_/);
    await expect(frame).toHaveAttribute('inert');
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page.getByRole('region', { name: 'Visitor preview' })).toHaveCount(1);
    // Pressing the unavailable Publish does nothing. It's aria-disabled, which Playwright won't press without force.
    await publishButton(page).click({ force: true });
    await expect(result(page)).toHaveCount(0);
});

test('blocks with one link per blocker: four Tab stops before Validate, and each link lands on its fix', async ({ page }) => {
    await open(page);
    await press(page, validate(page), 'Publication blocked');
    await expect(page.getByText('2 changes need you before revision 3 can publish. Revision 2 stays live.')).toBeVisible();
    await expect(page.locator('#publish-reason')).toHaveText('Fix the changes above, then validate again.');
    // Keyboard: from Open full preview to Validate, the two row fixes, then the two blocker links.
    await page.getByRole('link', { name: /Open full preview/ }).focus();
    const stops: string[] = [];
    for (let i = 0; i < 8; i++) {
        await page.keyboard.press('Tab');
        const name = await focused(page);
        if (name === 'Validate revision' || /^Validate revision/.test(name)) break;
        stops.push(name);
    }
    // The rows in ledger order (the series' move, then the new photograph), then the list in the same order.
    expect(stops).toEqual([
        'Still right, mark reviewed: Pier lamps position in Salt Roads',
        `Review and mark description ready: ${BREAKWATER_TITLE}`,
        'Review it: Pier lamps position in Salt Roads',
        `Review the description: ${BREAKWATER_TITLE}`,
    ]);
    await expect(validate(page)).toBeFocused();
    // The description link opens the row's fix in place and moves focus to it, with no page load.
    await page.getByRole('link', { name: `Review the description: ${BREAKWATER_TITLE}` }).click();
    await expect(page.locator('#fix-heading')).toBeFocused();
    await expect(result(page)).toHaveText('Publication blocked');
    // Escape closes it, and focus goes to the row's summary, since the list opened it.
    await page.keyboard.press('Escape');
    await expect(page.locator('p[id$="-summary"]', { hasText: `Add ${BREAKWATER_TITLE}` })).toBeFocused();
    // The restamp link moves focus to the row.
    await page.getByRole('link', { name: 'Review it: Pier lamps position in Salt Roads' }).click();
    await expect(page.locator('p[id$="-summary"]', { hasText: 'Pier lamps moves from position 7 to 2' })).toBeFocused();
});

test('fixes from the rows, validates, and publishes, with the live region speaking only while it waits, and `/` serves revision 3', async ({ page, request }) => {
    await open(page);
    await fixFromRows(page);
    await slowActions(page, 1_500);
    await validate(page).click();
    await expect(page.locator('main > [role="status"]')).toHaveText('Checking revision 3.');
    await expect(bar(page)).toHaveAttribute('aria-busy', 'true');
    await expect(validate(page)).toHaveText('Validating…');
    await expect(result(page)).toHaveText('Catalog revision is valid');
    await expect(result(page)).toBeFocused();
    await expect(page.locator('main > [role="status"]')).toHaveText('');
    await expect(page.getByText(/^Publishing makes these \d+ changes live on every page\. Revision 2 stays rollback-ready\.$/)).toBeVisible();
    await expect(publishButton(page)).not.toHaveAttribute('aria-disabled', 'true');
    await publishButton(page).click();
    await expect(page.locator('main > [role="status"]')).toHaveText('Publishing revision 3. Revision 2 stays live until the switch.');
    await expect(publishButton(page)).toHaveText('Publishing revision 3…');
    // A second press while it waits is ignored.
    await publishButton(page).click({ force: true });
    await expect(result(page)).toHaveText('Revision 3 published atomically');
    await expect(result(page)).toBeFocused();
    await expect(page.locator('main > [role="status"]')).toHaveText('');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Revision 3 is live');
    await expect(page.getByText('Revision 2 is kept.')).toBeVisible();
    await expect(page.locator('main')).not.toContainText(/This draft|not public/);
    await expect(bar(page)).toHaveCount(0);
    expect((await readActivePointer(fixture.root))?.revisionId).toBeTruthy();
    // Visitors get it: Work shows the new short statement.
    const work = await request.get(`${webOrigin()}/work`);
    expect(await work.text()).toContain('Six mornings on the estuary before the water comes back.');
});

test('blocks at publish when a review goes stale after Validate, and the stale row says so with its Inbox fix', async ({ page }) => {
    await fixBoth(fixture);
    await open(page);
    await press(page, validate(page), 'Catalog revision is valid');
    await reopenBreakwater(fixture);
    await press(page, publishButton(page), 'Nothing was published');
    await expect(page.getByText('1 change went stale since you validated. Revision 2 stays live.')).toBeVisible();
    const link = page.getByRole('link', { name: `Decide it in the Inbox: ${BREAKWATER_TITLE}` });
    await expect(link).toHaveAttribute('href', `/curation/inbox?item=${fixture.breakwaterEvent}#item`);
    await expect(page.getByText(`curation show ${fixture.breakwaterEvent}`).first()).toBeVisible();
    const row = page.locator('li', { has: page.locator('p[id$="-summary"]', { hasText: `Add ${BREAKWATER_TITLE}` }) });
    await expect(row.getByText('Stale review')).toBeVisible();
    await expect(row.getByText('Blocks publishing')).toBeVisible();
    await expect(publishButton(page)).toHaveAttribute('aria-disabled', 'true');
});

test('stops when the working catalog changed after the page loaded, and offers the one way on', async ({ page }) => {
    await fixBoth(fixture);
    await open(page);
    await press(page, validate(page), 'Catalog revision is valid');
    await editBehindThePage(fixture);
    await press(page, publishButton(page), 'The working catalog changed');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Preview your draft');
    await expect(page.getByText('Change ledger, out of date')).toBeVisible();
    await expect(page.locator('main [data-sticky-bar]').getByRole('link', { name: 'Load the updated ledger' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Validate revision|Publish revision/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /mark reviewed|Mark description ready/ })).toHaveCount(0);
    await expect(page.locator('iframe')).toHaveCount(0);
});

test('says who published from the command line meanwhile, with the new pointer on the page', async ({ page }) => {
    await fixBoth(fixture);
    await open(page);
    await press(page, validate(page), 'Catalog revision is valid');
    await editBehindThePage(fixture);
    await publishFromCli(fixture, 'keyur');
    await press(page, publishButton(page), 'Revision 3 went live from the command line');
    await expect(page.getByText(/^keyur published it at \d\d:\d\d, with photos publish\. Nothing was published from here\.$/)).toBeVisible();
    await expect(page.getByText('Current public revision 3')).toBeVisible();
    await expect(page.getByText('Revision 2 is kept.')).toBeVisible();
});

test('says already live when this candidate went live meanwhile', async ({ page }) => {
    await fixBoth(fixture);
    await open(page);
    await press(page, validate(page), 'Catalog revision is valid');
    await publishFromCli(fixture, 'keyur');
    await press(page, publishButton(page), 'Revision 3 is already live');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Revision 3 is live');
    await expect(page.getByRole('heading', { name: 'Live in revision 3' })).toBeVisible();
});

test('answers busy while another process holds the catalog, and Publish stays the retry', async ({ page }) => {
    await fixBoth(fixture);
    await open(page);
    await press(page, validate(page), 'Catalog revision is valid');
    const release = await holdCatalogLock(fixture);
    try {
        await press(page, publishButton(page), 'Another publish or rollback is running');
        await expect(page.getByText(/Nothing changed here\. Publish again when it finishes\.$/)).toBeVisible();
        await expect(publishButton(page)).not.toHaveAttribute('aria-disabled', 'true');
        await expect(page.getByRole('link', { name: 'Try again' })).toHaveCount(0);
    } finally {
        await release();
    }
    await press(page, publishButton(page), 'Revision 3 published atomically');
});

test('answers failed when the publish stops before the switch, and Publish stays the retry', async ({ page }) => {
    await fixBoth(fixture);
    await open(page);
    await press(page, validate(page), 'Catalog revision is valid');
    const draftId = await bar(page).locator('input[name="draftId"]').inputValue();
    const undo = blockRevisionFile(fixture, draftId);
    try {
        await press(page, publishButton(page), 'The publish stopped before revision 3 went live');
        await expect(page.getByText('Revision 2 is still live, and visitors see no change. The server log names what failed. Publish again to retry.')).toBeVisible();
        await expect(publishButton(page)).not.toHaveAttribute('aria-disabled', 'true');
    } finally {
        undo();
    }
    await press(page, publishButton(page), 'Revision 3 published atomically');
});

test.describe('without JavaScript', () => {
    // Curator pages send Referrer-Policy: no-referrer, so a form navigation's Origin is "null", and the boundary refuses
    // every mutation without a same-origin Origin. Without JavaScript the screen reads in full and its fixes open from
    // their links; a post is refused before it reaches the action, and nothing is written.
    test('reads the ledger and opens a fix, and a post is refused with nothing written', async ({ page: signedIn, browser }) => {
        await fixBoth(fixture);
        // Sign in posts with fetch, so it needs JavaScript; the screen then runs in a context without it, on that session.
        await signIn(signedIn, origin(), (curator as CuratorServer).passphrase);
        const context = await browser.newContext({ javaScriptEnabled: false, storageState: await signedIn.context().storageState() });
        const page = await context.newPage();
        await page.goto(`${origin()}/curation/publish`);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText('Preview catalog revision 3');
        await expect(page.getByText(/Pier lamps moves from position 7 to 2 in Salt Roads/)).toBeVisible();
        await expect(page.locator('main > [role="status"]')).toHaveCount(1);
        const before = (await readActivePointer(fixture.root))?.revisionId;
        const posted = page.waitForResponse((response) => response.request().method() === 'POST');
        await validate(page).click();
        expect((await posted).status()).toBe(403);
        expect((await readActivePointer(fixture.root))?.revisionId).toBe(before);
        await context.close();
    });
});

test.describe('the #1 checks', () => {
    for (const [width, height] of [
        [1440, 900],
        [390, 844],
    ] as const) {
        test(`pass on the blocked screen at ${width} px`, async ({ page }) => {
            await page.setViewportSize({ width, height });
            await open(page);
            // From the keyboard, as a keyboard user would, so the focus ring shows where focus goes next.
            await validate(page).focus();
            await page.keyboard.press('Enter');
            await expect(result(page)).toHaveText('Publication blocked');
            await checkSurface(page, {
                controls: [
                    page.getByRole('link', { name: /Open full preview/ }),
                    page.locator('main [id$="-open"]'),
                    page.getByRole('button', { name: /mark reviewed/ }),
                    page.locator('ol li a'),
                    validate(page),
                    publishButton(page),
                ],
                chrome: [bar(page)],
            });
        });
    }
});
