import type { Page } from '@playwright/test';
import { publish } from '../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../lib/catalog/testing';
import { readAuthoredRecord } from '../lib/catalog/working-layer';
import { writeAuthoredRecord } from '../lib/catalog/working-layer-writer';
import { describeLog, recordAnnouncer, shownHolding, spokenOf, type AnnouncerStep } from './support/announcerLog';
import { READY_TIMEOUT, startCatalogServer, type CatalogServer } from './support/catalogServer';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';

// #255: a return to the series page that lands with focus on its heading, `h1#series-title`, says the page's name
// there, so Next's route announcer (<next-route-announcer>, an assertive role="alert" in its shadow root) must not say
// it for the navigation that lands there, and no alert with the name may sit beside the focused heading. Every other
// page change is still announced. Its own catalog and server, as viewer-revision.spec.ts has for #178, since each
// test republishes the series without the photograph it opened. The tests run in order in one worker, and none needs
// another's revision, so a failure doesn't skip the rest: the worker that takes over starts from the first revision.
//
// - The modal's Back to the series, when a publish dropped the photograph that opened it (ViewerHost).
// - Back after a reload on the Viewer to a deep link's page whose ?photo= named the dropped photograph: the page is
//   already the server's answer for it (SeriesReturn's missing photograph's return).
// - Back after a reload on the Viewer to the series page, whose return asks the server for the dropped photograph's
//   page with ?photo= and lands on the heading when the answer doesn't hold it (SeriesReturn's landReturn).
//
// Each records every write to the announcer's shadow root and every change to its host's aria-hidden from before the
// press (test/helpers/announcerLog.ts), so a write that's emptied a moment later still counts.

test.describe.configure({ mode: 'default' });

