import { afterEach, describe, expect, it } from 'vitest';
import { inboxFormsUnready, pageReady, waitForInboxForms } from './helpers/inboxReady';

// e2e/support/hydration.ts's last wait, run in the page: every form at the submit gate ready, and on an Inbox URL the
// Inbox itself in first, since it streams after the shell and its forms aren't there to wait for until it does.

const at = (url: string) => window.history.replaceState(null, '', url);
const loading = '<div role="status"><span>Loading the inbox</span></div>';
const form = (gate: 'waiting' | 'ready') => `<form data-submit-gate="${gate}"><button name="intent" value="defer">Decide later</button></form>`;

afterEach(() => {
    document.body.innerHTML = '';
    at('/');
});

describe('pageReady', () => {
    it('waits on an Inbox URL while the Inbox is still loading, with no gated form yet', () => {
        for (const url of ['/curation/inbox', '/curation/inbox?item=evt_000000000000000000000001#item']) {
            at(url);
            document.body.innerHTML = loading;
            expect(pageReady(), url).toBe(false);
        }
    });

    it('waits while any gated form waits, on the Inbox or anywhere', () => {
        for (const url of ['/curation/inbox', '/curation/publish']) {
            at(url);
            document.body.innerHTML = `${form('ready')}${form('waiting')}`;
            expect(pageReady(), url).toBe(false);
        }
    });

    it('is ready once the Inbox is in and every gated form is ready', () => {
        at('/curation/inbox');
        document.body.innerHTML = `${form('ready')}${form('ready')}`;
        expect(pageReady()).toBe(true);
    });

    it('is ready on an Inbox with nothing to act on once its loading state is gone', () => {
        at('/curation/inbox');
        document.body.innerHTML = '<main><p>Nothing requires judgment.</p></main>';
        expect(pageReady()).toBe(true);
    });

    it('is ready on any other page with no gated form, as before', () => {
        at('/curation/publish');
        document.body.innerHTML = '<main><div role="status"><span>Loading</span></div></main>';
        expect(pageReady()).toBe(true);
    });
});

/** A form as React leaves it once it has hydrated it: a fiber key on the node. */
const claim = <T extends Element>(element: T) => Object.assign(element, { __reactFiber$probe: {} });

describe('inboxFormsUnready', () => {
    it('names the first Inbox form still waiting at the submit gate', () => {
        document.body.innerHTML = `<main><form aria-label="Bulk actions" data-submit-gate="ready"></form><form aria-label="Review" data-submit-gate="waiting"></form></main>`;
        for (const form of document.querySelectorAll('form')) claim(form);
        expect(inboxFormsUnready()).toBe('an Inbox form kept waiting: Review');
    });

    it('names the first Inbox form React never claimed, by its label, its id or its place', () => {
        document.body.innerHTML = `<main><form aria-label="Filter the inbox"></form><form id="inbox-bulk"></form><section><form></form></section></main>`;
        const [labelled, withId, bare] = [...document.querySelectorAll('form')];
        expect(inboxFormsUnready()).toBe('an Inbox form was never claimed by React: Filter the inbox');
        claim(labelled);
        expect(inboxFormsUnready()).toBe('an Inbox form was never claimed by React: #inbox-bulk');
        claim(withId);
        expect(inboxFormsUnready()).toBe('an Inbox form was never claimed by React: main>section:nth-of-type(1)>form:nth-of-type(1)');
        claim(bare);
        expect(inboxFormsUnready()).toBeNull();
    });

    it("passes the base's Inbox, which has no submit gate, once React has claimed its forms", () => {
        document.body.innerHTML = '<main><form aria-label="Filter the inbox" method="get"></form><form aria-label="Review" method="post"></form></main>';
        for (const form of document.querySelectorAll('form')) claim(form);
        expect(inboxFormsUnready()).toBeNull();
    });
});

describe('waitForInboxForms', () => {
    /** A page whose Inbox answers `answers` in turn, then the last one for good. */
    const pageAnswering = (...answers: (string | null)[]) => {
        let asked = 0;
        return {
            asked: () => asked,
            evaluate: async () => answers[Math.min(asked++, answers.length - 1)],
        };
    };

    it('returns once the Inbox forms are ready and claimed', async () => {
        const page = pageAnswering('an Inbox form kept waiting: Review', null);
        await expect(waitForInboxForms(page, { timeout: 1000, interval: 10 })).resolves.toBeUndefined();
        expect(page.asked()).toBe(2);
    });

    it('fails by name within its timeout when a form never hydrates, never walking on and never hanging', async () => {
        const started = Date.now();
        await expect(waitForInboxForms(pageAnswering('an Inbox form was never claimed by React: Review'), { timeout: 300, interval: 10 })).rejects.toThrow(
            /^The Inbox didn't hydrate within 300 ms: an Inbox form was never claimed by React: Review$/,
        );
        expect(Date.now() - started).toBeLessThan(2000);
        await expect(waitForInboxForms(pageAnswering('an Inbox form kept waiting: Bulk actions'), { timeout: 200, interval: 10 })).rejects.toThrow(/an Inbox form kept waiting: Bulk actions$/);
    }, 5000);
});

