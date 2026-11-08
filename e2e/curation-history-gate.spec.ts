import { listActivations } from '../lib/catalog/repository';
import { createHistoryFixture, type PublishFixture } from '../test/helpers/publishFixture';
import { READY_TIMEOUT } from './support/catalogServer';
import { signIn, startCuratorServer, type CuratorServer } from './support/curatorServer';
import { nothingOnceReady, pressEveryFormEarly, watchPosts, written } from './support/forms-gate';
import { GATE_STATUS, holdScripts } from './support/inbox-gate';
import { expect, test } from './support/test';

// History's restore form at the submit gate (components/site/submitGateScript.ts). `?restore=N` opens the dialog in
// the server HTML, so its form is there before the page hydrates, and with no referrer a plain post then lands on the
// curator's 403. Before the page hydrates, the head's script drops every press on it and the typing in its reason, and
// the first drop says the page is still loading; once the form has mounted it says it's ready, and Restore posts and
// restores. With no JavaScript the form is the server's markup alone, as e2e/curation-history.spec.ts's no-JavaScript
// test has it. The data root is left under the system's temp folder.

test.use({ actionTimeout: 10_000 });

const HOOK_TIMEOUT = READY_TIMEOUT + 90_000;

let fixture: (PublishFixture & { live: string }) | undefined;
let curator: CuratorServer | undefined;

test.beforeEach(async () => {
    test.setTimeout(test.info().timeout + HOOK_TIMEOUT);
    fixture = await createHistoryFixture();
    curator = await startCuratorServer(fixture.root, undefined, { library: fixture.library });
});

test.afterEach(async () => {
    test.setTimeout(test.info().timeout + HOOK_TIMEOUT);
    await curator?.stop();
});

const data = () => {
    if (!fixture) throw new Error('The history fixture was not made');
    return fixture;
};
const origin = () => {
    if (!curator) throw new Error('The curator server did not start');
    return curator.origin;
};

test.describe('with JavaScript, before the page hydrates', () => {
    test("every press on History's restore form posts nothing and lands on no 403, its reason takes no typing, the status says so, and once ready Restore posts", async ({ page }) => {
        test.setTimeout(5 * 60_000);
        await signIn(page, origin(), (curator as CuratorServer).passphrase);
        const release = await holdScripts(page);
        await page.goto(`${origin()}/curation/publish?restore=2#restore-heading`, { waitUntil: 'domcontentloaded' });
        const watch = watchPosts(page);
        const forms = page.locator('main form');
        await expect(forms, 'the restore form, the only one').toHaveCount(1);
        await expect(page.locator('#restore-heading')).toHaveText('Restore revision 2?');
        expect(await page.locator('html[data-hydrated]').count(), 'the page is held back from hydrating').toBe(0);
        const submit = page.locator('#restore-submit');
        await expect(submit, 'the press it makes once ready is offered').toHaveText('Restore revision 2');
        await expect(page.locator(GATE_STATUS), 'no status before a press').toHaveCount(0);

        const covered = await pressEveryFormEarly(page, { name: 'History', forms, root: data().root, watch });

        // The reason takes no typing before the form is ready, so what it shows is what the form will send.
        const reason = page.locator('#restore-reason');
        await reason.evaluate((element) => {
            (element as HTMLTextAreaElement).value = '';
        });
        await reason.click();
        await page.keyboard.type('Typed before the page was ready.');
        await expect(reason, 'the reason before the form is ready').toHaveValue('');
        covered.push('History: typing in the reason');
        // Checked after the presses, so a form without the gate fails at the press that posts, by its name.
        await expect(forms.first(), 'the form waits at the gate').toHaveAttribute('data-submit-gate', 'waiting');

        const before = written(data().root);
        await release();
        await nothingOnceReady(page, { name: 'History', root: data().root, before, watch });
        await expect(forms.first(), 'the form is ready').toHaveAttribute('data-submit-gate', 'ready');

        // Once ready, the form works: the reason takes typing, and Restore posts and restores.
        const activations = (await listActivations(data().root)).length;
        await reason.fill('The new order reads wrong.');
        await expect(reason).toHaveValue('The new order reads wrong.');
        const sent = page.waitForResponse((response) => response.request().method() === 'POST', { timeout: 15_000 });
        await submit.click();
        expect((await sent).status(), 'History: the press once ready').toBe(200);
        await page.waitForURL(/\?restored=4#history-result-heading$/);
        expect((await listActivations(data().root)).length, 'History: the press once ready restores').toBe(activations + 1);
        expect(watch.refused, 'History: nothing landed on a 403').toEqual([]);
        watch.stop();
        await page.unrouteAll({ behavior: 'ignoreErrors' });

        expect(covered).toEqual(expect.arrayContaining(['History: press Restore revision 2', 'History: requestSubmit, form 1', 'History: typing in the reason']));
    });
});
