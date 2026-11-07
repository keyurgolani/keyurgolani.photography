import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FOLD_PAINT, walk, type EvaluatingPage } from './helpers/parityWalk';

// A folded element (test/helpers/parityWalk.ts's WalkOptions.fold) is left out of the parity walk, so it may paint nothing its parent
// doesn't. Its ::before and ::after, where they render, may carry no text either: their `content` is pinned to the empty
// string, which Work's stretched title link's ::after has (B8's review of the Viewer heading's fold).

const page: EvaluatingPage = { evaluate: async (fn, arg) => fn(arg) };

beforeAll(() => {
    if (!('adoptedStyleSheets' in document)) Object.defineProperty(document, 'adoptedStyleSheets', { value: [], configurable: true });
});

afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

/**
 * jsdom reads no pseudo-element's style, so this stands in for the browser's: the folded link's ::after renders with
 * `content` and paints nothing else; every other pseudo-element doesn't render. An element's own style is jsdom's.
 */
function pseudoAfter(content: string) {
    const own = window.getComputedStyle.bind(window);
    const neutral: Record<string, string> = { ...FOLD_PAINT.pseudo, content };
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
        if (!pseudo) return own(element);
        const renders = pseudo === '::after' && element.matches('h2 > a');
        return { getPropertyValue: (name: string) => (renders ? (neutral[name] ?? '') : name === 'content' ? 'none' : '') } as unknown as CSSStyleDeclaration;
    });
}

describe("a folded element's pseudo-elements", () => {
    it('render no text: their content is pinned to the empty string', () => {
        expect(FOLD_PAINT.pseudo).toMatchObject({ content: '""' });
    });

    it("fail the walk when a folded link's ::after carries text, and pass it when it's empty", async () => {
        document.body.innerHTML = '<main><h2><a href="/work/x">Fixture title</a></h2></main>';
        const fold = [{ selector: 'h2 > a' }];
        pseudoAfter('"x"');
        const text = await walk(page, [], [], { fold });
        expect(text.folded.filter((line) => line.includes('(folded)::after content: "x"'))).toHaveLength(1);
        vi.restoreAllMocks();
        pseudoAfter('""');
        const empty = await walk(page, [], [], { fold });
        expect(empty.folded.filter((line) => line.includes('::after'))).toEqual([]);
    });
});
