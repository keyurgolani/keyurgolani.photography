import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import { eventIdOf, eventKey } from '../lib/curation/events';
import { bindAnswer, LIBRARY_BANNER, RELEASE_HINT, RELEASED_ANSWER, RESTORED_TEXT, restoreHint } from '../lib/curation/inbox-view';
import { heldMissingIds, LIBRARY_EVENT_ID } from '../lib/curation/library';
import { listEvents, readEvent } from '../lib/curation/repository';
import { createCurationSink } from '../lib/curation/sink';
import { identityPaths, readRegistry, writeRegistry } from '../lib/identity/registry';
import type { IdentityFact } from '../lib/identity/types';
import { expectNoA11yViolations } from './support/a11y';
import { READY_TIMEOUT } from './support/catalogServer';
import { signIn, startCuratorServer, type CuratorServer } from './support/curatorServer';
import { createInboxFixture, DRAFT_ID, fact, FRESH, FRESH_SOURCES, type InboxFixture } from './support/curation-inbox';
import { waitForHydration } from './support/hydration';
import { checkSurface } from './support/surface';
import { expectMinTargetSize } from './support/targets';
import { expect, test } from './support/test';

// #17's three Inbox pieces on both #1 projects, on a fixture and a curator server of their own: Restore in Approve's
// place on a new photograph whose bytes are an archived one's; Bind's suggested files, which are `curation show`'s;
// and the held missing items while the library item is open, with the Status filter's Held, Release on each, the
// banner, and the held count. Sample values only. The fixture's temp folder stays for the runner to clear.
//
// Each row stands on its own: it reads what's held from the data root when it runs, and touches only its own items,
// so one row failing never skips the rest, and a worker started again after a failure makes a fresh fixture.

test.describe.configure({ mode: 'default' });

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

const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rev = (text: string) => `sha256-${createHash('sha256').update(text).digest('hex')}`;

/** The archived photograph a Restore brings back, and the new photograph whose bytes are its. */
const ARCHIVED = FRESH.reopen;
const DUPLICATE = id(41);
const DUPLICATE_PATH = 'returned/arrival-reopen.jpg';
const DUPLICATE_REVISION = rev('e2e inbox duplicate bytes');
/** The new photograph the watcher suggests for the missing draft photograph, by its file name. */
const SUGGESTED = id(42);
const SUGGESTED_REVISION = rev('e2e inbox suggested bytes');
/** 30 more present photographs, 20 of which go missing in one pass: the library item opens and holds those. */
const BULK = 30;
const HELD = 20;
const OUTAGE = '2026-02-01T02:00:00.000Z';

let suggestedPath = '';
let missingId = '';

const newItemOf = (photoId: string, assetRevision: string) => eventIdOf(eventKey('new', { photoId, assetRevision, key: `new:${photoId}:${assetRevision}` }));

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    fixture = await createInboxFixture();
    const f = fixture;
    const sink = createCurationSink({ root: f.root, logger: quiet });
    const registry = await readRegistry(f.root);
    const template = registry.photos[DRAFT_ID];
    const copyOf = (photoId: string, at: string, assetRevision: string, extra: Partial<typeof template> = {}) => ({
        ...template,
        photoId,
        createdAt: '2026-02-01T00:05:00.000Z',
        source: { ...template.source, path: at, key: at.toLowerCase(), present: true, observedRevision: assetRevision, lastSeenAt: '2026-02-01T00:05:00.000Z' },
        sourceHealth: 'present' as const,
        duplicateOf: null,
        revisions: { [assetRevision]: { ...template.revisions[template.source.observedRevision], assetRevision, pixelDigest: rev(`${assetRevision} pixels`), firstSeenAt: '2026-02-01T00:05:00.000Z', firstSeenPath: at, profiles: {} } },
        ...extra,
    });

    // Restore: the archived photograph's bytes back at another path, a new photograph the registry says is its copy.
    registry.photos[ARCHIVED] = { ...registry.photos[ARCHIVED], sourceHealth: 'archived', source: { ...registry.photos[ARCHIVED].source, present: false } };
    registry.photos[DUPLICATE] = copyOf(DUPLICATE, DUPLICATE_PATH, DUPLICATE_REVISION, { duplicateOf: ARCHIVED });

    // Bind's suggestion: the draft photograph's file gone, and other pixels with its file name in another folder.
    const draftPath = template.source.path;
    suggestedPath = `edits/${path.posix.basename(draftPath)}`;
    registry.photos[DRAFT_ID] = { ...template, sourceHealth: 'missing', source: { ...template.source, present: false } };
    registry.photos[SUGGESTED] = copyOf(SUGGESTED, suggestedPath, SUGGESTED_REVISION);

    // Held: 30 more present photographs, then 20 of them missing in one pass.
    const bulk = Array.from({ length: BULK }, (_, index) => {
        const at = `bulk/photo-${String(index).padStart(2, '0')}.jpg`;
        const record = copyOf(id(100 + index), at, rev(`e2e inbox bulk ${index}`));
        registry.photos[record.photoId] = record;
        return record;
    });
    for (const record of bulk.slice(0, HELD)) registry.photos[record.photoId] = { ...record, sourceHealth: 'missing', source: { ...record.source, present: false } };
    await writeRegistry(f.root, registry, registry.version);

    await sink([
        fact(f, 'new', DUPLICATE, { assetRevision: DUPLICATE_REVISION, path: DUPLICATE_PATH, duplicateOf: ARCHIVED, observedAt: '2026-02-01T00:05:00.000Z' }),
        fact(f, 'missing', DRAFT_ID, { observedAt: '2026-02-01T00:05:00.000Z' }),
        fact(f, 'new', SUGGESTED, { assetRevision: SUGGESTED_REVISION, path: suggestedPath, suggestedFor: DRAFT_ID, suggestedBy: 'basename', observedAt: '2026-02-01T00:06:00.000Z' }),
    ]);
    const missingFacts: IdentityFact[] = bulk.slice(0, HELD).map((record) => fact(f, 'missing', record.photoId, { assetRevision: record.source.observedRevision, path: record.source.path, observedAt: OUTAGE }));
    await sink(missingFacts);
    expect(new Set(await heldNow())).toEqual(new Set(missingFacts.map((entry) => eventIdOf(eventKey('missing', entry)))));
    missingId = eventIdOf(eventKey('missing', fact(f, 'missing', DRAFT_ID)));
    expect((await readEvent(f.root, LIBRARY_EVENT_ID))?.status).toBe('open');

    const base = Number(process.env.E2E_CURATION_PORT);
    const pinned = Number.isInteger(base) && base > 0 ? base + 2 * test.info().parallelIndex + 40 : undefined;
    curator = await startCuratorServer(f.root, pinned, { library: f.library });
});

