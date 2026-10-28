import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COVER_ID, RESTORE_WAIT_MS, RETURN_KEY, clearReturn, openerOf, readReturn, restoreReturn, scheduleRestore, withReturn } from '../returnPosition';
import { SERIES_PAGES_KEY, SERIES_RESTORED_EVENT } from '../seriesContinuation';

// The series page's return record (#5): what goes into the series' history
// entry, what's read back, and how the visitor is put back.

const PHOTO = 'ph_00000000-0000-4000-8000-000000000001';
const OTHER = 'ph_00000000-0000-4000-8000-000000000002';
const BASE = 'https://photos.example.test/work/harbor';
const NEXT_KEYS = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: ['', {}], renderedSearch: '' } };

describe('withReturn', () => {
    it('adds the record beside every key already there, so Next\'s router keys and #6\'s extent survive', () => {
        const extent = { revisionId: 'rev_a', slug: 'harbor', loaded: 200 };
        const state = { ...NEXT_KEYS, [SERIES_PAGES_KEY]: extent };
        expect(withReturn(state, { photoId: PHOTO, opener: 'entry', scrollY: 640 })).toEqual({ ...NEXT_KEYS, [SERIES_PAGES_KEY]: extent, [RETURN_KEY]: { photoId: PHOTO, opener: 'entry', scrollY: 640 } });
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
        ['cut off at the top', -1],
        ['cut off at the bottom', 701],
    ])('scrolls an opener %s at that offset the least distance into view before focusing it', (_label, top) => {
        const entry = document.getElementById(`photo-${PHOTO}`);
        inView(entry, top);
        restoreReturn({ photoId: PHOTO, opener: 'entry', scrollY: 0 });
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(scrollIntoView.mock.contexts[0]).toBe(entry);
        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'instant' });
        expect(document.activeElement).toBe(entry);
    });

    it.each([
        ['at the top edge', 0],
        ['at the bottom edge', 700],
    ])('keeps an opener wholly in view %s where it is', (_label, top) => {
        inView(document.getElementById(`photo-${PHOTO}`), top);
        restoreReturn({ photoId: PHOTO, opener: 'entry', scrollY: 0 });
        expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('with scroll off, leaves the page where it is and focuses an opener wholly in view', () => {
        inView(document.getElementById(`photo-${PHOTO}`), 300);
        restoreReturn({ photoId: PHOTO, opener: 'entry', scrollY: 640 }, { scroll: false });
        expect(scrollTo).not.toHaveBeenCalled();
        expect(scrollIntoView).not.toHaveBeenCalled();
        expect(document.activeElement?.id).toBe(`photo-${PHOTO}`);
    });

    it.each([
        ['above the viewport', -200],
        ['cut off at the top', -1],
        ['cut off at the bottom', 701],
        ['below the viewport', 800],
    ])('with scroll off, leaves focus alone for an opener %s, since focusing it would move the page', (_label, top) => {
        inView(document.getElementById(`photo-${PHOTO}`), top);
        expect(restoreReturn({ photoId: PHOTO, opener: 'entry', scrollY: 640 }, { scroll: false })).toBeNull();
        expect(scrollTo).not.toHaveBeenCalled();
        expect(scrollIntoView).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(document.body);
    });

    it('with onlyIfIdle, takes focus only from the body', () => {
        const other = document.getElementById(`photo-${OTHER}`) as HTMLElement;
        other.focus();
        expect(restoreReturn({ photoId: PHOTO, opener: 'entry', scrollY: 0 }, { onlyIfIdle: true })).toBeNull();
        expect(document.activeElement).toBe(other);
        other.blur();
        restoreReturn({ photoId: PHOTO, opener: 'entry', scrollY: 0 }, { onlyIfIdle: true });
        expect(document.activeElement?.id).toBe(`photo-${PHOTO}`);
    });

    it('only scrolls when the photograph is gone from the page', () => {
        const before = document.activeElement;
        expect(restoreReturn({ photoId: 'ph_gone', opener: 'entry', scrollY: 320 })).toBeNull();
        expect(scrollTo).toHaveBeenCalledWith({ top: 320, left: 0, behavior: 'instant' });
        expect(document.activeElement).toBe(before);
    });

    const SERIES = { slug: 'harbor', revisionId: 'rev_a', total: 300 };
    const LATE = 'ph_late';
    const extent = (revisionId = 'rev_a', loaded = 200) => window.history.replaceState({ [SERIES_PAGES_KEY]: { revisionId, slug: 'harbor', loaded } }, '');
    /** #6 appends the entry it loaded again, then fires its event on the section, which bubbles to window. */
    const appendLate = () => {
        const late = document.createElement('a');
        late.id = `photo-${LATE}`;
        late.href = `/work/harbor/photo/${LATE}`;
        document.querySelector('ol')?.append(late);
        inView(late, 200);
        return late;
    };
    const restored = () => document.querySelector('section')?.dispatchEvent(new Event(SERIES_RESTORED_EVENT, { bubbles: true }));
    const record = (photoId: string, opener: 'entry' | 'cover' = 'entry', scrollY = 640) => ({ photoId, opener, scrollY });
    /** The record in the entry, beside Next's keys, as SeriesReturn leaves it before a restore. */
    const storeRecord = (photoId: string, extra: object = {}) => window.history.replaceState({ ...NEXT_KEYS, ...extra, [RETURN_KEY]: record(photoId) }, '');
    const state = () => window.history.state as Record<string, unknown>;

    it('restores at once when no extent is stored, and takes the record out of the entry, keeping every other key', () => {
        storeRecord(PHOTO);
        inView(document.getElementById(`photo-${PHOTO}`), 100);
        scheduleRestore(record(PHOTO), SERIES);
        expect(document.activeElement?.id).toBe(`photo-${PHOTO}`);
        expect(state()).toEqual(NEXT_KEYS);
    });

    it('restores at once, with an extent stored, when the opener is already on the page', () => {
        extent();
        inView(document.getElementById(`photo-${PHOTO}`), 100);
        scheduleRestore(record(PHOTO), SERIES);
        expect(document.activeElement?.id).toBe(`photo-${PHOTO}`);
    });

    it('restores the cover at once, whatever #6 is loading, since the cover is never paged', () => {
        extent();
        inView(document.getElementById(COVER_ID), 100);
        scheduleRestore(record(LATE, 'cover', 0), SERIES);
        expect(document.activeElement?.id).toBe(COVER_ID);
    });

    it.each([
        ['another revision\'s', () => extent('rev_old')],
        ['another series\'', () => window.history.replaceState({ [SERIES_PAGES_KEY]: { revisionId: 'rev_a', slug: 'ridge', loaded: 200 } }, '')],
        ['a larger extent than the series has', () => extent('rev_a', 301)],
        ['no', () => undefined],
    ])('only scrolls, at once, when the opener is missing and the entry holds %s extent, which #6 won\'t load', (_label, store) => {
        store();
        scheduleRestore(record(LATE, 'entry', 4800), SERIES);
        expect(scrollTo).toHaveBeenCalledWith({ top: 4800, left: 0, behavior: 'instant' });
        expect(document.activeElement).toBe(document.body);
    });

    it('waits for #6\'s event when the opener is missing and this series\' extent is stored, then restores scroll and focus once and uses the record up', () => {
        const pages = { revisionId: 'rev_a', slug: 'harbor', loaded: 200 };
        storeRecord(LATE, { [SERIES_PAGES_KEY]: pages });
        scheduleRestore(record(LATE, 'entry', 4800), SERIES);
        expect(scrollTo).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(document.body);
        expect(state()).toHaveProperty(RETURN_KEY);
        const late = appendLate();
        restored();
        expect(scrollTo).toHaveBeenCalledWith({ top: 4800, left: 0, behavior: 'instant' });
        expect(document.activeElement).toBe(late);
        expect(state()).toEqual({ ...NEXT_KEYS, [SERIES_PAGES_KEY]: pages });
        restored();
        expect(scrollTo).toHaveBeenCalledTimes(1);
    });

    it('does not wait for a busy section alone, which #6 can\'t have marked by the time the page mounts', () => {
        document.querySelector('section')?.setAttribute('aria-busy', 'true');
        scheduleRestore(record(LATE, 'entry', 0), SERIES);
        expect(scrollTo).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['a key', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))],
        ['a pointer press', () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))],
        ['the wheel', () => document.body.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 }))],
    ])('skips the scroll of a delayed restore after %s, and leaves focus alone when the opener is off screen', (_label, input) => {
        extent();
        scheduleRestore(record(LATE, 'entry', 4800), SERIES);
        input();
        const late = appendLate();
        inView(late, -500);
        restored();
        expect(scrollTo).not.toHaveBeenCalled();
        expect(scrollIntoView).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(document.body);
    });

    it('skips the scroll of a delayed restore after input, and still focuses an opener wholly in view from the body', () => {
        extent();
        scheduleRestore(record(LATE, 'entry', 4800), SERIES);
        document.body.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 }));
        const late = appendLate();
        inView(late, 200);
        restored();
        expect(scrollTo).not.toHaveBeenCalled();
        expect(scrollIntoView).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(late);
    });

    it('never takes focus from where the visitor went while it waited', () => {
        extent();
        scheduleRestore(record(LATE, 'entry', 4800), SERIES);
        const other = document.getElementById(`photo-${OTHER}`) as HTMLElement;
        other.focus();
        appendLate();
        restored();
        expect(document.activeElement).toBe(other);
    });

    it('scrolls with what is there after RESTORE_WAIT_MS, then focuses the opener when #6 finishes later', () => {
        vi.useFakeTimers();
        storeRecord(LATE, { [SERIES_PAGES_KEY]: { revisionId: 'rev_a', slug: 'harbor', loaded: 200 } });
        scheduleRestore(record(LATE), SERIES);
        vi.advanceTimersByTime(RESTORE_WAIT_MS - 1);
        expect(scrollTo).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(scrollTo).toHaveBeenCalledWith({ top: 640, left: 0, behavior: 'instant' });
        expect(document.activeElement).toBe(document.body);
        expect(state()).not.toHaveProperty(RETURN_KEY);
        const late = appendLate();
        restored();
        expect(document.activeElement).toBe(late);
        // Then it's done: another event moves nothing.
        restored();
        expect(scrollTo).toHaveBeenCalledTimes(2);
    });

    it('focuses nothing on a late event once the visitor has focused something after the timeout', () => {
        vi.useFakeTimers();
        extent();
        scheduleRestore(record(LATE), SERIES);
        vi.advanceTimersByTime(RESTORE_WAIT_MS);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
        const other = document.getElementById(`photo-${OTHER}`) as HTMLElement;
        other.focus();
        appendLate();
        restored();
        expect(document.activeElement).toBe(other);
        expect(scrollTo).toHaveBeenCalledTimes(1);
    });

    it('restores nothing once cancelled, and keeps the record, by the event or the timeout', () => {
        vi.useFakeTimers();
        storeRecord(LATE, { [SERIES_PAGES_KEY]: { revisionId: 'rev_a', slug: 'harbor', loaded: 200 } });
        const cancel = scheduleRestore(record(LATE), SERIES);
        cancel();
        appendLate();
        restored();
        vi.advanceTimersByTime(RESTORE_WAIT_MS);
        expect(scrollTo).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(document.body);
        expect(state()).toHaveProperty(RETURN_KEY);
    });

    it('stops listening for input once cancelled', () => {
        extent();
        const remove = vi.spyOn(window, 'removeEventListener');
        scheduleRestore(record(LATE), SERIES)();
        expect(remove.mock.calls.map(([type, , options]) => [type, options])).toEqual(expect.arrayContaining([['keydown', true], ['pointerdown', true], ['wheel', true]]));
    });
});

describe('clearReturn', () => {
    afterEach(() => window.history.replaceState(null, ''));

    it('takes only the record out, with a spread', () => {
        window.history.replaceState({ ...NEXT_KEYS, [SERIES_PAGES_KEY]: { loaded: 2 }, [RETURN_KEY]: { photoId: PHOTO, opener: 'entry', scrollY: 1 } }, '');
        clearReturn();
        expect(window.history.state).toEqual({ ...NEXT_KEYS, [SERIES_PAGES_KEY]: { loaded: 2 } });
    });

    it('writes nothing when there is no record', () => {
        window.history.replaceState({ ...NEXT_KEYS }, '');
        const replace = vi.spyOn(window.history, 'replaceState');
        clearReturn();
        expect(replace).not.toHaveBeenCalled();
        replace.mockRestore();
    });
});

