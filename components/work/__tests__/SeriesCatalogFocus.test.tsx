import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { WorkCatalog, WorkSeriesSummary } from '@/lib/catalog/projections/work';
import SeriesCatalog from '../SeriesCatalog';

// B3's body, item 93, in B10: keyboard focus scrolls the title link into view, not its entry, so Shift+Tab back up
// Work can leave a cover's top above the screen. Keyboard focus on an entry's link brings the whole entry, its list
// item, into view, once the browser's own focus scroll is done: in the frame after the focus. The room is the screen
// less html's scroll paddings (6rem and 8rem, app/globals.css), 576 px of an 800 px window. An entry that fits the
// room scrolls into it, nearest. One that fits the screen but not the room meets the screen's edge. One taller than
// the screen keeps the title where the browser put it. Pointer focus and a window coming back into focus never
// scroll. The box measured is the entry's grown by its link's ::after past it, where the target and its focus ring
// paint (B3), rounded outward, so the ring's edge stays on screen too. jsdom has no layout, no pseudo-element styles,
// no scrollIntoView and no input modality, so each entry's box, the ::after's insets, the frame, scrolling and
// :focus-visible are stubbed.

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

/** The window: 800 px tall, with html's scroll paddings, 96 and 128 px, so the room between them is 576 px. */
const HEIGHT = 800;
const PADDING_TOP = 96;
const PADDING_BOTTOM = 128;

/** Every list item's box, as getBoundingClientRect gives it. */
function entryBox(top: number, bottom: number) {
    vi.spyOn(HTMLLIElement.prototype, 'getBoundingClientRect').mockReturnValue({ top, bottom, left: 0, right: 375, width: 375, height: bottom - top, x: 0, y: top, toJSON: () => ({}) });
}

/** The link's ::after insets, as getComputedStyle(link, '::after') resolves them: Dark's 6 px past the entry by default. */
let ringInsets: { top: string; bottom: string };
function stubRingInsets() {
    const computed = window.getComputedStyle;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) =>
        pseudo === '::after' ? ({ ...ringInsets } as unknown as CSSStyleDeclaration) : computed(element, pseudo),
    );
}

/** Whether a link matches :focus-visible, as the browser decides from how focus came: by the keyboard, or by a click or a tap. */
function focusVisible(visible: boolean) {
    const matches = HTMLAnchorElement.prototype.matches;
    vi.spyOn(HTMLAnchorElement.prototype, 'matches').mockImplementation(function (this: HTMLAnchorElement, selector: string) {
        return selector === ':focus-visible' ? visible : matches.call(this, selector);
    });
}

const savedScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
const savedHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
let scrollIntoView: Mock<(options?: ScrollIntoViewOptions | boolean) => void>;
let scrollBy: Mock;
let windowFocused: boolean;
let frames: FrameRequestCallback[];

/** Runs the frames asked for so far, as the browser does after its own focus scroll. */
const nextFrame = () =>
    act(() => {
        const due = frames;
        frames = [];
        for (const frame of due) frame(0);
    });

beforeEach(() => {
    router.prefetch.mockClear();
    frames = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((frame) => frames.push(frame));
    scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: scrollIntoView, configurable: true, writable: true });
    scrollBy = vi.fn();
    vi.spyOn(window, 'scrollBy').mockImplementation(scrollBy);
    Object.defineProperty(window, 'innerHeight', { value: HEIGHT, configurable: true });
    document.documentElement.style.scrollPaddingTop = `${PADDING_TOP}px`;
    document.documentElement.style.scrollPaddingBottom = `${PADDING_BOTTOM}px`;
    windowFocused = true;
    vi.spyOn(document, 'hasFocus').mockImplementation(() => windowFocused);
    ringInsets = { top: '0px', bottom: '0px' };
    stubRingInsets();
});

afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(Element.prototype, 'scrollIntoView', savedScrollIntoView ?? { value: undefined, configurable: true, writable: true });
    if (savedHeight) Object.defineProperty(window, 'innerHeight', savedHeight);
    document.documentElement.style.scrollPaddingTop = '';
    document.documentElement.style.scrollPaddingBottom = '';
});

const focus = (n: number) => act(() => link(n).focus());
const nothingScrolled = () => {
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollBy).not.toHaveBeenCalled();
};

