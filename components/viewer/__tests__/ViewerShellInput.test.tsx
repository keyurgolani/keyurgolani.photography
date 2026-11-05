import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishedViewerPhoto, ViewerImage } from '@/lib/catalog/projections/viewer';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '@/lib/identity/variants';
import { mediaUrl } from '@/lib/media/url';
import { setPrefersReducedMotion } from '@/test/matchMedia';
import StoryViewer from '../StoryViewer';
import ViewerShell from '../ViewerShell';
import ViewerUnavailable from '../ViewerUnavailable';
import type { ViewerMode } from '../viewerContext';

// B9 (#178): the Viewer's input. The repeated end message (bug 3), the mouse swipe (bug 4), the revision check for
// stale neighbours (bug 5), the keys, the swipe's edges and resets, Escape while zoomed, the move's busy stage and its
// queue under reduced motion, the offline move, the unavailable photograph, the announcements' settle, and saveData.

const router = vi.hoisted(() => ({ replace: vi.fn(), back: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), forward: vi.fn() }));
const params = vi.hoisted(() => ({ value: { slug: 'fixture', photoId: '' } as Record<string, string> }));
vi.mock('next/navigation', () => ({ useRouter: () => router, useParams: () => params.value }));
vi.mock('next/link', () => ({
    default: ({ href, replace, prefetch, children, ...rest }: { href: string; replace?: boolean; prefetch?: boolean | null; children: ReactNode }) => (
        <a href={href} data-replace={String(Boolean(replace))} data-prefetch={String(prefetch)} {...rest}>
            {children}
        </a>
    ),
}));

const showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
    this.querySelector<HTMLElement>('button, a[href]')?.focus();
});
const closeDialog = vi.fn(function (this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
});
const setPointerCapture = vi.fn();
const fetchMock = vi.fn();
const REVISION = `rev_${'a'.repeat(64)}`;
const REVISED = `rev_${'b'.repeat(64)}`;

beforeAll(() => {
    Object.assign(HTMLDialogElement.prototype, { showModal, close: closeDialog });
    Object.assign(HTMLElement.prototype, { setPointerCapture });
});
afterAll(() => {
    delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture;
});

beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (url: string) => {
        const photoId = /photos\/([^/?]+)/.exec(url)?.[1] ?? '';
        return new Response(JSON.stringify({ revisionId: REVISION, photoId, image: null, accent: null }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    params.value = { slug: 'fixture', photoId: id(3) };
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const photoHref = (n: number) => `/work/fixture/photo/${id(n)}`;

function imageOf(n: number): ViewerImage {
    const ref = { photoId: id(n), assetRevision: `sha256-${'3'.repeat(64)}`, profileId: 'p_0123456789abcdef' };
    const variants = {} as ViewerImage['variants'];
    for (const width of VARIANT_WIDTHS) {
        variants[width] = {} as (typeof variants)[typeof width];
        for (const format of VARIANT_FORMATS) variants[width][format] = { url: mediaUrl(ref, width, format), width: Number(width.slice(1)) };
    }
    return { width: 2400, height: 1600, assetRevision: ref.assetRevision, variants };
}

/** Photo n of 3, described, so a move's announcement can carry the description. */
function model(n: number, { withImage = false, revision = REVISION, technical = false } = {}): PublishedViewerPhoto {
    return {
        catalogRevision: revision,
        series: { id: 'ser_fixture', slug: 'fixture', title: 'Fixture series', accent: '#a0b0c0' },
        photo: {
            id: id(n),
            title: `Fixture title ${n}`,
            description: `A described photograph, number ${n}.`,
            caption: null,
            alt: `A described photograph, number ${n}.`,
            descriptionPending: false,
            namedByPlace: false,
            image: withImage ? imageOf(n) : null,
            shareImage: null,
            accent: null,
            technical: technical ? { Make: 'Fixture Make' } : {},
        },
        position: n,
        total: 3,
        previousPhotoId: n > 1 ? id(n - 1) : null,
        nextPhotoId: n < 3 ? id(n + 1) : null,
    };
}

type PhotoOptions = { withImage?: boolean; revision?: string; technical?: boolean; mount?: string };
function photo(n: number, options: PhotoOptions = {}) {
    const viewer = model(n, options);
    return (
        <StoryViewer
            key={`${options.mount ?? ''}${viewer.catalogRevision}/${viewer.photo.id}`}
            viewer={viewer}
            closeHref="/work/fixture"
            previousHref={viewer.previousPhotoId === null ? null : photoHref(n - 1)}
            nextHref={viewer.nextPhotoId === null ? null : photoHref(n + 1)}
            pendingCopy={null}
        />
    );
}

function renderShell(mode: ViewerMode, n: number, options: PhotoOptions = {}) {
    const view = render(<ViewerShell mode={mode}>{photo(n, options)}</ViewerShell>);
    return {
        ...view,
        move: (to: number, moved: PhotoOptions = options) => view.rerender(<ViewerShell mode={mode}>{photo(to, moved)}</ViewerShell>),
        show: (child: ReactNode) => view.rerender(<ViewerShell mode={mode}>{child}</ViewerShell>),
    };
}

const root = () => document.querySelector<HTMLElement>('[data-surface="viewer"]') as HTMLElement;
const announcer = () => document.querySelector('[data-viewer-announcer]') as HTMLElement;
const step = (name: 'Previous photograph' | 'Next photograph') => screen.getByRole('button', { name });
const stage = () => document.querySelector<HTMLElement>('[data-viewer-stage]') as HTMLElement;
const zoom = () => screen.getByRole('button', { name: 'Zoom' });
const advance = (ms: number) =>
    act(() => {
        vi.advanceTimersByTime(ms);
    });
/** Lets fetches resolve and their state land, under fake timers too. */
const flush = () =>
    act(async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
    });

/**
 * Every time the live region's text became `text`, on the region itself: a text node added holding it, or a text
 * node's data changed to it. A screen reader speaks a polite region when it changes, so this counts what it hears.
 */
function listen(node: HTMLElement) {
    const heard: string[] = [];
    const observer = new MutationObserver((records) => take(records));
    const take = (records: MutationRecord[]) => {
        for (const record of records) {
            if (record.type === 'characterData') heard.push((record.target as Text).data);
            for (const added of record.addedNodes) heard.push(added.textContent ?? '');
        }
    };
    observer.observe(node, { childList: true, characterData: true, subtree: true });
    return {
        landings(text: string) {
            take(observer.takeRecords());
            return heard.filter((value) => value === text).length;
        },
        heard() {
            take(observer.takeRecords());
            return heard.filter((value) => value !== '');
        },
        stop: () => observer.disconnect(),
    };
}

function pointer(target: EventTarget, type: string, { x = 200, y = 300, pointerType = 'touch' }: { x?: number; y?: number; pointerType?: string } = {}) {
    const event = new PointerEvent(type, { pointerId: 1, clientX: x, clientY: y, pointerType, isPrimary: true, bubbles: true, cancelable: true });
    act(() => {
        target.dispatchEvent(event);
    });
}

/** A drag on the stage from `x`, `dx` across, by `pointerType`. */
function drag(dx: number, { x = 200, pointerType = 'touch' }: { x?: number; pointerType?: string } = {}) {
    pointer(stage(), 'pointerdown', { x, pointerType });
    pointer(stage(), 'pointermove', { x: x + dx / 2, pointerType });
    pointer(stage(), 'pointerup', { x: x + dx, pointerType });
}

describe('bug 3: every press at an end is announced', () => {
    it.each(['page', 'modal'] as const)('in the %s, two presses at the last photograph land the end message twice, on the same node', (mode) => {
        vi.useFakeTimers();
        renderShell(mode, 3);
        const region = announcer();
        const ears = listen(region);
        fireEvent.click(step('Next photograph'));
        fireEvent.keyDown(mode === 'modal' ? root() : document.body, { key: 'ArrowRight' });
        advance(1000);
        expect(ears.landings('Last photograph in Fixture series.')).toBe(2);
        expect(announcer()).toBe(region);
        expect(region).toHaveTextContent('Last photograph in Fixture series.');
        expect(router.replace).not.toHaveBeenCalled();
        ears.stop();
    });

    it.each(['page', 'modal'] as const)('in the %s, three presses at the first photograph land it three times', (mode) => {
        vi.useFakeTimers();
        renderShell(mode, 1);
        const ears = listen(announcer());
        for (let i = 0; i < 3; i++) {
            fireEvent.click(step('Previous photograph'));
            advance(400);
        }
        expect(ears.landings('First photograph in Fixture series.')).toBe(3);
        ears.stop();
    });

    it('sets a first end message at once, as before, and only a repeat waits for the region to clear', () => {
        vi.useFakeTimers();
        renderShell('page', 3);
        fireEvent.click(step('Next photograph'));
        expect(announcer()).toHaveTextContent('Last photograph in Fixture series.');
        fireEvent.click(step('Next photograph'));
        // Cleared first, so the second landing is a change the screen reader hears.
        expect(announcer()).toHaveTextContent('');
        advance(150);
        expect(announcer()).toHaveTextContent('Last photograph in Fixture series.');
    });

    it('drops a repeat waiting to land when a move starts inside the gap: the region ends on the move\'s words', () => {
        vi.useFakeTimers();
        const { move } = renderShell('page', 3);
        const ears = listen(announcer());
        fireEvent.click(step('Next photograph'));
        fireEvent.click(step('Next photograph'));
        fireEvent.click(step('Previous photograph'));
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(2), { scroll: false });
        move(2);
        advance(1000);
        expect(ears.landings('Last photograph in Fixture series.')).toBe(1);
        expect(announcer().textContent).toMatch(/^Photograph 2 of 3\b/);
        ears.stop();
    });
});

describe('announcements settle (#178)', () => {
    it('gives a move\'s position, title and description 250 ms after the photograph arrives', () => {
        vi.useFakeTimers();
        const { move } = renderShell('page', 1);
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        move(2);
        expect(announcer()).toHaveTextContent('');
        advance(249);
        expect(announcer()).toHaveTextContent('');
        advance(1);
        expect(announcer().textContent).toBe('Photograph 2 of 3. Fixture title 2. A described photograph, number 2.');
    });

    it('gives one message for rapid presses: the photograph the visitor stops on', () => {
        vi.useFakeTimers();
        const { move } = renderShell('page', 1);
        const ears = listen(announcer());
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        move(2);
        advance(100);
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        move(3);
        advance(1000);
        expect(ears.heard()).toEqual(['Photograph 3 of 3. Fixture title 3. A described photograph, number 3.']);
        ears.stop();
    });
});

describe('bug 4 and the swipe\'s rules: touch and pen only, the edges, the resets, data-gesture', () => {
    it('never moves on a mouse drag on the stage; touch and pen still do', () => {
        renderShell('page', 2);
        drag(-150, { pointerType: 'mouse' });
        expect(router.replace).not.toHaveBeenCalled();
        drag(-150, { pointerType: 'pen' });
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(3), { scroll: false });
    });

    it('moves on a touch swipe, and a mouse press engages nothing: no peek is asked for', async () => {
        renderShell('page', 2);
        pointer(stage(), 'pointerdown', { pointerType: 'mouse' });
        pointer(stage(), 'pointerup', { pointerType: 'mouse' });
        await flush();
        expect(fetchMock).not.toHaveBeenCalled();
        drag(150, { pointerType: 'touch' });
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(1), { scroll: false });
    });

    it('ignores a swipe that starts within 24 px of either edge of the window, where the browser\'s back gesture lives', () => {
        renderShell('page', 2);
        const width = window.innerWidth;
        drag(150, { x: 10 });
        drag(-150, { x: width - 10 });
        drag(150, { x: 23 });
        expect(router.replace).not.toHaveBeenCalled();
        drag(150, { x: 30 });
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(1), { scroll: false });
    });

    it.each([
        ['the window losing focus', () => window.dispatchEvent(new Event('blur'))],
        ['the tab being hidden', () => document.dispatchEvent(new Event('visibilitychange'))],
        ['a context menu', () => stage().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))],
    ])('drops a gesture in flight on %s: its lift never moves', (_, interrupt) => {
        renderShell('page', 2);
        pointer(stage(), 'pointerdown');
        pointer(stage(), 'pointermove', { x: 120 });
        act(() => {
            interrupt();
        });
        expect(root()).toHaveAttribute('data-gesture', 'idle');
        pointer(stage(), 'pointerup', { x: 40 });
        expect(router.replace).not.toHaveBeenCalled();
    });

    it('shows the gesture\'s state on the root as data-gesture', () => {
        renderShell('page', 2);
        expect(root()).toHaveAttribute('data-gesture', 'idle');
        pointer(stage(), 'pointerdown');
        expect(root()).toHaveAttribute('data-gesture', 'pressed');
        pointer(stage(), 'pointermove', { x: 170 });
        expect(root()).toHaveAttribute('data-gesture', 'swiping');
        // Short of a swipe, so nothing is on its way and the next finger can start one.
        pointer(stage(), 'pointerup', { x: 185 });
        expect(root()).toHaveAttribute('data-gesture', 'idle');
        pointer(stage(), 'pointerdown');
        pointer(stage(), 'pointermove', { x: 200, y: 340 });
        expect(root()).toHaveAttribute('data-gesture', 'scrolling');
        pointer(stage(), 'pointercancel');
        expect(root()).toHaveAttribute('data-gesture', 'idle');
        // A mouse holds no gesture.
        pointer(stage(), 'pointerdown', { pointerType: 'mouse' });
        expect(root()).toHaveAttribute('data-gesture', 'idle');
    });
});

