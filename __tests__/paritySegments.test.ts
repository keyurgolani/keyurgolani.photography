import { describe, expect, it } from 'vitest';
import { compare, completeHiddenSegments, failures, type Walk, type Walked } from '../test/helpers/parityCompare';

// #14's A8, from its CI: Dark parity's gate helpers. Without JavaScript, React leaves a streamed segment in a hidden
// <div id="S:n"> at the end of the body and a <template id="P:n"> where it goes, and how the page's payload splits into
// segments follows its size, not its structure. Inside content no-JS never shows (the Inbox streams in behind its
// loading state), the walk puts each segment where it goes, as React's $RS would, in both builds. And a sanctioned
// change of `display` away from list-item takes the ::marker that only a list item has with it.

describe('completeHiddenSegments()', () => {
    it("puts each segment in its placeholder inside hidden content, nested ones too, as React's $RS does", () => {
        document.body.innerHTML = [
            '<div hidden id="S:0"><main><ul><li>one</li><template id="P:1"></template></ul><template id="P:3"></template></main></div>',
            '<div hidden id="S:1"><li>two</li><template id="P:2"></template></div>',
            '<div hidden id="S:2"><li>three</li></div>',
            '<div hidden id="S:3"><section>facts</section></div>',
        ].join('');
        expect(completeHiddenSegments()).toBe(3);
        expect(document.body.innerHTML).toBe('<div hidden="" id="S:0"><main><ul><li>one</li><li>two</li><li>three</li></ul><section>facts</section></main></div>');
    });

    it('leaves a placeholder in the shown page alone, since no-JS shows that hole, and one with no segment', () => {
        const page = '<main><template id="P:1"></template></main><div hidden id="S:1"><p>late</p></div><div hidden id="S:5"><template id="P:4"></template></div>';
        document.body.innerHTML = page;
        expect(completeHiddenSegments()).toBe(0);
        expect(document.body.innerHTML).toBe(page.replaceAll(' hidden ', ' hidden="" '));
    });

    // The review of bbf1e280: only React's own segments, a hidden <div id="S:n"> straight in <body>, and only placeholders
    // inside one of those.
    it("leaves a placeholder inside the app's own hidden content alone, until-found or not", () => {
        const page = [
            '<main><div hidden=""><template id="P:1"></template></div><div hidden="until-found"><template id="P:2"></template></div></main>',
            '<div hidden="" id="S:1"><p>one</p></div>',
            '<div hidden="" id="S:2"><p>two</p></div>',
        ].join('');
        document.body.innerHTML = page;
        expect(completeHiddenSegments()).toBe(0);
        expect(document.body.innerHTML).toBe(page);
    });

    it("never takes an app's element that happens to be id S:n for a segment", () => {
        const page = '<div hidden="" id="S:0"><main><template id="P:1"></template><section id="S:1"><p>the app\'s own</p></section></main></div>';
        document.body.innerHTML = page;
        expect(completeHiddenSegments()).toBe(0);
        expect(document.body.innerHTML).toBe(page);
    });

    it('leaves a segment that holds its own placeholder where it is', () => {
        const page = '<div hidden="" id="S:0"><p>shell</p></div><div hidden="" id="S:1"><li>one</li><template id="P:1"></template></div>';
        document.body.innerHTML = page;
        expect(completeHiddenSegments()).toBe(0);
        expect(document.body.innerHTML).toBe(page);
    });

    /** The Inbox's rows as the base or the head might stream them: `split` lists each late segment's rows. */
    const streamed = (split: string[][], late = split) => {
        const rows = (names: string[]) => names.map((name) => `<li>${name}</li>`).join('');
        const placeholders = split.map((_, index) => `<template id="P:${index + 1}"></template>`).join('');
        const segments = late.map((names, index) => (names.length ? `<div hidden="" id="S:${index + 1}">${rows(names)}</div>` : '')).join('');
        return `<div hidden="" id="S:0"><main><ul><li>first</li>${placeholders}</ul></main></div>${segments}`;
    };
    const completed = (html: string) => {
        document.body.innerHTML = html;
        completeHiddenSegments();
        return document.body.innerHTML;
    };

    it('makes the same rows, split two ways, the same page', () => {
        const oneByOne = completed(streamed([['b'], ['c'], ['d']]));
        const together = completed(streamed([['b', 'c', 'd']]));
        expect(oneByOne).toBe(together);
        expect(together).toBe('<div hidden="" id="S:0"><main><ul><li>first</li><li>b</li><li>c</li><li>d</li></ul></main></div>');
    });

    it('still shows a row whose segment never came as a difference', () => {
        const whole = completed(streamed([['b'], ['c'], ['d']]));
        const short = completed(streamed([['b'], ['c'], ['d']], [['b'], [], ['d']]));
        expect(short).not.toBe(whole);
        expect(short).toBe('<div hidden="" id="S:0"><main><ul><li>first</li><li>b</li><template id="P:2"></template><li>d</li></ul></main></div>');
    });
});

describe("compare(), a sanctioned display and its ::marker", () => {
    const element = (display: string, marker: boolean): Walked => ({
        path: 'body>ul:nth-of-type(1)>li:nth-of-type(1)',
        styles: [`display: ${display}`],
        pseudos: marker ? { '::marker': ['color: rgb(0, 0, 0)'] } : {},
        rect: [0, 0, 10, 10],
        slot: false,
    });
    const walk = (elements: Walked[]): Walk => ({ tokens: { root: {}, body: {} }, elements, resolved: {}, folded: [], foldedPinned: [] });
    const base = walk([element('list-item', true)]);
    const head = walk([element('grid', false)]);

    it('lists the marker that goes with a sanctioned display, and fails nothing', () => {
        const c = compare(base, head, {}, { 'body>ul:nth-of-type(1)>li:nth-of-type(1)': ['display'] });
        expect(failures(c)).toEqual([]);
        expect(c.sanctioned).toHaveLength(2);
        expect(c.sanctioned.some((line) => line.includes('::marker'))).toBe(true);
    });

    it("fails a marker both builds have that paints differently, even with display sanctioned (the review of bbf1e280)", () => {
        const marked = (color: string): Walked => ({ ...element('list-item', true), pseudos: { '::marker': [`color: ${color}`] } });
        const c = compare(walk([marked('rgb(0, 0, 0)')]), walk([marked('rgb(255, 0, 0)')]), {}, { 'body>ul:nth-of-type(1)>li:nth-of-type(1)': ['display'] });
        expect(failures(c)).toEqual(['body>ul:nth-of-type(1)>li:nth-of-type(1)::marker color: rgb(0, 0, 0) against rgb(255, 0, 0)']);
        expect(c.sanctioned).toEqual([]);
    });

    it('fails both without the sanction, and the marker under any other sanctioned property', () => {
        expect(failures(compare(base, head))).toHaveLength(2);
        expect(failures(compare(base, head, {}, { 'body>ul:nth-of-type(1)>li:nth-of-type(1)': ['color'] }))).toHaveLength(2);
    });
});
