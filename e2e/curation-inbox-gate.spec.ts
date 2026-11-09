import type { Locator } from '@playwright/test';
import { readEvent } from '../lib/curation/repository';
import { signIn } from './support/curatorServer';
import { actionForms, fillRequired, focusOf, GATE_STATUS, GATE_STATUS_TEXT, holdScripts, PAGES, reveal, useGateWorld } from './support/inbox-gate';
import { expect, test } from './support/test';

// The Inbox's forms post by hand, from their handlers. Before a form has mounted, the head's script drops a press on it,
// and the first drop says the page is still loading; once each form has mounted it says it's ready, and the script lets
// it through. Each test here runs on its own (no serial mode), so one red never keeps the others from running. The
// no-JavaScript test is its own file, curation-inbox-gate-nojs.spec.ts.

// No action or wait here may hang: each fails by itself, and says which press it was.
test.use({ actionTimeout: 10_000 });

const { data, origin, ids, passphrase, urlOf, written } = useGateWorld();

test.describe('with JavaScript, before the page hydrates', () => {
    test("every press, Enter in Archive's reason and requestSubmit post nothing and keep the focus, the controls take no input, and each form works once it's ready", async ({ page }) => {
        test.setTimeout(10 * 60_000);
        await signIn(page, origin(), passphrase());
        const posts: string[] = [];
        page.on('request', (request) => {
            if (request.method() === 'POST') posts.push(request.url());
        });
        const covered: string[] = [];
        /** One attempt: nothing posted, the page where it was, nothing written, and the focus where the press left it. */
        const dropped = async (label: string, act: () => Promise<void>, focus: Locator | null) => {
            const url = page.url();
            const before = await written();
            const focusBefore = await focusOf(page);
            await act();
            await page.waitForTimeout(400);
            expect(posts, label).toEqual([]);
            expect(page.url(), label).toBe(url);
            expect(await written(), label).toEqual(before);
            if (focus) await expect(focus, label).toBeFocused();
            else expect(await focusOf(page), label).toBe(focusBefore);
            covered.push(label);
        };
        for (const where of PAGES) {
            const release = await holdScripts(page);
            await page.goto(urlOf(where.item), { waitUntil: 'domcontentloaded' });
            await expect(actionForms(page, where.scope).first()).toBeVisible();
            // The page shows its own item, in the state the press once ready needs, before anything is pressed. A page that
            // shows another item, or this one moved on, fails here by name, not at the last click.
            if (where.item !== null) await expect(page.locator('#item input[name="eventId"]').first(), `${where.name}: the page shows its item`).toHaveValue(ids[where.item]);
            await expect(actionForms(page, where.scope).locator(where.ready), `${where.name}: the press it makes once ready is offered`).toHaveCount(1);
            expect(await page.locator('html[data-hydrated]').count(), 'the page is held back from hydrating').toBe(0);
            // Nothing pressed, nothing said.
            await expect(page.locator(GATE_STATUS), `${where.name}: no status before a press`).toHaveCount(0);
            let said = false;

            // The submit presses first, so a press that went through is the first thing a held page fails on.
            const count = await actionForms(page, where.scope).count();
            for (let index = 0; index < count; index++) {
                const form = actionForms(page, where.scope).nth(index);
                const buttons = form.locator('button[name="intent"]');
                for (let at = 0; at < (await buttons.count()); at++) {
                    const button = buttons.nth(at);
                    await reveal(button);
                    await fillRequired(form);
                    await dropped(`${where.name}: press ${await button.getAttribute('value')}`, () => button.click({ timeout: 5000 }), button);
                    if (!said) {
                        // The first drop says the page is still loading, in a status that's read out, and shows it.
                        const status = page.getByRole('status').filter({ hasText: GATE_STATUS_TEXT });
                        await expect(status, `${where.name}: the status after a dropped press`).toBeVisible();
                        await expect(page.locator(GATE_STATUS)).toHaveCount(1);
                        said = true;
                    }
                }
                const reason = form.locator('#archive-reason');
                if (await reason.count()) {
                    await reveal(reason);
                    await fillRequired(form);
                    await reason.focus();
                    await dropped(`${where.name}: Enter in Archive's reason`, () => reason.press('Enter'), reason);
                }
                await fillRequired(form);
                await dropped(`${where.name}: requestSubmit, form ${index + 1}`, () => form.evaluate((element) => (element as HTMLFormElement).requestSubmit()), null);
            }

            // Then the controls that aren't submits: they take nothing before their form is ready, so what the screen shows
            // is what the form will send. What they show now, the presses' required fields filled, is the baseline.
            const review = page.locator('#item form[aria-label="Review"]');
            const decorative = review.getByRole('checkbox', { name: /Decorative/ });
            const description = review.locator('textarea').first();
            const series = review.locator('select').first();
            const shown = async () => ({ decorative: await decorative.isChecked(), description: await description.inputValue(), series: await series.inputValue() });
            let was: Awaited<ReturnType<typeof shown>> | null = null;
            // The key that would move the select to another option: up from the last one, as "Leave unassigned" is. On macOS
            // a key opens a closed select's menu instead, so there the unit test (submitGateScript) is this check's proof.
            let move = 'ArrowDown';
            if (where.item === null) {
                const box = page.locator(`#pick-${ids.bulk}`);
                await box.click();
                await expect(box, 'a row checkbox before the form is ready').not.toBeChecked();
                covered.push('the list: checkbox');
            } else if (where.item === 'fresh') {
                was = await shown();
                move = await series.evaluate((element) => ((element as HTMLSelectElement).selectedIndex === (element as HTMLSelectElement).options.length - 1 ? 'ArrowUp' : 'ArrowDown'));
                await decorative.click();
                await description.click();
                await page.keyboard.type('Typed before the page was ready.');
                await series.focus();
                await page.keyboard.press(move);
                expect(await shown(), 'a checkbox, a text area and a select before the form is ready').toEqual(was);
                covered.push('a new photograph: checkbox, text area and select');
            } else if (where.item === 'bind') {
                const typed = page.locator('#item form[aria-label="Bind"]').getByRole('radio', { name: 'Another file in the library' });
                await reveal(typed);
                await typed.click();
                await expect(typed, 'a radio before the form is ready').not.toBeChecked();
                covered.push('a missing source to bind: radio');
            }

            const beforeRelease = await written();
            await release();
            // Nothing a dropped press did goes out while the page hydrates, or once it's ready.
            await page.waitForTimeout(400);
            expect(posts, `${where.name}: nothing posted while the page hydrated`).toEqual([]);
            expect(await written(), `${where.name}: nothing written while the page hydrated`).toEqual(beforeRelease);
            // Once every form is ready, the word goes.
            await expect(page.locator(GATE_STATUS), `${where.name}: the status once ready`).toHaveCount(0);
            if (was) {
                // Once ready, the screen still shows what it did, and each control takes input as it should.
                expect(await shown(), 'once the form is ready').toEqual(was);
                await description.fill('A harbour wall at low tide.');
                await expect(description).toHaveValue('A harbour wall at low tide.');
                await decorative.click();
                await expect(decorative).toBeChecked({ checked: !was.decorative });
                await decorative.click();
                // Once ready, a choice takes. By selectOption, since a key on a closed select opens its menu on macOS
                // rather than moving it; before ready, the key is what the gate holds, where the platform moves it.
                const other = await series.evaluate((element) => {
                    const select = element as HTMLSelectElement;
                    return select.options[select.selectedIndex === 0 ? 1 : 0].value;
                });
                await series.selectOption(other);
                await expect(series).toHaveValue(other);
            }

            // Once ready, the form works: its press posts, and the item moves on.
            const target = where.item === null ? ids.bulk : ids[where.item];
            const version = (await readEvent(data().root, target))!.version;
            const sent = page.waitForResponse((response) => response.request().method() === 'POST', { timeout: 15_000 });
            if (where.item === null) {
                await page.locator(`#pick-${ids.bulk}`).check();
                await page.getByRole('button', { name: 'Decide later on selected' }).click();
            } else if (where.item === 'fresh') {
                await page.locator('#item').getByRole('button', { name: 'Decide later', exact: true }).click();
            } else if (where.item === 'reopen') {
                await page.locator('#item').getByRole('button', { name: 'Reopen' }).click();
            } else if (where.item === 'failed') {
                await page.locator('#item').getByRole('textbox', { name: 'Reason' }).fill('An export from another app; the JPEG is already in.');
                await page.locator('#item').getByRole('button', { name: 'Dismiss', exact: true }).click();
            } else if (where.item === 'replacement') {
                await page.locator('#item').getByRole('button', { name: 'Confirm new asset revision' }).click();
            } else if (where.item === 'bind') {
                const bind = page.locator('#item form[aria-label="Bind"]');
                await bind.getByRole('radio').first().check();
                await bind.getByRole('button', { name: 'Bind', exact: true }).click();
            } else {
                await page.locator('#archive-reason').fill('Gone for good: the file was lost.');
                await page.locator('#item').getByRole('button', { name: 'Archive', exact: true }).click();
                await page.locator('#item').getByRole('button', { name: 'Yes, archive it' }).click();
            }
            expect((await sent).status(), `${where.name}: the press once ready`).toBe(200);
            await expect.poll(async () => (await readEvent(data().root, target))!.version, `${where.name}: the press once ready writes`).toBeGreaterThan(version);
            // Decide later then opens the next item that needs a decision. That load lands before the next page is opened,
            // so the two never race.
            if (where.item === 'fresh') {
                await expect.poll(() => new URL(page.url()).searchParams.get('item'), { message: `${where.name}: Decide later moves on to another item`, timeout: 15_000 }).not.toBe(ids.fresh);
                await page.waitForLoadState('domcontentloaded');
            }
            posts.length = 0;
            await page.unrouteAll({ behavior: 'ignoreErrors' });
        }
        expect(covered).toEqual(
            expect.arrayContaining([
                'the list: press defer',
                'the list: press unassigned',
                'the list: requestSubmit, form 1',
                'the list: checkbox',
                'a new photograph: press edit',
                'a new photograph: press defer',
                'a new photograph: press approve',
                'a new photograph: press dismiss',
                'a new photograph: checkbox, text area and select',
                'a photograph decided later: press reopen',
                'a file the watcher cannot read: press dismiss',
                'a replacement: press confirm',
                'a missing source to bind: press bind',
                'a missing source to bind: radio',
                "a missing source to archive: Enter in Archive's reason",
            ]),
        );
    });

    test('a form without the gate, as Apply filters, sends the plain way before the page hydrates', async ({ page }) => {
        await signIn(page, origin(), passphrase());
        await holdScripts(page);
        await page.goto(urlOf(null), { waitUntil: 'domcontentloaded' });
        const filters = page.getByRole('search', { name: 'Filter the inbox' });
        await expect(filters).toBeVisible();
        expect(await page.locator('html[data-hydrated]').count()).toBe(0);
        await expect(filters).not.toHaveAttribute('data-submit-gate');
        await expect(page.locator(GATE_STATUS)).toHaveCount(0);
        const sent = page.waitForRequest((request) => request.method() === 'GET' && new URL(request.url()).pathname === '/curation/inbox' && new URL(request.url()).search !== '', { timeout: 15_000 });
        await filters.getByRole('button', { name: 'Apply filters' }).click();
        await sent;
        await page.unrouteAll({ behavior: 'ignoreErrors' });
    });
});
