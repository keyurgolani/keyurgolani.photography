import { act, fireEvent, render } from '@testing-library/react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARRIVAL_KEY, COVER_ID, RESTORE_WAIT_MS, RETURN_KEY, SERIES_TITLE_ID } from '../returnPosition';
import { SERIES_PAGES_KEY, SERIES_RESTORED_EVENT } from '../seriesContinuation';
import SeriesReturn from '../SeriesReturn';

// The series page's return position (#5) as the page mounts it: the record a
// plain activation writes into the series' history entry, the restore when
// the page mounts again (and not on a reload of the page itself), the wait
// for #6's restored entries, and the scroll put back when the intercepted
// Viewer (#9) closes over the mounted page.

const navigation = vi.hoisted(() => ({ pathname: '/work/harbor', replace: (() => undefined) as (href: string, options?: unknown) => void }));
vi.mock('next/navigation', () => ({ usePathname: () => navigation.pathname, useRouter: () => ({ replace: (href: string, options?: unknown) => navigation.replace(href, options) }) }));

const A = 'ph_00000000-0000-4000-8000-000000000001';
const B = 'ph_00000000-0000-4000-8000-000000000002';
const NEXT_KEYS = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: ['', {}], renderedSearch: '' } };
/** Past the first page, so it isn't on the page until #6 loads it again. */
const LATE = 'ph_00000000-0000-4000-8000-000000000003';
const PROPS = { path: '/work/harbor', slug: 'harbor', revisionId: 'rev_a', total: 3, firstPosition: 1, focusPhotoId: null as string | null };

const PAGE = `
    <main>
        <h1 id="${SERIES_TITLE_ID}">Harbor</h1>
        <figure><a id="${COVER_ID}" href="/work/harbor/photo/${B}"><span data-photo="cover"></span></a></figure>
        <section aria-labelledby="series-sequence">
            <h2 id="series-sequence">Sequence</h2>
            <ol>
                <li><a id="photo-${A}" href="/work/harbor/photo/${A}"><span data-position>1</span></a></li>
                <li><a id="photo-${B}" href="/work/harbor/photo/${B}"><span data-position>2</span></a></li>
            </ol>
        </section>
        <a id="all-work" href="/work">All work</a>
        <a id="elsewhere" href="/work/ridge/photo/${A}">Ridge</a>
    </main>`;

let scrollTo: ReturnType<typeof vi.fn>;
let navigationType: string | undefined;

function setScrollY(value: number) {
    Object.defineProperty(window, 'scrollY', { configurable: true, value });
}

const returnState = () => (window.history.state as Record<string, unknown> | null)?.[RETURN_KEY];

beforeAll(() => {
    // A click on a link would try to navigate jsdom.
    document.addEventListener('click', (event) => event.preventDefault());
});

