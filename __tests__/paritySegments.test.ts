import { describe, expect, it } from 'vitest';
import { compare, completeHiddenSegments, failures, type Walk, type Walked } from '../e2e/themes/computed';

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

    it('fails both without the sanction, and the marker under any other sanctioned property', () => {
        expect(failures(compare(base, head))).toHaveLength(2);
        expect(failures(compare(base, head, {}, { 'body>ul:nth-of-type(1)>li:nth-of-type(1)': ['color'] }))).toHaveLength(2);
    });
});