describe('keys (#178)', () => {
    it.each(['page', 'modal'] as const)('in the %s, ignores an auto-repeated arrow, one an input method is composing, and one already taken', (mode) => {
        renderShell(mode, 2);
        const target = mode === 'modal' ? root() : document.body;
        fireEvent.keyDown(target, { key: 'ArrowRight', repeat: true });
        fireEvent.keyDown(target, { key: 'ArrowRight', isComposing: true });
        const taken = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
        taken.preventDefault();
        target.dispatchEvent(taken);
        expect(router.replace).not.toHaveBeenCalled();
        fireEvent.keyDown(target, { key: 'ArrowRight' });
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(3), { scroll: false });
    });

    it('holding an arrow down moves once: the auto-repeats after the first press do nothing', () => {
        const { move } = renderShell('page', 1);
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        for (let i = 0; i < 5; i++) fireEvent.keyDown(document.body, { key: 'ArrowRight', repeat: true });
        move(2);
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(2), { scroll: false });
    });
});

describe('Escape while zoomed (#178)', () => {
    it('in the modal, only resets the zoom, and focus moves from the zoomed region to Zoom; the next Escape closes', () => {
        renderShell('modal', 2, { withImage: true });
        fireEvent.click(zoom());
        expect(stage()).toHaveAttribute('data-zoomed', 'true');
        stage().focus();
        expect(document.activeElement).toBe(stage());
        fireEvent.keyDown(stage(), { key: 'Escape' });
        const cancel = new Event('cancel', { cancelable: true });
        root().dispatchEvent(cancel);
        expect(cancel.defaultPrevented).toBe(true);
        expect(router.back).not.toHaveBeenCalled();
        expect(stage()).not.toHaveAttribute('data-zoomed');
        expect(document.activeElement).toBe(zoom());
        fireEvent.keyDown(zoom(), { key: 'Escape' });
        root().dispatchEvent(new Event('cancel', { cancelable: true }));
        expect(router.back).toHaveBeenCalledOnce();
    });

    it('in the modal, a cancel alone while zoomed resets the zoom and never closes', () => {
        renderShell('modal', 2, { withImage: true });
        fireEvent.click(zoom());
        act(() => {
            root().dispatchEvent(new Event('cancel', { cancelable: true }));
        });
        expect(router.back).not.toHaveBeenCalled();
        expect(stage()).not.toHaveAttribute('data-zoomed');
    });

    it('on a page, Escape resets the zoom and puts focus on Zoom; it never navigates', () => {
        renderShell('page', 2, { withImage: true });
        fireEvent.click(zoom());
        stage().focus();
        fireEvent.keyDown(stage(), { key: 'Escape' });
        expect(stage()).not.toHaveAttribute('data-zoomed');
        expect(document.activeElement).toBe(zoom());
        expect(router.back).not.toHaveBeenCalled();
        expect(router.replace).not.toHaveBeenCalled();
    });

    it('moves focus to Zoom whenever the zoomed region it was in resets, by Zoom or by a double-tap', () => {
        renderShell('page', 2, { withImage: true });
        fireEvent.click(zoom());
        stage().focus();
        act(() => {
            zoom().click();
        });
        expect(document.activeElement).toBe(zoom());
    });
});

