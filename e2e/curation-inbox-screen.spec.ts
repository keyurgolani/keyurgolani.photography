import type { Page } from '@playwright/test';
import { deferEvent } from '../lib/curation/actions';
import { eventIdOf, eventKey } from '../lib/curation/events';
import { LIBRARY_EVENT_ID, recordLibraryState } from '../lib/curation/library';
import { listEvents, readEvent } from '../lib/curation/repository';
import { createCurationSink } from '../lib/curation/sink';
import { READY_TIMEOUT } from './support/catalogServer';
import { signIn, startCuratorServer, type CuratorServer } from './support/curatorServer';
import { createInboxFixture, fact, FAILED_SOURCE, FRESH, openInboxItems, type InboxFixture } from './support/curation-inbox';
import { waitForHydration } from './support/hydration';
import { checkSurface } from './support/surface';
import { expect, test } from './support/test';

// #14's A8 on both #1 projects: the Inbox's Status and Type filters, 50 items a page, age labels, bulk Decide later
// and Leave unassigned with one version per item, the 60 s summary poll, the offline state, the error summary, the
// stale alert that keeps unsaved edits, and checkSurface() at both widths, in Light and Dark. Its own fixture and
// curator server, so the 14-3 spec's counts stay its own.

test.describe.configure({ mode: 'serial' });

const HOOK_TIMEOUT = READY_TIMEOUT + 60_000;
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };

let fixture: InboxFixture | undefined;
let curator: CuratorServer | undefined;

const data = () => {
    if (!fixture) throw new Error('The inbox fixture was not made');
    return fixture;
};
const origin = () => {
    if (!curator) throw new Error('The curator server did not start');
    return curator.origin;
};

/** 55 more files the watcher couldn't read, so the list runs to two pages. */
const EXTRA_FAILURES = 55;

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    fixture = await createInboxFixture();
    await openInboxItems(fixture);
    await createCurationSink({ root: fixture.root, logger: quiet })(
        Array.from({ length: EXTRA_FAILURES }, (_, index) =>
            fact(fixture as InboxFixture, 'processing-failed', null, {
                reason: 'unsupported-format',
                path: `inbox/raw-${String(index).padStart(2, '0')}.heic`,
                assetRevision: `sha256-${index.toString(16).padStart(64, 'd')}`,
                observedAt: `2026-01-${String((index % 27) + 1).padStart(2, '0')}T00:00:00.000Z`,
            }),
        ),
    );
    expect(await recordLibraryState({ available: false, cause: 'missing' }, { root: fixture.root, logger: quiet })).toBe('opened');
    const base = Number(process.env.E2E_CURATION_PORT);
    const pinned = Number.isInteger(base) && base > 0 ? base + 2 * test.info().parallelIndex + 40 : undefined;
    curator = await startCuratorServer(fixture.root, pinned, { library: fixture.library });
});

test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await curator?.stop();
    await fixture?.cleanup();
});

test.beforeEach(async ({ page }) => {
    if (!curator) throw new Error('The curator server did not start');
    await signIn(page, curator.origin, curator.passphrase);
});

const newItem = (photoId: string) => eventIdOf(eventKey('new', fact(data(), 'new', photoId)));

async function openInbox(page: Page, query = '') {
    await page.goto(`${origin()}/curation/inbox${query}`);
    await waitForHydration(page);
}

const list = (page: Page) => page.locator('#inbox-list');
const rows = (page: Page) => list(page).locator('a[data-row]');

