import path from 'node:path';
import { request as httpRequest, type APIRequestContext, type Page } from '@playwright/test';
import { folderBytes } from '../test/helpers/folderBytes';
import { readAuthoredRecord } from '../lib/catalog/working-layer';
import { deferEvent } from '../lib/curation/actions';
import { eventIdOf, eventKey } from '../lib/curation/events';
import { listEvents, readEvent } from '../lib/curation/repository';
import { startCatalogServer, READY_TIMEOUT, type CatalogServer } from './support/catalogServer';
import { createInboxFixture, FAILED_SOURCE, FRESH, FRESH_SOURCES, INBOX_SERIES, PUBLISHED_IDS, openInboxItems, undisclosed, type InboxFixture } from './support/curation-inbox';
import { waitForHydration } from './support/hydration';
import { expect, test } from './support/test';

// #14's 14-3: the curation inbox on both #1 projects. Each project's worker
// builds its own published fixture, then serves it twice from the harness's
// build: once as the curator (CURATION_ENABLED=true, loopback, the Host
// allowlist on its own port) and once as `web` (the flag off). The spec walks
// the empty inbox, the items the sink opens, approve, a concurrent update,
// dismiss and reopen, and then checks the approved non-disclosure criterion
// on `web`: until an active revision references a photograph, no public page
// or API holds its photo ID, filename or asset revision, and no public URL
// serves its bytes.

test.describe.configure({ mode: 'serial' });

const HOOK_TIMEOUT = 2 * READY_TIMEOUT + 60_000;

let fixture: InboxFixture | undefined;
let curator: CatalogServer | undefined;
let web: CatalogServer | undefined;

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    fixture = await createInboxFixture();
    // E2E_CURATION_PORT pins two ports per worker, for a machine that hands out ranges.
    const base = Number(process.env.E2E_CURATION_PORT);
    const pinned = Number.isInteger(base) && base > 0 ? base + 2 * test.info().parallelIndex : undefined;
    curator = await startCatalogServer(fixture.root, pinned, { library: fixture.library, curator: true });
    web = await startCatalogServer(fixture.root, pinned === undefined ? undefined : pinned + 1, { library: fixture.library });
});

test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await curator?.stop();
    await web?.stop();
    await fixture?.cleanup();
});

const data = () => {
    if (!fixture) throw new Error('The inbox fixture was not made');
    return fixture;
};
const curatorOrigin = () => {
    if (!curator) throw new Error('The curator server did not start');
    return curator.origin;
};
const webOrigin = () => {
    if (!web) throw new Error('The web server did not start');
    return web.origin;
};

const eventOf = (photoId: string) => eventIdOf(eventKey('new', { photoId, assetRevision: data().revisionOf(photoId), key: `new:${photoId}:${data().revisionOf(photoId)}` }));
const layers = () => ({ catalog: folderBytes(path.join(data().root, 'catalog')) });
/** The answer the last action gave, in the page's polite status region. */
const answer = (page: Page, state: 'done' | 'stale') => page.getByRole('status').locator(`[data-state="${state}"]`);
const summary = (page: Page) => page.getByRole('region', { name: 'Curation inbox' }).locator('header p');

async function openInbox(page: Page, item?: string) {
    await page.goto(`${curatorOrigin()}/curation/inbox${item ? `?item=${item}` : ''}`);
    await waitForHydration(page);
}