describe('a move is busy, one at a time (#178)', () => {
    it('marks the stage aria-busy from the press to the photograph\'s arrival', () => {
        const { move } = renderShell('page', 1);
        expect(stage()).not.toHaveAttribute('aria-busy');
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        expect(stage()).toHaveAttribute('aria-busy', 'true');
        move(2);
        expect(stage()).not.toHaveAttribute('aria-busy');
    });

    it('under reduced motion too: one move runs, and the latest press waits and runs once it lands', () => {
        setPrefersReducedMotion(true);
        const { move } = renderShell('page', 1);
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        expect(stage()).toHaveAttribute('aria-busy', 'true');
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        fireEvent.click(step('Next photograph'));
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(2), { scroll: false });
        move(2);
        expect(router.replace).toHaveBeenCalledTimes(2);
        expect(router.replace).toHaveBeenLastCalledWith(photoHref(3), { scroll: false });
        // Nothing slides under reduced motion: the counter still changes only when the photograph arrives.
        expect(document.querySelector('header p > span[aria-hidden="true"]')?.textContent).toBe('02 / 03');
    });
});

describe('offline (#178)', () => {
    let online = true;
    beforeEach(() => {
        online = true;
        vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
    });

    it.each(['page', 'modal'] as const)('in the %s, a move offline says so by the controls, announces it, and doesn\'t navigate', (mode) => {
        renderShell(mode, 2);
        online = false;
        act(() => {
            window.dispatchEvent(new Event('offline'));
        });
        fireEvent.click(step('Next photograph'));
        expect(router.replace).not.toHaveBeenCalled();
        const notice = document.querySelector('[data-viewer-offline]');
        expect(notice).toHaveTextContent("You're offline. The next photograph couldn't load.");
        expect(notice?.parentElement).toBe(root());
        expect(announcer()).toHaveTextContent("You're offline. The next photograph couldn't load.");
        fireEvent.keyDown(mode === 'modal' ? root() : document.body, { key: 'ArrowLeft' });
        expect(router.replace).not.toHaveBeenCalled();
        expect(document.querySelector('[data-viewer-offline]')).toHaveTextContent("You're offline. The previous photograph couldn't load.");
        // Back online, the notice goes, and a press moves.
        online = true;
        act(() => {
            window.dispatchEvent(new Event('online'));
        });
        expect(document.querySelector('[data-viewer-offline]')).toBeNull();
        fireEvent.click(step('Next photograph'));
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(3), { scroll: false });
    });

    it('a swipe offline says the same, and the photograph stays', () => {
        renderShell('page', 2);
        online = false;
        drag(-150);
        expect(router.replace).not.toHaveBeenCalled();
        expect(document.querySelector('[data-viewer-offline]')).toHaveTextContent("You're offline. The next photograph couldn't load.");
    });

    it('an end offline is still the end', () => {
        renderShell('page', 3);
        online = false;
        fireEvent.click(step('Next photograph'));
        expect(announcer()).toHaveTextContent('Last photograph in Fixture series.');
        expect(document.querySelector('[data-viewer-offline]')).toBeNull();
    });
});

