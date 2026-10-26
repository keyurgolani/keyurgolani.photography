import path from 'node:path';
import { request as httpRequest, type APIRequestContext, type Page } from '@playwright/test';
import { folderBytes } from '../test/helpers/folderBytes';
import { validateWorkingLayer } from '../lib/catalog/publish';
import { readAuthoredRecord } from '../lib/catalog/working-layer';
import { deferEvent } from '../lib/curation/actions';
import { eventIdOf, eventKey } from '../lib/curation/events';
import { listEvents, readEvent } from '../lib/curation/repository';
import { startCatalogServer, READY_TIMEOUT, type CatalogServer } from './support/catalogServer';
import { signIn, startCuratorServer, type CuratorServer } from './support/curatorServer';
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
let curator: CuratorServer | undefined;
let web: CatalogServer | undefined;

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    fixture = await createInboxFixture();
    // E2E_CURATION_PORT pins two ports per worker, for a machine that hands out ranges.
    const base = Number(process.env.E2E_CURATION_PORT);
    const pinned = Number.isInteger(base) && base > 0 ? base + 2 * test.info().parallelIndex : undefined;
    // The curator with 14-2b's login: test secret files made for this run, a test passphrase never printed.
    curator = await startCuratorServer(fixture.root, pinned, { library: fixture.library });
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
const answer = (page: Page, state: 'done' | 'stale' | 'invalid') => page.getByRole('status').locator(`[data-state="${state}"]`);
const summary = (page: Page) => page.getByRole('region', { name: 'Curation inbox' }).locator('header p');
/** The item's heading: its source file's name, which is what tells the curator which photograph it is. */
const itemHeading = (page: Page, photoId: string) => page.getByRole('heading', { level: 2, name: path.posix.basename(FRESH_SOURCES[photoId]) });

/** `landed` opens the item on `#item`, as its row link does, so a link back to the same URL only scrolls unless the page reloads it. */
async function openInbox(page: Page, item?: string, { landed = false }: { landed?: boolean } = {}) {
    await page.goto(`${curatorOrigin()}/curation/inbox${item ? `?item=${item}` : ''}${landed ? '#item' : ''}`);
    await waitForHydration(page);
}

// Every curator page needs a session, so each test signs in through the login form first.
test.beforeEach(async ({ page }) => {
    if (!curator) throw new Error('The curator server did not start');
    await signIn(page, curator.origin, curator.passphrase);
});