const HOOK_TIMEOUT = READY_TIMEOUT + 60_000;
const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n + 60).padStart(12, '0')}`;
const R = Array.from({ length: 6 }, (_, n) => id(n));
const SERIES_ID = 'ser_e2e-swell';
const SLUG = 'swell';
const NAME = 'Fixture swell';
const SERIES = `/work/${SLUG}`;
const href = (photoId: string) => `${SERIES}/photo/${photoId}`;

let catalog: TestCatalog | undefined;
let server: CatalogServer | undefined;

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    catalog = await createTestCatalog({
        seed: 255,
        withAssets: true,
        photos: R.map((photoId, n) => ({ id: photoId, width: 900, height: 600, title: `Fixture swell ${n + 1}` })),
        series: [{ id: SERIES_ID, slug: SLUG, title: NAME, photoIds: R }],
    });
    const outcome = await publish({ dataRoot: catalog.root, actor: 'e2e', confirmLaunch: true, logger: { log: () => undefined } });
    expect(outcome.outcome, outcome.message).toBe('PUBLISHED');
    const base = Number(process.env.E2E_CATALOG_PORT);
    server = await startCatalogServer(catalog.root, Number.isInteger(base) && base > 0 ? base + 1 + test.info().parallelIndex : undefined);
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

/** Publishes the next revision: the series without `photoId`. */
async function publishWithout(photoId: string): Promise<void> {
    if (!catalog) throw new Error('No catalog');
    const record = await readAuthoredRecord(catalog.root, 'series', SERIES_ID);
    if (record === null) throw new Error('No series record');
    await writeAuthoredRecord({ ...record, photoIds: record.photoIds.filter((member) => member !== photoId) }, { expectedVersion: record.version, root: catalog.root });
    const outcome = await publish({ dataRoot: catalog.root, actor: 'e2e', confirmLaunch: true, logger: { log: () => undefined } });
    expect(outcome.outcome, outcome.message).toBe('PUBLISHED');
}

/** Publishes the whole series again when a test before this one, or a try of this one, left it short. */
test.beforeEach(async () => {
    if (!catalog) throw new Error('No catalog');
    const record = await readAuthoredRecord(catalog.root, 'series', SERIES_ID);
    if (record === null) throw new Error('No series record');
    if (record.photoIds.length === R.length) return;
    await writeAuthoredRecord({ ...record, photoIds: R }, { expectedVersion: record.version, root: catalog.root });
    const outcome = await publish({ dataRoot: catalog.root, actor: 'e2e', confirmLaunch: true, logger: { log: () => undefined } });
    expect(outcome.outcome, outcome.message).toBe('PUBLISHED');
});

const viewer = (page: Page) => page.locator('[data-surface="viewer"]');
const entry = (page: Page, photoId: string) => page.locator(`[id="photo-${photoId}"]`);
const heading = (page: Page) => page.locator('h1#series-title');
const host = (page: Page) => page.locator('next-route-announcer');
const named = new RegExp(`\\b${NAME}\\b`);

/** The steps from the heading's focus on. */
function fromHeading(steps: AnnouncerStep[]): AnnouncerStep[] {
    const index = steps.findIndex((step) => step.kind === 'focus' && step.focus === 'series-title');
    expect(index, `the heading took focus (${describeLog(steps)})`).toBeGreaterThanOrEqual(0);
    return steps.slice(index);
}

/**
 * Landed on the heading: it has focus, the announcer's host isn't hidden, and the page's accessibility tree, which the
 * snapshot reads into shadow roots, holds no alert with the page's name. Then nothing the announcer was given from the
 * heading's focus on had the name, and nothing at all while `strict` (the landing's own navigation).
 */
async function expectHeadingAlone(page: Page, read: () => Promise<AnnouncerStep[]>, strict: boolean): Promise<AnnouncerStep[]> {
    await expect(heading(page)).toBeFocused();
    await expect(host(page)).toHaveCount(1);
    // Past the landing's write: the announcer's update renders in a commit after the landing's (#255).
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));
    const steps = await read();
    const log = describeLog(steps);
    // The whole log, in the report and the output, whatever fails below.
    test.info().annotations.push({ type: 'announcer', description: log });
    console.log(`[${test.info().project.name}] ${test.info().title}: ${log}`);
    await expect(host(page), log).not.toHaveAttribute('aria-hidden');
    await expect(page.getByRole('alert').filter({ hasText: named }), log).toHaveCount(0);
    expect(await page.locator('body').ariaSnapshot(), log).not.toMatch(new RegExp(`^\\s*- alert\\b.*${NAME}`, 'm'));
    await expect(heading(page), log).toBeFocused();
    expect(spokenOf(fromHeading(steps)).filter((text) => named.test(text)), log).toEqual([]);
    // Nor was the host ever shown holding a title it took while hidden: the Viewer's, or Next's own for this landing.
    expect(shownHolding(steps), log).toEqual([]);
    if (strict) expect(spokenOf(steps).filter((text) => named.test(text)), log).toEqual([]);
    return steps;
}

/** A page change that focuses no heading: All work, from the series page. The announcer says Work's title. */
async function expectNextChangeHeard(page: Page): Promise<void> {
    const read = await recordAnnouncer(page, { titles: true });
    await page.getByRole('link', { name: 'All work, back to the series list' }).click();
    await expect(page).toHaveURL(`${origin()}/work`);
    try {
        await expect(page.getByRole('alert')).toHaveText(/^Work\b/);
        await expect(host(page)).not.toHaveAttribute('aria-hidden');
    } finally {
        // The log, with the title's changes, in the report and the output, whether or not the alert came.
        const log = describeLog(await read());
        test.info().annotations.push({ type: 'next change', description: `${test.info().project.name}: ${log}` });
        console.log(`[${test.info().project.name}] next change after ${test.info().title}: ${log}`);
    }
    const steps = await read();
    expect(spokenOf(steps).filter((text) => /^Work\b/.test(text)), describeLog(steps)).not.toEqual([]);
}

test('the modal\'s Back to the series onto the heading, when a publish dropped its photograph: the heading alone says the name', async ({ page }) => {
    await page.clock.install();
    await page.goto(`${origin()}${SERIES}`);
    await waitForHydration(page);
    await entry(page, R[1]).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${origin()}${href(R[1])}`);
    await expect(page.getByRole('dialog')).toBeVisible();
    await publishWithout(R[1]);
    // The Viewer's revision check, at 30 s, finds the photograph gone.
    await page.clock.fastForward(30_000);
    await expect(viewer(page).getByRole('heading', { level: 1, name: 'This photograph is no longer here' })).toBeFocused();
    const read = await recordAnnouncer(page);
    await viewer(page).getByRole('button', { name: 'Back to the series' }).click();
    await expect(page).toHaveURL(`${origin()}${SERIES}`);
    await expect(entry(page, R[1])).toHaveCount(0);
    await expectHeadingAlone(page, read, true);
    await expectNextChangeHeard(page);
});