describe('bug 5: the revision check, for every visitor', () => {
    let hidden = false;
    beforeEach(() => {
        hidden = false;
        vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => (hidden ? 'hidden' : 'visible'));
        window.history.replaceState(null, '', photoHref(2));
    });
    const checks = () => fetchMock.mock.calls.map(([url]) => String(url));
    // The served revision is REVISED: a check in the one before gets the 409, one in REVISED a 200.
    // The 409 says whether the photograph shown is still there (#178 review): kept, under a renamed series, or gone.
    const revised409 = (photo?: 'kept' | 'renamed' | 'gone') =>
        fetchMock.mockImplementation(async (url: string) =>
            String(url).includes(REVISION)
                ? new Response(JSON.stringify({ reason: 'revision-changed', ...(photo && { photo }) }), { status: 409 })
                : new Response(JSON.stringify({ revisionId: REVISED, photoId: '', image: null, accent: null }), { status: 200 }),
        );
    const setHidden = (value: boolean) =>
        act(() => {
            hidden = value;
            document.dispatchEvent(new Event('visibilitychange'));
        });

    it.each([false, true])('asks nothing on a load, then once every 30 s for the photograph shown, in its revision (reduced motion %s)', async (reduced) => {
        setPrefersReducedMotion(reduced);
        vi.useFakeTimers();
        renderShell('page', 2);
        advance(29_999);
        await flush();
        expect(fetchMock).not.toHaveBeenCalled();
        advance(1);
        await flush();
        expect(checks()).toEqual([`/api/catalog/series/fixture/photos/${id(2)}?revision=${REVISION}`]);
        advance(30_000);
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        // A 200 is only a yes: nothing is dropped, and it's never kept as a peek.
        expect(router.refresh).not.toHaveBeenCalled();
        expect(router.replace).not.toHaveBeenCalled();
        expect(document.querySelectorAll('[data-viewer-peek]')).toHaveLength(0);
    });

    it('keeps one interval across moves, and asks for the photograph shown then', async () => {
        vi.useFakeTimers();
        const { move } = renderShell('modal', 1);
        advance(20_000);
        fireEvent.click(step('Next photograph'));
        move(2);
        advance(10_000);
        await flush();
        expect(checks()).toEqual([`/api/catalog/series/fixture/photos/${id(2)}?revision=${REVISION}`]);
    });

    it('in the modal, a 409 drops the prefetched pages with one refresh, and the neighbours are prefetched again in the new revision', async () => {
        vi.useFakeTimers();
        const { move } = renderShell('modal', 2);
        advance(1000);
        const before = router.prefetch.mock.calls.length;
        expect(before).toBe(2);
        revised409();
        advance(30_000);
        await flush();
        expect(router.refresh).toHaveBeenCalledOnce();
        // The refresh lands: the same photograph in the revision served.
        move(2, { revision: REVISED });
        advance(1000);
        expect(router.prefetch.mock.calls.length).toBe(before + 2);
        advance(30_000);
        await flush();
        expect(router.refresh).toHaveBeenCalledOnce();
    });

    it('on a page no move has left, a 409 for a photograph that\'s gone asks for the page again where it lands in the Viewer', async () => {
        vi.useFakeTimers();
        const { move } = renderShell('page', 2);
        revised409('gone');
        advance(30_000);
        await flush();
        // A refresh of a directly loaded page would land a dropped photograph on the site's not-found page, outside
        // the Viewer. A replace to the same URL comes back through the intercepted route, like a move.
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(`${photoHref(2)}`, { scroll: false });
        expect(router.refresh).not.toHaveBeenCalled();
        // It lands in the revision served, which drops the prefetched pages once.
        move(2, { revision: REVISED });
        await flush();
        expect(router.refresh).toHaveBeenCalledOnce();
    });

    it.each([['kept'], ['an answer that doesn\'t say']] as const)('on a page no move has left, a 409 for a photograph %s refreshes: nothing remounts', async (said) => {
        vi.useFakeTimers();
        renderShell('page', 2);
        revised409(said === 'kept' ? 'kept' : undefined);
        advance(30_000);
        await flush();
        expect(router.refresh).toHaveBeenCalledOnce();
        expect(router.replace).not.toHaveBeenCalled();
    });

    it('on a page no move has left, a 409 under a renamed series asks for the page again, and focus and the zoomed scroll come back on the remounted photograph', async () => {
        vi.useFakeTimers();
        const { move } = renderShell('page', 2, { technical: true });
        const toggle = () => screen.getByRole('button', { name: /technical details$/ });
        toggle().focus();
        revised409('renamed');
        advance(30_000);
        await flush();
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(2), { scroll: false });
        // It comes back through the other slot, a new photograph element: the old toggle is gone with focus on it.
        const before = toggle();
        move(2, { technical: true, revision: REVISED, mount: 'slot/' });
        expect(before.isConnected).toBe(false);
        expect(document.activeElement).toBe(toggle());
    });

    it('on a page after a move, a 409 refreshes', async () => {
        vi.useFakeTimers();
        const { move } = renderShell('page', 1);
        fireEvent.click(step('Next photograph'));
        move(2);
        router.replace.mockClear();
        revised409();
        advance(30_000);
        await flush();
        expect(router.refresh).toHaveBeenCalledOnce();
        expect(router.replace).not.toHaveBeenCalled();
    });

    it('asks nothing while the tab is hidden, and asks at once when it\'s visible again', async () => {
        vi.useFakeTimers();
        renderShell('page', 2);
        advance(10_000);
        setHidden(true);
        advance(120_000);
        await flush();
        expect(fetchMock).not.toHaveBeenCalled();
        setHidden(false);
        await flush();
        expect(fetchMock).toHaveBeenCalledOnce();
        advance(29_999);
        await flush();
        expect(fetchMock).toHaveBeenCalledOnce();
        advance(1);
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('waits for a move on its way before it acts on a 409', async () => {
        vi.useFakeTimers();
        let answer: (response: Response) => void = () => undefined;
        fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (answer = resolve)));
        const { move } = renderShell('modal', 2);
        advance(30_000);
        fireEvent.click(step('Next photograph'));
        answer(new Response('{}', { status: 409 }));
        await flush();
        expect(router.refresh).not.toHaveBeenCalled();
        move(3);
        await flush();
        expect(router.refresh).toHaveBeenCalledOnce();
    });

    it('leaves no timer and no listener after close, and ignores an answer that comes after it', async () => {
        vi.useFakeTimers();
        let answer: (response: Response) => void = () => undefined;
        fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (answer = resolve)));
        const added = vi.spyOn(document, 'addEventListener');
        const removed = vi.spyOn(document, 'removeEventListener');
        const windowAdded = vi.spyOn(window, 'addEventListener');
        const windowRemoved = vi.spyOn(window, 'removeEventListener');
        const { unmount } = renderShell('modal', 3);
        fireEvent.click(step('Next photograph'));
        fireEvent.click(step('Next photograph'));
        advance(30_000);
        unmount();
        answer(new Response('{}', { status: 409 }));
        await flush();
        expect(router.refresh).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        const count = (spy: typeof added, type: string) => spy.mock.calls.filter(([name]) => name === type).length;
        for (const type of ['keydown', 'visibilitychange']) expect(count(removed, type), type).toBe(count(added, type));
        for (const type of ['blur', 'online', 'offline']) expect(count(windowRemoved, type), type).toBe(count(windowAdded, type));
    });
});

