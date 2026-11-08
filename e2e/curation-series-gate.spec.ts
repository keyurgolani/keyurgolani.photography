import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { publish } from '../lib/catalog/publish';
import { createTestCatalog } from '../lib/catalog/testing';
import type { AuthoredSeries } from '../lib/catalog/types';
import { readAuthoredRecord } from '../lib/catalog/working-layer';
import { READY_TIMEOUT } from './support/catalogServer';
import { signIn, startCuratorServer, type CuratorServer } from './support/curatorServer';
import { nothingOnceReady, pressEveryFormEarly, watchPosts, written } from './support/forms-gate';
import { GATE_STATUS, holdScripts } from './support/inbox-gate';
import { expect, test } from './support/test';

// The Series screens' forms at the submit gate (components/site/submitGateScript.ts): New series, Put on Work and
// Featured on Home on the Series screen; Edit series, Add a photograph, Move to a position, Cover, Opening photograph,
// a chapter's Move the start and Add a chapter on a series' page. Each submits by hand, from its handler, and has no
// plain-post route, so a plain post before hydration lands on the curator's 403. Before the page hydrates, the head's
// script drops every press on them and what their controls would take, and the first drop says the page is still
// loading; once each form has mounted it says it's ready, and a press posts. With no JavaScript nothing gates, and a
// press posts the plain way, as before. Each test makes its own data root, left under the system's temp folder.

test.use({ actionTimeout: 10_000 });

const HOOK_TIMEOUT = READY_TIMEOUT + 90_000;
const P = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const HARBOR = { id: 'ser_e2e-gate-harbor', slug: 'gate-harbor', title: 'Gate fixture harbor' } as const;
const COAST = { id: 'ser_e2e-gate-coast', slug: 'gate-coast', title: 'Gate fixture coast' } as const;
const ROADS = { id: 'ser_e2e-gate-roads', slug: 'gate-roads', title: 'Gate fixture roads' } as const;
const MARSH = { id: 'ser_e2e-gate-marsh', slug: 'gate-marsh', title: 'Gate fixture marsh' } as const;

let root: string | undefined;
let curator: CuratorServer | undefined;

test.beforeEach(async () => {
    test.setTimeout(test.info().timeout + HOOK_TIMEOUT);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-series-gate-'));
    root = path.join(temp, 'data');
    const library = path.join(temp, 'library');
    fs.mkdirSync(library);
    // Harbor holds 1 to 3, with a chapter at 1; Coast holds 4; Roads and Marsh, drafts off Work, hold 5 and 6; 7 is in none.
    const photo = (n: number) => ({ id: P(n), width: 900, height: 600 });
    await createTestCatalog({
        root,
        seed: 1113,
        withAssets: true,
        photos: [1, 2, 3, 4, 5, 6, 7].map(photo),
        series: [
            { ...HARBOR, photoIds: [P(1), P(2), P(3)], chapters: [{ id: 'ch-gate-dawn', title: 'Dawn', startPhotoId: P(1) }] },
            { ...COAST, photoIds: [P(4)] },
            { ...ROADS, photoIds: [P(5)], visibility: 'draft' },
            { ...MARSH, photoIds: [P(6)], visibility: 'draft' },
        ],
        seriesOrder: [HARBOR.id, COAST.id],
    });
    const outcome = await publish({ dataRoot: root, actor: 'e2e', reason: 'series gate fixture', confirmLaunch: true, logger: { log: () => undefined } });
    if (outcome.outcome !== 'PUBLISHED') throw new Error(`The series gate fixture didn't publish: ${outcome.outcome}: ${outcome.message}`);
    curator = await startCuratorServer(root, undefined, { library });
});

test.afterEach(async () => {
    test.setTimeout(test.info().timeout + HOOK_TIMEOUT);
    await curator?.stop();
});

const dataRoot = () => {
    if (!root) throw new Error('The series gate fixture was not made');
    return root;
};
const origin = () => {
    if (!curator) throw new Error('The curator server did not start');
    return curator.origin;
};
const seriesCount = () => fs.readdirSync(path.join(dataRoot(), 'authored', 'series')).length;
const harbor = async () => (await readAuthoredRecord(dataRoot(), 'series', HARBOR.id)) as AuthoredSeries;

