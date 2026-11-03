import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest, type APIRequestContext, type Page } from '@playwright/test';
import { publish } from '../lib/catalog/publish';
import { createTestCatalog } from '../lib/catalog/testing';
import type { AuthoredSeries, AuthoredSite } from '../lib/catalog/types';
import { readActivePointer, readAuthoredRecord } from '../lib/catalog/working-layer';
import { writeAuthoredRecord } from '../lib/catalog/working-layer-writer';
import { startCatalogServer, READY_TIMEOUT, type CatalogServer } from './support/catalogServer';
import { signIn, startCuratorServer, type CuratorServer } from './support/curatorServer';
import { expectFocusRingVisible, expectRingNotClipped } from './support/focus';
import { holdNextPost } from './support/holdPost';
import { checkSurface } from './support/surface';
import { waitForHydration } from './support/hydration';
import { expectMinTargetSize } from './support/targets';
import { expect, test } from './support/test';

// #150: the curator's Series screen on #1's projects. Each project's worker builds its own published fixture, two
// published series and two approved photographs in none, then serves it twice from the harness's build: once as the
// curator and once as `web`. The spec makes a series, renames it and writes its statement, answers refresh to a form a
// write overtook, renames the published series and sees that in the draft Preview (2a). Then, by keyboard, it adds a
// photograph to that series, moves it, sets the cover and the opening photograph, adds a chapter, and reorders Work
// (2b), and sees the new order in the draft Preview. `web` shows none of it until a publish, and all of the published
// series' changes once the Publish screen publishes them.

test.describe.configure({ mode: 'serial' });

const HOOK_TIMEOUT = 2 * READY_TIMEOUT + 60_000;
const HARBOR = { id: 'ser_e2e-series-harbor', slug: 'series-harbor', title: 'Series fixture harbor' } as const;
const COAST = { id: 'ser_e2e-series-coast', slug: 'series-coast', title: 'Series fixture coast' } as const;
/** 2b's chapter, typed with the spaces `photos sequence chapter add` trims. */
const CHAPTER = 'Fixture chapter at the harbor mouth';
const RENAMED = { title: 'Series fixture harbor, retitled in the draft', statement: 'A statement written in the curator for the e2e fixture. Not real copy.' } as const;
const NEW = { id: 'ser_night-ferries', title: 'Night ferries', renamed: 'Night ferries, renamed', statement: 'Ferries crossing after dark.\n\nA second paragraph for the fixture. Not real copy.', shortStatement: 'Ferries crossing after dark.' } as const;

interface Fixture {
    root: string;
    library: string;
    /** The fixture's photographs, by index: Harbor holds 0 to 2, Coast 3, and 4 and 5 are approved and in no series. */
    photos: string[];
    cleanup(): void;
}

let fixture: Fixture | undefined;
let curator: CuratorServer | undefined;
let web: CatalogServer | undefined;

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-series-'));
    const root = path.join(temp, 'data');
    const library = path.join(temp, 'library');
    fs.mkdirSync(library);
    const catalog = await createTestCatalog({ root, seed: 150, withAssets: true, photos: 6, series: [{ ...HARBOR, photos: 3 }, { ...COAST, photos: 1 }] });
    const outcome = await publish({ dataRoot: root, actor: 'e2e', reason: 'series fixture', confirmLaunch: true, logger: { log: () => undefined } });
    if (outcome.outcome !== 'PUBLISHED') throw new Error(`The series fixture didn't publish: ${outcome.outcome}: ${outcome.message}`);
    fixture = { root, library, photos: catalog.photos.map((photo) => photo.id), cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
    // E2E_CURATION_PORT pins two ports per worker, for a machine that hands out ranges.
    const base = Number(process.env.E2E_CURATION_PORT);
    const pinned = Number.isInteger(base) && base > 0 ? base + 2 * test.info().parallelIndex : undefined;
    curator = await startCuratorServer(root, pinned, { library });
    web = await startCatalogServer(root, pinned === undefined ? undefined : pinned + 1, { library });
});

test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await curator?.stop();
    await web?.stop();
    fixture?.cleanup();
});