test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await curator?.stop();
    fixture?.watcher.stop();
});

test.beforeEach(async ({ page }) => {
    if (!curator) throw new Error('The curator server did not start');
    await signIn(page, curator.origin, curator.passphrase);
});

async function openInbox(page: Page, query = '') {
    await page.goto(`${origin()}/curation/inbox${query}`);
    await waitForHydration(page);
}

function pendingDecisions(): { type: string; path?: string; photoId?: string; merge?: string }[] {
    const dir = identityPaths(data().root).decisions;
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))) : [];
}

/** The missing items the library item holds now, as the page counts them: a row that releases one changes it. */
async function heldNow(): Promise<string[]> {
    const { events } = await listEvents(data().root);
    return heldMissingIds(events, events.find((event) => event.id === LIBRARY_EVENT_ID));
}

/** The banner. Exact, since the library item's own box is a region named "Library unavailable". */
const banner = (page: Page) => page.getByRole('region', { name: 'Library', exact: true });

const answer = (page: Page, state: 'done') => page.getByRole('status').locator(`[data-state="${state}"]`);

test('shows the library banner on the first load, above the list and the item, linking to the library item (#17)', async ({ page }) => {
    const held = (await heldNow()).length;
    await openInbox(page);
    const strip = banner(page);
    await expect(strip).toBeVisible();
    await expect(strip).toHaveAttribute('data-tone', 'alert');
    await expect(strip).toHaveText(new RegExp(`^The library can't be reached \\(one pass found ${HELD} of \\d+ bound sources missing\\), so nothing changes until it's back\\. ${held} missing items are on hold\\.$`));
    // Under the header, above both sides, as the watcher's strip is.
    const [bannerBox, listBox] = await Promise.all([strip.boundingBox(), page.locator('#inbox-list').boundingBox()]);
    expect(bannerBox && listBox && bannerBox.y + bannerBox.height <= listBox.y + 1).toBe(true);
    await expectNoA11yViolations(page, { include: '#library' });
    await strip.getByRole('link', { name: LIBRARY_BANNER.lead }).click();
    await expect(page).toHaveURL(new RegExp(`\\?item=${LIBRARY_EVENT_ID}#item$`));
    await expect(page.getByRole('heading', { level: 2, name: 'The photo library' })).toBeVisible();
});

test('counts the held items apart from the judgment count, and lists them under the Status filter\'s Held (#17)', async ({ page }) => {
    const held = await heldNow();
    expect(held.length).toBeGreaterThan(0);
    await openInbox(page);
    await expect(page.locator('#inbox-list header p')).toHaveText(new RegExp(`^\\d+ of \\d+ items require judgment, ${held.length} held`));
    const filters = page.getByRole('search', { name: 'Filter the inbox' });
    await filters.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'Held' });
    await filters.getByRole('button', { name: 'Apply filters' }).click();
    await waitForHydration(page);
    await expect(page).toHaveURL(/[?&]status=held/);
    await expect(page.getByText(`${held.length} items match these filters`)).toBeVisible();
    const shown = await page.locator('#inbox-list a[data-row]').evaluateAll((links) => links.map((link) => link.getAttribute('data-row')));
    expect(new Set(shown)).toEqual(new Set(held));
});

