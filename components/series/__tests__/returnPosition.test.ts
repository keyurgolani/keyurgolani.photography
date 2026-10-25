import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COVER_ID, ENTRIES_RESTORED_EVENT, EXTENT_KEY, RESTORE_WAIT_MS, RETURN_KEY, hasStoredExtent, openerOf, readReturn, restoreReturn, scheduleRestore, withReturn } from '../returnPosition';

// The series page's return record (#5): what goes into the series' history
// entry, what's read back, and how the visitor is put back.

const PHOTO = 'ph_00000000-0000-4000-8000-000000000001';
const OTHER = 'ph_00000000-0000-4000-8000-000000000002';
const BASE = 'https://photos.example.test/work/harbor';
const NEXT_KEYS = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: ['', {}], renderedSearch: '' } };

describe('withReturn', () => {
    it('adds the record beside every key already there, so Next\'s router keys and #6\'s extent survive', () => {
        const extent = { revisionId: 'rev_a', slug: 'harbor', loaded: 200 };
        const state = { ...NEXT_KEYS, [EXTENT_KEY]: extent };
        expect(withReturn(state, { photoId: PHOTO, opener: 'entry', scrollY: 640 })).toEqual({ ...NEXT_KEYS, [EXTENT_KEY]: extent, [RETURN_KEY]: { photoId: PHOTO, opener: 'entry', scrollY: 640 } });
        // The input is never changed in place.
        expect(state).not.toHaveProperty(RETURN_KEY);
    });

    it('replaces an older record and starts from nothing when the state isn\'t an object', () => {
        const older = withReturn(NEXT_KEYS, { photoId: OTHER, opener: 'cover', scrollY: 10 });
        expect(withReturn(older, { photoId: PHOTO, opener: 'entry', scrollY: 20 })[RETURN_KEY]).toEqual({ photoId: PHOTO, opener: 'entry', scrollY: 20 });
        for (const state of [null, undefined, 'state', 3, ['a']]) expect(withReturn(state, { photoId: PHOTO, opener: 'entry', scrollY: 0 })).toEqual({ [RETURN_KEY]: { photoId: PHOTO, opener: 'entry', scrollY: 0 } });
    });

    it('writes only the three fields, whatever else the caller passes', () => {
        const record = { photoId: PHOTO, opener: 'entry' as const, scrollY: 5, extra: 'x' };
        expect(withReturn({}, record)[RETURN_KEY]).toEqual({ photoId: PHOTO, opener: 'entry', scrollY: 5 });
    });
});

describe('readReturn', () => {
    it('reads back what withReturn wrote', () => {
        expect(readReturn(withReturn(NEXT_KEYS, { photoId: PHOTO, opener: 'cover', scrollY: 12.5 }))).toEqual({ photoId: PHOTO, opener: 'cover', scrollY: 12.5 });
    });

    it.each([
        ['no state', null],
        ['a string state', 'x'],
        ['no record', NEXT_KEYS],
        ['a record that isn\'t an object', { [RETURN_KEY]: 'photo' }],
        ['an array record', { [RETURN_KEY]: [PHOTO, 'entry', 1] }],
        ['no photo ID', { [RETURN_KEY]: { opener: 'entry', scrollY: 0 } }],
        ['a photo ID with a slash', { [RETURN_KEY]: { photoId: `${PHOTO}/x`, opener: 'entry', scrollY: 0 } }],
        ['a photo ID with a quote', { [RETURN_KEY]: { photoId: 'a"b', opener: 'entry', scrollY: 0 } }],
        ['an empty photo ID', { [RETURN_KEY]: { photoId: '', opener: 'entry', scrollY: 0 } }],
        ['a photo ID that is too long', { [RETURN_KEY]: { photoId: 'a'.repeat(129), opener: 'entry', scrollY: 0 } }],
        ['an unknown opener', { [RETURN_KEY]: { photoId: PHOTO, opener: 'heading', scrollY: 0 } }],
        ['a negative offset', { [RETURN_KEY]: { photoId: PHOTO, opener: 'entry', scrollY: -1 } }],
        ['an offset that isn\'t finite', { [RETURN_KEY]: { photoId: PHOTO, opener: 'entry', scrollY: Number.POSITIVE_INFINITY } }],
        ['an offset that isn\'t a number', { [RETURN_KEY]: { photoId: PHOTO, opener: 'entry', scrollY: '10' } }],
    ])('ignores %s', (_label, state) => {
        expect(readReturn(state)).toBeNull();
    });

    it('accepts the longest photo ID it allows, and offset zero', () => {
        expect(readReturn({ [RETURN_KEY]: { photoId: 'a'.repeat(128), opener: 'entry', scrollY: 0 } })).toEqual({ photoId: 'a'.repeat(128), opener: 'entry', scrollY: 0 });
    });
});

