import type { BrowserContext, Locator, Page } from '@playwright/test';
import { deferEvent } from '../lib/curation/actions';
import { eventIdOf, eventKey } from '../lib/curation/events';
import { listEvents, readEvent } from '../lib/curation/repository';
import { completeHiddenSegments } from '../test/helpers/parityWalk';
import { READY_TIMEOUT } from './support/catalogServer';
import { signIn, startCuratorServer, type CuratorServer } from './support/curatorServer';
import { createInboxFixture, FRESH, openArchiveItem, openBindItems, openInboxItems, openReplacementItem, type InboxFixture } from './support/curation-inbox';
import { expect, test } from './support/test';

// The Inbox's forms post by hand, from their handlers. Before the page hydrates the head's script drops a press on any
// of them, and once each form has mounted it says it's ready and the script lets it through. Without JavaScript nothing
// gates, so the server's markup holds no `disabled` for it; the Inbox shows only its loading state then, and a post
// made anyway is the boundary's to refuse, with nothing written.

test.describe.configure({ mode: 'serial' });
// No action or wait here may hang: each fails by itself, and says which press it was.
test.use({ actionTimeout: 10_000 });

const HOOK_TIMEOUT = READY_TIMEOUT + 60_000;

let fixture: InboxFixture | undefined;
let curator: CuratorServer | undefined;
const ids: Record<string, string> = {};

const data = () => {
    if (!fixture) throw new Error('The inbox fixture was not made');
    return fixture;
};
const origin = () => {
    if (!curator) throw new Error('The curator server did not start');
    return curator.origin;
};
const eventOf = (photoId: string) => eventIdOf(eventKey('new', { photoId, assetRevision: data().revisionOf(photoId), key: `new:${photoId}:${data().revisionOf(photoId)}` }));

test.beforeAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    fixture = await createInboxFixture();
    await openInboxItems(fixture);
    ids.replacement = await openReplacementItem(fixture);
    ids.bind = (await openBindItems(fixture)).missingId;
    ids.archive = await openArchiveItem(fixture);
    ids.fresh = eventOf(FRESH.approve);
    ids.bulk = eventOf(FRESH.unassigned);
    ids.reopen = eventOf(FRESH.reopen);
    const decided = (await readEvent(fixture.root, ids.reopen))!;
    expect(await deferEvent({ root: fixture.root, eventId: ids.reopen, expectedVersion: decided.version, actor: 'curator:cli' })).toMatchObject({ ok: true });
    const { events } = await listEvents(fixture.root);
    ids.failed = events.find((event) => event.type === 'processing-failure')!.id;
    curator = await startCuratorServer(fixture.root, undefined, { library: fixture.library });
});

test.afterAll(async () => {
    test.setTimeout(HOOK_TIMEOUT);
    await curator?.stop();
    await fixture?.cleanup();
});

/** Every page with an action form: the list's bulk form, and each kind of item's own forms. */
const PAGES = [
    { name: 'the list', item: null, scope: '#inbox-bulk' },
    { name: 'a new photograph', item: 'fresh', scope: '#item' },
    { name: 'a photograph decided later', item: 'reopen', scope: '#item' },
    { name: 'a file the watcher cannot read', item: 'failed', scope: '#item' },
    { name: 'a replacement', item: 'replacement', scope: '#item' },
    { name: 'a missing source to bind', item: 'bind', scope: '#item' },
    { name: 'a missing source to archive', item: 'archive', scope: '#item' },
] as const;
/**
 * An item's page with `#item` as its rows link it, or without, for the test with no JavaScript: a refused post lands on
 * the URL without the fragment, so a load of the same URL with it would only jump to it, not load the page again.
 */
const urlOf = (item: string | null, { hash = true }: { hash?: boolean } = {}) => `${origin()}/curation/inbox${item ? `?item=${ids[item]}${hash ? '#item' : ''}` : ''}`;

/**
 * Puts the streamed Inbox in place as React's own inline script would, which doesn't run without JavaScript: each
 * late segment into its placeholder (completeHiddenSegments), then each boundary's content in place of its loading
 * fallback, by the `$RC("B:…","S:…")` (or `$RR`) calls the page carries but can't run, and any segment left over shown
 * where it waits.
 */