test('the curator header leads, and an empty inbox says nothing requires judgment', async ({ page }) => {
    // The login lands on /curation, which leads on to the inbox.
    await page.getByRole('link', { name: 'Open the inbox' }).click();
    await expect(page).toHaveURL(`${curatorOrigin()}/curation/inbox`);
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
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
    await expect(summary(page)).toHaveText('8 items require judgment');
    const list = page.getByRole('list', { name: 'Requires judgment' });
    await expect(list.getByRole('link')).toHaveCount(8);
    // Each row names its source file, so rows of new photographs tell apart.
    await expect(list.getByRole('link', { name: new RegExp(FRESH_SOURCES[FRESH.approve]) })).toHaveCount(1);
    await list.getByRole('link', { name: /Uncurated photograph/ }).first().click();
    await waitForHydration(page);
    // The row's link lands on the item itself, so on a phone it isn't under the list.
    await expect(page).toHaveURL(/#item$/);
    await expect(itemHeading(page, FRESH.approve)).toBeInViewport();
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
    await page.getByRole('button', { name: 'Approve into draft' }).click();
    await expect(answer(page, 'done')).toHaveText(/^Approved into the draft\. Nothing is published until you publish\./);
    await expect(page.getByText('Suggestion approved')).toBeVisible();
    expect(layers()).toEqual(before);
    expect((await readAuthoredRecord(data().root, 'photo', FRESH.approve))?.alt).toEqual({ kind: 'described', text: 'A harbor wall at first light, typed in the e2e.', reviewed: true });
    expect((await readAuthoredRecord(data().root, 'series', INBOX_SERIES.draft.id))?.photoIds[0]).toBe(FRESH.approve);
});

test('turns away an action on an item that changed since the page loaded, and writes nothing', async ({ page }) => {
    const eventId = eventOf(FRESH.stale);
    // Opened the way a curator reaches it, through its row link, so "Refresh and review again" names the URL the page is already on.
    await openInbox(page, eventId, { landed: true });
    await expect(page).toHaveURL(`${curatorOrigin()}/curation/inbox?item=${eventId}#item`);
    await expect(itemHeading(page, FRESH.stale)).toBeVisible();
    // The CLI, or another tab, acts on it first.
    const shown = (await readEvent(data().root, eventId))!;
    expect(await deferEvent({ root: data().root, eventId, expectedVersion: shown.version, actor: 'curator:cli' })).toMatchObject({ ok: true });
    const moved = (await readEvent(data().root, eventId))!;
    await page.getByRole('textbox', { name: 'Draft description' }).fill('Typed before the refresh.');
    await page.getByRole('button', { name: 'Approve into draft' }).click();
    await expect(answer(page, 'stale')).toContainText('changed since the page loaded');
    await expect(page.getByRole('textbox', { name: 'Draft description' })).toHaveValue('Typed before the refresh.');
    expect(await readEvent(data().root, eventId)).toEqual(moved);
    expect(await readAuthoredRecord(data().root, 'photo', FRESH.stale)).toBeNull();
    const refresh = page.getByRole('link', { name: 'Refresh and review again' });
    await expect(refresh).toHaveAttribute('href', `/curation/inbox?item=${eventId}#item`);
    await refresh.click();
    await waitForHydration(page);
    await expect(page.locator('header').getByText('Left for later', { exact: true })).toBeVisible();
});

test('clears a saved Decorative flag the curator unchecks, so the description gate holds the photo back', async ({ page }) => {
    await openInbox(page, eventOf(FRESH.decorative));
    await page.getByRole('checkbox', { name: /Decorative/ }).check();
    await page.getByRole('button', { name: 'Save edits' }).click();
    await expect(answer(page, 'done')).toHaveText(/^Saved your edits/);
    await openInbox(page, eventOf(FRESH.decorative));
    const box = page.getByRole('checkbox', { name: /Decorative/ });
    await expect(box).toBeChecked();
    await box.uncheck();
    await page.getByRole('button', { name: 'Save edits' }).click();
    await expect(answer(page, 'done')).toHaveText(/^Saved your edits/);
    expect((await readEvent(data().root, eventOf(FRESH.decorative)))?.edits?.description).toBeNull();
    await page.getByRole('combobox', { name: 'Suggested series' }).selectOption(INBOX_SERIES.published.id);
    await page.getByRole('button', { name: 'Approve into draft' }).click();
    await expect(answer(page, 'done')).toContainText('no description yet');
    expect((await readAuthoredRecord(data().root, 'photo', FRESH.decorative))?.alt).toBeNull();
    // #13's description gate, as publish runs it, holds the photograph back.
    const validation = await validateWorkingLayer({ dataRoot: data().root });
    expect(validation.issues.filter((issue) => issue.code === 'description.required' && issue.record.id === FRESH.decorative)).toHaveLength(1);
});

test('stores the series it shows after a refused answer', async ({ page }) => {
    await openInbox(page, eventOf(FRESH.refused));
    const series = page.getByRole('combobox', { name: 'Suggested series' });
    await series.selectOption(INBOX_SERIES.draft.id);
    const description = page.getByRole('textbox', { name: 'Draft description' });
    await description.fill('<b>Harbor</b>');
    await page.getByRole('button', { name: 'Approve into draft' }).click();
    // The refusal shows by the description field, which is marked and takes focus.
    await expect(description).toHaveAccessibleDescription(/markup/);
    await expect(description).toHaveAttribute('aria-invalid', 'true');
    await expect(description).toBeFocused();
    await expect(series).toHaveValue(INBOX_SERIES.draft.id);
    await page.getByRole('textbox', { name: 'Draft description' }).fill('Harbor wall, fixed after the refusal.');
    // Read before approving: an approved item no longer offers the suggestion.
    const shown = await series.inputValue();
    await page.getByRole('button', { name: 'Approve into draft' }).click();
    await expect(answer(page, 'done')).toBeVisible();
    expect((await readAuthoredRecord(data().root, 'series', shown))?.photoIds).toContain(FRESH.refused);
});

test('approves "Leave unassigned" when no rules file suggests a series', async ({ page }) => {
    await openInbox(page, eventOf(FRESH.unassigned));
    await expect(page.getByRole('combobox', { name: 'Suggested series' })).toHaveValue('unassigned');
    await page.getByRole('button', { name: 'Approve into draft' }).click();
    await expect(answer(page, 'done')).toBeVisible();
    expect((await readEvent(data().root, eventOf(FRESH.unassigned)))?.decisions.at(-1)).toMatchObject({ action: 'approve', seriesId: null });
});

test('clears a decorative flag on a reopened item, so the description gate holds the photo back', async ({ page }) => {
    await openInbox(page, eventOf(FRESH.reopen));
    await page.getByRole('combobox', { name: 'Suggested series' }).selectOption(INBOX_SERIES.published.id);
    await page.getByRole('checkbox', { name: /Decorative/ }).check();
    await page.getByRole('button', { name: 'Approve into draft' }).click();
    await expect(answer(page, 'done')).toHaveText(/^Approved into the draft/);
    await page.getByRole('button', { name: 'Reopen' }).click();
    await expect(answer(page, 'done')).toHaveText('Reopened.');
    // The reopened form starts from the photo record and the series that holds it.
    await openInbox(page, eventOf(FRESH.reopen));
    await expect(page.getByRole('combobox', { name: 'Suggested series' })).toHaveValue(INBOX_SERIES.published.id);
    const box = page.getByRole('checkbox', { name: /Decorative/ });
    await expect(box).toBeChecked();
    await box.uncheck();
    await page.getByRole('button', { name: 'Approve into draft' }).click();
    await expect(answer(page, 'done')).toContainText('no description yet');
    expect((await readAuthoredRecord(data().root, 'photo', FRESH.reopen))?.alt).toBeNull();
    const validation = await validateWorkingLayer({ dataRoot: data().root });
    expect(validation.issues.filter((issue) => issue.code === 'description.required' && issue.record.id === FRESH.reopen)).toHaveLength(1);
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
