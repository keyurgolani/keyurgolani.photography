import path from 'node:path';
import { request as httpRequest, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { folderBytes } from '../test/helpers/folderBytes';
import { validateWorkingLayer } from '../lib/catalog/publish';
import { readActivePointer, readAuthoredRecord } from '../lib/catalog/working-layer';
import { writeAuthoredRecord } from '../lib/catalog/working-layer-writer';
import { deferEvent } from '../lib/curation/actions';
import { eventIdOf, eventKey } from '../lib/curation/events';
import { humanTime } from '../lib/curation/inbox-view';
import { listEvents, readEvent } from '../lib/curation/repository';
import { confirmReplacement } from '../lib/curation/resolutions';
import { startCatalogServer, READY_TIMEOUT, type CatalogServer } from './support/catalogServer';
import { signIn, startCuratorServer, type CuratorServer } from './support/curatorServer';
import {
    createInboxFixture,
    FAILED_SOURCE,
    FRESH,
    FRESH_SOURCES,
    INBOX_SERIES,
    PUBLISHED_IDS,
    openInboxItems,
    openReplacementItem,
    REPLACED,
    REPLACED_SOURCE,
    REPLACEMENT_REVISION,
    undisclosed,
    type InboxFixture,
} from './support/curation-inbox';
import { holdNextPost } from './support/holdPost';
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
const answer = (page: Page, state: 'done' | 'stale' | 'invalid' | 'refused') => page.getByRole('status').locator(`[data-state="${state}"]`);
/** What the last approval or Decide later did, in the strip at the top of the item it opened. */
const arrival = (page: Page) => page.locator('#item > [role="status"] [data-state="done"]');
/** The strip is on the first screen, above the photograph and the item's heading. */
async function arrivedOnTop(page: Page) {
    const strip = arrival(page);
    await expect(strip).toBeInViewport({ ratio: 1 });
    const box = (await strip.boundingBox())!;
    // The photograph's column follows the strip, and the heading is in the form beside or under it.
    for (const below of [page.locator('#item > [role="status"] + *'), page.locator('#item-heading')]) expect(box.y + box.height).toBeLessThanOrEqual((await below.boundingBox())!.y);
    await expect(page.getByText(/Next up/)).toHaveCount(0);
}
const summary = (page: Page) => page.getByRole('region', { name: 'Curation inbox' }).locator('header p');
/** The item's heading: its source file's name, which is what tells the curator which photograph it is. */
const itemHeading = (page: Page, photoId: string) => page.getByRole('heading', { level: 2, name: path.posix.basename(FRESH_SOURCES[photoId]) });

/** About 320 characters: four lines or more at 1440, six or so on a phone. */
const LONG_DESCRIPTION =
    'Harbor wall at first light, the tide out and the stones still wet, two gulls on the iron rail, the ferry just leaving the far pier with its lights on, a man in a yellow coat walking his dog along the seawall, and the hills behind the town still grey with fog that the sun has not yet burned off the water.';

/**
 * Presses the button by keyboard and holds its action on the way, checking
 * that the button keeps focus while it's pending and says it can't act, as
 * #1's contract asks. A focused button that turned `disabled` dropped focus
 * to the page's body. Then the action goes on.
 */
async function pressWhileHeld(page: Page, button: Locator) {
    await button.focus();
    const held = await holdNextPost(page, '/curation/inbox');
    await page.keyboard.press('Enter');
    await held.sent;
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).toBeFocused();
    await held.release();
}

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

