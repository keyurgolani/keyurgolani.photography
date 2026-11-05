import type { Page } from '@playwright/test';
import { publish } from '../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../lib/catalog/testing';
import { readAuthoredRecord } from '../lib/catalog/working-layer';
import { writeAuthoredRecord } from '../lib/catalog/working-layer-writer';
import { READY_TIMEOUT, startCatalogServer, type CatalogServer } from './support/catalogServer';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';

// B9 (#178, bug 5): a publish while the Viewer is open. Its own catalog and server, since the shared per-worker
// Viewer catalog can't be republished mid-run: a five-photo series, one with a 600-character caption, published as
// Revision A, then republished without a photograph each test (B, C, D) while a page or the modal is open. The
// tests run in order and each builds on the revision before. In this serial group a failure retries the whole group,
// beforeAll included, so a retry starts again from Revision A.
//
// - The open Viewer learns of a publish within 30 s (its revision check; page.clock runs on, and is fast-forwarded 30 s),
//   keeps focus, since the publish doesn't touch the open photograph, and every move after it lands on the served
//   revision's page, never Revision A's prefetched one, with the dropped photograph's words in no DOM state.
// - A photograph dropped under the open modal shows ViewerUnavailable, focus on its heading, announced, and the way
//   back lands on the series heading, since its entry and the opener are gone.
// - A move onto a neighbour the publish dropped, before any check, shows ViewerUnavailable too, never the site's
//   not-found page outside the Viewer.

test.describe.configure({ mode: 'serial' });