describe('hasStoredExtent', () => {
    const series = { slug: 'harbor', revisionId: 'rev_a' };

    it('is true only for #6\'s extent on this slug in this revision, with a whole positive count', () => {
        expect(hasStoredExtent({ [EXTENT_KEY]: { revisionId: 'rev_a', slug: 'harbor', loaded: 200 } }, series)).toBe(true);
        expect(hasStoredExtent({ [EXTENT_KEY]: { revisionId: 'rev_b', slug: 'harbor', loaded: 200 } }, series)).toBe(false);
        expect(hasStoredExtent({ [EXTENT_KEY]: { revisionId: 'rev_a', slug: 'ridge', loaded: 200 } }, series)).toBe(false);
        expect(hasStoredExtent({ [EXTENT_KEY]: { revisionId: 'rev_a', slug: 'harbor', loaded: 0 } }, series)).toBe(false);
        expect(hasStoredExtent({ [EXTENT_KEY]: { revisionId: 'rev_a', slug: 'harbor', loaded: 1.5 } }, series)).toBe(false);
        expect(hasStoredExtent({ [EXTENT_KEY]: { revisionId: 'rev_a', slug: 'harbor', loaded: '200' } }, series)).toBe(false);
        expect(hasStoredExtent({ [EXTENT_KEY]: 'harbor' }, series)).toBe(false);
        expect(hasStoredExtent(NEXT_KEYS, series)).toBe(false);
        expect(hasStoredExtent(null, series)).toBe(false);
    });
});

describe('openerOf', () => {
    const link = (id: string, href: string) => ({ id, href });

    it('knows a sequence entry by its photo-<photoId> id on its own Viewer URL', () => {
        expect(openerOf(link(`photo-${PHOTO}`, `/work/harbor/photo/${PHOTO}`), '/work/harbor', BASE)).toEqual({ opener: 'entry', photoId: PHOTO });
        expect(openerOf(link(`photo-${PHOTO}`, `https://photos.example.test/work/harbor/photo/${PHOTO}/`), '/work/harbor', BASE)).toEqual({ opener: 'entry', photoId: PHOTO });
    });

    it('knows the cover by its id, whatever photograph it opens', () => {
        expect(openerOf(link(COVER_ID, `/work/harbor/photo/${OTHER}`), '/work/harbor', BASE)).toEqual({ opener: 'cover', photoId: OTHER });
    });

    it.each([
        ['an entry id for another photograph', `photo-${OTHER}`, `/work/harbor/photo/${PHOTO}`],
        ['a link with no id', '', `/work/harbor/photo/${PHOTO}`],
        ['another series\' Viewer URL', `photo-${PHOTO}`, `/work/ridge/photo/${PHOTO}`],
        ['a series whose slug only starts the same', `photo-${PHOTO}`, `/work/harbor-two/photo/${PHOTO}`],
        ['a path below the photograph', `photo-${PHOTO}`, `/work/harbor/photo/${PHOTO}/more`],
        ['the series page itself', COVER_ID, '/work/harbor'],
        ['another origin', `photo-${PHOTO}`, `https://elsewhere.example.test/work/harbor/photo/${PHOTO}`],
        ['All work', '', '/work'],
    ])('ignores %s', (_label, id, href) => {
        expect(openerOf(link(id, href), '/work/harbor', BASE)).toBeNull();
    });

    it('takes the series path with or without its trailing slash', () => {
        expect(openerOf(link(`photo-${PHOTO}`, `/work/harbor/photo/${PHOTO}`), '/work/harbor/', BASE)).toEqual({ opener: 'entry', photoId: PHOTO });
    });
});