for (const theme of ['light', 'dark'] as const) {
    // A phone shows one side at a time, so the list is checked in list view (no item in the URL), at both widths,
    // and the item view on its own (A8 review B2).
    test(`passes checkSurface() on the list, its filters, bulk actions and pager, in ${theme}`, async ({ page }) => {
        await page.evaluate((stored) => localStorage.setItem('theme', stored), theme);
        await openInbox(page);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        const filters = page.getByRole('search', { name: 'Filter the inbox' });
        await checkSurface(page, {
            entries: rows(page),
            controls: [
                filters.getByRole('combobox'),
                filters.getByRole('button', { name: 'Apply filters' }),
                list(page).getByRole('button', { name: 'Refresh inbox' }),
                list(page).getByRole('checkbox'),
                list(page).getByRole('button', { name: /on selected|selected unassigned/ }),
                page.getByRole('navigation', { name: 'Inbox pages' }).getByRole('link'),
            ],
        });
    });

    test(`passes checkSurface() on one item's view, in ${theme}`, async ({ page, isMobile }) => {
        await page.evaluate((stored) => localStorage.setItem('theme', stored), theme);
        await openInbox(page, `?item=${newItem(FRESH.approve)}#item`);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        const item = page.locator('#item');
        await checkSurface(page, {
            controls: [
                item.getByRole('form', { name: 'Review' }).getByRole('button'),
                item.getByRole('combobox'),
                item.getByRole('textbox', { name: 'Draft description' }),
                ...(isMobile ? [item.getByRole('link', { name: 'Back to inbox' })] : []),
            ],
        });
    });
}

test('pages 50 items at a time, each with its age, and the filters keep to their own page', async ({ page }) => {
    await openInbox(page);
    await expect(rows(page)).toHaveCount(50);
    await expect(list(page).getByText(/^Showing 1 to 50 of \d+ items$/)).toBeVisible();
    await expect(rows(page).first().locator('time')).toHaveText(/ago$/);
    await page.getByRole('navigation', { name: 'Inbox pages' }).getByRole('link', { name: 'Next page' }).click();
    await waitForHydration(page);
    await expect(page).toHaveURL(/[?&]page=2/);
    await expect(rows(page).first()).toBeVisible();
    // Type: Processing failure, by keyboard, through the plain GET form.
    const filters = page.getByRole('search', { name: 'Filter the inbox' });
    await filters.getByRole('combobox', { name: 'Type' }).selectOption({ label: 'Processing failure' });
    await filters.getByRole('button', { name: 'Apply filters' }).press('Enter');
    await waitForHydration(page);
    await expect(page).toHaveURL(/type=processing-failure/);
    await expect(page).not.toHaveURL(/page=2/);
    await expect(rows(page)).toHaveCount(50);
    await expect(list(page).getByText(`Showing 1 to 50 of ${EXTRA_FAILURES + 1} items`)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Clear filters' })).toHaveAttribute('href', '/curation/inbox');
});

test('lists the library-unavailable item under its Type filter, and opens it', async ({ page }) => {
    await openInbox(page, '?type=library-unavailable');
    await expect(rows(page)).toHaveCount(1);
    await rows(page).first().click();
    await waitForHydration(page);
    await expect(page).toHaveURL(new RegExp(`type=library-unavailable&item=${LIBRARY_EVENT_ID}#item$`));
    await expect(page.getByRole('heading', { level: 2, name: 'The photo library' })).toBeVisible();
    await expect(page.getByText('The library root is missing')).toBeVisible();
});

test('Decide later on two selected items sends one version each, and lists the one that moved in an error summary that has focus', async ({ page }) => {
    const moved = newItem(FRESH.stale);
    const kept = newItem(FRESH.decorative);
    await openInbox(page, '?type=new');
    // Another tab acts on one of them first.
    const shown = (await readEvent(data().root, moved))!;
    expect(await deferEvent({ root: data().root, eventId: moved, expectedVersion: shown.version, actor: 'curator:cli' })).toMatchObject({ ok: true });
    const before = (await readEvent(data().root, moved))!;
    for (const id of [moved, kept]) await list(page).locator(`input[type="checkbox"][value^="${id}:"]`).check();
    await list(page).getByRole('button', { name: 'Decide later on selected' }).click();
    const summary = page.getByRole('region', { name: '1 item was left as it is' });
    await expect(summary).toBeFocused();
    await expect(summary.getByRole('link')).toHaveAttribute('href', new RegExp(`item=${moved}#item$`));
    await expect(page.getByRole('status', { name: 'Bulk answer' })).toHaveText('Left 1 of 2 items for later.');
    expect(await readEvent(data().root, moved)).toEqual(before);
    expect((await readEvent(data().root, kept))?.status).toBe('deferred');
});

test('polls the summary every minute: says new items once, and raises a stale alert on the open item that keeps the typed text', async ({ page }) => {
    await page.clock.install();
    const open = newItem(FRESH.refused);
    await openInbox(page, `?item=${open}#item`);
    const updates = page.getByRole('status', { name: 'Inbox updates' });
    await expect(updates).toHaveText('');
    await updates.evaluate((region) => {
        const said: string[] = [];
        (window as unknown as { said: string[] }).said = said;
        new MutationObserver(() => {
            const text = region.textContent ?? '';
            if (text && said.at(-1) !== text) said.push(text);
        }).observe(region, { childList: true, characterData: true, subtree: true });
    });
    await page.getByRole('textbox', { name: 'Draft description' }).fill('Typed while the poll ran.');
    // The watcher opens one more item, and the CLI moves the open one.
    await createCurationSink({ root: data().root, logger: quiet })([fact(data(), 'processing-failed', null, { reason: 'unsupported-format', path: 'inbox/late.heic', assetRevision: `sha256-${'f'.repeat(64)}` })]);
    const shown = (await readEvent(data().root, open))!;
    expect(await deferEvent({ root: data().root, eventId: open, expectedVersion: shown.version, actor: 'curator:cli' })).toMatchObject({ ok: true });
    await page.clock.fastForward(60_000);
    await expect(updates).toHaveText(/1 new item needs judgment\. Refresh the inbox(?! to see)/);
    expect((await updates.textContent())?.match(/Refresh the inbox/g)).toHaveLength(1);
    const alert = page.locator('#item [role="alert"][data-state="stale"]');
    await expect(alert).toContainText('changed since the page loaded');
    await expect(alert).toContainText('Your edits are still in the form');
    await expect(page.getByRole('textbox', { name: 'Draft description' })).toHaveValue('Typed while the poll ran.');
    await page.clock.fastForward(60_000);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { said: string[] }).said.filter((text) => /new item/.test(text)).length)).toBe(1);
    await expect(alert).toHaveCount(1);
});