describe('saveData (#174)', () => {
    afterEach(() => {
        delete (navigator as { connection?: unknown }).connection;
    });

    it('skips the idle neighbour prefetch when the visitor asks to save data', () => {
        Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } });
        vi.useFakeTimers();
        const { move } = renderShell('page', 2);
        advance(5000);
        move(3);
        advance(5000);
        expect(router.prefetch).not.toHaveBeenCalled();
    });

    it('prefetches as before when saveData is off or unknown', () => {
        Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: false } });
        vi.useFakeTimers();
        renderShell('page', 2);
        advance(5000);
        expect(router.prefetch).toHaveBeenCalledTimes(2);
    });
});

describe('a photograph unpublished or moved mid-visit (#178)', () => {
    const heading = () => screen.getByRole('heading', { level: 1, name: 'This photograph is no longer here' });

    it('on a page, a move that lands on it shows ViewerUnavailable: announced, focus on its heading, and a link back to the series', () => {
        vi.useFakeTimers();
        const { show } = renderShell('page', 2);
        const next = step('Next photograph');
        next.focus();
        fireEvent.click(next);
        show(<ViewerUnavailable />);
        expect(document.activeElement).toBe(heading());
        // No moves from a photograph that isn't there: the controls for it go.
        expect(screen.queryByRole('button', { name: 'Next photograph' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Zoom' })).toBeNull();
        expect(stage()).toBeNull();
        expect(screen.getByRole('link', { name: 'Back to the series' })).toHaveAttribute('href', '/work/fixture');
        expect(document.querySelector('[data-viewer-unavailable]')?.closest('[data-surface="viewer"]')).toBe(root());
        advance(1000);
        expect(announcer()).toHaveTextContent('This photograph is no longer here. It was unpublished or moved after this page loaded.');
    });

    it('in the modal, it names the dialog, and the way back is one Back to the series under it', () => {
        const { show } = renderShell('modal', 2);
        fireEvent.click(step('Next photograph'));
        show(<ViewerUnavailable />);
        expect(document.activeElement).toBe(heading());
        expect(root()).toHaveAttribute('aria-labelledby', heading().id);
        fireEvent.click(screen.getByRole('button', { name: 'Back to the series' }));
        expect(router.back).toHaveBeenCalledOnce();
    });

    it('opens the modal for it even when no photograph came first, so a stale entry still says what happened', () => {
        render(
            <ViewerShell mode="modal">
                <ViewerUnavailable />
            </ViewerShell>,
        );
        expect(showModal).toHaveBeenCalledOnce();
        expect(root()).toHaveAttribute('open');
        expect(document.activeElement).toBe(heading());
    });

    it('makes no check and no prefetch while it shows, and a photograph after it is a Viewer again', async () => {
        vi.useFakeTimers();
        const { show, move } = renderShell('modal', 2);
        show(<ViewerUnavailable />);
        router.prefetch.mockClear();
        advance(60_000);
        await flush();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(router.prefetch).not.toHaveBeenCalled();
        move(1);
        expect(step('Next photograph')).toBeInTheDocument();
    });
});

describe('the B9 review', () => {
    beforeEach(() => {
        vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => 'visible');
    });

    it('moves the address to the canonical URL when a photograph renders under a former slug of its series, and nothing remounts', () => {
        window.history.replaceState(null, '', `/work/fixture-old/photo/${id(2)}?from=mail`);
        const replaced = vi.spyOn(window.history, 'replaceState');
        renderShell('modal', 2);
        expect(window.location.pathname).toBe(photoHref(2));
        expect(window.location.search).toBe('?from=mail');
        expect(replaced).toHaveBeenCalledOnce();
        expect(router.replace).not.toHaveBeenCalled();
        // Already canonical: nothing to move.
        replaced.mockClear();
        document.body.innerHTML = '';
        renderShell('page', 3);
        window.history.replaceState(null, '', photoHref(3));
        replaced.mockClear();
        renderShell('page', 3);
        expect(replaced).not.toHaveBeenCalled();
    });

    it('lands a move\'s waiting announcement with the end message when Next is pressed at the end before it settles', () => {
        vi.useFakeTimers();
        const { move } = renderShell('page', 2);
        const ears = listen(announcer());
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        move(3);
        advance(100);
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        advance(1000);
        expect(ears.heard()).toEqual(['Photograph 3 of 3. Fixture title 3. A described photograph, number 3. Last photograph in Fixture series.']);
        ears.stop();
    });

    it('forgets an Escape the zoom took once its key is done, so a later cancel on its own closes the modal', () => {
        vi.useFakeTimers();
        renderShell('modal', 2, { withImage: true });
        fireEvent.click(zoom());
        // The browser may send no cancel after a key the page took.
        fireEvent.keyDown(stage(), { key: 'Escape' });
        expect(stage()).not.toHaveAttribute('data-zoomed');
        advance(1);
        act(() => {
            root().dispatchEvent(new Event('cancel', { cancelable: true }));
        });
        expect(router.back).toHaveBeenCalledOnce();
    });

    it('puts focus on Zoom when the zoomed region it was in resets, even once the browser has moved it to the body', () => {
        renderShell('page', 2, { withImage: true });
        fireEvent.click(zoom());
        const region = stage();
        region.focus();
        // A browser's focus fixup: the region drops focus to the body the moment its tabindex goes.
        const removeAttribute = region.removeAttribute.bind(region);
        region.removeAttribute = (name: string) => {
            removeAttribute(name);
            if (name.toLowerCase() === 'tabindex') region.blur();
        };
        fireEvent.click(zoom());
        expect(document.activeElement).toBe(zoom());
    });

    it('never overlaps two revision checks: a check still waiting skips the next', async () => {
        vi.useFakeTimers();
        let answer: (response: Response) => void = () => undefined;
        fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (answer = resolve)));
        renderShell('page', 2);
        advance(30_000);
        advance(30_000);
        await flush();
        expect(fetchMock).toHaveBeenCalledOnce();
        answer(new Response(JSON.stringify({ revisionId: REVISION, photoId: id(2), image: null, accent: null }), { status: 200 }));
        await flush();
        advance(30_000);
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('in the modal, a move that lands on ViewerUnavailable refreshes once, so Back lands on the series as it is now', () => {
        const { show } = renderShell('modal', 2);
        fireEvent.click(step('Next photograph'));
        show(<ViewerUnavailable />);
        expect(router.refresh).toHaveBeenCalledOnce();
    });

    it('on a page, a move that lands on ViewerUnavailable doesn\'t refresh: the link back loads the series afresh', () => {
        const { show } = renderShell('page', 2);
        fireEvent.click(step('Next photograph'));
        show(<ViewerUnavailable />);
        expect(router.refresh).not.toHaveBeenCalled();
    });

    it('prefetches a neighbour again when Next invalidates its prefetched page, and not after close', () => {
        vi.useFakeTimers();
        const { unmount } = renderShell('page', 2);
        advance(1000);
        expect(router.prefetch).toHaveBeenCalledTimes(2);
        const [href, options] = router.prefetch.mock.calls[0] as [string, { kind: string; onInvalidate?: () => void }];
        expect(options).toEqual({ kind: 'full', onInvalidate: expect.any(Function) });
        act(() => options.onInvalidate?.());
        advance(1000);
        expect(router.prefetch).toHaveBeenCalledTimes(3);
        expect(router.prefetch).toHaveBeenLastCalledWith(href, expect.objectContaining({ kind: 'full' }));
        unmount();
        act(() => options.onInvalidate?.());
        advance(1000);
        expect(router.prefetch).toHaveBeenCalledTimes(3);
    });
});