test('Back after a reload on the Viewer to a deep link\'s page for a dropped photograph: the heading alone says the name', async ({ page }) => {
    await page.goto(`${origin()}${SERIES}?photo=${R[2]}`);
    await waitForHydration(page);
    // The deep link's own focus (B5), then Enter on it.
    await expect(entry(page, R[2])).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${origin()}${href(R[2])}`);
    await page.reload();
    await waitForHydration(page);
    await expect(viewer(page)).toHaveAttribute('data-viewer-mode', 'page');
    await publishWithout(R[2]);
    const read = await recordAnnouncer(page);
    await page.goBack();
    await expect(page).toHaveURL(`${origin()}${SERIES}?photo=${R[2]}`);
    await expect(entry(page, R[2])).toHaveCount(0);
    await expectHeadingAlone(page, read, true);
    await expectNextChangeHeard(page);
});

test('Back after a reload on the Viewer, whose return asks the server for the dropped photograph\'s page: the heading alone says the name from its landing on', async ({ page }) => {
    await page.goto(`${origin()}${SERIES}`);
    await waitForHydration(page);
    await entry(page, R[3]).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${origin()}${href(R[3])}`);
    await page.reload();
    await waitForHydration(page);
    await expect(viewer(page)).toHaveAttribute('data-viewer-mode', 'page');
    await publishWithout(R[3]);
    const read = await recordAnnouncer(page);
    await page.goBack();
    // The return asks the server once for the page that holds the photograph, which no longer does.
    await expect(page).toHaveURL(`${origin()}${SERIES}?photo=${R[3]}`);
    await expect(entry(page, R[3])).toHaveCount(0);
    // The Back itself is a page change whose focus goes nowhere until the answer: the announcer may say it there.
    await expectHeadingAlone(page, read, false);
    await expectNextChangeHeard(page);
});

// The page change after a modal Close that takes no landing hold, for comparison with the returns above: All work,
// after a Close onto the photograph's entry, with and without the Viewer's revision check having refreshed the page
// under the modal. Whether Next writes for Work isn't guaranteed (its announcer reads the title in its effect for the
// router's new tree, and a title that streams in after that tree is never announced), so it's recorded in the report,
// with the log, and only what is guaranteed is asserted.
async function recordNextChange(page: Page): Promise<void> {
    const read = await recordAnnouncer(page, { titles: true });
    await page.getByRole('link', { name: 'All work, back to the series list' }).click();
    await expect(page).toHaveURL(`${origin()}/work`);
    await expect(page).toHaveTitle(/^Work\b/);
    await expect(host(page)).not.toHaveAttribute('aria-hidden');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 250)))));
    const steps = await read();
    const log = describeLog(steps);
    const wrote = steps.filter((step) => step.kind === 'text' && step.text !== '').map((step) => step.text);
    test.info().annotations.push({ type: 'Next wrote on the next change', description: `${test.info().project.name}: ${wrote.length > 0 ? 'yes' : 'no'} (${log})` });
    console.log(`[${test.info().project.name}] next change after ${test.info().title}: ${log}`);
    expect(steps.filter((step) => !step.hidden && step.text !== '' && !/^(Work|Fixture swell)\b/.test(step.text)), log).toEqual([]);
    expect(wrote.filter((text) => !/^Work\b/.test(text)), log).toEqual([]);
}

test('the modal\'s Close onto its entry, after the revision check refreshed the page under it, then All work: no hold, and Next\'s write is recorded', async ({ page }) => {
    await page.clock.install();
    await page.goto(`${origin()}${SERIES}`);
    await waitForHydration(page);
    await entry(page, R[5]).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    // A publish that keeps the open photograph: the 30 s check refreshes the page under the modal, as for the dropped one.
    await publishWithout(R[4]);
    await page.clock.fastForward(30_000);
    await expect(entry(page, R[4])).toHaveCount(0);
    await viewer(page).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page).toHaveURL(`${origin()}${SERIES}`);
    await expect(entry(page, R[5])).toBeFocused();
    await recordNextChange(page);
});

test('the modal\'s Close onto its entry, with no refresh, then All work: no hold, and Next\'s write is recorded', async ({ page }) => {
    await page.goto(`${origin()}${SERIES}`);
    await waitForHydration(page);
    await entry(page, R[5]).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await viewer(page).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page).toHaveURL(`${origin()}${SERIES}`);
    await expect(entry(page, R[5])).toBeFocused();
    await recordNextChange(page);
});