async function moveIntoPlace(page: Page) {
    await page.evaluate(completeHiddenSegments);
    await page.evaluate(() => {
        const calls = [...document.querySelectorAll('script')].flatMap((script) => [...(script.textContent ?? '').matchAll(/\$R[CR]\("(B:[0-9a-f]+)","(S:[0-9a-f]+)"/g)].map((call) => [call[1], call[2]] as const));
        for (const [boundaryId, segmentId] of calls) {
            const boundary = document.getElementById(boundaryId);
            const segment = document.getElementById(segmentId);
            if (!boundary || !segment) continue;
            // The fallback runs from the boundary's template to the comment that closes it.
            let depth = 0;
            for (let node = boundary.nextSibling; node; ) {
                const next = node.nextSibling;
                if (node.nodeType === Node.COMMENT_NODE) {
                    const mark = (node as Comment).data;
                    if (mark === '/$') {
                        if (depth === 0) break;
                        depth -= 1;
                    } else if (mark === '$' || mark === '$?' || mark === '$!') depth += 1;
                }
                node.remove();
                node = next;
            }
            boundary.replaceWith(...segment.childNodes);
            segment.remove();
        }
        // A segment no call names is shown where it waits, so its forms can still be pressed.
        for (const segment of document.querySelectorAll('body > div[hidden][id^="S:"]')) segment.removeAttribute('hidden');
    });
}

/** Every event as it is on disk, so a test can say nothing was written. */
const written = async () => (await listEvents(data().root)).events.map((event) => JSON.stringify(event)).sort();

/** The action forms in `scope`: the bulk form itself, or each form in the item with an intent button or Archive's reason. */
const actionForms = (page: Page, scope: string) =>
    scope === '#inbox-bulk' ? page.locator('#inbox-bulk') : page.locator(`${scope} form`).filter({ has: page.locator('button[name="intent"], #archive-reason') });

/** Fills each empty required field the plain way, with no input event, so the browser's own check lets a submit go. */
const fillRequired = (form: Locator) =>
    form.evaluate((element) => {
        for (const field of element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[required], textarea[required]')) if (field.value === '') field.value = 'Held back.';
    });

/** Opens the <details> that holds `control`, if it's closed, with its summary, which needs no script. */
async function reveal(control: Locator) {
    const details = control.locator('xpath=ancestor::details[1]');
    if ((await details.count()) && !(await details.evaluate((element) => (element as HTMLDetailsElement).open))) await details.locator('summary').click();
}

/** A context on the signed-in page's session, at its size, with JavaScript as `options` says. */
async function signedInContext(page: Page, { javaScriptEnabled, isMobile }: { javaScriptEnabled: boolean; isMobile: boolean }): Promise<BrowserContext> {
    await signIn(page, origin(), (curator as CuratorServer).passphrase);
    return page.context().browser()!.newContext({ javaScriptEnabled, isMobile, hasTouch: isMobile, storageState: await page.context().storageState(), viewport: page.viewportSize() });
}

test.describe('without JavaScript', () => {
    test("each bulk and item form is out of sight, and a post made anyway is refused at the boundary, with nothing written", async ({ page: signed, isMobile }) => {
        test.setTimeout(10 * 60_000);
        const context = await signedInContext(signed, { javaScriptEnabled: false, isMobile });
        const page = await context.newPage();
        const pressed: string[] = [];
        try {
            for (const where of PAGES) {
                // Out of sight: the Inbox streams in behind its loading state, which only React's own script swaps out.
                await page.goto(urlOf(where.item, { hash: false }));
                await expect(page.getByText('Loading the inbox')).toBeVisible();
                await expect(actionForms(page, where.scope).first()).toBeHidden();
                await moveIntoPlace(page);
                await expect(actionForms(page, where.scope).first(), `${where.name}: moved into place`).toBeVisible();
                const count = await actionForms(page, where.scope).count();
                expect(count, `${where.name} has an action form`).toBeGreaterThan(0);
                for (let index = 0; index < count; index++) {
                    await page.goto(urlOf(where.item, { hash: false }));
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
                            await page.goto(urlOf(where.item, { hash: false }));
                            await moveIntoPlace(page);
                        }
                        const before = await written();
                        const posted = page.waitForResponse((response) => response.request().method() === 'POST', { timeout: 15_000 });
                        await press.act();
                        // Curator pages send no referrer, so the form's Origin is "null", and the boundary refuses it first.
                        expect((await posted).status(), press.label).toBe(403);
                        expect(await written(), press.label).toEqual(before);
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

/** Holds back every script the page loads, so it can't hydrate, until the returned function lets them go. */
async function holdScripts(page: Page): Promise<() => Promise<void>> {
    let release = () => undefined as void;
    const held = new Promise<void>((done) => {
        release = done;
    });
    await page.route(/\/_next\/static\/.*\.js(?:\?.*)?$/, async (route) => {
        await held;
        await route.continue().catch(() => undefined);
    });
    return async () => {
        release();
        await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
        // Each form says it's ready once it has mounted: what the screen shows is then what its handlers send.
        await expect(page.locator('form[data-submit-gate]').first()).toBeAttached();
        await expect(page.locator('form[data-submit-gate="waiting"]')).toHaveCount(0);
    };
}

const focusOf = (page: Page) => page.evaluate(() => (document.activeElement === document.body ? 'body' : `${document.activeElement?.localName}#${document.activeElement?.id}:${(document.activeElement?.textContent ?? '').trim().slice(0, 30)}`));

test.describe('with JavaScript, before the page hydrates', () => {
    test("every press, Enter in Archive's reason and requestSubmit post nothing and keep the focus, the controls take no input, and each form works once it's ready", async ({ page }) => {
        test.setTimeout(10 * 60_000);
        await signIn(page, origin(), (curator as CuratorServer).passphrase);
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
            expect(await page.locator('html[data-hydrated]').count(), 'the page is held back from hydrating').toBe(0);

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

            await release();
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
        await signIn(page, origin(), (curator as CuratorServer).passphrase);
        await holdScripts(page);
        await page.goto(urlOf(null), { waitUntil: 'domcontentloaded' });
        const filters = page.getByRole('search', { name: 'Filter the inbox' });
        await expect(filters).toBeVisible();
        expect(await page.locator('html[data-hydrated]').count()).toBe(0);
        await expect(filters).not.toHaveAttribute('data-submit-gate');
        const sent = page.waitForRequest((request) => request.method() === 'GET' && new URL(request.url()).pathname === '/curation/inbox' && new URL(request.url()).search !== '', { timeout: 15_000 });
        await filters.getByRole('button', { name: 'Apply filters' }).click();
        await sent;
        await page.unrouteAll({ behavior: 'ignoreErrors' });
    });
});