beforeEach(() => {
    navigation.pathname = '/work/harbor';
    navigation.replace = () => undefined;
    document.body.innerHTML = PAGE;
    scrollTo = vi.fn();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Element.prototype.scrollIntoView = vi.fn();
    // Every opener sits in view, so only the offset moves the page.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 200, left: 0, right: 100, width: 100, height: 100, x: 0, y: 100, toJSON: () => ({}) } as DOMRect);
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    navigationType = 'navigate';
    vi.spyOn(performance, 'getEntriesByType').mockImplementation((type: string) => (type === 'navigation' && navigationType ? [{ type: navigationType } as unknown as PerformanceEntry] : []));
    setScrollY(0);
    window.history.replaceState({ ...NEXT_KEYS }, '', '/work/harbor');
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

/** A client render, as after a soft navigation. */
function mount(overrides: Partial<typeof PROPS> = {}) {
    const host = document.createElement('div');
    document.body.append(host);
    return render(<SeriesReturn {...PROPS} {...overrides} />, { container: host });
}

/** A hydration of server HTML, as on a document load. */
function hydrate(overrides: Partial<typeof PROPS> = {}): Root {
    const host = document.createElement('div');
    host.innerHTML = renderToString(<SeriesReturn {...PROPS} {...overrides} />);
    document.body.append(host);
    let root: Root | undefined;
    act(() => {
        root = hydrateRoot(host, <SeriesReturn {...PROPS} {...overrides} />);
    });
    if (!root) throw new Error('No root');
    return root;
}

const byId = (id: string) => document.getElementById(id) as HTMLElement;

describe('the record', () => {
    it('writes the photograph, the entry, and the scroll offset into the series\' entry on a plain click, keeping every other key', () => {
        const extent = { revisionId: 'rev_a', slug: 'harbor', loaded: 2 };
        window.history.replaceState({ ...NEXT_KEYS, [SERIES_PAGES_KEY]: extent }, '');
        mount();
        setScrollY(1234);
        fireEvent.click(byId(`photo-${A}`).querySelector('span') as Element);
        expect(window.history.state).toEqual({ ...NEXT_KEYS, [SERIES_PAGES_KEY]: extent, [RETURN_KEY]: { photoId: A, opener: 'entry', scrollY: 1234 } });
    });

    it('records the cover as the opener when the cover is activated', () => {
        mount();
        setScrollY(80);
        fireEvent.click(byId(COVER_ID));
        expect(returnState()).toEqual({ photoId: B, opener: 'cover', scrollY: 80 });
    });

    it('records on Enter too, which a link turns into a click', () => {
        mount();
        const entry = byId(`photo-${B}`);
        entry.focus();
        fireEvent.keyDown(entry, { key: 'Enter' });
        // jsdom doesn't synthesize the click a browser fires for Enter on a link, so fire it as the browser would.
        fireEvent.click(entry, { detail: 0 });
        expect(returnState()).toEqual({ photoId: B, opener: 'entry', scrollY: 0 });
    });

    it('records before the link\'s own handler runs, so it lands in the series\' entry and not the Viewer\'s', () => {
        mount();
        let seen: unknown;
        const entry = byId(`photo-${A}`);
        entry.addEventListener('click', () => {
            seen = returnState();
        });
        fireEvent.click(entry);
        expect(seen).toEqual({ photoId: A, opener: 'entry', scrollY: 0 });
    });

    it.each([
        ['Alt', { altKey: true }],
        ['Ctrl', { ctrlKey: true }],
        ['Meta', { metaKey: true }],
        ['Shift', { shiftKey: true }],
        ['a middle button', { button: 1 }],
    ])('writes nothing for a %s click, which opens elsewhere', (_label, init) => {
        mount();
        fireEvent.click(byId(`photo-${A}`), init);
        expect(returnState()).toBeUndefined();
    });

    it('writes nothing for links that aren\'t this page\'s Viewer entries', () => {
        mount();
        fireEvent.click(byId('all-work'));
        fireEvent.click(byId('elsewhere'));
        fireEvent.click(byId('series-sequence'));
        expect(returnState()).toBeUndefined();
    });

    it('stops listening once unmounted', () => {
        const view = mount();
        view.unmount();
        fireEvent.click(byId(`photo-${A}`));
        expect(returnState()).toBeUndefined();
    });

    it('renders nothing', () => {
        expect(mount().container.innerHTML).toBe('');
    });
});

describe('a series page that mounts again', () => {
    const stored = (record: object, extra: object = {}) => window.history.replaceState({ ...NEXT_KEYS, ...extra, [RETURN_KEY]: record }, '');

    it('restores the offset and focuses the entry that opened the Viewer, then uses the record up', () => {
        stored({ photoId: B, opener: 'entry', scrollY: 900 });
        mount();
        expect(scrollTo).toHaveBeenCalledWith({ top: 900, left: 0, behavior: 'instant' });
        expect(document.activeElement).toBe(byId(`photo-${B}`));
        expect(window.history.state).toEqual(NEXT_KEYS);
    });

    it('moves nothing on a second mount from the same entry, since the first one used the record', () => {
        stored({ photoId: B, opener: 'entry', scrollY: 900 });
        mount().unmount();
        byId(`photo-${B}`).blur();
        scrollTo.mockClear();
        mount();
        expect(scrollTo).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(document.body);
    });

    it('focuses the cover when the cover opened it', () => {
        stored({ photoId: B, opener: 'cover', scrollY: 0 });
        mount();
        expect(document.activeElement).toBe(byId(COVER_ID));
    });

    it('does nothing with no record', () => {
        mount();
        expect(scrollTo).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(document.body);
    });

    it('restores after a document load that came back through history (Back after a reload on the Viewer)', () => {
        stored({ photoId: A, opener: 'entry', scrollY: 300 });
        navigationType = 'back_forward';
        hydrate();
        expect(scrollTo).toHaveBeenCalledWith({ top: 300, left: 0, behavior: 'instant' });
        expect(document.activeElement).toBe(byId(`photo-${A}`));
    });

    it('restores nothing when the visitor reloaded the series page itself, and drops the record', () => {
        stored({ photoId: A, opener: 'entry', scrollY: 300 });
        navigationType = 'reload';
        hydrate();
        expect(scrollTo).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(document.body);
        expect(window.history.state).toEqual(NEXT_KEYS);
    });

    it('restores on a client render even in a document that was reloaded earlier, since that render is a return', () => {
        stored({ photoId: A, opener: 'entry', scrollY: 300 });
        navigationType = 'reload';
        mount();
        expect(document.activeElement).toBe(byId(`photo-${A}`));
    });

    it('waits for #6\'s restored entries when its photograph is past the first page and this series\' extent is stored, then restores', () => {
        stored({ photoId: LATE, opener: 'entry', scrollY: 5000 }, { [SERIES_PAGES_KEY]: { revisionId: 'rev_a', slug: 'harbor', loaded: 3 } });
        mount();
        expect(scrollTo).not.toHaveBeenCalled();
        // #6 loads the page holding it, then fires its event on the section.
        const late = document.createElement('a');
        late.id = `photo-${LATE}`;
        late.href = `/work/harbor/photo/${LATE}`;
        document.querySelector('ol')?.append(late);
        act(() => {
            document.querySelector('section')?.dispatchEvent(new Event(SERIES_RESTORED_EVENT, { bubbles: true }));
        });
        expect(scrollTo).toHaveBeenCalledWith({ top: 5000, left: 0, behavior: 'instant' });
        expect(document.activeElement).toBe(late);
    });

    it('restores at once when its photograph is on the first page, extent or not', () => {
        stored({ photoId: B, opener: 'entry', scrollY: 900 }, { [SERIES_PAGES_KEY]: { revisionId: 'rev_a', slug: 'harbor', loaded: 3 } });
        mount();
        expect(document.activeElement).toBe(byId(`photo-${B}`));
    });

    it('takes the extent\'s bound from the total it\'s given', () => {
        stored({ photoId: LATE, opener: 'entry', scrollY: 5000 }, { [SERIES_PAGES_KEY]: { revisionId: 'rev_a', slug: 'harbor', loaded: 4 } });
        mount();
        // 4 is more than the 3 photographs this page has, so #6 won't load it, and nothing waits.
        expect(scrollTo).toHaveBeenCalledWith({ top: 5000, left: 0, behavior: 'instant' });
    });

    it('stops waiting when it unmounts first', () => {
        stored({ photoId: LATE, opener: 'entry', scrollY: 5000 }, { [SERIES_PAGES_KEY]: { revisionId: 'rev_a', slug: 'harbor', loaded: 3 } });
        const view = mount();
        view.unmount();
        window.dispatchEvent(new Event(SERIES_RESTORED_EVENT));
        expect(scrollTo).not.toHaveBeenCalled();
    });

    it('restores once per mount, not again when the props change in place', () => {
        stored({ photoId: B, opener: 'entry', scrollY: 900 });
        const view = mount();
        expect(scrollTo).toHaveBeenCalledTimes(1);
        // A record written since (another click) is for the next return, not for a refresh in place.
        stored({ photoId: A, opener: 'entry', scrollY: 100 });
        view.rerender(<SeriesReturn {...PROPS} revisionId="rev_b" />);
        expect(scrollTo).toHaveBeenCalledTimes(1);
    });
});

describe('closing the intercepted Viewer over the mounted page', () => {
    const viewerOpen = (photoId: string) => {
        navigation.pathname = `/work/harbor/photo/${photoId}`;
    };

    it('puts the offset back and focus on the opener when the URL comes back to the series', () => {
        const view = mount();
        setScrollY(700);
        fireEvent.click(byId(`photo-${A}`));
        viewerOpen(A);
        view.rerender(<SeriesReturn {...PROPS} />);
        // Moves inside the Viewer replace its entry and leave the page alone.
        viewerOpen(B);
        view.rerender(<SeriesReturn {...PROPS} />);
        expect(scrollTo).not.toHaveBeenCalled();
        navigation.pathname = '/work/harbor';
        view.rerender(<SeriesReturn {...PROPS} />);
        expect(scrollTo).toHaveBeenCalledWith({ top: 700, left: 0, behavior: 'instant' });
        expect(document.activeElement).toBe(byId(`photo-${A}`));
        expect(returnState()).toBeUndefined();
    });

    it('moves nothing when the visitor closes the Viewer, scrolls on, goes to Work, and comes Back', () => {
        const view = mount();
        setScrollY(700);
        fireEvent.click(byId(`photo-${A}`));
        viewerOpen(A);
        view.rerender(<SeriesReturn {...PROPS} />);
        navigation.pathname = '/work/harbor';
        view.rerender(<SeriesReturn {...PROPS} />);
        expect(scrollTo).toHaveBeenCalledTimes(1);
        // Scrolls on to 4000, then follows Work: a push, so the [slug] layout unmounts.
        setScrollY(4000);
        byId(`photo-${A}`).blur();
        view.unmount();
        // Back renders the series page afresh from the same entry.
        mount();
        expect(scrollTo).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(document.body);
    });

    it('does nothing when the series path changes without a Viewer between', () => {
        const view = mount();
        fireEvent.click(byId(`photo-${A}`));
        navigation.pathname = '/work/harbor/';
        view.rerender(<SeriesReturn {...PROPS} />);
        navigation.pathname = '/work/harbor';
        view.rerender(<SeriesReturn {...PROPS} />);
        expect(scrollTo).not.toHaveBeenCalled();
    });

    it('does nothing when the Viewer closes onto a page with no record', () => {
        const view = mount();
        viewerOpen(A);
        view.rerender(<SeriesReturn {...PROPS} />);
        navigation.pathname = '/work/harbor';
        view.rerender(<SeriesReturn {...PROPS} />);
        expect(scrollTo).not.toHaveBeenCalled();
    });
});

describe('?photo= (#5, #6 deep entry, B5)', () => {
    const at = (search: string, state: object = NEXT_KEYS) => window.history.replaceState({ ...state }, '', `/work/harbor${search}`);
    const stored = (record: object, extra: object = {}) => ({ ...NEXT_KEYS, ...extra, [RETURN_KEY]: record });

    it('leaves the series URL alone on activation: the return lives in history.state, so a reload or a copied link starts where the page does', () => {
        at('?utm_source=mail#sequence');
        mount();
        fireEvent.click(byId(`photo-${A}`));
        expect([window.location.pathname, window.location.search, window.location.hash]).toEqual(['/work/harbor', '?utm_source=mail', '#sequence']);
        expect(returnState()).toEqual({ photoId: A, opener: 'entry', scrollY: 0 });
    });

    it('marks a deep link\'s ?photo= as used when an entry on its page is opened, so Back from Work later doesn\'t refocus it', () => {
        at(`?photo=${B}`);
        navigationType = 'reload';
        hydrate({ focusPhotoId: B });
        fireEvent.click(byId(`photo-${A}`));
        expect((window.history.state as Record<string, unknown>)[ARRIVAL_KEY]).toBe(B);
    });

    it('focuses the entry a direct load of ?photo= names, brought to the middle of the view, and only the first time', () => {
        at(`?photo=${B}`);
        const root = hydrate({ focusPhotoId: B });
        expect(document.activeElement).toBe(byId(`photo-${B}`));
        expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'instant' });
        expect(scrollTo).not.toHaveBeenCalled();
        expect((window.history.state as Record<string, unknown>)[ARRIVAL_KEY]).toBe(B);
        // Work, then Back to the same entry: the browser keeps its place.
        act(() => root.unmount());
        byId(`photo-${B}`).blur();
        mount({ focusPhotoId: B });
        expect(document.activeElement).toBe(document.body);
    });

    it('focuses it after a soft navigation too, as Close from a directly loaded photograph is', () => {
        at(`?photo=${A}`);
        mount({ focusPhotoId: A });
        expect(document.activeElement).toBe(byId(`photo-${A}`));
    });

    it.each([
        ['a photograph the server didn\'t find', `?photo=${B}`, null, 'navigate'],
        ['a reload of the page', `?photo=${B}`, B, 'reload'],
        ['a URL with no parameter', '', B, 'navigate'],
        ['a URL that names another photograph', `?photo=${A}`, B, 'navigate'],
        ['a value that isn\'t a photo ID', `?photo=${B.toUpperCase()}`, B, 'navigate'],
        ['two values', `?photo=${B}&photo=${B}`, B, 'navigate'],
    ])('focuses nothing for %s', (_case, search, focusPhotoId, type) => {
        at(search);
        navigationType = type;
        hydrate({ focusPhotoId });
        expect(document.activeElement).toBe(document.body);
        expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    });

    it('puts a return from the Viewer first: the record\'s offset and opener, then uses it up', () => {
        at(`?photo=${B}`, stored({ photoId: B, opener: 'cover', scrollY: 640 }));
        navigationType = 'back_forward';
        hydrate({ focusPhotoId: B });
        expect(scrollTo).toHaveBeenCalledWith({ top: 640, left: 0, behavior: 'instant' });
        expect(document.activeElement).toBe(byId(COVER_ID));
        expect(returnState()).toBeUndefined();
    });

    it('passes the server page\'s first position on, so a restore waits for #6 to load the pages before it', () => {
        at(`?photo=${B}`, stored({ photoId: B, opener: 'entry', scrollY: 640 }, { [SERIES_PAGES_KEY]: { revisionId: 'rev_a', slug: 'harbor', first: 1, loaded: 3 } }));
        navigationType = 'back_forward';
        hydrate({ focusPhotoId: B, firstPosition: 2 });
        expect(scrollTo).not.toHaveBeenCalled();
        act(() => {
            document.querySelector('section')?.dispatchEvent(new Event(SERIES_RESTORED_EVENT, { bubbles: true }));
        });
        expect(scrollTo).toHaveBeenCalledWith({ top: 640, left: 0, behavior: 'instant' });
        expect(document.activeElement).toBe(byId(`photo-${B}`));
    });

    it('goes to the series heading when the server\'s answer for this ?photo= doesn\'t hold the photograph: it left the revision', () => {
        const LEFT = 'ph_00000000-0000-4000-8000-000000000009';
        at(`?photo=${LEFT}`, stored({ photoId: LEFT, opener: 'entry', scrollY: 640 }));
        navigationType = 'back_forward';
        const replace = vi.fn();
        navigation.replace = replace;
        hydrate({ focusPhotoId: null });
        expect(document.activeElement).toBe(byId(SERIES_TITLE_ID));
        // The page is already the server's answer for this URL: nothing to ask again.
        expect(replace).not.toHaveBeenCalled();
    });

    it('restores a return from the Viewer on a deep link\'s page, whatever photograph its ?photo= named', () => {
        at(`?photo=${B}`, stored({ photoId: A, opener: 'entry', scrollY: 320 }, { [ARRIVAL_KEY]: B }));
        navigationType = 'back_forward';
        hydrate({ focusPhotoId: B });
        expect(scrollTo).toHaveBeenCalledWith({ top: 320, left: 0, behavior: 'instant' });
        expect(document.activeElement).toBe(byId(`photo-${A}`));
    });

    describe('when the saved pages can\'t bring the photograph back', () => {
        const OLD_PAGES = { revisionId: 'rev_old', slug: 'harbor', first: 1, loaded: 3 };
        const appendLate = () => {
            const late = document.createElement('a');
            late.id = `photo-${LATE}`;
            late.href = `/work/harbor/photo/${LATE}`;
            document.querySelector('ol')?.append(late);
            return late;
        };
        /** As Next lands a replace to ?photo=: the entry rewritten with its own keys, and the page under it mounted again. */
        const land = (view: ReturnType<typeof mount>, search: string) => {
            window.history.replaceState({ ...NEXT_KEYS }, '', `/work/harbor${search}`);
            view.unmount();
        };

        it('asks the server once for the page that holds it, then focuses it there and writes kgSeriesPages and kgSeriesReturn back before using the record', () => {
            at('', stored({ photoId: LATE, opener: 'entry', scrollY: 5000 }, { [SERIES_PAGES_KEY]: OLD_PAGES }));
            const replace = vi.fn();
            navigation.replace = replace;
            const view = mount();
            expect(replace).toHaveBeenCalledTimes(1);
            expect(replace).toHaveBeenCalledWith(`/work/harbor?photo=${LATE}`, { scroll: false });
            // Never the heading while the answer is on its way.
            expect(document.activeElement).toBe(document.body);
            expect(scrollTo).toHaveBeenCalledTimes(1);
            land(view, `?photo=${LATE}`);
            const late = appendLate();
            const pagesSeen: unknown[] = [];
            const spy = vi.spyOn(window.history, 'replaceState').mockImplementation(function (this: History, data, unused, url) {
                pagesSeen.push((data as Record<string, unknown> | null)?.[RETURN_KEY] ?? null);
                return History.prototype.replaceState.call(this, data, unused, url);
            });
            mount({ focusPhotoId: LATE, firstPosition: 3 });
            spy.mockRestore();
            expect(document.activeElement).toBe(late);
            expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'instant' });
            // Both keys went back before the record was used up.
            expect(pagesSeen).toContainEqual({ photoId: LATE, opener: 'entry', scrollY: 5000 });
            expect(window.history.state).toEqual({ ...NEXT_KEYS, [SERIES_PAGES_KEY]: OLD_PAGES, [ARRIVAL_KEY]: LATE });
            expect(replace).toHaveBeenCalledTimes(1);
        });

        it('goes to the heading when the server\'s page for ?photo= doesn\'t hold it either: it left the revision', () => {
            at('', stored({ photoId: LATE, opener: 'entry', scrollY: 5000 }));
            const view = mount();
            land(view, `?photo=${LATE}`);
            mount({ focusPhotoId: null });
            expect(document.activeElement).toBe(byId(SERIES_TITLE_ID));
            expect(returnState()).toBeUndefined();
        });

        it('waits for #6\'s saved pages and never falls back to the heading first (Viewer, Work, then Back twice)', () => {
            at('', stored({ photoId: LATE, opener: 'entry', scrollY: 5000 }, { [SERIES_PAGES_KEY]: { revisionId: 'rev_a', slug: 'harbor', first: 1, loaded: 3 } }));
            const replace = vi.fn();
            navigation.replace = replace;
            mount();
            expect(document.activeElement).toBe(document.body);
            expect(replace).not.toHaveBeenCalled();
            const late = appendLate();
            act(() => {
                document.querySelector('section')?.dispatchEvent(new Event(SERIES_RESTORED_EVENT, { bubbles: true }));
            });
            expect(document.activeElement).toBe(late);
            expect(replace).not.toHaveBeenCalled();
        });

        it('asks the server, and still not the heading, when #6\'s saved pages ended without it', () => {
            at('', stored({ photoId: LATE, opener: 'entry', scrollY: 5000 }, { [SERIES_PAGES_KEY]: { revisionId: 'rev_a', slug: 'harbor', first: 1, loaded: 3 } }));
            const replace = vi.fn();
            navigation.replace = replace;
            mount();
            act(() => {
                document.querySelector('section')?.dispatchEvent(new Event(SERIES_RESTORED_EVENT, { bubbles: true }));
            });
            expect(replace).toHaveBeenCalledWith(`/work/harbor?photo=${LATE}`, { scroll: false });
            expect(document.activeElement).toBe(document.body);
        });

        it('restores focus and uses the record up after RESTORE_WAIT_MS when the answer never lands', () => {
            vi.useFakeTimers();
            at('', stored({ photoId: LATE, opener: 'entry', scrollY: 5000 }));
            mount();
            expect(document.activeElement).toBe(document.body);
            act(() => {
                vi.advanceTimersByTime(RESTORE_WAIT_MS);
            });
            expect(document.activeElement).toBe(byId(SERIES_TITLE_ID));
            expect(returnState()).toBeUndefined();
        });

        it('keeps a later page that has nothing to do with it alone: an answer for another photograph doesn\'t land', () => {
            at('', stored({ photoId: LATE, opener: 'entry', scrollY: 5000 }));
            const view = mount();
            land(view, `?photo=${A}`);
            mount({ focusPhotoId: A });
            // That page is a deep link of its own, focused as one; the pending answer isn't taken for it.
            expect(document.activeElement).toBe(byId(`photo-${A}`));
        });
    });
});