describe('Work\'s entry on keyboard focus', () => {
    it('waits for the frame after the focus, once the browser\'s own focus scroll is done, before it measures or scrolls', () => {
        render(<SeriesCatalog work={work} />);
        entryBox(-300, 200);
        focusVisible(true);
        focus(2);
        expect(link(2)).toHaveFocus();
        nothingScrolled();
        nextFrame();
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });

    // Mutant M18 measured at the focus and scrolled in the frame: off screen at the focus, on screen once the browser
    // has scrolled, so only a measure in the frame leaves it alone.
    it('measures in the frame, not at the focus: an entry the browser\'s own scroll brought on screen stays put', () => {
        render(<SeriesCatalog work={work} />);
        entryBox(-300, 200);
        focusVisible(true);
        focus(2);
        entryBox(40, 760);
        nextFrame();
        nothingScrolled();
    });

    it.each([
        ['starts above the screen, as after Shift+Tab back up the list', -300, 200],
        ['runs off the foot of the screen, as after Tab down it', 500, 1000],
    ])('scrolls an entry that fits the room into it, nearest and at once, when the entry %s', (_, top, bottom) => {
        render(<SeriesCatalog work={work} />);
        entryBox(top, bottom);
        focusVisible(true);
        focus(2);
        nextFrame();
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(scrollIntoView.mock.contexts[0]).toBe(entryOf(2));
        // Instant, never smooth, so it doesn't animate, under reduced motion or not. The browser keeps the paddings.
        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        expect(scrollBy).not.toHaveBeenCalled();
    });

    it.each([
        ['up, its top above the screen, to the screen\'s top', -50, 650, -50],
        ['down, its foot below the screen, to the screen\'s foot', 300, 1000, 200],
    ])('brings an entry that fits the screen but not the room %s, at once', (_, top, bottom, by) => {
        render(<SeriesCatalog work={work} />);
        entryBox(top, bottom);
        focusVisible(true);
        focus(2);
        nextFrame();
        expect(scrollBy).toHaveBeenCalledTimes(1);
        expect(scrollBy).toHaveBeenCalledWith({ top: by, behavior: 'instant' });
        expect(scrollIntoView).not.toHaveBeenCalled();
    });

    // B10's re-review, 1: the ring paints on the link's ::after, past the entry by max(--work-room, 6 px), so the
    // scroll takes the ring's edge to the screen's, not the entry's.
    it.each([
        ['up, by Light\'s 12 px ring room above the entry, rounded down', '-12px', '-12px', -50.4, 649.6, -63],
        ['down, by Dark\'s 6 px past the entry\'s foot, rounded up', '-6px', '-6px', 300.2, 1000.2, 207],
        ['down, by Black\'s band below the copy alone', '0px', '-6px', 300, 1000, 206],
    ])('brings the ring\'s edge to the screen\'s, %s', (_, top, bottom, boxTop, boxBottom, by) => {
        render(<SeriesCatalog work={work} />);
        ringInsets = { top, bottom };
        entryBox(boxTop, boxBottom);
        focusVisible(true);
        focus(2);
        nextFrame();
        expect(scrollBy).toHaveBeenCalledWith({ top: by, behavior: 'instant' });
    });

    it('counts the ring in every comparison: an entry on screen whose ring runs off, or that fits the room only without its ring, is grown first', () => {
        render(<SeriesCatalog work={work} />);
        ringInsets = { top: '-12px', bottom: '-12px' };
        // The entry is on screen, but its ring's top is 4 px above it.
        entryBox(8, 600);
        focusVisible(true);
        focus(2);
        nextFrame();
        // 592 px plus 24 px of ring is 616, past the 576 px room, so it meets the screen's edge rather than the room's.
        expect(scrollBy).toHaveBeenCalledWith({ top: -4, behavior: 'instant' });
        expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('leaves an entry taller than the screen where the browser\'s focus scroll put it, with its title in view', () => {
        render(<SeriesCatalog work={work} />);
        entryBox(-400, 600);
        focusVisible(true);
        focus(2);
        nextFrame();
        nothingScrolled();
    });

    it('leaves the scroll alone when the whole entry is on screen already, in the room or not', () => {
        render(<SeriesCatalog work={work} />);
        entryBox(40, 760);
        focusVisible(true);
        focus(2);
        nextFrame();
        nothingScrolled();
    });

    it('does nothing when focus has moved on by the frame', () => {
        render(<SeriesCatalog work={work} />);
        entryBox(-300, 200);
        focusVisible(true);
        focus(2);
        focus(3);
        expect(frames).toHaveLength(2);
        act(() => frames[0](0));
        nothingScrolled();
    });

    it('never scrolls for focus that isn\'t keyboard focus, a click or a tap, even with the entry above the screen', () => {
        render(<SeriesCatalog work={work} />);
        entryBox(-300, 200);
        focusVisible(false);
        focus(2);
        nextFrame();
        expect(link(2)).toHaveFocus();
        nothingScrolled();
    });

    it('never scrolls when the window comes back into focus onto the link it left', () => {
        render(<SeriesCatalog work={work} />);
        entryBox(40, 760);
        focusVisible(true);
        focus(2);
        nextFrame();
        // The visitor switches away, scrolls the entry off, and comes back: the browser focuses the link again.
        windowFocused = false;
        act(() => link(2).blur());
        entryBox(-300, 200);
        windowFocused = true;
        focus(2);
        nextFrame();
        nothingScrolled();
    });

    // Mutant M13 counted any blur to nothing as the window leaving: a click on the page's background, say.
    it('still reveals after a blur to nothing with the window focused, then a Tab back', () => {
        render(<SeriesCatalog work={work} />);
        entryBox(40, 760);
        focusVisible(true);
        focus(2);
        nextFrame();
        act(() => link(2).blur());
        entryBox(-300, 200);
        focus(2);
        nextFrame();
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(scrollIntoView.mock.contexts[0]).toBe(entryOf(2));
    });

    it('reveals a link the window left once focus comes to it from another element, not from the window', () => {
        render(<SeriesCatalog work={work} />);
        entryBox(40, 760);
        focusVisible(true);
        focus(2);
        nextFrame();
        windowFocused = false;
        act(() => link(2).blur());
        windowFocused = true;
        // Back in the window, focus lands elsewhere, and Shift+Tab brings it from there.
        focus(3);
        nextFrame();
        entryBox(-300, 200);
        focus(2);
        nextFrame();
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(scrollIntoView.mock.contexts[0]).toBe(entryOf(2));
    });

    it('never scrolls for a focus with nothing before it while the window doesn\'t have focus', () => {
        render(<SeriesCatalog work={work} />);
        entryBox(-300, 200);
        focusVisible(true);
        windowFocused = false;
        focus(2);
        nextFrame();
        nothingScrolled();
    });

    it('still prefetches the entry\'s series on that focus', () => {
        render(<SeriesCatalog work={work} />);
        entryBox(-300, 200);
        focusVisible(true);
        focus(3);
        nextFrame();
        expect(router.prefetch.mock.calls).toEqual([['/work/entry-3']]);
        expect(scrollIntoView.mock.contexts[0]).toBe(entryOf(3));
    });
});