test('the curator header leads, and an empty inbox says once that nothing requires judgment', async ({ page }) => {
    // The login lands on /curation, which leads on to the inbox.
    await page.getByRole('link', { name: 'Open the inbox' }).click();
    await expect(page).toHaveURL(`${curatorOrigin()}/curation/inbox`);
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Portfolio curation' })).toBeVisible();
    const screens = page.getByRole('navigation', { name: 'Curation' });
    await expect(screens.getByRole('link', { name: 'Inbox' })).toHaveAttribute('aria-current', 'page');
    await expect(screens.getByText('Preview & publish')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Curation inbox' })).toBeVisible();
    // Said once: no count above it, and nothing beside it on a wide screen.
    await expect(summary(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Nothing requires judgment' })).toBeVisible();
    await expect(page.getByText(/Nothing (requires judgment|to review)/)).toHaveCount(1);
});

test('lists what the watcher opened, and shows the selected photograph from the curator-only route', async ({ page }) => {
    await openInboxItems(data());
    await openInbox(page);
    await expect(summary(page)).toHaveText('8 items require judgment');
    const list = page.getByRole('list', { name: 'Requires judgment' });
    await expect(list.getByRole('link')).toHaveCount(8);
    // Each row leads with its source file's name, so rows of new photographs tell apart.
    const approveName = path.posix.basename(FRESH_SOURCES[FRESH.approve]);
    const approveRow = list.getByRole('link', { name: new RegExp(approveName.replace('.', '\\.')) });
    await expect(approveRow).toHaveCount(1);
    await expect(approveRow.locator('strong')).toHaveText(approveName);
    // And shows a thumbnail: the set's smallest WebP from the curator-only route, at a fixed size, loaded lazily, with an empty alt.
    const thumb = approveRow.locator('img');
    await expect(thumb).toHaveAttribute('alt', '');
    await expect(thumb).toHaveAttribute('loading', 'lazy');
    const thumbSrc = (await thumb.getAttribute('src')) ?? '';
    expect(thumbSrc).toMatch(new RegExp(`^/api/curation/media/${FRESH.approve}/sha256-[0-9a-f]{64}/p_[0-9a-z]+/w400\\.webp$`));
    await expect.poll(() => thumb.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    expect(await thumb.boundingBox()).toMatchObject({ width: 56, height: 56 });
    const thumbResponse = await page.request.get(`${curatorOrigin()}${thumbSrc}`);
    expect(thumbResponse.status()).toBe(200);
    expect(thumbResponse.headers()['content-type']).toContain('image/webp');
    expect(thumbResponse.headers()['cache-control']).toContain('no-store');
    // A file nothing was made from holds its place with a neutral square, the same size.
    const failedRow = list.getByRole('link', { name: /Processing failed/ });
    await expect(failedRow.locator('img')).toHaveCount(0);
    await expect(failedRow.locator('[data-thumb="none"]')).toBeVisible();
    expect(await failedRow.locator('[data-thumb="none"]').boundingBox()).toMatchObject({ width: 56, height: 56 });
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
    // A new photograph has no published statement to keep; the missing published one below does.
    await expect(page.getByText('Published statement remains unchanged.')).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Suggested series' })).toBeVisible();
    // Three lines at least, for a sentence.
    const description = page.getByRole('textbox', { name: 'Draft description' });
    const empty = (await description.boundingBox())!.height;
    expect(empty).toBeGreaterThanOrEqual(3 * 16);
    // And it grows with a long description, with nothing hidden behind a scrollbar.
    await description.fill(LONG_DESCRIPTION);
    await expect.poll(async () => (await description.boundingBox())!.height).toBeGreaterThan(empty);
    expect(await description.evaluate((box) => box.scrollHeight - box.clientHeight)).toBeLessThanOrEqual(1);
    await description.fill('');
    // Each ID shows once, in full, and copies whole: the selected text is the value, on one line.
    for (const [label, value] of [['Stable photo identity', FRESH.approve], ['Asset revision', data().revisionOf(FRESH.approve)]]) {
        const cell = page.locator('#item dt').filter({ hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::dd[1]');
        await expect(cell).toHaveCount(1);
        const copied = await cell.evaluate((dd) => {
            const range = document.createRange();
            range.selectNodeContents(dd);
            const selection = window.getSelection()!;
            selection.removeAllRanges();
            selection.addRange(range);
            return selection.toString();
        });
        expect(copied).toBe(value);
    }
});

// The server sends times in UTC; once the page runs they read in the browser's own zone, after hydration, so nothing mismatches.
test("reads times in the browser's zone with no hydration error, from server HTML in UTC with the zone named", async ({ page, browser }) => {
    const url = `${curatorOrigin()}/curation/inbox?item=${eventOf(FRESH.approve)}#item`;
    const storageState = await page.context().storageState();
    // This project's device, so a phone stays a phone.
    const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = test.info().project.use;
    const device = { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent };
    const observed = (on: Page) => on.getByRole('region', { name: 'Source facts' }).locator('dt', { hasText: /^Observed$/ }).locator('xpath=following-sibling::dd[1]/time').first();
    const zoned = await browser.newContext({ ...device, storageState, timezoneId: 'America/Los_Angeles' });
    try {
        const local = await zoned.newPage();
        const problems: string[] = [];
        local.on('console', (message) => {
            if (message.type() === 'error' || /hydrat/i.test(message.text())) problems.push(message.text());
        });
        local.on('pageerror', (error) => problems.push(error.message));
        await local.goto(url);
        await waitForHydration(local);
        await local.waitForLoadState('load');
        const stored = (await observed(local).getAttribute('datetime')) ?? '';
        await expect(observed(local)).toHaveText(humanTime(stored, 'America/Los_Angeles'));
        await expect(observed(local)).toHaveText(/ P[SD]T$/);
        expect(problems.filter((text) => /hydrat|#418|#423|#425|did not match/i.test(text))).toEqual([]);
    } finally {
        await zoned.close();
    }
    // The HTML the server sends: every stored time in UTC, with the zone named. (Without JavaScript the inbox stays on its loading
    // state, since the page streams in behind it, so this reads the server's HTML rather than a page with JavaScript off.)
    const html = await (await page.request.get(url.replace(/#item$/, ''))).text();
    const times = [...html.matchAll(/<time datetime="([^"]+T[^"]+)">([^<]+)<\/time>/gi)].map(([, at, text]) => ({ at, text }));
    expect(times.length).toBeGreaterThan(0);
    for (const { at, text } of times) {
        expect(text).toBe(humanTime(at));
        expect(text).toMatch(/ UTC$/);
    }
});

test('approves a new photograph into the draft with the typed description, and publishes nothing', async ({ page }) => {
    const before = layers();
    await openInbox(page, eventOf(FRESH.approve));
    await page.getByRole('combobox', { name: 'Suggested series' }).selectOption(INBOX_SERIES.draft.id);
    await page.getByRole('combobox', { name: 'Proposed sequence position' }).selectOption('start');
    await page.getByRole('textbox', { name: 'Draft description' }).fill('A harbor wall at first light, typed in the e2e.');
    await pressWhileHeld(page, page.getByRole('button', { name: 'Approve into draft' }));
    // The next item that needs a decision opens, in list order, with its heading focused, and says what was done.
    await expect(page).toHaveURL(`${curatorOrigin()}/curation/inbox?item=${eventOf(FRESH.stale)}#item`);
    await waitForHydration(page);
    await expect(itemHeading(page, FRESH.stale)).toBeFocused();
    // At the top of the item, naming the file it approved, since the heading under it names this one.
    await expect(arrival(page)).toHaveText(/^Approved arrival-approve\.jpg into the draft\. Nothing is published until you publish\./);
    await arrivedOnTop(page);
    // The approved item is one link away, where Reopen is.
    await page.getByRole('link', { name: 'Open arrival-approve.jpg again' }).click();
    await waitForHydration(page);
    await expect(page.getByText('Suggestion approved')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reopen' })).toBeVisible();
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

test('keeps the curator where they were after Save edits from the plain inbox URL, with the answer in view', async ({ page, isMobile }) => {
    // A phone's plain URL shows the list alone, so only a wide screen has an item to save there.
    test.skip(isMobile, 'a wide screen shows an item on the plain inbox URL');
    await openInbox(page);
    await expect(itemHeading(page, FRESH.unassigned)).toBeVisible();
    await page.getByRole('textbox', { name: 'Draft description' }).fill('A harbor wall, saved from the plain inbox URL.');
    const save = page.getByRole('button', { name: 'Save edits' });
    await save.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 40));
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBeGreaterThan(0);
    await save.click();
    await expect(answer(page, 'done')).toHaveText(/^Saved your edits/);
    // The save named the item in the URL, and the refresh after it brought the same item back.
    await expect(page).toHaveURL(`${curatorOrigin()}/curation/inbox?item=${eventOf(FRESH.unassigned)}#item`);
    await expect(itemHeading(page, FRESH.unassigned)).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(before, 0);
    await expect(answer(page, 'done')).toBeInViewport();
    expect((await readEvent(data().root, eventOf(FRESH.unassigned)))?.edits?.description).toMatchObject({ text: 'A harbor wall, saved from the plain inbox URL.' });
});

test('approves "Leave unassigned" when no rules file suggests a series, from the plain inbox URL', async ({ page, isMobile }) => {
    // /curation/inbox with no item, as the header's Inbox link opens it. A wide screen shows the first item that needs judgment beside the list.
    await openInbox(page);
    if (isMobile) {
        // A phone shows the list alone, with no row marked current, since nothing is open; the curator opens the first.
        const rows = page.getByRole('list', { name: 'Requires judgment' }).getByRole('link');
        await expect(page.locator('#inbox-list a[aria-current]')).toHaveCount(0);
        await rows.first().click();
        await waitForHydration(page);
    } else {
        await expect(page).toHaveURL(`${curatorOrigin()}/curation/inbox`);
    }
    await expect(itemHeading(page, FRESH.unassigned)).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Suggested series' })).toHaveValue('unassigned');
    await page.getByRole('button', { name: 'Approve into draft' }).click();
    // It moves on from there too, and says what it did.
    await expect(page).toHaveURL(`${curatorOrigin()}/curation/inbox?item=${eventOf(FRESH.reopen)}#item`);
    await waitForHydration(page);
    await expect(itemHeading(page, FRESH.reopen)).toBeFocused();
    await expect(arrival(page)).toHaveText(/^Approved arrival-unassigned\.jpg into the draft\. Nothing is published until you publish\./);
    await arrivedOnTop(page);
    await expect(arrival(page).getByRole('link', { name: 'Open arrival-unassigned.jpg again' })).toHaveAttribute('href', `/curation/inbox?item=${eventOf(FRESH.unassigned)}#item`);
    expect((await readEvent(data().root, eventOf(FRESH.unassigned)))?.decisions.at(-1)).toMatchObject({ action: 'approve', seriesId: null });
});

test('clears a decorative flag on a reopened item, so the description gate holds the photo back', async ({ page }) => {
    await openInbox(page, eventOf(FRESH.reopen));
    await page.getByRole('combobox', { name: 'Suggested series' }).selectOption(INBOX_SERIES.published.id);
    await page.getByRole('checkbox', { name: /Decorative/ }).check();
    await page.getByRole('button', { name: 'Approve into draft' }).click();
    await expect(page).toHaveURL(/\?item=evt_[0-9a-f]{24}#item$/);
    await expect(page).not.toHaveURL(new RegExp(eventOf(FRESH.reopen)));
    await expect(arrival(page)).toHaveText(/^Approved arrival-reopen\.jpg into the draft/);
    // The approval moved on to the next item; Reopen is on the approved one, and stays there once pressed.
    await page.getByRole('link', { name: 'Open arrival-reopen.jpg again' }).click();
    await waitForHydration(page);
    await page.getByRole('button', { name: 'Reopen' }).click();
    await expect(answer(page, 'done')).toHaveText('Reopened.');
    await expect(page).toHaveURL(`${curatorOrigin()}/curation/inbox?item=${eventOf(FRESH.reopen)}#item`);
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

test('dismisses an unreadable file with a reason, then reopens it', async ({ page, isMobile }) => {
    const { events } = await listEvents(data().root);
    const failed = events.find((event) => event.type === 'processing-failure')!;
    await openInbox(page, failed.id);
    // Why, and what to do, on the first screen, not only in Source facts.
    await expect(page.getByText("This is a HEIC file, which the watcher doesn't read.")).toBeInViewport();
    await expect(page.getByText(/^The watcher reads JPEG, PNG and WebP\./)).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Retry processing' })).toHaveCount(0);
    await page.getByText('Dismiss with a reason').click();
    await page.getByRole('textbox', { name: 'Reason' }).fill('An export from another app; the JPEG is already in.');
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(answer(page, 'done')).toHaveText('Dismissed.');
    await expect(page.locator('header').getByText('Dismissed', { exact: true })).toBeVisible();
    // A wide screen lists it under Settled beside the item; a phone shows the item alone, so the list waits behind Back to inbox.
    if (isMobile) await expect(page.getByRole('heading', { name: 'Settled' })).toBeHidden();
    else await expect(page.getByRole('heading', { name: 'Settled' })).toBeVisible();
    await page.getByRole('button', { name: 'Reopen' }).click();
    await expect(answer(page, 'done')).toHaveText('Reopened.');
    expect((await readEvent(data().root, failed.id))?.status).toBe('failed');
});

test('shows a phone one item at a time, and Back to inbox or the browser Back returns to the row it came from', async ({ page, isMobile }) => {
    await openInbox(page);
    const list = page.locator('#inbox-list');
    if (!isMobile) {
        // A wide screen keeps the list beside the item, so it needs no way back.
        await expect(list).toBeVisible();
        await expect(page.locator('#item')).toBeVisible();
        await expect(page.getByRole('link', { name: 'Back to inbox' })).toBeHidden();
        return;
    }
    // The list alone, until an item is opened.
    await expect(list).toBeVisible();
    await expect(page.locator('#item')).toBeHidden();
    // Refresh reads the list again and stays on it: the item the server selects for a wide screen doesn't open.
    await page.getByRole('button', { name: 'Refresh inbox' }).click();
    await expect(page).toHaveURL(new RegExp(`^${curatorOrigin()}/curation/inbox\\??$`));
    await waitForHydration(page);
    await expect(list).toBeVisible();
    await expect(page.locator('#item')).toBeHidden();
    const row = list.getByRole('link').last();
    await row.scrollIntoViewIfNeeded();
    const scrolled = await page.evaluate(() => window.scrollY);
    expect(scrolled).toBeGreaterThan(0);
    const rowId = (await row.getAttribute('data-row')) ?? '';
    await row.click();
    // The URL rows already use for the item; the item alone, its heading focused.
    await expect(page).toHaveURL(`${curatorOrigin()}/curation/inbox?item=${rowId}#item`);
    await waitForHydration(page);
    await expect(list).toBeHidden();
    await expect(page.locator('#item-heading')).toBeFocused();
    await expect(page.locator('#item-heading')).toBeInViewport();
    // Back to inbox stays at the top while the form scrolls, so the way out is always one tap.
    const backLink = page.getByRole('link', { name: 'Back to inbox' });
    await page.evaluate(() => window.scrollTo(0, 1200));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(600);
    await expect(backLink).toBeInViewport({ ratio: 1 });
    expect((await backLink.boundingBox())?.y).toBe(0);
    expect((await backLink.boundingBox())?.height).toBeGreaterThanOrEqual(44);

    await backLink.click();
    await expect(page).toHaveURL(`${curatorOrigin()}/curation/inbox#row-${rowId}`);
    await waitForHydration(page);
    const back = page.locator(`#row-${rowId}`);
    await expect(back).toBeFocused();
    await expect(back).toBeInViewport();
    await expect(page.locator('#item')).toBeHidden();
    // Only the row it came back to reads as where the curator is: no other row is marked current.
    await expect(list.locator('a[aria-current]')).toHaveCount(0);
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrolled)).toBeLessThanOrEqual(2);

    // The browser's Back does the same.
    await back.click();
    await expect(page).toHaveURL(`${curatorOrigin()}/curation/inbox?item=${rowId}#item`);
    await waitForHydration(page);
    await expect(list).toBeHidden();
    await page.goBack();
    await expect(page).toHaveURL(`${curatorOrigin()}/curation/inbox#row-${rowId}`);
    await waitForHydration(page);
    await expect(page.locator(`#row-${rowId}`)).toBeFocused();
    await expect(page.locator(`#row-${rowId}`)).toBeInViewport();
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrolled)).toBeLessThanOrEqual(2);
});

// The walkthrough on 018ec79a found a phone in the light theme left at the top of the page; the curator lands the same in Dark and in Light.
for (const theme of ['dark', 'light'] as const) {
    test(`lands a phone's opened item at the top in the ${theme} theme, its heading focused`, async ({ page, isMobile }) => {
        test.skip(!isMobile, 'a wide screen shows the item beside the list');
        await page.evaluate((stored) => localStorage.setItem('theme', stored), theme);
        await openInbox(page);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        const row = page.locator('#inbox-list').getByRole('link').first();
        const rowId = (await row.getAttribute('data-row')) ?? '';
        // A full load of the row's URL, as a tap on it makes.
        await row.click();
        await expect(page).toHaveURL(`${curatorOrigin()}/curation/inbox?item=${rowId}#item`);
        await waitForHydration(page);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        // Through the load event too, so a late layout can't take the page back to the header.
        await page.waitForLoadState('load');
        await expect(page.locator('#item-heading')).toBeFocused();
        await expect.poll(() => page.evaluate(() => Math.round(document.getElementById('item')!.getBoundingClientRect().top))).toBe(0);
        expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
        expect((await page.getByRole('link', { name: 'Back to inbox' }).boundingBox())?.y).toBe(0);
    });
}

test('Decide later moves on to the next item too, and the last decision, from the plain inbox URL, shows the empty state', async ({ page, isMobile }) => {
    const { events } = await listEvents(data().root);
    const missing = events.find((event) => event.type === 'missing')!;
    const failed = events.find((event) => event.type === 'processing-failure')!;
    await openInbox(page, missing.id, { landed: true });
    // The active revision holds it, so its published statement is kept, and the page says so.
    await expect(page.getByText('Published statement remains unchanged.')).toBeVisible();
    await pressWhileHeld(page, page.getByRole('button', { name: 'Decide later' }));
    await expect(page).toHaveURL(`${curatorOrigin()}/curation/inbox?item=${failed.id}#item`);
    await waitForHydration(page);
    await expect(page.getByRole('heading', { level: 2, name: path.posix.basename(FAILED_SOURCE) })).toBeFocused();
    const missingName = path.posix.basename(missing.derivedFacts.sourcePath);
    await expect(arrival(page)).toHaveText(`Left ${missingName} for later. Nothing in the draft changed.Open ${missingName} again`);
    await arrivedOnTop(page);
    // The last one, from /curation/inbox with no item: a wide screen shows it beside the list, a phone opens its row.
    await openInbox(page);
    if (isMobile) {
        await page.getByRole('list', { name: 'Requires judgment' }).getByRole('link').first().click();
        await waitForHydration(page);
    }
    await expect(page.getByRole('heading', { level: 2, name: path.posix.basename(FAILED_SOURCE) })).toBeVisible();
    await page.getByRole('button', { name: 'Decide later' }).click();
    // Nothing else needs a decision, so the inbox opens on its empty state and says so.
    await expect(page).toHaveURL(`${curatorOrigin()}/curation/inbox`);
    await waitForHydration(page);
    await expect(page.getByText('Nothing requires judgment right now.')).toBeFocused();
    await expect(answer(page, 'done')).toHaveText(`Left ${path.posix.basename(FAILED_SOURCE)} for later. Nothing in the draft changed.Open ${path.posix.basename(FAILED_SOURCE)} again`);
    // Said once: the focused line says nothing requires judgment.
    await expect(page.getByText('Nothing else requires judgment')).toHaveCount(0);
    await expect(summary(page)).toHaveText(/^0 of \d+ items require judgment/);
    await expect(page.getByRole('link', { name: `Open ${path.posix.basename(FAILED_SOURCE)} again` })).toBeVisible();
    for (const id of [missing.id, failed.id]) expect((await readEvent(data().root, id))?.status).toBe('deferred');
});

test('says what a replacement\'s draft holds before and after Reopen and Decide later, once it was confirmed (#17)', async ({ page }) => {
    const root = data().root;
    const eventId = await openReplacementItem(data());
    const earlier = data().revisionOf(REPLACED);
    const file = path.posix.basename(REPLACED_SOURCE);
    const base = (await readActivePointer(root))?.revisionId ?? null;
    const hint = page.locator('#primary-unavailable');
    const pinned = async () => (await readAuthoredRecord(root, 'photo', REPLACED))?.assetRevision;
    // `curation confirm`, which the inbox doesn't offer yet.
    const confirm = async () => {
        const shown = (await readEvent(root, eventId))!;
        expect(await confirmReplacement({ root, eventId, expectedVersion: shown.version, expectedBase: base, actor: 'curator:cli' })).toMatchObject({ ok: true });
    };
    // A photos edit of the record's assetRevision, outside the inbox.
    const edit = async (assetRevision: string) => {
        const record = (await readAuthoredRecord(root, 'photo', REPLACED))!;
        await writeAuthoredRecord({ ...record, assetRevision }, { expectedVersion: record.version, root });
    };
    const reopen = async (message: string) => {
        await openInbox(page, eventId);
        await page.getByRole('button', { name: 'Reopen' }).click();
        await expect(answer(page, 'done')).toHaveText(message);
    };
    /** What Decide later did, on the page it opened: the next item's strip, or the empty state's answer. */
    const decidedLater = async (text: string) => {
        await page.getByRole('button', { name: 'Decide later' }).click();
        await expect(page).not.toHaveURL(new RegExp(eventId));
        await waitForHydration(page);
        await expect(page.locator('[data-state="done"]').filter({ hasText: `Left ${file} for later.` })).toHaveText(`${text}Open ${file} again`);
    };

    // Never confirmed: Decide later writes nothing.
    await openInbox(page, eventId);
    await expect(page.getByRole('heading', { level: 2, name: file })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm new asset revision' })).toBeDisabled();
    await expect(hint).toHaveText(/^Confirming a new version isn't in the inbox yet, so choose Decide later until it is\./);

    // Confirmed: in the draft only, and nothing on the item offers or recommends Decide later, or a series or description.
    await confirm();
    expect(await pinned()).toBe(REPLACEMENT_REVISION);
    await openInbox(page, eventId);
    await expect(page.locator('header').getByText('New version confirmed', { exact: true })).toBeVisible();
    await expect(page.getByText('Suggestion approved')).toHaveCount(0);
    await expect(page.getByText('The draft uses the new version. Visitors keep the current one until you publish.')).toBeVisible();
    await expect(page.getByText(/^Live in the active revision/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Confirm new asset revision' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Decide later' })).toHaveCount(0);
    await expect(page.getByText(/choose Decide later|series or description/)).toHaveCount(0);
    await expect(page.getByText('Reopen it to leave the new version out of the draft. Decide later then puts the earlier version back.')).toBeVisible();

    // Reopened: the draft still uses the new version, and the item says before the click that Decide later puts the earlier one back.
    await reopen('Reopened. The draft still uses the new version until you decide.');
    await expect(hint).toHaveText('The draft uses the new version, confirmed earlier. Decide later puts the earlier version back in the draft. Nothing is published until you publish.');
    await decidedLater(`Left ${file} for later. The draft is back on the earlier version of this photograph, and the next publish uses that one.`);
    expect(await pinned()).toBe(earlier);

    // A photos edit puts the new version in the draft with no confirm of this item: Decide later keeps it, and says the next publish uses it.
    await reopen('Reopened.');
    await edit(REPLACEMENT_REVISION);
    await openInbox(page, eventId);
    await expect(hint).toHaveText('The draft already uses the new version, so Decide later keeps it there, and the next publish uses it. Nothing is published until you publish.');
    await decidedLater(`Left ${file} for later. The draft already uses the new version of this photograph, so the next publish uses it too.`);
    expect(await pinned()).toBe(REPLACEMENT_REVISION);

    // Confirmed again from the earlier version, reopened, then the draft moves to a third version: the page knows Decide later
    // would refuse, so it shows it disabled, with the hint, in its own words, as its reason, every time.
    await edit(earlier);
    await reopen('Reopened.');
    await confirm();
    await reopen('Reopened. The draft still uses the new version until you decide.');
    const third = `sha256-${'c'.repeat(64)}`;
    await edit(third);
    const moved = "This photograph's draft moved to another version after the new one was confirmed, so Decide later can't tell which one to put back. Set its version with photos edit, or dismiss this item.";
    for (let attempt = 0; attempt < 2; attempt += 1) {
        await openInbox(page, eventId);
        await expect(hint).toHaveText(moved);
        const before = await readEvent(root, eventId);
        const later = page.getByRole('button', { name: 'Decide later' });
        await expect(later).toBeDisabled();
        await expect(later).toHaveAccessibleDescription(moved);
        await expect(page.getByRole('button', { name: 'Confirm new asset revision' })).toHaveAccessibleDescription("Confirming a new version isn't in the inbox yet.");
        // Said once, and nothing to refresh.
        await expect(page.getByText(moved)).toHaveCount(1);
        await expect(page.getByRole('link', { name: 'Refresh and review again' })).toHaveCount(0);
        expect(await readEvent(root, eventId)).toEqual(before);
        expect(await pinned()).toBe(third);
    }
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
                `/api/curation/media/${set}/w400.webp`,
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