/** A rect at `top`, `height` tall. */
const rect = (top: number, height = 100) => ({ top, bottom: top + height, left: 0, right: 100, width: 100, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

describe('restoreReturn and scheduleRestore', () => {
    let scrollTo: ReturnType<typeof vi.fn>;
    let scrollIntoView: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        document.body.innerHTML = `
            <main>
                <figure><a id="${COVER_ID}" href="/work/harbor/photo/${OTHER}">Cover</a></figure>
                <section aria-labelledby="series-sequence">
                    <h2 id="series-sequence">Sequence</h2>
                    <ol><li><a id="photo-${OTHER}" href="/work/harbor/photo/${OTHER}">Other</a></li><li><a id="photo-${PHOTO}" href="/work/harbor/photo/${PHOTO}">Entry</a></li></ol>
                </section>
            </main>`;
        scrollTo = vi.fn();
        scrollIntoView = vi.fn();
        window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
        Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView'];
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
        window.history.replaceState(null, '');
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    const inView = (element: Element | null, top: number) => {
        if (element) vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect(top));
    };

    it('scrolls to the offset at once, then focuses the entry without moving the page again', () => {
        const entry = document.getElementById(`photo-${PHOTO}`);
        inView(entry, 300);
        const focus = vi.spyOn(entry as HTMLElement, 'focus');
        expect(restoreReturn({ photoId: PHOTO, opener: 'entry', scrollY: 640 })).toBe(entry);
        expect(scrollTo).toHaveBeenCalledWith({ top: 640, left: 0, behavior: 'instant' });
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(document.activeElement).toBe(entry);
        expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('focuses the cover when the cover opened the Viewer, not the photograph\'s entry', () => {
        inView(document.getElementById(COVER_ID), 100);
        restoreReturn({ photoId: OTHER, opener: 'cover', scrollY: 0 });
        expect(document.activeElement?.id).toBe(COVER_ID);
    });

    it('falls back to the photograph\'s entry when the cover is gone', () => {
        document.getElementById(COVER_ID)?.remove();
        inView(document.getElementById(`photo-${OTHER}`), 100);
        restoreReturn({ photoId: OTHER, opener: 'cover', scrollY: 0 });
        expect(document.activeElement?.id).toBe(`photo-${OTHER}`);
    });

    it.each([
        ['above the viewport', -200],
        ['below the viewport', 800],
    ])('scrolls an opener %s at that offset into view before focusing it', (_label, top) => {
        const entry = document.getElementById(`photo-${PHOTO}`);
        inView(entry, top);
        restoreReturn({ photoId: PHOTO, opener: 'entry', scrollY: 0 });
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(scrollIntoView.mock.contexts[0]).toBe(entry);
        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'instant' });
        expect(document.activeElement).toBe(entry);
    });

    it('keeps an opener that is partly in view where it is', () => {
        inView(document.getElementById(`photo-${PHOTO}`), -50);
        restoreReturn({ photoId: PHOTO, opener: 'entry', scrollY: 0 });
        expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('only scrolls when the photograph is gone from the page', () => {
        const before = document.activeElement;
        expect(restoreReturn({ photoId: 'ph_gone', opener: 'entry', scrollY: 320 })).toBeNull();
        expect(scrollTo).toHaveBeenCalledWith({ top: 320, left: 0, behavior: 'instant' });
        expect(document.activeElement).toBe(before);
    });

    it('restores at once when no extent is stored and the sequence isn\'t busy', () => {
        inView(document.getElementById(`photo-${PHOTO}`), 100);
        scheduleRestore({ photoId: PHOTO, opener: 'entry', scrollY: 640 }, { slug: 'harbor', revisionId: 'rev_a' });
        expect(document.activeElement?.id).toBe(`photo-${PHOTO}`);
    });

    it('restores at once when the stored extent is another revision\'s, which #6 ignores', () => {
        window.history.replaceState({ [EXTENT_KEY]: { revisionId: 'rev_old', slug: 'harbor', loaded: 200 } }, '');
        inView(document.getElementById(`photo-${PHOTO}`), 100);
        scheduleRestore({ photoId: PHOTO, opener: 'entry', scrollY: 640 }, { slug: 'harbor', revisionId: 'rev_a' });
        expect(document.activeElement?.id).toBe(`photo-${PHOTO}`);
    });

    it('waits for #6\'s event when an extent is stored, then restores scroll and focus once', () => {
        window.history.replaceState({ [EXTENT_KEY]: { revisionId: 'rev_a', slug: 'harbor', loaded: 200 } }, '');
        scheduleRestore({ photoId: 'ph_late', opener: 'entry', scrollY: 4800 }, { slug: 'harbor', revisionId: 'rev_a' });
        expect(scrollTo).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(document.body);
        // #6 appends the entry it loaded again, then fires the event on the section, which bubbles to window.
        const late = document.createElement('a');
        late.id = 'photo-ph_late';
        late.href = '/work/harbor/photo/ph_late';
        document.querySelector('ol')?.append(late);
        inView(late, 200);
        document.querySelector('section')?.dispatchEvent(new Event(ENTRIES_RESTORED_EVENT, { bubbles: true }));
        expect(scrollTo).toHaveBeenCalledWith({ top: 4800, left: 0, behavior: 'instant' });
        expect(document.activeElement).toBe(late);
        document.querySelector('section')?.dispatchEvent(new Event(ENTRIES_RESTORED_EVENT, { bubbles: true }));
        expect(scrollTo).toHaveBeenCalledTimes(1);
    });

    it('waits while the sequence section is aria-busy, even before an extent shows in the state', () => {
        document.querySelector('section')?.setAttribute('aria-busy', 'true');
        scheduleRestore({ photoId: PHOTO, opener: 'entry', scrollY: 0 }, { slug: 'harbor', revisionId: 'rev_a' });
        expect(scrollTo).not.toHaveBeenCalled();
        window.dispatchEvent(new Event(ENTRIES_RESTORED_EVENT));
        expect(scrollTo).toHaveBeenCalledTimes(1);
    });

    it('stops waiting after RESTORE_WAIT_MS and restores with what is there', () => {
        vi.useFakeTimers();
        window.history.replaceState({ [EXTENT_KEY]: { revisionId: 'rev_a', slug: 'harbor', loaded: 200 } }, '');
        inView(document.getElementById(`photo-${PHOTO}`), 100);
        scheduleRestore({ photoId: PHOTO, opener: 'entry', scrollY: 640 }, { slug: 'harbor', revisionId: 'rev_a' });
        vi.advanceTimersByTime(RESTORE_WAIT_MS - 1);
        expect(scrollTo).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(document.activeElement?.id).toBe(`photo-${PHOTO}`);
        // The event after the timeout restores nothing more.
        window.dispatchEvent(new Event(ENTRIES_RESTORED_EVENT));
        expect(scrollTo).toHaveBeenCalledTimes(1);
    });

    it('restores nothing once cancelled, by the event or the timeout', () => {
        vi.useFakeTimers();
        window.history.replaceState({ [EXTENT_KEY]: { revisionId: 'rev_a', slug: 'harbor', loaded: 200 } }, '');
        const cancel = scheduleRestore({ photoId: PHOTO, opener: 'entry', scrollY: 640 }, { slug: 'harbor', revisionId: 'rev_a' });
        cancel();
        window.dispatchEvent(new Event(ENTRIES_RESTORED_EVENT));
        vi.advanceTimersByTime(RESTORE_WAIT_MS);
        expect(scrollTo).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(document.body);
    });
});
