import type { Page } from '@playwright/test';
import { publish } from '../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../lib/catalog/testing';
import { readAuthoredRecord } from '../lib/catalog/working-layer';
import { writeAuthoredRecord } from '../lib/catalog/working-layer-writer';
import { describeLog, recordAnnouncer, spokenOf, type AnnouncerStep } from './support/announcerLog';
import { READY_TIMEOUT, startCatalogServer, type CatalogServer } from './support/catalogServer';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';

// #255: a return to the series page that lands with focus on its heading, `h1#series-title`, says the page's name
// there, so Next's route announcer (<next-route-announcer>, an assertive role="alert" in its shadow root) must not say
// it for the navigation that lands there, and no alert with the name may sit beside the focused heading. Every other
// page change is still announced. Its own catalog and server, as viewer-revision.spec.ts has for #178, since each
// test republishes the series without the photograph it opened. The tests run in order and each builds on the
// revision before; in this serial group a retry starts again from the first revision.
//
// - The modal's Back to the series, when a publish dropped the photograph that opened it (ViewerHost).
// - Back after a reload on the Viewer to a deep link's page whose ?photo= named the dropped photograph: the page is
//   already the server's answer for it (SeriesReturn's missing photograph's return).
// - Back after a reload on the Viewer to the series page, whose return asks the server for the dropped photograph's
//   page with ?photo= and lands on the heading when the answer doesn't hold it (SeriesReturn's landReturn).
//
// Each records every write to the announcer's shadow root and every change to its host's aria-hidden from before the
// press (e2e/support/announcerLog.ts), so a write that's emptied a moment later still counts.

test.describe.configure({ mode: 'serial' });

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
    await expect(host(page)).not.toHaveAttribute('aria-hidden');
    await expect(page.getByRole('alert').filter({ hasText: named })).toHaveCount(0);
    expect(await page.locator('body').ariaSnapshot()).not.toMatch(new RegExp(`^\\s*- alert\\b.*${NAME}`, 'm'));
    await expect(heading(page)).toBeFocused();
    const steps = await read();
    test.info().annotations.push({ type: 'announcer', description: describeLog(steps) });
    expect(spokenOf(fromHeading(steps)).filter((text) => named.test(text)), describeLog(steps)).toEqual([]);
    if (strict) expect(spokenOf(steps).filter((text) => named.test(text)), describeLog(steps)).toEqual([]);
    return steps;
}

/** A page change that focuses no heading: All work, from the series page. The announcer says Work's title. */
async function expectNextChangeHeard(page: Page): Promise<void> {
    const read = await recordAnnouncer(page);
    await page.getByRole('link', { name: 'All work, back to the series list' }).click();
    await expect(page).toHaveURL(`${origin()}/work`);
    await expect(page.getByRole('alert')).toHaveText(/^Work\b/);
    await expect(host(page)).not.toHaveAttribute('aria-hidden');
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
