import type { BrowserContext, Locator, Page } from '@playwright/test';
import { SUBMIT_GATE_STATUS_TEXT } from '../../components/site/submitGateScript';
import { deferEvent } from '../../lib/curation/actions';
import { eventIdOf, eventKey } from '../../lib/curation/events';
import { listEvents, readEvent } from '../../lib/curation/repository';
import { completeHiddenSegments } from '../../test/helpers/parityWalk';
import { READY_TIMEOUT } from './catalogServer';
import { signIn, startCuratorServer, type CuratorServer } from './curatorServer';
import { createInboxFixture, FRESH, openArchiveItem, openBindItems, openInboxItems, openReplacementItem, type InboxFixture } from './curation-inbox';
import { expect, test } from './test';

// The Inbox's submit gate in the browser (e2e/curation-inbox-gate*.spec.ts): one fixture and curator server per file and
// worker, with an item of every kind that has an action form, and the helpers both files share.

const HOOK_TIMEOUT = READY_TIMEOUT + 60_000;

/** The status the head's script shows after it drops something, and what it says. */
export const GATE_STATUS = '[data-submit-gate-status]';
export const GATE_STATUS_TEXT = SUBMIT_GATE_STATUS_TEXT;

/**
 * Registers the fixture and server, one per test: made before each test and stopped after it. Returns what the
 * tests read them by. The early-press test writes to every item, so a second run on the same fixture (a repeat, or
 * another test in the same worker) would start on items it had already moved on.
 */
export function useGateWorld() {
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
    // Each hook gets its own time on top of the test's.
    test.beforeEach(async () => {
        test.setTimeout(test.info().timeout + HOOK_TIMEOUT);
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
    test.afterEach(async () => {
        test.setTimeout(test.info().timeout + HOOK_TIMEOUT);
        await curator?.stop();
        await fixture?.cleanup();
    });
    return {
        data,
        origin,
        ids,
        passphrase: () => (curator as CuratorServer).passphrase,
        /**
         * An item's page with `#item` as its rows link it, or without, for the test with no JavaScript: a refused post
         * lands on the URL without the fragment, so a load of the same URL with it would only jump to it, not load again.
         */
        urlOf: (item: string | null, { hash = true }: { hash?: boolean } = {}) => `${origin()}/curation/inbox${item ? `?item=${ids[item]}${hash ? '#item' : ''}` : ''}`,
        /** Every event as it is on disk, so a test can say nothing was written. */
        written: async () => (await listEvents(data().root)).events.map((event) => JSON.stringify(event)).sort(),
        /** A context on the signed-in page's session, at its size, with JavaScript as `options` says. */
        signedInContext: async (page: Page, { javaScriptEnabled, isMobile }: { javaScriptEnabled: boolean; isMobile: boolean }): Promise<BrowserContext> => {
            await signIn(page, origin(), (curator as CuratorServer).passphrase);
            return page.context().browser()!.newContext({ javaScriptEnabled, isMobile, hasTouch: isMobile, storageState: await page.context().storageState(), viewport: page.viewportSize() });
        },
    };
}

/**
 * Every page with an action form: the list's bulk form, and each kind of item's own forms. `ready` finds, in `scope`,
 * the button the early-press test presses once the form is ready: Archive's first step opens the one that sends.
 */
export const PAGES = [
    { name: 'the list', item: null, scope: '#inbox-bulk', ready: 'button[name="intent"][value="defer"]' },
    { name: 'a new photograph', item: 'fresh', scope: '#item', ready: 'button[name="intent"][value="defer"]' },
    { name: 'a photograph decided later', item: 'reopen', scope: '#item', ready: 'button[name="intent"][value="reopen"]' },
    { name: 'a file the watcher cannot read', item: 'failed', scope: '#item', ready: 'button[name="intent"][value="dismiss"]' },
    { name: 'a replacement', item: 'replacement', scope: '#item', ready: 'button[name="intent"][value="confirm"]' },
    { name: 'a missing source to bind', item: 'bind', scope: '#item', ready: 'button[name="intent"][value="bind"]' },
    { name: 'a missing source to archive', item: 'archive', scope: '#item', ready: 'button[aria-controls="archive-confirm"]' },
] as const;
/**
 * Puts the streamed Inbox in place as React's own inline script would, which doesn't run without JavaScript: each
 * late segment into its placeholder (completeHiddenSegments), then each boundary's content in place of its loading
 * fallback, by the `$RC("B:…","S:…")` (or `$RR`) calls the page carries but can't run, and any segment left over shown
 * where it waits.
 */
export async function moveIntoPlace(page: Page) {
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

/** The action forms in `scope`: the bulk form itself, or each form in the item with an intent button or Archive's reason. */
export const actionForms = (page: Page, scope: string) =>
    scope === '#inbox-bulk' ? page.locator('#inbox-bulk') : page.locator(`${scope} form`).filter({ has: page.locator('button[name="intent"], #archive-reason') });

/** Fills each empty required field the plain way, with no input event, so the browser's own check lets a submit go. */
export const fillRequired = (form: Locator) =>
    form.evaluate((element) => {
        for (const field of element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[required], textarea[required]')) if (field.value === '') field.value = 'Held back.';
    });

/** Opens the <details> that holds `control`, if it's closed, with its summary, which needs no script. */
export async function reveal(control: Locator) {
    const details = control.locator('xpath=ancestor::details[1]');
    if ((await details.count()) && !(await details.evaluate((element) => (element as HTMLDetailsElement).open))) await details.locator('summary').click();
}

/** Holds back every script the page loads, so it can't hydrate, until the returned function lets them go. */
export async function holdScripts(page: Page): Promise<() => Promise<void>> {
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

export const focusOf = (page: Page) => page.evaluate(() => (document.activeElement === document.body ? 'body' : `${document.activeElement?.localName}#${document.activeElement?.id}:${(document.activeElement?.textContent ?? '').trim().slice(0, 30)}`));
