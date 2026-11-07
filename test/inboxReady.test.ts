import { afterEach, describe, expect, it } from 'vitest';
import { pageReady } from './helpers/inboxReady';

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
