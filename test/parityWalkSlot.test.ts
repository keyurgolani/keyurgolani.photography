import type { Page } from '@playwright/test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { compare, walk } from '../e2e/themes/computed';

// The Dark parity walk (e2e/themes/computed.ts) in jsdom, through a page that runs the walk's own function here.
// jsdom has no layout, so every box is zero; what this checks is which elements the walk calls the theme control's slot.
const page = { evaluate: (fn: (args: unknown) => unknown, args: unknown) => Promise.resolve(fn(args)) } as unknown as Page;

/** The base's markup and the head's, walked in turn, with the head's added elements left out as HEAD_ONLY leaves them. */
async function walkBoth(base: string, head: string, leaveOut: string[]) {
    document.body.innerHTML = base;
    const before = await walk(page);
    document.body.innerHTML = head;
    const after = await walk(page, [], leaveOut);
    return { before, after };
}

// jsdom has no constructed stylesheets; the walk reads them as the browser has them. jsdom reads no pseudo-element's
// style either, and logs "Not implemented" for each element; the slot doesn't depend on it.
beforeAll(() => {
    if (!('adoptedStyleSheets' in document)) Object.defineProperty(document, 'adoptedStyleSheets', { value: [], configurable: true });
});

afterEach(() => {
    document.body.innerHTML = '';
});

describe("the parity walk's control slot", () => {
    it("doesn't take a heading for the theme control's slot when its only element is one the head adds beside its text", async () => {
        const { before, after } = await walkBoth('<header><h1>Fixture harbor</h1></header>', '<header><h1>Fixture harbor<span class="sr-only">, photograph 2 of 3</span></h1></header>', ['header h1 > span.sr-only']);
        const heading = (walked: typeof before) => walked.elements.find((element) => element.path === 'body>header:nth-of-type(1)>h1:nth-of-type(1)');
        expect(heading(before)?.slot).toBe(false);
        expect(heading(after)?.slot).toBe(false);
        expect(compare(before, after).structural).toEqual([]);
    });

    it('still takes an element holding the theme control and nothing else for its slot, in both builds', async () => {
        const nav = (control: string) => `<nav><a href="/work">Work</a><div>${control}</div></nav>`;
        const { before, after } = await walkBoth(nav('<button type="button">Switch to dark</button>'), nav('<div data-theme-control=""><button type="button">Theme</button></div>'), []);
        const slot = (walked: typeof before) => walked.elements.find((element) => element.path === 'body>nav:nth-of-type(1)>div:nth-of-type(1)');
        expect(slot(before)?.slot).toBe(true);
        expect(slot(after)?.slot).toBe(true);
        expect(compare(before, after).structural).toEqual([]);
    });
});
