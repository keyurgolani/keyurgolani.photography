import { act, fireEvent, render } from '@testing-library/react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARRIVAL_KEY, COVER_ID, RETURN_KEY, SERIES_TITLE_ID } from '../returnPosition';
import { SERIES_PAGES_KEY, SERIES_RESTORED_EVENT } from '../seriesContinuation';
import SeriesReturn from '../SeriesReturn';

// The series page's return position (#5) as the page mounts it: the record a
// plain activation writes into the series' history entry, the restore when
// the page mounts again (and not on a reload of the page itself), the wait
// for #6's restored entries, and the scroll put back when the intercepted
// Viewer (#9) closes over the mounted page.

const navigation = vi.hoisted(() => ({ pathname: '/work/harbor', refresh: (() => undefined) as () => void }));
vi.mock('next/navigation', () => ({ usePathname: () => navigation.pathname, useRouter: () => ({ refresh: () => navigation.refresh() }) }));

const A = 'ph_00000000-0000-4000-8000-000000000001';
const B = 'ph_00000000-0000-4000-8000-000000000002';
const NEXT_KEYS = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: ['', {}], renderedSearch: '' } };
/** Past the first page, so it isn't on the page until #6 loads it again. */
const LATE = 'ph_00000000-0000-4000-8000-000000000003';
const PROPS = { path: '/work/harbor', slug: 'harbor', revisionId: 'rev_a', total: 3, focusPhotoId: null as string | null };

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
    navigation.refresh = () => undefined;
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
        expect(window.history.state).toEqual({ ...NEXT_KEYS, [SERIES_PAGES_KEY]: extent, [RETURN_KEY]: { photoId: A, opener: 'entry', scrollY: 1234 }, [ARRIVAL_KEY]: A });
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

    it('writes ?photo= into the series\' URL on activation, keeping its other parameters and the hash', () => {
        at('?utm_source=mail#sequence');
        mount();
        fireEvent.click(byId(`photo-${A}`));
        expect([window.location.pathname, window.location.search, window.location.hash]).toEqual(['/work/harbor', `?utm_source=mail&photo=${A}`, '#sequence']);
        fireEvent.click(byId(COVER_ID));
        expect(window.location.search).toBe(`?utm_source=mail&photo=${B}`);
        expect(returnState()).toEqual({ photoId: B, opener: 'cover', scrollY: 0 });
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

    it('goes to the series heading when the photograph that opened the Viewer left the revision', () => {
        const LEFT = 'ph_00000000-0000-4000-8000-000000000009';
        at(`?photo=${LEFT}`, stored({ photoId: LEFT, opener: 'entry', scrollY: 640 }));
        navigationType = 'back_forward';
        const refresh = vi.fn();
        navigation.refresh = refresh;
        hydrate({ focusPhotoId: null });
        expect(document.activeElement).toBe(byId(SERIES_TITLE_ID));
        // A document load is the server's answer for this URL already: nothing to refresh.
        expect(refresh).not.toHaveBeenCalled();
    });

    describe('when Back restored another page', () => {
        const pages = { revisionId: 'rev_a', slug: 'harbor', first: 1, loaded: 3 };
        const appendLate = () => {
            const late = document.createElement('a');
            late.id = `photo-${LATE}`;
            late.href = `/work/harbor/photo/${LATE}`;
            document.querySelector('ol')?.append(late);
            return late;
        };

        it('refreshes once, writes kgSeriesPages and kgSeriesReturn again, and focuses the photograph without the saved offset', () => {
            at(`?photo=${LATE}`, stored({ photoId: LATE, opener: 'entry', scrollY: 5000 }, { [SERIES_PAGES_KEY]: pages }));
            const refresh = vi.fn(() => {
                // As Next does: a refresh rewrites the entry with its own keys only (#6's limit 24).
                window.history.replaceState({ ...NEXT_KEYS }, '');
            });
            navigation.refresh = refresh;
            const view = mount({ focusPhotoId: null });
            expect(refresh).toHaveBeenCalledTimes(1);
            expect(scrollTo).not.toHaveBeenCalled();
            // The server's page for ?photo= arrives with the photograph on it.
            const late = appendLate();
            view.rerender(<SeriesReturn {...PROPS} focusPhotoId={LATE} />);
            expect(document.activeElement).toBe(late);
            expect(scrollTo).not.toHaveBeenCalled();
            expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'instant' });
            expect(window.history.state).toEqual({ ...NEXT_KEYS, [SERIES_PAGES_KEY]: pages, [ARRIVAL_KEY]: LATE });
            view.rerender(<SeriesReturn {...PROPS} focusPhotoId={LATE} />);
            expect(refresh).toHaveBeenCalledTimes(1);
        });

        it('keeps the record in the entry, for the restore, until the refresh lands', () => {
            at(`?photo=${LATE}`, stored({ photoId: LATE, opener: 'entry', scrollY: 5000 }, { [SERIES_PAGES_KEY]: pages }));
            navigation.refresh = vi.fn();
            const view = mount({ focusPhotoId: null });
            view.rerender(<SeriesReturn {...PROPS} focusPhotoId={null} />);
            expect(returnState()).toEqual({ photoId: LATE, opener: 'entry', scrollY: 5000 });
            expect(document.activeElement).toBe(document.body);
        });

        it('goes to the heading when the refreshed page doesn\'t hold the photograph either', () => {
            at(`?photo=${LATE}`, stored({ photoId: LATE, opener: 'entry', scrollY: 5000 }));
            navigation.refresh = () => window.history.replaceState({ ...NEXT_KEYS }, '');
            const view = mount({ focusPhotoId: null });
            view.rerender(<SeriesReturn {...PROPS} focusPhotoId={null} />);
            expect(document.activeElement).toBe(byId(SERIES_TITLE_ID));
            expect(returnState()).toBeUndefined();
        });

        it('refreshes nothing for a record from before ?photo= (no parameter in the URL): #6\'s extent brings the photograph back', () => {
            at('', stored({ photoId: LATE, opener: 'entry', scrollY: 5000 }, { [SERIES_PAGES_KEY]: pages }));
            const refresh = vi.fn();
            navigation.refresh = refresh;
            mount();
            expect(refresh).not.toHaveBeenCalled();
        });
    });
});