const HOOK_TIMEOUT = READY_TIMEOUT + 60_000;
const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n + 40).padStart(12, '0')}`;
const R = Array.from({ length: 5 }, (_, n) => id(n));
const SERIES_ID = 'ser_e2e-tide';
const SLUG = 'tide';
/** The 600-character caption, on the last photograph, which every revision keeps. */
const LONG_CAPTION = 'Fixture tide caption that runs on. '.repeat(18).slice(0, 600).trim();
const DROPPED = { title: 'Fixture tide dropped title', caption: 'Fixture tide dropped caption.', description: 'Fixture tide dropped description.' };
const href = (photoId: string) => `/work/${SLUG}/photo/${photoId}`;

let catalog: TestCatalog | undefined;
let server: CatalogServer | undefined;

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    const photo = (n: number) => ({ id: R[n], width: 900, height: 600, title: `Fixture tide ${n + 1}` });
    catalog = await createTestCatalog({
        seed: 178,
        withAssets: true,
        photos: [
            photo(0),
            photo(1),
            photo(2),
            // The one Revision B drops: its words must never show once the Viewer knows of B.
            { ...photo(3), title: DROPPED.title, caption: DROPPED.caption, alt: { kind: 'described', text: DROPPED.description, reviewed: true } },
            { ...photo(4), caption: LONG_CAPTION },
        ],
        series: [{ id: SERIES_ID, slug: SLUG, title: 'Fixture tide', photoIds: R }],
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
const header = (page: Page) => viewer(page).locator('header');
const announcer = (page: Page) => viewer(page).locator('[data-viewer-announcer]');
const unavailable = (page: Page) => viewer(page).getByRole('heading', { level: 1, name: 'This photograph is no longer here' });

/** From now on, every text the page shows, as it's added or changed, so a word that shows for a moment is caught. */
async function recordText(page: Page): Promise<() => Promise<string>> {
    await page.evaluate(() => {
        const seen: string[] = [document.body.innerText];
        (window as unknown as { kgSeen: string[] }).kgSeen = seen;
        new MutationObserver((records) => {
            for (const record of records) {
                if (record.type === 'characterData') seen.push((record.target as Text).data);
                for (const added of record.addedNodes) seen.push(added.textContent ?? '');
            }
            seen.push(document.body.innerText);
        }).observe(document.body, { childList: true, characterData: true, subtree: true });
    });
    return () => page.evaluate(() => (window as unknown as { kgSeen: string[] }).kgSeen.join('\n'));
}

test('the 30 s check learns of Revision B without touching the open photograph: focus stays, and no move shows Revision A\'s pages', async ({ page }) => {
    await page.clock.install();
    await page.goto(`${origin()}${href(R[2])}`);
    await waitForHydration(page);
    await expect(header(page)).toContainText('03 / 05');
    // Let the idle prefetch take both neighbours' pages in Revision A, as a visitor resting here would have them.
    await page.clock.fastForward(3000);
    const next = viewer(page).getByRole('button', { name: 'Next photograph', exact: true });
    await next.focus();
    const seen = await recordText(page);
    await publishWithout(R[3]);
    // The check, at 30 s: B drops R[3], not the open photograph, so it's a refresh, which remounts nothing.
    await page.clock.fastForward(30_000);
    await expect(header(page)).toContainText('03 / 04');
    await expect(next).toBeFocused();
    // Previous lands on R[1], whose page was prefetched in A as "02 / 05": B's own answer shows, never A's.
    await viewer(page).getByRole('button', { name: 'Previous photograph', exact: true }).click();
    await expect(page).toHaveURL(`${origin()}${href(R[1])}`);
    await expect(header(page)).toContainText('02 / 04');
    // On to the end: R[2], then R[4], never the dropped R[3].
    await next.click();
    await expect(header(page)).toContainText('03 / 04');
    await next.click();
    await expect(page).toHaveURL(`${origin()}${href(R[4])}`);
    await expect(header(page)).toContainText('04 / 04');
    await expect(viewer(page).locator('[data-viewer-reading]')).toContainText(LONG_CAPTION.slice(0, 40));
    await page.clock.fastForward(1000);
    const text = await seen();
    expect(text).not.toContain('02 / 05');
    for (const words of Object.values(DROPPED)) expect(text, words).not.toContain(words);
});

test('a photograph dropped under the open modal shows ViewerUnavailable, focus on its heading, announced, and the way back lands on the series heading (Revision C)', async ({ page }) => {
    await page.clock.install();
    await page.goto(`${origin()}/work/${SLUG}`);
    await waitForHydration(page);
    await page.locator(`[id="photo-${R[1]}"]`).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${origin()}${href(R[1])}`);
    await expect(page.getByRole('dialog')).toBeVisible();
    await publishWithout(R[1]);
    await page.clock.fastForward(30_000);
    await expect(unavailable(page)).toBeFocused();
    await expect(page.getByRole('dialog')).toHaveAccessibleName('This photograph is no longer here');
    await expect(viewer(page).getByRole('button', { name: 'Next photograph' })).toHaveCount(0);
    await page.clock.fastForward(1000);
    await expect(announcer(page)).toHaveText('This photograph is no longer here. It was unpublished or moved after this page loaded.');
    await viewer(page).getByRole('button', { name: 'Back to the series' }).click();
    await expect(page).toHaveURL(`${origin()}/work/${SLUG}`);
    // The refresh under the modal took the entry away, and the opener with it: the series heading takes focus.
    await expect(page.locator(`[id="photo-${R[1]}"]`)).toHaveCount(0);
    await expect(page.locator('#series-title')).toBeFocused();
});

test('a move onto a neighbour a publish dropped, before any check, shows ViewerUnavailable inside the Viewer (Revision D)', async ({ page }) => {
    // Nothing prefetched (saveData), so the move asks the server, which no longer has the photograph.
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true, addEventListener() {}, removeEventListener() {} } });
    });
    await page.goto(`${origin()}${href(R[0])}`);
    await waitForHydration(page);
    await expect(header(page)).toContainText('01 / 03');
    await publishWithout(R[2]);
    const next = viewer(page).getByRole('button', { name: 'Next photograph', exact: true });
    await next.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${origin()}${href(R[2])}`);
    await expect(unavailable(page)).toBeFocused();
    // Inside the Viewer, never the site's not-found page outside it.
    await expect(page.getByRole('heading', { name: 'Page not found' })).toHaveCount(0);
    await expect(viewer(page).getByRole('link', { name: 'Back to the series' })).toHaveAttribute('href', `/work/${SLUG}`);
    await expect(announcer(page)).toHaveText('This photograph is no longer here. It was unpublished or moved after this page loaded.');
});
