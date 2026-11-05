import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { WorkCatalog, WorkSeriesSummary } from '@/lib/catalog/projections/work';
import SeriesCatalog from '../SeriesCatalog';

// B3's body, item 93, in B10: keyboard focus scrolls the title link into view, not its entry, so Shift+Tab back up
// Work can leave a cover's top above the screen. Keyboard focus on an entry's link brings the whole entry, its list
// item, into view, at once and only as far as it must. Pointer focus never scrolls. jsdom has no layout and no
// scrollIntoView, so each entry's box is stubbed and scrollIntoView is a spy.

const router = vi.hoisted(() => ({ prefetch: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => router }));

function series(n: number): WorkSeriesSummary {
    return {
        id: `ser_entry-${n}`,
        slug: `entry-${n}`,
        href: `/work/entry-${n}`,
        title: `Entry ${n}`,
        shortStatement: `Short statement ${n}.`,
        derived: { photoCount: n },
        cover: null,
    };
}

const work: WorkCatalog = { catalogRevision: `rev_${'a'.repeat(64)}`, series: [series(1), series(2), series(3)] };
const link = (n: number) => screen.getByRole('link', { name: `Entry ${n}` });
const entryOf = (n: number) => link(n).closest('li');

/** Every list item's box, as getBoundingClientRect gives it, against jsdom's 768 px tall window. */
function entryBox(top: number, bottom: number) {
    vi.spyOn(HTMLLIElement.prototype, 'getBoundingClientRect').mockReturnValue({ top, bottom, left: 0, right: 375, width: 375, height: bottom - top, x: 0, y: top, toJSON: () => ({}) });
}

const saved = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
let scrollIntoView: Mock<(options?: ScrollIntoViewOptions | boolean) => void>;

beforeEach(() => {
    router.prefetch.mockClear();
    scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: scrollIntoView, configurable: true, writable: true });
});

afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(Element.prototype, 'scrollIntoView', saved ?? { value: undefined, configurable: true, writable: true });
});

const focus = (n: number) => act(() => link(n).focus());

describe('Work\'s entry on keyboard focus', () => {
    it.each([
        ['starts above the screen, as after Shift+Tab back up the list', -300, 200],
        ['runs off the foot of the screen', 500, 1100],
    ])('brings the whole entry into view, nearest and at once, when its link takes keyboard focus and the entry %s', (_, top, bottom) => {
        render(<SeriesCatalog work={work} />);
        entryBox(top, bottom);
        focus(2);
        expect(link(2)).toHaveFocus();
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(scrollIntoView.mock.contexts[0]).toBe(entryOf(2));
        // Instant, never smooth, so it doesn't animate, under reduced motion or not.
        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    });

    it('leaves the scroll alone when the whole entry is on screen already', () => {
        render(<SeriesCatalog work={work} />);
        entryBox(100, 700);
        focus(2);
        expect(link(2)).toHaveFocus();
        expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('never scrolls for focus that isn\'t keyboard focus, a click or a tap, even with the entry above the screen', () => {
        render(<SeriesCatalog work={work} />);
        entryBox(-300, 200);
        const matches = HTMLAnchorElement.prototype.matches;
        vi.spyOn(HTMLAnchorElement.prototype, 'matches').mockImplementation(function (this: HTMLAnchorElement, selector: string) {
            return selector === ':focus-visible' ? false : matches.call(this, selector);
        });
        focus(2);
        expect(link(2)).toHaveFocus();
        expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('still prefetches the entry\'s series on that focus', () => {
        render(<SeriesCatalog work={work} />);
        entryBox(-300, 200);
        focus(3);
        expect(router.prefetch.mock.calls).toEqual([['/work/entry-3']]);
        expect(scrollIntoView.mock.contexts[0]).toBe(entryOf(3));
    });
});
