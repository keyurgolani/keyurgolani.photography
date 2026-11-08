import type { Page } from '@playwright/test';
import { readEvent } from '../lib/curation/repository';
import { signIn } from './support/curatorServer';
import { INBOX_SERIES } from './support/curation-inbox';
import { waitForHydration } from './support/hydration';
import { useGateWorld } from './support/inbox-gate';
import { watchSends } from './support/sent-forms';
import { expect, test } from './support/test';

// Enter on a checkbox, a radio or a select in an Inbox form, on both projects. In Chromium the key sends the form by its
// first enabled submit button: Decide later on selected from a ticked row box, Save edits from Decorative, Bind from a
// file to bind. Each form stops that, so the key there sends nothing, and the page stays where it was. Space still
// ticks, the arrow keys still choose, and Enter in a text field still sends its form, as before. Bind's suggested
// files and Release are curation-inbox-held.spec.ts's, on its fixture. The fixture and server are one per test
// (useGateWorld), so each row stands on its own. Bind and Dismiss sit in closed disclosures, whose content a role query
// can't find, so each row opens its own by its summary first, as the curator does.

test.use({ actionTimeout: 10_000 });

const { data, origin, ids, passphrase, urlOf, written } = useGateWorld();

async function open(page: Page, item: string | null) {
    await signIn(page, origin(), passphrase());
    await page.goto(urlOf(item));
    await waitForHydration(page);
}

test('the list: Enter on a ticked row checkbox sends nothing, and the box stays ticked and focused', async ({ page }) => {
    await open(page, null);
    const sends = await watchSends(page);
    const before = await written();
    const box = page.locator(`#pick-${ids.bulk}`);
    await box.focus();
    await page.keyboard.press('Space');
    await expect(box, 'Space ticks a row box').toBeChecked();
    await sends.nothingSent('Enter on a ticked row box', () => page.keyboard.press('Enter'));
    await expect(box).toBeChecked();
    await expect(box).toBeFocused();
    await page.keyboard.press('Space');
    await expect(box, 'Space unticks it').not.toBeChecked();
    expect(await written(), 'nothing written').toEqual(before);
});

test('a new photograph: Enter on Decorative, a sequence radio or a select sends nothing, and Space and the arrow keys still work', async ({ page }) => {
    await open(page, 'fresh');
    const sends = await watchSends(page);
    const before = await written();
    const review = page.getByRole('form', { name: 'Review' });
    await expect(review).toHaveAttribute('data-submit-gate', 'ready');

    const decorative = review.getByRole('checkbox', { name: /Decorative/ });
    const was = await decorative.isChecked();
    await decorative.focus();
    await sends.nothingSent('Enter on Decorative', () => page.keyboard.press('Enter'));
    await expect(decorative).toBeChecked({ checked: was });
    await expect(decorative).toBeFocused();
    await page.keyboard.press('Space');
    await expect(decorative, 'Space ticks Decorative').toBeChecked({ checked: !was });
    await page.keyboard.press('Space');
    await expect(decorative).toBeChecked({ checked: was });

    // The sequence editor's radios, for the published series.
    await review.getByRole('combobox', { name: 'Suggested series' }).selectOption(INBOX_SERIES.published.id);
    await review.getByRole('combobox', { name: 'Proposed sequence position' }).selectOption('editor');
    const slots = review.getByRole('group', { name: /^Place it in / }).getByRole('radio');
    const start = slots.first();
    await start.check();
    await start.focus();
    await sends.nothingSent('Enter on a sequence radio', () => page.keyboard.press('Enter'));
    await expect(start).toBeChecked();
    await expect(start).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(slots.nth(1), 'the arrow keys still move between the radios').toBeChecked();
    await expect(slots.nth(1)).toBeFocused();

    // Last, since on some platforms Enter opens a select's menu, which Escape closes.
    const series = review.getByRole('combobox', { name: 'Suggested series' });
    await series.focus();
    await sends.nothingSent('Enter on Suggested series', async () => {
        await page.keyboard.press('Enter');
        await page.keyboard.press('Escape');
    });
    await expect(series).toHaveValue(INBOX_SERIES.published.id);
    expect(await written(), 'nothing written').toEqual(before);
});

test("a missing source to bind: Enter on a file's radio sends nothing, the arrow keys still choose, and Enter in Library path still sends Bind", async ({ page }) => {
    await open(page, 'bind');
    const sends = await watchSends(page);
    const before = await written();
    await page.locator('#item').getByText('Bind to the file that replaces it').click();
    const bind = page.getByRole('form', { name: 'Bind' });
    const radios = bind.getByRole('group', { name: 'File to bind' }).getByRole('radio');
    await expect(radios, 'the file at its last path, then Another file in the library').toHaveCount(2);
    await expect(radios.first(), 'the file at its last path is chosen').toBeChecked();
    const linked = ((await radios.first().locator('xpath=ancestor::label[1]').textContent()) ?? '').replace(/, the new file at its last path$/, '');
    await radios.first().focus();
    await sends.nothingSent("Enter on the file at its last path's radio", () => page.keyboard.press('Enter'));
    await expect(radios.first()).toBeChecked();
    await expect(radios.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    const another = bind.getByRole('radio', { name: 'Another file in the library' });
    await expect(another, 'the arrow keys still move between the radios').toBeChecked();
    await sends.nothingSent('Enter on Another file in the library', () => page.keyboard.press('Enter'));
    await expect(another).toBeFocused();
    expect(await written(), 'nothing written').toEqual(before);

    // Enter in a text field still sends its form, as the browser does by itself.
    await sends.stop();
    const path = bind.getByRole('textbox', { name: 'Library path' });
    await path.fill(linked);
    const sent = page.waitForResponse((response) => response.request().method() === 'POST', { timeout: 15_000 });
    await path.press('Enter');
    expect((await sent).status(), 'Enter in Library path posts Bind').toBe(200);
    expect(await sends.forms()).toEqual(['Bind']);
});

test("a file the watcher cannot read: Enter in Dismiss's reason still sends Dismiss", async ({ page }) => {
    await open(page, 'failed');
    const sends = await watchSends(page);
    await sends.stop();
    await page.locator('#item').getByText('Dismiss with a reason').click();
    const reason = page.locator('#item').getByRole('textbox', { name: 'Reason' });
    await expect(reason).toBeVisible();
    await reason.fill('An export from another app; the JPEG is already in.');
    const version = (await readEvent(data().root, ids.failed))!.version;
    const sent = page.waitForResponse((response) => response.request().method() === 'POST', { timeout: 15_000 });
    await reason.press('Enter');
    expect((await sent).status(), "Enter in Dismiss's reason posts Dismiss").toBe(200);
    expect(await sends.forms()).toHaveLength(1);
    await expect.poll(async () => (await readEvent(data().root, ids.failed))!.version, 'Dismiss writes').toBeGreaterThan(version);
});