test('shows an offline state when the network goes, and clears it once it is back', async ({ page, context }) => {
    await openInbox(page);
    await context.setOffline(true);
    const offline = page.getByRole('region', { name: 'Offline' });
    await expect(offline).toBeVisible();
    await expect(page.getByRole('status', { name: 'Inbox updates' })).toHaveText(/^You're offline/);
    await context.setOffline(false);
    await expect(offline).toHaveCount(0);
    await expect(page.getByRole('status', { name: 'Inbox updates' })).toHaveText(/^Back online/);
});

test('stops polling quietly once the session ends', async ({ page }) => {
    await page.clock.install();
    await openInbox(page);
    const asked: string[] = [];
    page.on('request', (request) => {
        if (request.url().includes('/api/curation/inbox/summary')) asked.push(request.url());
    });
    await page.context().clearCookies();
    await page.clock.fastForward(60_000);
    await expect.poll(() => asked.length).toBe(1);
    await page.clock.fastForward(10 * 60_000);
    await page.waitForTimeout(500);
    expect(asked).toHaveLength(1);
    await expect(page.getByRole('status', { name: 'Inbox updates' })).toHaveText('');
    await expect(page.getByRole('heading', { level: 1, name: 'Curation inbox' })).toBeVisible();
});

test('answers the summary as no-store JSON with no path, and a bad query with a 400', async ({ page }) => {
    await openInbox(page);
    const ok = await page.request.get(`${origin()}/api/curation/inbox/summary`);
    expect(ok.status()).toBe(200);
    expect(ok.headers()['cache-control']).toMatch(/no-store/);
    const text = await ok.text();
    for (const leak of [data().root, data().library, FAILED_SOURCE]) expect(text).not.toContain(leak);
    expect((await page.request.get(`${origin()}/api/curation/inbox/summary?item=../x`)).status()).toBe(400);
    expect((await page.request.post(`${origin()}/api/curation/inbox/summary`, { headers: { origin: origin() } })).status()).toBe(405);
    expect((await listEvents(data().root)).problems).toEqual([]);
});
