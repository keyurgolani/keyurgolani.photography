import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest, type APIRequestContext, type Page } from '@playwright/test';
import { publish } from '../lib/catalog/publish';
import { createTestCatalog } from '../lib/catalog/testing';
import type { AuthoredSeries } from '../lib/catalog/types';
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

// #150's 2a: the curator's Series screen on #1's projects. Each project's worker builds its own published fixture,
// one published series, then serves it twice from the harness's build: once as the curator and once as `web`. The
// spec makes a series, renames it and writes its statement, answers refresh to a form a write overtook, renames the
// published series and sees that in the draft Preview, and checks that `web` shows none of it until a publish, and
// the published series' change once the Publish screen publishes it.

test.describe.configure({ mode: 'serial' });

const HOOK_TIMEOUT = 2 * READY_TIMEOUT + 60_000;
const HARBOR = { id: 'ser_e2e-series-harbor', slug: 'series-harbor', title: 'Series fixture harbor' } as const;
const RENAMED = { title: 'Series fixture harbor, retitled in the draft', statement: 'A statement written in the curator for the e2e fixture. Not real copy.' } as const;
const NEW = { id: 'ser_night-ferries', title: 'Night ferries', renamed: 'Night ferries, renamed', statement: 'Ferries crossing after dark.\n\nA second paragraph for the fixture. Not real copy.', shortStatement: 'Ferries crossing after dark.' } as const;

interface Fixture {
    root: string;
    library: string;
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
    await createTestCatalog({ root, seed: 150, withAssets: true, photos: 3, series: [{ ...HARBOR, photos: 3 }] });
    const outcome = await publish({ dataRoot: root, actor: 'e2e', reason: 'series fixture', confirmLaunch: true, logger: { log: () => undefined } });
    if (outcome.outcome !== 'PUBLISHED') throw new Error(`The series fixture didn't publish: ${outcome.outcome}: ${outcome.message}`);
    fixture = { root, library, cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
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

/** Every public page and API a series' copy could reach, on `web`. */
const PUBLIC_PATHS = ['/', '/work', `/work/${HARBOR.slug}`, '/work/night-ferries', '/gallery', '/api/photos', '/api/catalog/active'];

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
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list.getByRole('listitem').first()).toContainText('Published');
    await expect(list.getByRole('listitem').first()).toContainText('3 photographs');
    await expect(list.getByRole('link', { name: HARBOR.title })).toHaveAttribute('href', `/curation/series/${HARBOR.id}`);
    await expect(page.locator('main')).not.toContainText(/ser_/);
    // From the keyboard, as a keyboard user would, so the focus ring shows where focus goes.
    await page.keyboard.press('Tab');
    await checkSurface(page, { controls: [list.getByRole('link'), page.getByLabel('Title'), page.getByLabel(/Web address/), page.getByRole('button', { name: 'Make series' })] });
    await expectMinTargetSize(page.locator('header a, header button'));
});

test('makes a series, then renames it and writes its statement, each saved to the draft only', async ({ page }) => {
    const before = await readActivePointer(data().root);
    await open(page, '/curation/series');
    // A refusal by the field, with focus there and the text kept.
    await page.getByLabel('Title').fill(NEW.title);
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
    await expect(page.getByLabel('Title')).toHaveValue('');
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
        controls: [page.getByRole('link', { name: 'All series' }), page.getByLabel('Title'), page.getByLabel('Statement', { exact: true }), page.getByLabel('Short statement'), page.getByRole('button', { name: 'Save' })],
    });
    // A choice's target is its whole label, as the Inbox's sequence slots are, and the radio carries the ring.
    await expectMinTargetSize(page.locator('main label:has(input[type="radio"])'));
    for (const radio of await page.getByRole('radio').all()) {
        await expectFocusRingVisible(radio);
        await expectRingNotClipped(radio);
    }

    await page.getByLabel('Title').fill(NEW.renamed);
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
    await page.getByLabel('Title').fill('A title that never lands');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(answer(page, 'stale')).toContainText('This series changed since the page loaded, so nothing was written.');
    await expect(page.locator('[role="status"]:has([data-state="stale"])')).toBeFocused();
    expect(await record(HARBOR.id)).toEqual(overtaken);
    await answer(page, 'stale').getByRole('link', { name: 'Refresh' }).click();
    await waitForHydration(page);
    await expect(page.getByLabel('Short statement')).toHaveValue('Saved from the command line while the page was open.');
    await expect(page.getByLabel('Title')).toHaveValue(HARBOR.title);
});

test('renames the published series and writes its statement, and the draft Preview shows both', async ({ page }) => {
    await open(page, `/curation/series/${HARBOR.id}`);
    await page.getByLabel('Title').fill(RENAMED.title);
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

test('shows visitors none of it until a publish, and the published series\' change once the Publish screen publishes', async ({ page }) => {
    for (const { pathname, body } of await publicBodies()) {
        for (const secret of [NEW.title, NEW.renamed, NEW.shortStatement, RENAMED.title, RENAMED.statement]) expect(body, `${pathname} holds ${secret}`).not.toContain(secret);
        // No curator control reaches a public page either.
        expect(body, pathname).not.toContain('/curation/series');
    }
    await withRequest(webOrigin(), async (request) => {
        expect((await request.get('/work/night-ferries')).status()).toBe(404);
        // Nor does web serve the curator at all.
        for (const pathname of ['/curation/series', `/curation/series/${HARBOR.id}`]) expect((await request.get(pathname, { maxRedirects: 0 })).status(), pathname).toBe(404);
        // The published title is still what visitors get.
        expect(await (await request.get(`/work/${HARBOR.slug}`)).text()).toContain(HARBOR.title);
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
        // The new series is still a draft, so the publish took it nowhere.
        expect((await request.get('/work/night-ferries')).status()).toBe(404);
        expect(await (await request.get('/work')).text()).not.toContain(NEW.renamed);
    });
});