const data = () => {
    if (!fixture) throw new Error('The series fixture was not made');
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

const record = async (id: string) => (await readAuthoredRecord(data().root, 'series', id)) as AuthoredSeries;
const siteRecord = async () => (await readAuthoredRecord(data().root, 'site', 'site')) as AuthoredSite;
/** The answer the last action gave, in the form's polite status region. */
const answer = (page: Page, state: 'done' | 'stale' | 'invalid' | 'busy') => page.getByRole('status').locator(`[data-state="${state}"]`);

async function open(page: Page, pathname: string) {
    await page.goto(`${curatorOrigin()}${pathname}`);
    await waitForHydration(page);
}

async function withRequest<T>(origin: string, run: (request: APIRequestContext) => Promise<T>): Promise<T> {
    const request = await httpRequest.newContext({ baseURL: origin });
    try {
        return await run(request);
    } finally {
        await request.dispose();
    }
}

/** 2b: the answer a section of a series' page, or of the Series screen, gave its last action, in its own status region. */
const answerIn = (page: Page, section: string, state: 'done' | 'stale' | 'invalid' | 'busy') => page.getByRole('region', { name: section }).getByRole('status').locator(`[data-state="${state}"]`);

/** The photo IDs a series page lists, in its order: each entry's link is `photo-<photoId>`. */
const entryOrder = (page: Page) => page.locator('main a[id^="photo-"]').evaluateAll((links) => links.map((link) => link.id.slice('photo-'.length)));

/** Where each title first shows in a page's text, so a test can say which comes first on Work. */
const before = (text: string, first: string, second: string) => text.indexOf(first) >= 0 && text.indexOf(second) > text.indexOf(first);

/** Every public page and API a series' copy could reach, on `web`. */
const PUBLIC_PATHS = ['/', '/work', `/work/${HARBOR.slug}`, `/work/${COAST.slug}`, '/work/night-ferries', '/gallery', '/api/photos', '/api/catalog/active'];

/** Each public path's body, as a document and as an RSC payload. */
async function publicBodies(): Promise<{ pathname: string; status: number; body: string }[]> {
    return withRequest(webOrigin(), async (request) => {
        const bodies: { pathname: string; status: number; body: string }[] = [];
        for (const pathname of PUBLIC_PATHS) {
            for (const headers of [{}, { RSC: '1' }] as Record<string, string>[]) {
                const response = await request.get(pathname, { headers, maxRedirects: 5 });
                bodies.push({ pathname, status: response.status(), body: await response.text() });
            }
        }
        return bodies;
    });
}

// Every curator page needs a session, so each test signs in through the login form first.
test.beforeEach(async ({ page }) => {
    if (!curator) throw new Error('The curator server did not start');
    await signIn(page, curator.origin, curator.passphrase);
});

test('the header leads to Series, which lists the working layer and passes the #1 checks', async ({ page }) => {
    await open(page, '/curation/inbox');
    const screens = page.getByRole('navigation', { name: 'Curation' });
    await screens.getByRole('link', { name: 'Series' }).click();
    await expect(page).toHaveURL(`${curatorOrigin()}/curation/series`);
    await waitForHydration(page);
    await expect(screens.getByRole('link', { name: 'Series' })).toHaveAttribute('aria-current', 'page');
    await expect(screens.getByRole('link', { name: 'Inbox' })).not.toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { level: 1, name: 'Series' })).toBeVisible();
    const list = page.getByRole('list', { name: 'Series' });
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await expect(list.getByRole('listitem').first()).toContainText('Published');
    await expect(list.getByRole('listitem').first()).toContainText('3 photographs');
    await expect(list.getByRole('link', { name: HARBOR.title })).toHaveAttribute('href', `/curation/series/${HARBOR.id}`);
    await expect(page.locator('main')).not.toContainText(/ser_/);
    // From the keyboard, as a keyboard user would, so the focus ring shows where focus goes.
    await page.keyboard.press('Tab');
    await checkSurface(page, { controls: [list.getByRole('link'), page.getByLabel('Title', { exact: true }), page.getByLabel(/Web address/), page.getByRole('button', { name: 'Make series' })] });
    await expectMinTargetSize(page.locator('header a, header button'));
});