test('the curator header leads, and an empty inbox says nothing requires judgment', async ({ page }) => {
    await page.goto(`${curatorOrigin()}/curation`);
    await expect(page).toHaveURL(`${curatorOrigin()}/curation/inbox`);
    await waitForHydration(page);
    await expect(page.getByRole('link', { name: 'Portfolio curation' })).toBeVisible();
    const screens = page.getByRole('navigation', { name: 'Curation' });
    await expect(screens.getByRole('link', { name: 'Inbox' })).toHaveAttribute('aria-current', 'page');
    await expect(screens.getByText('Preview & publish')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Curation inbox' })).toBeVisible();
    await expect(summary(page)).toHaveText('0 items require judgment');
    await expect(page.getByRole('heading', { name: 'Nothing requires judgment' })).toBeVisible();
});

test('lists what the watcher opened, and shows the selected photograph from the curator-only route', async ({ page }) => {
    await openInboxItems(data());
    await openInbox(page);
    await expect(summary(page)).toHaveText('4 items require judgment');
    const list = page.getByRole('list', { name: 'Requires judgment' });
    await expect(list.getByRole('link')).toHaveCount(4);
    await list.getByRole('link', { name: /Uncurated photograph/ }).first().click();
    await waitForHydration(page);
    await expect(page.getByRole('heading', { level: 2, name: FRESH.approve })).toBeVisible();
    const preview = page.getByRole('img', { name: /^Candidate photograph / });
    await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    const response = await page.request.get(`${curatorOrigin()}${await preview.getAttribute('src')}`);
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toContain('no-store');
    await expect(page.getByText('Published statement remains unchanged.')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Suggested series' })).toBeVisible();
});

test('approves a new photograph into the draft with the typed description, and publishes nothing', async ({ page }) => {
    const before = layers();
    await openInbox(page, eventOf(FRESH.approve));
    await page.getByRole('combobox', { name: 'Suggested series' }).selectOption(INBOX_SERIES.draft.id);
    await page.getByRole('combobox', { name: 'Proposed sequence position' }).selectOption('start');
    await page.getByRole('textbox', { name: 'Draft description' }).fill('A harbor wall at first light, typed in the e2e.');
    await page.getByRole('button', { name: 'Review series suggestion' }).click();
    await expect(answer(page, 'done')).toHaveText(/^Approved into the draft\. Nothing is published until you publish\./);
    await expect(page.getByText('Suggestion approved')).toBeVisible();
    expect(layers()).toEqual(before);
    expect((await readAuthoredRecord(data().root, 'photo', FRESH.approve))?.alt).toEqual({ kind: 'described', text: 'A harbor wall at first light, typed in the e2e.', reviewed: true });
    expect((await readAuthoredRecord(data().root, 'series', INBOX_SERIES.draft.id))?.photoIds[0]).toBe(FRESH.approve);
});

test('turns away an action on an item that changed since the page loaded, and writes nothing', async ({ page }) => {
    const eventId = eventOf(FRESH.stale);
    await openInbox(page, eventId);
    await expect(page.getByRole('heading', { level: 2, name: FRESH.stale })).toBeVisible();
    // The CLI, or another tab, acts on it first.
    const shown = (await readEvent(data().root, eventId))!;
    expect(await deferEvent({ root: data().root, eventId, expectedVersion: shown.version, actor: 'curator:cli' })).toMatchObject({ ok: true });
    const moved = (await readEvent(data().root, eventId))!;
    await page.getByRole('textbox', { name: 'Draft description' }).fill('Typed before the refresh.');
    await page.getByRole('button', { name: 'Review series suggestion' }).click();
    await expect(answer(page, 'stale')).toContainText('changed since the page loaded');
    await expect(page.getByRole('textbox', { name: 'Draft description' })).toHaveValue('Typed before the refresh.');
    expect(await readEvent(data().root, eventId)).toEqual(moved);
    expect(await readAuthoredRecord(data().root, 'photo', FRESH.stale)).toBeNull();
    await page.getByRole('link', { name: 'Refresh and review again' }).click();
    await waitForHydration(page);
    await expect(page.locator('header').getByText('Left in draft', { exact: true })).toBeVisible();
});

test('dismisses an unreadable file with a reason, then reopens it', async ({ page }) => {
    const { events } = await listEvents(data().root);
    const failed = events.find((event) => event.type === 'processing-failure')!;
    await openInbox(page, failed.id);
    await expect(page.getByText('The file is not a format the watcher reads.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry processing' })).toHaveCount(0);
    await page.getByText('Dismiss with a reason').click();
    await page.getByRole('textbox', { name: 'Reason' }).fill('An export from another app; the JPEG is already in.');
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(answer(page, 'done')).toHaveText('Dismissed.');
    await expect(page.getByRole('heading', { name: 'Settled' })).toBeVisible();
    await page.getByRole('button', { name: 'Reopen' }).click();
    await expect(answer(page, 'done')).toHaveText('Reopened.');
    expect((await readEvent(data().root, failed.id))?.status).toBe('failed');
});

/** Every public page and API the approved criterion names, by path, on `web`. */
function publicPaths(): string[] {
    return ['/', '/work', `/work/${INBOX_SERIES.published.slug}`, `/work/${INBOX_SERIES.draft.slug}`, '/gallery', '/api/photos', '/api/catalog/active', '/api/catalog/photos'];
}

async function withRequest<T>(origin: string, run: (request: APIRequestContext) => Promise<T>): Promise<T> {
    const request = await httpRequest.newContext({ baseURL: origin });
    try {
        return await run(request);
    } finally {
        await request.dispose();
    }
}

test('discloses no unpublished photograph on any public page or API, and serves none of its bytes', async () => {
    const secrets = undisclosed(data());
    await withRequest(webOrigin(), async (request) => {
        for (const pathname of publicPaths()) {
            for (const headers of [{}, { RSC: '1' }] as Record<string, string>[]) {
                const response = await request.get(pathname, { headers, maxRedirects: 5 });
                const body = await response.text();
                for (const secret of secrets) expect(body, `${pathname} ${JSON.stringify(headers)} holds ${secret}`).not.toContain(secret);
                // No curator control reaches a public page either.
                expect(body, pathname).not.toContain('Curation inbox');
                expect(body, pathname).not.toContain('/api/curation/');
            }
        }
        for (const photoId of Object.values(FRESH)) {
            const revision = data().revisionOf(photoId);
            const set = `${photoId}/${revision}/${data().catalog.profileId}`;
            for (const pathname of [
                `/media/${set}/w800.webp`,
                `/media/${set}/w1920.avif`,
                `/api/curation/media/${set}/w800.webp`,
                `/_next/image?url=${encodeURIComponent(`/media/${set}/w800.webp`)}&w=800&q=75`,
                `/assets/photos/${FRESH_SOURCES[photoId]}`,
            ]) {
                const response = await request.get(pathname, { maxRedirects: 0 });
                expect(response.status(), pathname).toBeGreaterThanOrEqual(400);
                expect((await response.body()).length < 200, `${pathname} answered with a body`).toBe(true);
            }
        }
        expect((await request.get(`/assets/photos/${FAILED_SOURCE}`)).status()).toBe(404);
        // Nor does web serve the curator at all.
        for (const pathname of ['/curation', '/curation/inbox']) expect((await request.get(pathname, { maxRedirects: 0 })).status(), pathname).toBe(404);
    });
    // Home serves the published photographs, so the check above isn't passing on an empty site.
    await withRequest(webOrigin(), async (request) => {
        expect(await (await request.get('/')).text()).toContain(PUBLISHED_IDS[0]);
    });
});
