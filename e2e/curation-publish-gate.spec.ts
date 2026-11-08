import { createPublishFixture, BREAKWATER_TITLE, type PublishFixture } from '../test/helpers/publishFixture';
import { READY_TIMEOUT } from './support/catalogServer';
import { signIn, startCuratorServer, type CuratorServer } from './support/curatorServer';
import { nothingOnceReady, pressEveryFormEarly, watchPosts, written } from './support/forms-gate';
import { GATE_STATUS, holdScripts } from './support/inbox-gate';
import { expect, test } from './support/test';

// The Publish screen's forms at the submit gate (components/site/submitGateScript.ts): the description review a fix
// link opens, Still right, Use the published value, and the bar's Validate and Publish. Each posts through the screen's
// action, and with no referrer a plain post before hydration lands on the curator's 403. Before the page hydrates,
// the head's script drops every press on them, and the first drop says the page is still loading; once each form has
// mounted it says it's ready, and a press posts. With no JavaScript the forms are the server's markup alone, as
// e2e/curation-publish.spec.ts's no-JavaScript test has them. The data root is left under the system's temp folder.

test.use({ actionTimeout: 10_000 });

const HOOK_TIMEOUT = READY_TIMEOUT + 90_000;

let fixture: PublishFixture | undefined;
let curator: CuratorServer | undefined;

test.beforeEach(async () => {
    test.setTimeout(test.info().timeout + HOOK_TIMEOUT);
    fixture = await createPublishFixture();
    curator = await startCuratorServer(fixture.root, undefined, { library: fixture.library });
});

test.afterEach(async () => {
    test.setTimeout(test.info().timeout + HOOK_TIMEOUT);
    await curator?.stop();
});

const data = () => {
    if (!fixture) throw new Error('The publish fixture was not made');
    return fixture;
};
const origin = () => {
    if (!curator) throw new Error('The curator server did not start');
    return curator.origin;
};

test.describe('with JavaScript, before the page hydrates', () => {
    test("every press on the Publish screen's forms posts nothing and lands on no 403, the status says so, and once ready Validate posts", async ({ page }) => {
        test.setTimeout(5 * 60_000);
        await signIn(page, origin(), (curator as CuratorServer).passphrase);
        // The fix link's own address opens the description review in the server HTML, so all four forms are there.
        const release = await holdScripts(page);
        await page.goto(`${origin()}/curation/publish`, { waitUntil: 'domcontentloaded' });
        const fixLink = page.getByRole('link', { name: new RegExp(`^Review and mark description ready\\s*: ${BREAKWATER_TITLE}$`) });
        const href = await fixLink.getAttribute('href');
        expect(href, 'the fix link has its own address').toMatch(/^\/curation\/publish\?fix=chg-[0-9a-f]{16}#fix-heading$/);
        await page.goto(`${origin()}${href}`, { waitUntil: 'domcontentloaded' });
        const watch = watchPosts(page);
        const forms = page.locator('main form');
        await expect(forms, 'the four forms').toHaveCount(4);
        expect(await page.locator('html[data-hydrated]').count(), 'the page is held back from hydrating').toBe(0);
        // The press it makes once ready is offered before anything is pressed.
        const validate = page.locator('main form[data-sticky-bar] button[value="validate"]');
        await expect(validate, 'the press it makes once ready is offered').toHaveCount(1);
        await expect(page.locator(GATE_STATUS), 'no status before a press').toHaveCount(0);

        const covered = await pressEveryFormEarly(page, { name: 'Publish', forms, root: data().root, watch });
        // Checked after the presses, so a form without the gate fails at the press that posts, by its name.
        for (const form of await forms.all()) await expect(form, 'each form waits at the gate').toHaveAttribute('data-submit-gate', 'waiting');

        const before = written(data().root);
        await release();
        await nothingOnceReady(page, { name: 'Publish', root: data().root, before, watch });
        for (const form of await forms.all()) await expect(form, 'each form is ready').toHaveAttribute('data-submit-gate', 'ready');

        // Once ready, the form works: Validate posts and answers.
        const sent = page.waitForResponse((response) => response.request().method() === 'POST', { timeout: 15_000 });
        await validate.click();
        expect((await sent).status(), 'Publish: the press once ready').toBe(200);
        await expect(page.locator('#result-heading'), 'Publish: the press once ready answers').toHaveText('Publication blocked');
        expect(watch.refused, 'Publish: nothing landed on a 403').toEqual([]);
        watch.stop();
        await page.unrouteAll({ behavior: 'ignoreErrors' });

        expect(covered).toEqual(
            expect.arrayContaining([
                'Publish: press Still right, mark reviewed: Pier lamps position in Salt Roads',
                "Publish: press Use the published value: the order of Salt Roads, from Pier lamps' move",
                `Publish: press Mark description ready: ${BREAKWATER_TITLE}`,
                'Publish: press Validate revision',
                'Publish: press Publish revision 3',
                'Publish: requestSubmit, form 1',
                'Publish: requestSubmit, form 4',
            ]),
        );
    });
});