/** Opens `pathname` with its scripts held back, so it can't hydrate, and checks every form on it waits at the gate. */
async function openHeld(page: Page, pathname: string, count: number) {
    await signIn(page, origin(), (curator as CuratorServer).passphrase);
    const release = await holdScripts(page);
    await page.goto(`${origin()}${pathname}`, { waitUntil: 'domcontentloaded' });
    const forms = page.locator('main form');
    await expect(forms, `${pathname}: its forms`).toHaveCount(count);
    expect(await page.locator('html[data-hydrated]').count(), 'the page is held back from hydrating').toBe(0);
    for (const form of await forms.all()) await expect(form, 'each form waits at the gate').toHaveAttribute('data-submit-gate', 'waiting');
    await expect(page.locator(GATE_STATUS), 'no status before a press').toHaveCount(0);
    return { release, forms };
}

/** The key that moves a select to another option: up from the last one, down from any other. */
const moveKey = (page: Page, selector: string) => page.locator(selector).evaluate((element) => ((element as HTMLSelectElement).selectedIndex === (element as HTMLSelectElement).options.length - 1 ? 'ArrowUp' : 'ArrowDown'));

test.describe('with JavaScript, before the page hydrates', () => {
    test("every press on the Series screen's forms posts nothing and lands on no 403, the controls take no input, the status says so, and once ready Make series posts", async ({ page }) => {
        test.setTimeout(5 * 60_000);
        const { release, forms } = await openHeld(page, '/curation/series', 3);
        const make = page.getByRole('button', { name: 'Make series' });
        await expect(make, 'the press it makes once ready is offered').toHaveCount(1);
        const watch = watchPosts(page);

        const covered = await pressEveryFormEarly(page, { name: 'the Series screen', forms, root: dataRoot(), watch });

        // Then the controls that aren't submits: they take nothing before their form is ready.
        const title = page.getByLabel('Title', { exact: true });
        const featured = page.getByRole('checkbox', { name: COAST.title });
        const putOn = 'main form[aria-labelledby="put-on-work-heading"] select';
        await title.evaluate((element) => {
            (element as HTMLInputElement).value = '';
        });
        const shown = async () => ({ title: await title.inputValue(), featured: await featured.isChecked(), putOn: await page.locator(putOn).inputValue() });
        const was = await shown();
        await title.click();
        await page.keyboard.type('Typed before the page was ready.');
        await featured.click();
        // On macOS a key opens a closed select's menu instead of moving it, so there the unit test is this check's proof.
        const key = await moveKey(page, putOn);
        await page.locator(putOn).focus();
        await page.keyboard.press(key);
        expect(await shown(), 'a text field, a checkbox and a select before the form is ready').toEqual(was);
        covered.push('the Series screen: text field, checkbox and select');

        const before = written(dataRoot());
        await release();
        await nothingOnceReady(page, { name: 'the Series screen', root: dataRoot(), before, watch });
        for (const form of await forms.all()) await expect(form, 'each form is ready').toHaveAttribute('data-submit-gate', 'ready');
        expect(await shown(), 'once the form is ready').toEqual(was);

        // Once ready, the form works: Make series posts and makes it.
        const made = seriesCount();
        await title.fill('Night ferries');
        const sent = page.waitForResponse((response) => response.request().method() === 'POST', { timeout: 15_000 });
        await make.click();
        expect((await sent).status(), 'the Series screen: the press once ready').toBe(200);
        await expect.poll(seriesCount, 'the Series screen: the press once ready writes').toBe(made + 1);
        expect(watch.refused, 'the Series screen: nothing landed on a 403').toEqual([]);
        watch.stop();
        await page.unrouteAll({ behavior: 'ignoreErrors' });

        expect(covered).toEqual(
            expect.arrayContaining([
                'the Series screen: press Make series',
                'the Series screen: Enter in title, form 1',
                'the Series screen: press Put on Work, last',
                'the Series screen: press Save featured',
                'the Series screen: requestSubmit, form 1',
                'the Series screen: requestSubmit, form 2',
                'the Series screen: requestSubmit, form 3',
                'the Series screen: text field, checkbox and select',
            ]),
        );
    });

    test("every press on a series' page posts nothing and lands on no 403, the controls take no input, the status says so, and once ready Set opening photograph posts", async ({ page }) => {
        test.setTimeout(5 * 60_000);
        // Edit series, Add a photograph, Move to a position, Cover, Opening photograph, Dawn's Move the start, Add a chapter.
        const { release, forms } = await openHeld(page, `/curation/series/${HARBOR.id}`, 7);
        const setOpening = page.getByRole('button', { name: 'Set opening photograph' });
        await expect(setOpening, 'the press it makes once ready is offered').toHaveCount(1);
        const watch = watchPosts(page);

        const covered = await pressEveryFormEarly(page, { name: "a series' page", forms, root: dataRoot(), watch });

        const title = page.locator('main form[aria-label="Edit series"] input[name="title"]');
        const at = page.getByRole('radio', { name: 'At the point below' });
        const opening = 'main form[aria-labelledby="opening-form-heading"] select';
        const shown = async () => ({ title: await title.inputValue(), at: await at.isChecked(), opening: await page.locator(opening).inputValue() });
        const was = await shown();
        await title.click();
        await page.keyboard.press('End');
        await page.keyboard.type(', typed before the page was ready');
        await at.click();
        const key = await moveKey(page, opening);
        await page.locator(opening).focus();
        await page.keyboard.press(key);
        expect(await shown(), 'a text field, a radio and a select before the form is ready').toEqual(was);
        covered.push("a series' page: text field, radio and select");

        const before = written(dataRoot());
        await release();
        await nothingOnceReady(page, { name: "a series' page", root: dataRoot(), before, watch });
        for (const form of await forms.all()) await expect(form, 'each form is ready').toHaveAttribute('data-submit-gate', 'ready');
        expect(await shown(), 'once the form is ready').toEqual(was);

        // Once ready, the form works: Set opening photograph posts and writes.
        const version = (await harbor()).version;
        await page.locator(opening).selectOption(P(3));
        const sent = page.waitForResponse((response) => response.request().method() === 'POST', { timeout: 15_000 });
        await setOpening.click();
        expect((await sent).status(), "a series' page: the press once ready").toBe(200);
        await expect.poll(async () => (await harbor()).version, "a series' page: the press once ready writes").toBeGreaterThan(version);
        expect((await harbor()).openingPhotoId).toBe(P(3));
        expect(watch.refused, "a series' page: nothing landed on a 403").toEqual([]);
        watch.stop();
        await page.unrouteAll({ behavior: 'ignoreErrors' });

        expect(covered).toEqual(
            expect.arrayContaining([
                "a series' page: press Save",
                "a series' page: Enter in title, form 1",
                "a series' page: press Add",
                "a series' page: press Set cover",
                "a series' page: Enter in focalX, form 4",
                "a series' page: press Set opening photograph",
                "a series' page: press Add chapter",
                "a series' page: requestSubmit, form 7",
                "a series' page: text field, radio and select",
            ]),
        );
    });
});

test.describe('without JavaScript', () => {
    test('nothing gates: Make series posts the plain way, the curator refuses it, and nothing is written', async ({ page: signedIn, browser }) => {
        await signIn(signedIn, origin(), (curator as CuratorServer).passphrase);
        const context = await browser.newContext({ javaScriptEnabled: false, storageState: await signedIn.context().storageState() });
        const page = await context.newPage();
        await page.goto(`${origin()}/curation/series`);
        await page.getByLabel('Title', { exact: true }).fill('No script');
        const before = written(dataRoot());
        const posted = page.waitForResponse((response) => response.request().method() === 'POST');
        await page.getByRole('button', { name: 'Make series' }).click();
        expect((await posted).status()).toBe(403);
        expect(written(dataRoot())).toEqual(before);
        await context.close();
    });
});
