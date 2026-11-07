import { actionForms, fillRequired, moveIntoPlace, PAGES, reveal, useGateWorld } from './support/inbox-gate';
import { expect, test } from './support/test';

// The Inbox with no JavaScript: nothing gates, so the server's markup is all there is. The Inbox shows only its loading
// state, since only React's own script swaps the streamed content in; a post made anyway, by moving that content into
// place, is the boundary's to refuse, by its "null" Origin, with nothing written. A file of its own, so a red here never
// keeps the scripted tests (curation-inbox-gate.spec.ts) from running.

// No action or wait here may hang: each fails by itself, and says which press it was.
test.use({ actionTimeout: 10_000 });

const world = useGateWorld();

test.describe('without JavaScript', () => {
    test("each bulk and item form is out of sight, and a post made anyway is refused at the boundary, with nothing written", async ({ page: signed, isMobile }) => {
        test.setTimeout(10 * 60_000);
        const context = await world.signedInContext(signed, { javaScriptEnabled: false, isMobile });
        const page = await context.newPage();
        const pressed: string[] = [];
        try {
            for (const where of PAGES) {
                // Out of sight: the Inbox streams in behind its loading state, which only React's own script swaps out.
                await page.goto(world.urlOf(where.item, { hash: false }));
                await expect(page.getByText('Loading the inbox')).toBeVisible();
                await expect(actionForms(page, where.scope).first()).toBeHidden();
                await moveIntoPlace(page);
                await expect(actionForms(page, where.scope).first(), `${where.name}: moved into place`).toBeVisible();
                const count = await actionForms(page, where.scope).count();
                expect(count, `${where.name} has an action form`).toBeGreaterThan(0);
                for (let index = 0; index < count; index++) {
                    await page.goto(world.urlOf(where.item, { hash: false }));
                    await moveIntoPlace(page);
                    const form = actionForms(page, where.scope).nth(index);
                    const buttons = await form.locator('button[name="intent"]').count();
                    const presses: { label: string; act: () => Promise<void> }[] = [];
                    for (let at = 0; at < buttons; at++) {
                        presses.push({
                            label: `${where.name}: ${await form.locator('button[name="intent"]').nth(at).getAttribute('value')}`,
                            act: async () => {
                                const button = actionForms(page, where.scope).nth(index).locator('button[name="intent"]').nth(at);
                                await reveal(button);
                                if (where.scope === '#inbox-bulk') await page.locator('input[type="checkbox"][form="inbox-bulk"]').first().check();
                                await fillRequired(actionForms(page, where.scope).nth(index));
                                await button.click({ timeout: 5000 });
                            },
                        });
                    }
                    // Archive's first step has no submit button, so Enter in its reason sends the form the plain way.
                    if (await form.locator('#archive-reason').count()) {
                        presses.push({
                            label: `${where.name}: Enter in Archive's reason`,
                            act: async () => {
                                const reason = page.locator('#archive-reason');
                                await reveal(reason);
                                await reason.fill('Taken down at the owner’s request.', { timeout: 5000 });
                                await reason.press('Enter');
                            },
                        });
                    }
                    for (const [at, press] of presses.entries()) {
                        if (at > 0) {
                            await page.goto(world.urlOf(where.item, { hash: false }));
                            await moveIntoPlace(page);
                        }
                        const before = await world.written();
                        const posted = page.waitForResponse((response) => response.request().method() === 'POST', { timeout: 15_000 });
                        await press.act();
                        // Curator pages send no referrer, so the form's Origin is "null", and the boundary refuses it first.
                        const response = await posted;
                        expect((await response.request().allHeaders()).origin, press.label).toBe('null');
                        expect(response.status(), press.label).toBe(403);
                        expect(await world.written(), press.label).toEqual(before);
                        pressed.push(press.label);
                    }
                }
            }
            expect(pressed).toEqual(
                expect.arrayContaining([
                    'the list: defer',
                    'the list: unassigned',
                    'a new photograph: edit',
                    'a new photograph: defer',
                    'a new photograph: approve',
                    'a new photograph: dismiss',
                    'a photograph decided later: reopen',
                    'a file the watcher cannot read: dismiss',
                    'a replacement: confirm',
                    'a missing source to bind: bind',
                    "a missing source to archive: Enter in Archive's reason",
                ]),
            );
        } finally {
            await context.close();
        }
    });
});