test('makes a series, then renames it and writes its statement, each saved to the draft only', async ({ page }) => {
    const before = await readActivePointer(data().root);
    await open(page, '/curation/series');
    // A refusal by the field, with focus there and the text kept.
    await page.getByLabel('Title', { exact: true }).fill(NEW.title);
    await page.getByLabel(/Web address/).fill('work');
    await page.getByRole('button', { name: 'Make series' }).click();
    await expect(page.getByText('The site keeps /work for its own pages. Choose another web address. Nothing was written.')).toBeVisible();
    await expect(page.getByLabel(/Web address/)).toBeFocused();
    await expect(page.getByLabel(/Web address/)).toHaveAttribute('aria-invalid', 'true');
    await page.getByLabel(/Web address/).fill('');

    // By keyboard, with the button focusable and saying it can't act while the action is out.
    const make = page.getByRole('button', { name: 'Make series' });
    await make.focus();
    const held = await holdNextPost(page, '/curation/series');
    await page.keyboard.press('Enter');
    await held.sent;
    await expect(make).toHaveAttribute('aria-disabled', 'true');
    await expect(make).toBeFocused();
    await held.release();
    await expect(answer(page, 'done')).toHaveText(new RegExp(`^Made ${NEW.title}, a draft\\. Nothing is public until you publish\\.`));
    await expect(page.locator('[role="status"]:has([data-state="done"])')).toBeFocused();
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('');
    const row = page.getByRole('list', { name: 'Series' }).getByRole('listitem').filter({ hasText: NEW.title });
    await expect(row).toContainText('Draft');
    await expect(row).toContainText('No photographs');
    await expect(row).toContainText('Not in Work order');
    expect(await record(NEW.id)).toMatchObject({ version: 1, slug: 'night-ferries', title: NEW.title, visibility: 'draft', photoIds: [] });

    // On to its page from the answer.
    await answer(page, 'done').getByRole('link', { name: `Open ${NEW.title}` }).click();
    await expect(page).toHaveURL(`${curatorOrigin()}/curation/series/${NEW.id}`);
    await waitForHydration(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(NEW.title);
    await expect(page.getByRole('navigation', { name: 'Curation' }).getByRole('link', { name: 'Series' })).toHaveAttribute('aria-current', 'page');
    await page.keyboard.press('Tab');
    await checkSurface(page, {
        controls: [page.getByRole('link', { name: 'All series' }), page.getByLabel('Title', { exact: true }), page.getByLabel('Statement', { exact: true }), page.getByLabel('Short statement'), page.getByRole('button', { name: 'Save' })],
    });
    // A choice's target is its whole label, as the Inbox's sequence slots are, and the radio carries the ring.
    await expectMinTargetSize(page.locator('main label:has(input[type="radio"])'));
    for (const radio of await page.getByRole('radio').all()) {
        await expectFocusRingVisible(radio);
        await expectRingNotClipped(radio);
    }

    await page.getByLabel('Title', { exact: true }).fill(NEW.renamed);
    await page.getByLabel('Statement', { exact: true }).fill(NEW.statement);
    await page.getByLabel('Short statement').fill(NEW.shortStatement);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(answer(page, 'done')).toHaveText('Saved to the draft. Nothing is public until you publish.');
    await expect(page.locator('[role="status"]:has([data-state="done"])')).toBeFocused();
    // The refresh after it opens the page on what was stored.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(NEW.renamed);
    await expect(page.locator('input[name="version"]')).toHaveValue('2');
    expect(await record(NEW.id)).toMatchObject({ version: 2, title: NEW.renamed, statement: NEW.statement, shortStatement: NEW.shortStatement, visibility: 'draft', photoIds: [], slug: 'night-ferries' });
    // Nothing published: the active revision is the one the fixture made.
    expect(await readActivePointer(data().root)).toEqual(before);
});

test('answers refresh to a form a write overtook, and writes nothing', async ({ page }) => {
    await open(page, `/curation/series/${HARBOR.id}`);
    // `photos edit` saves it while the page is open.
    const shown = await record(HARBOR.id);
    await writeAuthoredRecord({ ...shown, shortStatement: 'Saved from the command line while the page was open.' }, { expectedVersion: shown.version, root: data().root });
    const overtaken = await record(HARBOR.id);
    await page.getByLabel('Title', { exact: true }).fill('A title that never lands');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(answer(page, 'stale')).toContainText('This series changed since the page loaded, so nothing was written.');
    await expect(page.locator('[role="status"]:has([data-state="stale"])')).toBeFocused();
    expect(await record(HARBOR.id)).toEqual(overtaken);
    await answer(page, 'stale').getByRole('link', { name: 'Refresh' }).click();
    await waitForHydration(page);
    await expect(page.getByLabel('Short statement')).toHaveValue('Saved from the command line while the page was open.');
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue(HARBOR.title);
});

test('renames the published series and writes its statement, and the draft Preview shows both', async ({ page }) => {
    await open(page, `/curation/series/${HARBOR.id}`);
    await page.getByLabel('Title', { exact: true }).fill(RENAMED.title);
    await page.getByLabel('Statement', { exact: true }).fill(RENAMED.statement);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(answer(page, 'done')).toHaveText('Saved to the draft. Nothing is public until you publish.');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(RENAMED.title);

    // /curation/preview opens the draft as it compiles now.
    await page.goto(`${curatorOrigin()}/curation/preview`);
    await expect(page).toHaveURL(new RegExp(`^${curatorOrigin()}/curation/preview/rev_[0-9a-f]{64}$`));
    const draft = new URL(page.url()).pathname.split('/').at(-1);
    await page.goto(`${curatorOrigin()}/curation/preview/${draft}/site/work/${HARBOR.slug}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(RENAMED.title);
    await expect(page.getByText(RENAMED.statement)).toBeVisible();
    await page.goto(`${curatorOrigin()}/curation/preview/${draft}/site/work`);
    await expect(page.locator('main')).toContainText(RENAMED.title);
    // The new series is a draft with no photographs and no place in Work order, so the draft site doesn't show it either.
    await expect(page.locator('main')).not.toContainText(NEW.title);
});

test('orders the published series by keyboard: adds a photograph, moves it, sets the cover and opening photograph, and adds a chapter', async ({ page }) => {
    const live = await readActivePointer(data().root);
    const [first, second, third, , added] = data().photos;
    await open(page, `/curation/series/${HARBOR.id}`);
    const sequence = page.getByRole('list', { name: 'Photographs in order' });
    await expect(sequence.getByRole('listitem')).toHaveCount(3);
    await expect(sequence.getByRole('listitem').first()).toContainText('1. fixture-0001.jpg');
    await expect(sequence.getByRole('listitem').first()).toContainText('Cover');
    // The curator-only route's thumbnail, never the original.
    await expect(sequence.locator('img').first()).toHaveAttribute('src', /^\/api\/curation\/media\/.+\/w400\.webp$/);
    await expect(page.locator('main')).not.toContainText(/\b(?:ph|ser|ch)_/);
    const add = page.getByRole('form', { name: 'Add a photograph' });
    await page.keyboard.press('Tab');
    await checkSurface(page, { controls: [sequence.getByRole('button'), add.getByLabel('Photograph'), add.getByLabel('Position'), add.getByRole('button', { name: 'Add' })] });

    // Add the approved photograph in no series, at the end, from the keyboard.
    await add.getByLabel('Photograph').selectOption({ label: 'fixture-0005.jpg' });
    await add.getByRole('button', { name: 'Add' }).focus();
    await page.keyboard.press('Enter');
    await expect(answerIn(page, 'Sequence', 'done')).toHaveText(/^Added fixture-0005\.jpg at position 4 of 4\. Nothing is public until you publish\./);
    await expect(sequence.getByRole('listitem')).toHaveCount(4);
    await expect(page.locator('[role="status"]:has([data-state="done"])')).toBeFocused();
    expect((await record(HARBOR.id)).photoIds).toEqual([first, second, third, added]);

    // Move it up twice: focus stays on its Move up, on its new row, so the second press moves it on. Its name carries its place, so it's found by its row.
    await expect(sequence.getByRole('button', { name: 'Move up: 4. fixture-0005.jpg' })).toBeVisible();
    const up = sequence.locator(`[data-photo="${added}"] [data-control="up"]`);
    await up.focus();
    await page.keyboard.press('Enter');
    await expect(sequence.getByRole('listitem').nth(2)).toContainText('3. fixture-0005.jpg');
    await expect(up).toBeFocused();
    await page.keyboard.press('Space');
    await expect(sequence.getByRole('listitem').nth(1)).toContainText('2. fixture-0005.jpg');
    await expect(answerIn(page, 'Sequence', 'done')).toHaveText(/^Moved fixture-0005\.jpg to position 2 of 4\./);
    await expect(up).toBeFocused();
    await expect(up).toHaveAccessibleName('Move up: 2. fixture-0005.jpg');
    await expectFocusRingVisible(up);
    expect((await record(HARBOR.id)).photoIds).toEqual([first, added, second, third]);

    // The cover, with a focal point typed as two percentages.
    const cover = page.getByRole('form', { name: 'Cover' });
    await cover.getByLabel('Cover photograph').selectOption({ label: '2. fixture-0005.jpg' });
    await cover.getByRole('radio', { name: 'At the point below' }).check();
    await cover.getByLabel('Across, %').fill('30');
    await cover.getByLabel('Down, %').fill('60');
    await cover.getByRole('button', { name: 'Set cover' }).click();
    await expect(answerIn(page, 'Cover and opening photograph', 'done')).toHaveText(/^fixture-0005\.jpg is the cover now, with its focal point 30% across and 60% down\. Nothing is public until you publish\./);
    expect((await record(HARBOR.id)).cover).toEqual({ photoId: added, focalPoint: { x: 0.3, y: 0.6 } });

    // The opening photograph.
    const opening = page.getByRole('form', { name: 'Opening photograph' });
    await opening.getByLabel('Opening photograph').selectOption({ label: '3. fixture-0002.jpg' });
    await opening.getByRole('button', { name: 'Set opening photograph' }).click();
    await expect(answerIn(page, 'Cover and opening photograph', 'done')).toHaveText(/^fixture-0002\.jpg is the opening photograph now\./);
    expect((await record(HARBOR.id)).openingPhotoId).toBe(second);

    // A chapter, its title cleaned as the CLI cleans it.
    const chapter = page.getByRole('form', { name: 'Add a chapter' });
    await chapter.getByLabel('Chapter title').fill(`  ${CHAPTER}  `);
    await chapter.getByLabel('Starts at').selectOption({ label: '2. fixture-0005.jpg' });
    await chapter.getByRole('button', { name: 'Add chapter' }).click();
    await expect(answerIn(page, 'Chapters', 'done')).toHaveText(new RegExp(`^Added the chapter ${CHAPTER}, starting at fixture-0005\\.jpg\\.`));
    await expect(page.getByRole('list', { name: 'Chapters' })).toContainText(CHAPTER);
    await expect(sequence.getByRole('listitem').nth(1)).toContainText(`Starts the chapter ${CHAPTER}`);
    expect((await record(HARBOR.id)).chapters).toEqual([{ id: expect.stringMatching(/^ch_/), title: CHAPTER, startPhotoId: added }]);
    await page.keyboard.press('Tab');
    await checkSurface(page, { controls: [cover.getByRole('button'), opening.getByRole('button'), page.getByRole('list', { name: 'Chapters' }).getByRole('button'), chapter.getByRole('button')] });
    // Nothing published: the active revision is the one the fixture made.
    expect(await readActivePointer(data().root)).toEqual(live);
});

test('reorders Work from the Series screen by keyboard, and the draft Preview shows the new order', async ({ page }) => {
    const [first, second, third, , added] = data().photos;
    await open(page, '/curation/series');
    const work = page.getByRole('list', { name: 'Work order' });
    await expect(work.getByRole('listitem')).toHaveText([new RegExp(`^1\\. ${RENAMED.title}`), new RegExp(`^2\\. ${COAST.title}`)]);
    await page.keyboard.press('Tab');
    await checkSurface(page, { controls: [work.getByRole('button'), page.getByRole('button', { name: 'Save featured' })] });
    const up = work.locator(`[data-series="${COAST.id}"] [data-control="up"]`);
    await expect(up).toHaveAccessibleName(`Move up: 2. ${COAST.title}`);
    await up.focus();
    await page.keyboard.press('Enter');
    await expect(answerIn(page, 'Work order', 'done')).toHaveText(`Moved ${COAST.title} to place 1 of 2 in Work order. Nothing is public until you publish.`);
    await expect(work.getByRole('listitem').first()).toContainText(COAST.title);
    await expect(up).toBeFocused();
    await expect(up).toHaveAttribute('aria-disabled', 'true');
    expect((await siteRecord()).seriesOrder).toEqual([COAST.id, HARBOR.id]);

    await page.goto(`${curatorOrigin()}/curation/preview`);
    await expect(page).toHaveURL(new RegExp(`^${curatorOrigin()}/curation/preview/rev_[0-9a-f]{64}$`));
    const draft = new URL(page.url()).pathname.split('/').at(-1);
    await page.goto(`${curatorOrigin()}/curation/preview/${draft}/site/work`);
    expect(before(await page.locator('main').innerText(), COAST.title, RENAMED.title)).toBe(true);
    await page.goto(`${curatorOrigin()}/curation/preview/${draft}/site/work/${HARBOR.slug}`);
    await expect.poll(() => entryOrder(page)).toEqual([first, added, second, third]);
    await expect(page.getByRole('heading', { level: 3, name: CHAPTER })).toBeVisible();
});

test('shows visitors none of it until a publish, and the published series\' change once the Publish screen publishes', async ({ page }) => {
    for (const { pathname, body } of await publicBodies()) {
        for (const secret of [NEW.title, NEW.renamed, NEW.shortStatement, RENAMED.title, RENAMED.statement, CHAPTER]) expect(body, `${pathname} holds ${secret}`).not.toContain(secret);
        // 2b's added photograph is in no published series yet.
        expect(body, pathname).not.toContain(data().photos[4]);
        // No curator control reaches a public page either.
        expect(body, pathname).not.toContain('/curation/series');
    }
    await withRequest(webOrigin(), async (request) => {
        expect((await request.get('/work/night-ferries')).status()).toBe(404);
        // Nor does web serve the curator at all.
        for (const pathname of ['/curation/series', `/curation/series/${HARBOR.id}`]) expect((await request.get(pathname, { maxRedirects: 0 })).status(), pathname).toBe(404);
        // The published title is still what visitors get, and the published Work order.
        expect(await (await request.get(`/work/${HARBOR.slug}`)).text()).toContain(HARBOR.title);
        expect(before(await (await request.get('/work')).text(), HARBOR.title, COAST.title)).toBe(true);
    });

    await open(page, '/curation/publish');
    const bar = page.locator('main form[data-sticky-bar]');
    await bar.locator('button[value="validate"]').click();
    await expect(page.locator('#result-heading')).toHaveText('Catalog revision is valid');
    await bar.locator('button[value="publish"]').click();
    await expect(page.locator('#result-heading')).toHaveText(/^Revision \d+ is live$/);

    await withRequest(webOrigin(), async (request) => {
        const harbor = await (await request.get(`/work/${HARBOR.slug}`)).text();
        expect(harbor).toContain(RENAMED.title);
        expect(harbor).toContain(RENAMED.statement);
        // 2b: the photograph added, the chapter, and the new Work order.
        expect(harbor).toContain(`id="photo-${data().photos[4]}"`);
        expect(harbor).toContain(CHAPTER);
        expect(before(await (await request.get('/work')).text(), COAST.title, RENAMED.title)).toBe(true);
        // The new series is still a draft, so the publish took it nowhere.
        expect((await request.get('/work/night-ferries')).status()).toBe(404);
        expect(await (await request.get('/work')).text()).not.toContain(NEW.renamed);
    });
});