test('releases one held item with Release and an optional reason, as confirm-missing, and it counts as missing then (#17)', async ({ page, isMobile }) => {
    const held = await heldNow();
    const [first] = held;
    await openInbox(page, `?item=${first}#item`);
    const form = page.getByRole('form', { name: 'Release' });
    await expect(form).toHaveAttribute('data-submit-gate', 'ready');
    await expect(form.getByText(RELEASE_HINT)).toBeVisible();
    const release = form.getByRole('button', { name: 'Release' });
    await expect(release).toHaveAccessibleDescription(RELEASE_HINT);
    await checkSurface(page, {
        controls: [form.getByRole('textbox', { name: 'Reason for releasing' }), release, ...(isMobile ? [page.getByRole('link', { name: 'Back to inbox' })] : [])],
    });
    const before = (await readEvent(data().root, first))!;
    await form.getByRole('textbox', { name: 'Reason for releasing' }).fill('Deleted on purpose.');
    await release.focus();
    await page.keyboard.press('Enter');
    await expect(answer(page, 'done')).toHaveText(RELEASED_ANSWER);
    // The refresh takes Release away, so the answer under the buttons holds the focus.
    await expect(page.getByRole('form', { name: 'Release' })).toHaveCount(0);
    await expect(page.locator('[role="status"]:has([data-state="done"])')).toBeFocused();
    expect((await readEvent(data().root, first))?.decisions.at(-1)).toMatchObject({ action: 'confirm-missing', reason: 'Deleted on purpose.' });
    expect((await readEvent(data().root, first))?.version).toBe(before.version + 1);
    await openInbox(page);
    expect(await heldNow()).toHaveLength(held.length - 1);
    await expect(page.locator('#inbox-list header p')).toHaveText(new RegExp(`, ${held.length - 1} held`));
    await expect(banner(page)).toContainText(`${held.length - 1} missing items are on hold.`);
});

test('lists the suggested files in Bind after the linked ones, none chosen, and binds the one chosen by its path (#17)', async ({ page }) => {
    await openInbox(page, `?item=${missingId}#item`);
    await page.getByText('Bind to the file that replaces it').click();
    const form = page.getByRole('form', { name: 'Bind' });
    const choices = form.getByRole('group', { name: 'File to bind' }).getByRole('radio');
    await expect(choices).toHaveCount(2);
    const suggestion = form.getByRole('radio', { name: `${suggestedPath}: same file name, different pixels` });
    await expect(suggestion).not.toBeChecked();
    await expect(form.getByRole('radio', { name: 'Another file in the library' })).toBeChecked();
    await expect(form.getByRole('textbox', { name: 'Library path' })).toHaveValue('');
    await expectMinTargetSize(form.locator('label:has(input[type="radio"]), button'));
    await expectNoA11yViolations(page, { include: 'form[aria-label="Bind"]' });
    await suggestion.check();
    await expect(form.getByRole('textbox', { name: 'Library path' })).toHaveValue(suggestedPath);
    await form.getByRole('button', { name: 'Bind', exact: true }).click();
    await expect(answer(page, 'done')).toHaveText(bindAnswer(suggestedPath, false));
    expect(pendingDecisions()).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'bind', path: suggestedPath, photoId: DRAFT_ID, merge: SUGGESTED })]));
});

test("offers Restore in Approve's place on a new photograph whose bytes are an archived one's, with no series, position or description, and Dismiss still there (#17)", async ({ page, isMobile }) => {
    const itemId = newItemOf(DUPLICATE, DUPLICATE_REVISION);
    await openInbox(page, `?item=${itemId}#item`);
    const review = page.getByRole('form', { name: 'Review' });
    const restore = review.getByRole('button', { name: 'Restore' });
    await expect(restore).toBeVisible();
    await expect(review.getByRole('button', { name: 'Approve into draft' })).toHaveCount(0);
    await expect(review.getByRole('button', { name: 'Save edits' })).toHaveCount(0);
    await expect(review.getByRole('combobox')).toHaveCount(0);
    await expect(review.getByRole('textbox')).toHaveCount(0);
    const hint = restoreHint(path.posix.basename(FRESH_SOURCES[ARCHIVED]));
    await expect(review.getByText(hint)).toBeVisible();
    await expect(restore).toHaveAccessibleDescription(hint);
    await expect(page.getByText('Dismiss with a reason')).toBeVisible();
    await checkSurface(page, { controls: [review.getByRole('button'), ...(isMobile ? [page.getByRole('link', { name: 'Back to inbox' })] : [])] });
    await restore.focus();
    await page.keyboard.press('Space');
    await expect(answer(page, 'done')).toHaveText(RESTORED_TEXT);
    expect(pendingDecisions()).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'restore', path: DUPLICATE_PATH, photoId: ARCHIVED, merge: DUPLICATE })]));
    expect((await listEvents(data().root)).events.find((entry) => entry.id === itemId)).toMatchObject({ status: 'approved' });
    await expect(page.getByRole('button', { name: 'Restore' })).toHaveCount(0);
    await expect(page.locator('[role="status"]:has([data-state="done"])')).toBeFocused();
});
