import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import InboxLoading from '../loading';

// Without JavaScript the Inbox never leaves this loading state: the list and the header stream into hidden segments
// that only React's own script moves into place. So the state says so itself, in a <noscript> after its status region.
// The browser's side, where the parser keeps <noscript> as raw text, is e2e/curation-inbox-gate-nojs.spec.ts's.

const NOTE = 'The Inbox and its header, with Sign out, need JavaScript. Nothing is written without it.';

describe('the Inbox loading state', () => {
    const markup = renderToStaticMarkup(<InboxLoading />);
    const page = new DOMParser().parseFromString(markup, 'text/html');

    it('says the Inbox and its header need JavaScript, in a <noscript>', () => {
        const notes = page.querySelectorAll('noscript');
        expect(notes).toHaveLength(1);
        expect(notes[0].textContent).toContain(NOTE);
    });

    it('keeps the note after the status region, outside it, so the status still reads only "Loading the inbox"', () => {
        const status = page.querySelector('[role="status"]');
        expect(status?.textContent).toBe('Loading the inbox');
        expect(status?.querySelector('noscript')).toBeNull();
        expect(status?.nextElementSibling?.localName).toBe('noscript');
    });
});
