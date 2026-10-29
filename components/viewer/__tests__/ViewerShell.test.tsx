import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishedViewerPhoto, ViewerImage } from '@/lib/catalog/projections/viewer';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '@/lib/identity/variants';
import { mediaUrl } from '@/lib/media/url';
import { setPrefersReducedMotion } from '@/test/matchMedia';
import StoryViewer from '../StoryViewer';
import SiteRoutesProvider from '@/components/site/SiteRoutes';
import ViewerShell from '../ViewerShell';
import type { ViewerMode } from '../viewerContext';

// jsdom has HTMLDialogElement but no showModal() or close(), so these stand in:
// showModal() opens the dialog and focuses its first control, as the browser's
// dialog focusing steps do, and close() fires close once, as the browser does.
const router = vi.hoisted(() => ({ replace: vi.fn(), back: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), forward: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
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
const close = vi.fn(function (this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
});

beforeAll(() => {
    Object.assign(HTMLDialogElement.prototype, { showModal, close });
});

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    document.body.innerHTML = '';
});

const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const photoHref = (n: number) => `/work/fixture/photo/${id(n)}`;

/** A /media set for photo n, for the cases that need Zoom to work. */
function imageOf(n: number): ViewerImage {
    const ref = { photoId: id(n), assetRevision: `sha256-${'3'.repeat(64)}`, profileId: 'p_0123456789abcdef' };
    const variants = {} as ViewerImage['variants'];
    for (const width of VARIANT_WIDTHS) {
        variants[width] = {} as (typeof variants)[typeof width];
        for (const format of VARIANT_FORMATS) {
            const pixels = Number(width.slice(1));
            variants[width][format] = { url: mediaUrl(ref, width, format), width: pixels };
        }
    }
    return { width: 2400, height: 1600, assetRevision: ref.assetRevision, variants };
}

/** Photo n of 3 in the fixture series, with its neighbors, and no image unless asked, so nothing loads. */
function model(n: number, technical = true, withImage = false): PublishedViewerPhoto {
    return {
        catalogRevision: `rev_${'a'.repeat(64)}`,
        series: { id: 'ser_fixture', slug: 'fixture', title: 'Fixture series', accent: '#a0b0c0' },
        photo: {
            id: id(n),
            title: `Fixture title ${n}`,
            description: null,
            caption: null,
            alt: '',
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

/** The route's output for photo n: the photograph, keyed by its id, so a move remounts it as Next does. */
function photo(n: number, withImage = false) {
    const viewer = model(n, true, withImage);
    return (
        <StoryViewer
            key={viewer.photo.id}
            viewer={viewer}
            closeHref="/work/fixture"
            previousHref={viewer.previousPhotoId === null ? null : photoHref(n - 1)}
            nextHref={viewer.nextPhotoId === null ? null : photoHref(n + 1)}
            pendingCopy={null}
        />
    );
}

function renderShell(mode: ViewerMode, n: number) {
    const view = render(<ViewerShell mode={mode}>{photo(n)}</ViewerShell>);
    return { ...view, move: (to: number) => view.rerender(<ViewerShell mode={mode}>{photo(to)}</ViewerShell>) };
}

const root = () => document.querySelector<HTMLElement>('[data-surface="viewer"]');
const announcer = () => document.querySelector('[data-viewer-announcer]');
const step = (name: 'Previous photograph' | 'Next photograph') => screen.getByRole('button', { name });
const stage = () => document.querySelector<HTMLElement>('[data-viewer-stage]') as HTMLElement;

/**
 * A touchmove at `dx` across and `dy` down from the swipe's 200, 300 start, with `fingers` touches down, and whether the
 * page cancelled it. jsdom's TouchEvent wants real Touch objects, so this is a plain cancelable event with `touches` set.
 */
function touchMove(target: HTMLElement, dx: number, dy = 0, { fingers = 1, cancelable = true } = {}): boolean {
    const event = new Event('touchmove', { bubbles: true, cancelable });
    const touch = { clientX: 200 + dx, clientY: 300 + dy };
    Object.defineProperty(event, 'touches', { value: Array.from({ length: fingers }, () => touch) });
    target.dispatchEvent(event);
    return event.defaultPrevented;
}

/** One finger down on `target` and up `dx` across and `dy` down, as the root sees it once it holds the capture. */
function swipe(target: HTMLElement, dx: number, dy = 0) {
    fireEvent.pointerDown(target, { pointerId: 1, isPrimary: true, clientX: 200, clientY: 300 });
    fireEvent.pointerUp(target, { pointerId: 1, clientX: 200 + dx, clientY: 300 + dy });
}

describe('ViewerShell, on a page', () => {
    it('is a main with the controls rendered once, as buttons, with no dialog and an empty polite region', () => {
        renderShell('page', 2);
        expect(root()?.tagName).toBe('MAIN');
        expect(root()).toHaveAttribute('data-viewer-mode', 'page');
        expect(document.querySelectorAll('[data-surface]')).toHaveLength(1);
        expect(document.querySelectorAll('header')).toHaveLength(1);
        expect(document.querySelectorAll('[data-viewer-step]')).toHaveLength(2);
        // The shell's controls are direct children of the root, outside the photograph, so they outlive it.
        expect(document.querySelector('header')?.parentElement).toBe(root());
        expect(step('Next photograph').parentElement).toBe(root());
        expect(screen.queryByRole('link', { name: 'Next photograph' })).toBeNull();
        expect(screen.getByRole('link', { name: 'Close' })).toHaveAttribute('href', '/work/fixture');
        expect(document.querySelector('dialog')).toBeNull();
        expect(showModal).not.toHaveBeenCalled();
        expect(announcer()).toHaveAttribute('aria-live', 'polite');
        expect(announcer()).toHaveTextContent('');
    });

    it('moves through the router without scrolling, keeps focus on the same Next, and announces the new position', () => {
        const { move } = renderShell('page', 1);
        const next = step('Next photograph');
        next.focus();
        fireEvent.click(next);
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(2), { scroll: false });
        move(2);
        expect(step('Next photograph')).toBe(next);
        expect(document.activeElement).toBe(next);
        expect(document.querySelector('header')).toHaveTextContent('02 / 03');
        expect(announcer()).toHaveTextContent('Photograph 2 of 3');
        expect(router.back).not.toHaveBeenCalled();
    });

    it('stops at an end: the control stays focusable with aria-disabled, nothing moves, and the end is announced', () => {
        renderShell('page', 3);
        const next = step('Next photograph');
        expect(next).toHaveAttribute('aria-disabled', 'true');
        expect(next).toBeEnabled();
        next.focus();
        fireEvent.click(next);
        expect(router.replace).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(next);
        expect(announcer()).toHaveTextContent('Last photograph in Fixture series.');
        fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(2), { scroll: false });
    });

    it('announces the first photograph\'s end for Previous and Left', () => {
        renderShell('page', 1);
        fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
        expect(router.replace).not.toHaveBeenCalled();
        expect(announcer()).toHaveTextContent('First photograph in Fixture series.');
    });

    it('takes Left and Right from the document, but not with a modifier, and Escape does nothing on a page', () => {
        renderShell('page', 2);
        // A move takes the key, so it doesn't also scroll the page sideways (fireEvent returns false once the default is prevented).
        expect(fireEvent.keyDown(document.body, { key: 'ArrowRight' })).toBe(false);
        expect(router.replace).toHaveBeenLastCalledWith(photoHref(3), { scroll: false });
        router.replace.mockClear();
        for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
            expect(fireEvent.keyDown(document.body, { key: 'ArrowLeft', [modifier]: true })).toBe(true);
        }
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(router.replace).not.toHaveBeenCalled();
        expect(router.back).not.toHaveBeenCalled();
    });

    it('puts focus on the control for the direction moved when the photograph that held it leaves', () => {
        const { move } = renderShell('page', 1);
        const toggle = screen.getByRole('button', { name: 'Show technical details' });
        toggle.focus();
        fireEvent.keyDown(toggle, { key: 'ArrowRight' });
        expect(router.replace).toHaveBeenCalledOnce();
        move(2);
        expect(toggle.isConnected).toBe(false);
        expect(document.activeElement).toBe(step('Next photograph'));
    });

    it('puts focus on Previous when the move that lost it went back', () => {
        const { move } = renderShell('page', 2);
        const toggle = screen.getByRole('button', { name: 'Show technical details' });
        toggle.focus();
        fireEvent.keyDown(toggle, { key: 'ArrowLeft' });
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(1), { scroll: false });
        move(1);
        expect(toggle.isConnected).toBe(false);
        expect(document.activeElement).toBe(step('Previous photograph'));
    });

    it('resets Zoom on a move, and Zoom on a photo with nothing to enlarge stays focusable and does nothing', () => {
        const { move } = renderShell('page', 1);
        const zoom = screen.getByRole('button', { name: 'Zoom' });
        expect(zoom).toHaveAttribute('aria-disabled', 'true');
        zoom.focus();
        fireEvent.click(zoom);
        expect(zoom).toHaveAttribute('aria-pressed', 'false');
        move(2);
        expect(screen.getByRole('button', { name: 'Zoom' })).toBe(zoom);
        expect(document.activeElement).toBe(zoom);
    });

    it('drops Zoom when the photograph changes by any route, Back and Forward included, and when Next is pressed', () => {
        const view = render(<ViewerShell mode="page">{photo(1, true)}</ViewerShell>);
        const zoom = screen.getByRole('button', { name: 'Zoom' });
        fireEvent.click(zoom);
        expect(zoom).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('region', { name: 'Zoomed photograph' })).toBeInTheDocument();
        // A history traversal changes the photograph without Previous or Next.
        view.rerender(<ViewerShell mode="page">{photo(2, true)}</ViewerShell>);
        expect(zoom).toHaveAttribute('aria-pressed', 'false');
        expect(screen.queryByRole('region', { name: 'Zoomed photograph' })).toBeNull();
        fireEvent.click(zoom);
        fireEvent.click(step('Next photograph'));
        expect(zoom).toHaveAttribute('aria-pressed', 'false');
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(3), { scroll: false });
    });

    it('sends whole server HTML: the photograph renders the header and the steps until the shell takes them', () => {
        const html = renderToString(<ViewerShell mode="page">{photo(1)}</ViewerShell>);
        expect(html.match(/<header/g)).toHaveLength(1);
        expect(html).toMatch(/<h1[^>]*>Fixture series<\/h1>/);
        expect(html).toContain('01 / 03');
        // Before hydration, a direction with a photograph is a link, so it works without the shell.
        expect(html).toMatch(new RegExp(`<a(?=[^>]*aria-label="Next photograph")(?=[^>]*href="${photoHref(2)}")`));
        expect(html).toMatch(/<button(?=[^>]*aria-label="Previous photograph")(?=[^>]*aria-disabled="true")/);
        expect(html).toContain('data-viewer-announcer');
    });
});

describe('ViewerShell, as the modal', () => {
    const dialog = () => document.querySelector('dialog');

    it('opens a native modal dialog once, named by the header line, with focus moved inside onto Close', () => {
        renderShell('modal', 2);
        expect(showModal).toHaveBeenCalledOnce();
        expect(dialog()).toHaveAttribute('open');
        expect(dialog()).toHaveAttribute('data-surface', 'viewer');
        expect(dialog()).toHaveAttribute('data-viewer-mode', 'modal');
        expect(screen.getByRole('dialog')).toHaveAccessibleName('Fixture series Photograph 2 of 3');
        const closeButton = within(dialog() as HTMLElement).getByRole('button', { name: 'Close' });
        expect(document.activeElement).toBe(closeButton);
        // Close is a button in the modal; nothing in it links into the series.
        expect(within(dialog() as HTMLElement).queryByRole('link')).toBeNull();
    });

    it('closes with one Back however many cancel, close, and Close presses arrive', () => {
        renderShell('modal', 2);
        const cancel = new Event('cancel', { cancelable: true });
        dialog()?.dispatchEvent(cancel);
        expect(cancel.defaultPrevented).toBe(true);
        expect(router.back).toHaveBeenCalledOnce();
        // Chrome's quick second Escape fires close without a cancelable cancel.
        dialog()?.dispatchEvent(new Event('cancel'));
        dialog()?.dispatchEvent(new Event('close'));
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(router.back).toHaveBeenCalledOnce();
    });

    it('closes with one Back on a close event alone, and on Close alone', () => {
        const first = renderShell('modal', 2);
        dialog()?.dispatchEvent(new Event('close'));
        expect(router.back).toHaveBeenCalledOnce();
        first.unmount();
        router.back.mockClear();
        renderShell('modal', 2);
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(router.back).toHaveBeenCalledOnce();
    });

    it('takes arrows only inside the dialog, and moves keep focus on the same control', () => {
        const { move } = renderShell('modal', 1);
        const outside = document.createElement('button');
        document.body.append(outside);
        fireEvent.keyDown(outside, { key: 'ArrowRight' });
        expect(fireEvent.keyDown(document.documentElement, { key: 'ArrowRight' })).toBe(true);
        expect(router.replace).not.toHaveBeenCalled();
        const next = step('Next photograph');
        next.focus();
        expect(fireEvent.keyDown(next, { key: 'ArrowRight' })).toBe(false);
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(2), { scroll: false });
        move(2);
        expect(document.activeElement).toBe(next);
        expect(within(dialog() as HTMLElement).getByRole('status')).toHaveTextContent('Photograph 2 of 3');
        // The moves never open a second dialog or show it again.
        expect(showModal).toHaveBeenCalledOnce();
    });

    it('keeps #6\'s reserved box, adds no head preload, and keeps Previous, Next, and Close working when the file fails', () => {
        const preloads = () => document.head.querySelectorAll('link[rel="preload"][as="image"]').length;
        const before = preloads();
        const view = render(<ViewerShell mode="modal">{photo(2, true)}</ViewerShell>);
        const modal = dialog() as HTMLElement;
        // A modal open is a client render: the box is reserved from the record, and nothing goes in the head.
        expect(modal.querySelector('figure')?.getAttribute('style')).toContain('--ratio: 2400 / 1600');
        expect(preloads()).toBe(before);
        fireEvent.error(modal.querySelector('img') as HTMLImageElement);
        const missing = modal.querySelector('[data-photo="unavailable"]');
        expect(missing?.getAttribute('style')).toContain('--ratio: 2400 / 1600');
        const next = step('Next photograph');
        next.focus();
        fireEvent.click(next);
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(3), { scroll: false });
        view.rerender(<ViewerShell mode="modal">{photo(3, true)}</ViewerShell>);
        // The next photograph starts without the failure, focus stays on Next, and still no head link.
        expect(modal.querySelector('[data-photo="unavailable"]')).toBeNull();
        expect(document.activeElement).toBe(next);
        expect(preloads()).toBe(before);
        fireEvent.click(step('Previous photograph'));
        expect(router.replace).toHaveBeenLastCalledWith(photoHref(2), { scroll: false });
        fireEvent.click(within(modal).getByRole('button', { name: 'Close' }));
        expect(router.back).toHaveBeenCalledOnce();
    });

    it('takes arrows from the body while it\'s open, where focus lands after Tab past the end or a tap in WebKit', () => {
        const { move } = renderShell('modal', 1);
        (document.activeElement as HTMLElement).blur();
        expect(document.activeElement).toBe(document.body);
        expect(fireEvent.keyDown(document.body, { key: 'ArrowRight' })).toBe(false);
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(2), { scroll: false });
        move(2);
        // The move leaves focus where it was.
        expect(document.activeElement).toBe(document.body);
        // The dialog itself, which a click on the photograph focuses in Chromium, counts as inside.
        fireEvent.keyDown(dialog() as HTMLElement, { key: 'ArrowLeft' });
        expect(router.replace).toHaveBeenLastCalledWith(photoHref(1), { scroll: false });
        // A modifier still means the key is someone else's.
        router.replace.mockClear();
        expect(fireEvent.keyDown(document.body, { key: 'ArrowRight', altKey: true })).toBe(true);
        expect(router.replace).not.toHaveBeenCalled();
    });

    it('moves on a swipe in the modal too', () => {
        const { move } = renderShell('modal', 2);
        swipe(stage(), -80);
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(3), { scroll: false });
        move(3);
        swipe(stage(), 80);
        expect(router.replace).toHaveBeenLastCalledWith(photoHref(2), { scroll: false });
    });

    it('closes the dialog when it unmounts without asking for a Back, and leaves no listener', () => {
        const { unmount } = renderShell('modal', 2);
        const element = dialog() as HTMLDialogElement;
        unmount();
        expect(close).toHaveBeenCalledOnce();
        expect(element.hasAttribute('open')).toBe(false);
        // Its own close event, and any later one, ask for nothing.
        act(() => {
            element.dispatchEvent(new Event('cancel', { cancelable: true }));
            element.dispatchEvent(new Event('close'));
        });
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        swipe(element.querySelector<HTMLElement>('[data-viewer-stage]') ?? element, -80);
        expect(router.back).not.toHaveBeenCalled();
        expect(router.replace).not.toHaveBeenCalled();
    });
});

describe('ViewerShell, swipes', () => {
    const setPointerCapture = vi.fn();
    beforeAll(() => {
        // jsdom has pointer events but no pointer capture.
        Object.assign(HTMLElement.prototype, { setPointerCapture });
    });
    afterAll(() => {
        delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture;
    });

    it('moves on a horizontal swipe on the photograph: toward the left is Next, toward the right Previous', () => {
        const { move } = renderShell('page', 2);
        swipe(stage(), -48);
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(3), { scroll: false });
        move(3);
        expect(announcer()).toHaveTextContent('Photograph 3 of 3');
        router.replace.mockClear();
        swipe(stage(), 120, 20);
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(2), { scroll: false });
    });

    it('takes the pointer\'s capture on the root, which outlives the photograph, for a gesture it follows', () => {
        renderShell('page', 2);
        fireEvent.pointerDown(stage(), { pointerId: 4, isPrimary: true, clientX: 200, clientY: 300 });
        expect(setPointerCapture).toHaveBeenCalledExactlyOnceWith(4);
        expect(setPointerCapture.mock.contexts[0]).toBe(root());
        fireEvent.pointerUp(root() as HTMLElement, { pointerId: 4, clientX: 100, clientY: 300 });
        expect(router.replace).toHaveBeenCalledOnce();
        // A start off the photograph takes no capture.
        setPointerCapture.mockClear();
        fireEvent.pointerDown(step('Next photograph'), { pointerId: 5, isPrimary: true, clientX: 200, clientY: 300 });
        expect(setPointerCapture).not.toHaveBeenCalled();
    });

    it('still moves when the browser refuses the capture', () => {
        setPointerCapture.mockImplementationOnce(() => {
            throw new DOMException('No active pointer', 'NotFoundError');
        });
        renderShell('page', 2);
        swipe(stage(), -80);
        expect(router.replace).toHaveBeenCalledOnce();
    });

    it('leaves focus where it was: a swipe never moves keyboard focus', () => {
        const { move } = renderShell('page', 2);
        expect(document.activeElement).toBe(document.body);
        swipe(stage(), -80);
        move(3);
        expect(document.activeElement).toBe(document.body);
        // Nor does an arrow with nothing focused.
        fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
        move(2);
        expect(document.activeElement).toBe(document.body);
    });

    it('never moves on a short swipe, a mostly vertical one, a cancel, or a lost capture', () => {
        renderShell('page', 2);
        swipe(stage(), -47);
        swipe(stage(), 47);
        swipe(stage(), -60, 49);
        swipe(stage(), 5, 200);
        fireEvent.pointerDown(stage(), { pointerId: 1, isPrimary: true, clientX: 200, clientY: 300 });
        fireEvent.pointerCancel(stage(), { pointerId: 1 });
        fireEvent.pointerUp(stage(), { pointerId: 1, clientX: 50, clientY: 300 });
        fireEvent.pointerDown(stage(), { pointerId: 2, isPrimary: true, clientX: 200, clientY: 300 });
        (root() as HTMLElement).dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 2, bubbles: true }));
        fireEvent.pointerUp(stage(), { pointerId: 2, clientX: 50, clientY: 300 });
        expect(router.replace).not.toHaveBeenCalled();
        // And the next clean swipe still works.
        swipe(stage(), -80);
        expect(router.replace).toHaveBeenCalledOnce();
    });

    it('never moves on two fingers, a pinch, or a second finger on a control', () => {
        renderShell('page', 2);
        fireEvent.pointerDown(stage(), { pointerId: 1, isPrimary: true, clientX: 200, clientY: 300 });
        fireEvent.pointerDown(stage(), { pointerId: 2, isPrimary: false, clientX: 220, clientY: 300 });
        fireEvent.pointerUp(stage(), { pointerId: 2, clientX: 400, clientY: 300 });
        fireEvent.pointerUp(stage(), { pointerId: 1, clientX: 20, clientY: 300 });
        fireEvent.pointerDown(stage(), { pointerId: 3, isPrimary: true, clientX: 200, clientY: 300 });
        fireEvent.pointerDown(step('Previous photograph'), { pointerId: 4, isPrimary: false, clientX: 10, clientY: 10 });
        fireEvent.pointerUp(stage(), { pointerId: 3, clientX: 20, clientY: 300 });
        expect(router.replace).not.toHaveBeenCalled();
    });

    it('never moves on a swipe that starts off the photograph', () => {
        renderShell('page', 2);
        swipe(step('Next photograph'), -80);
        swipe(document.querySelector('header') as HTMLElement, -80);
        swipe(screen.getByRole('button', { name: 'Show technical details' }), -80);
        expect(router.replace).not.toHaveBeenCalled();
    });

    describe('claims a sideways touch from the browser, so it leaves no fling to swallow the next tap', () => {
        const down = (target: HTMLElement, pointerId = 1, isPrimary = true) =>
            fireEvent.pointerDown(target, { pointerId, isPrimary, clientX: 200, clientY: 300 });

        it('cancels every move of a touch that settles sideways, from the slop on, and still moves at the lift', () => {
            renderShell('page', 2);
            down(stage());
            expect(touchMove(stage(), -4, 1), 'under the slop').toBe(false);
            expect(touchMove(stage(), -12, 3)).toBe(true);
            // Settled: a later move that turns down is still the Viewer's, and so is one aimed outside the photograph.
            expect(touchMove(stage(), -20, 40)).toBe(true);
            expect(touchMove(root() as HTMLElement, -150, 0)).toBe(true);
            // A move the browser already made uncancelable is left alone.
            expect(touchMove(stage(), -150, 0, { cancelable: false })).toBe(false);
            fireEvent.pointerUp(root() as HTMLElement, { pointerId: 1, clientX: 50, clientY: 300 });
            expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(3), { scroll: false });
        });

        it('leaves a touch that settles downward to the browser to scroll, however it turns later', () => {
            renderShell('page', 2);
            down(stage());
            expect(touchMove(stage(), 3, -12)).toBe(false);
            expect(touchMove(stage(), -150, -14)).toBe(false);
        });

        it('settles each touch afresh', () => {
            renderShell('page', 2);
            down(stage());
            expect(touchMove(stage(), -30)).toBe(true);
            fireEvent.pointerUp(root() as HTMLElement, { pointerId: 1, clientX: 170, clientY: 300 });
            down(stage(), 2);
            expect(touchMove(stage(), 0, 30)).toBe(false);
            fireEvent.pointerUp(root() as HTMLElement, { pointerId: 2, clientX: 200, clientY: 330 });
            down(stage(), 3);
            expect(touchMove(stage(), 30)).toBe(true);
        });

        it('claims nothing it doesn\'t follow: a touch off the photograph, on the zoomed photograph, a second finger, after a lift or cancel', () => {
            render(<ViewerShell mode="page">{photo(2, true)}</ViewerShell>);
            down(step('Next photograph'));
            expect(touchMove(step('Next photograph'), -30)).toBe(false);
            fireEvent.pointerUp(step('Next photograph'), { pointerId: 1, clientX: 170, clientY: 300 });
            down(stage());
            expect(touchMove(stage(), -30, 0, { fingers: 2 })).toBe(false);
            down(stage(), 2, false);
            expect(touchMove(stage(), -40)).toBe(false);
            fireEvent.pointerUp(stage(), { pointerId: 2, clientX: 160, clientY: 300 });
            fireEvent.pointerUp(stage(), { pointerId: 1, clientX: 160, clientY: 300 });
            down(stage(), 3);
            fireEvent.pointerUp(root() as HTMLElement, { pointerId: 3, clientX: 200, clientY: 300 });
            expect(touchMove(stage(), -30)).toBe(false);
            down(stage(), 4);
            fireEvent.pointerCancel(stage(), { pointerId: 4 });
            expect(touchMove(stage(), -30)).toBe(false);
            const zoom = screen.getByRole('button', { name: 'Zoom' });
            fireEvent.click(zoom);
            down(stage(), 5);
            expect(touchMove(stage(), -30)).toBe(false);
            expect(router.replace).not.toHaveBeenCalled();
        });

        it('listens actively, since a passive listener can\'t cancel, on the root, and stops when it unmounts', () => {
            const add = vi.spyOn(HTMLElement.prototype, 'addEventListener');
            const remove = vi.spyOn(HTMLElement.prototype, 'removeEventListener');
            try {
                const { unmount } = renderShell('page', 2);
                // React adds its own passive touchmove listeners on the container, so only the root's count.
                const added = add.mock.calls.filter(([type], index) => type === 'touchmove' && add.mock.contexts[index] === root());
                expect(added).toHaveLength(1);
                expect(added[0][2]).toEqual({ passive: false });
                unmount();
                expect(remove.mock.calls.filter(([type, listener]) => type === 'touchmove' && listener === added[0][1])).toHaveLength(1);
            } finally {
                add.mockRestore();
                remove.mockRestore();
            }
        });
    });

    it('leaves a drag on the zoomed photograph to its scroll region, and drops a gesture when Zoom changes mid-way', () => {
        render(<ViewerShell mode="page">{photo(2, true)}</ViewerShell>);
        const zoom = screen.getByRole('button', { name: 'Zoom' });
        fireEvent.click(zoom);
        expect(zoom).toHaveAttribute('aria-pressed', 'true');
        swipe(stage(), -120);
        expect(router.replace).not.toHaveBeenCalled();
        // Started unzoomed, then zoomed before the lift.
        fireEvent.click(zoom);
        fireEvent.pointerDown(stage(), { pointerId: 1, isPrimary: true, clientX: 200, clientY: 300 });
        fireEvent.click(zoom);
        fireEvent.pointerUp(stage(), { pointerId: 1, clientX: 20, clientY: 300 });
        expect(router.replace).not.toHaveBeenCalled();
    });

    describe('on a pinch-zoomed page', () => {
        // jsdom has no visualViewport, so a stand-in carries the scale and fires resize as the browser does.
        const viewport = Object.assign(new EventTarget(), { scale: 1 });
        const pinch = (scale: number) =>
            act(() => {
                viewport.scale = scale;
                viewport.dispatchEvent(new Event('resize'));
            });
        beforeEach(() => {
            viewport.scale = 1;
            Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
        });
        afterEach(() => {
            Reflect.deleteProperty(window, 'visualViewport');
        });

        it('leaves a sideways drag to the browser to pan the page, and swipes again once it\'s back to scale 1', () => {
            renderShell('page', 2);
            expect(root()).not.toHaveAttribute('data-pinched');
            pinch(2);
            expect(root()).toHaveAttribute('data-pinched', '');
            swipe(stage(), -120);
            expect(router.replace).not.toHaveBeenCalled();
            // A hair over 1 still counts as pinched; back at 1, the stage swipes again.
            pinch(1.02);
            swipe(stage(), -120);
            expect(router.replace).not.toHaveBeenCalled();
            pinch(1);
            expect(root()).not.toHaveAttribute('data-pinched');
            swipe(stage(), -120);
            expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(3), { scroll: false });
        });

        it('reads the scale at the start, even before a resize reports it', () => {
            renderShell('page', 2);
            viewport.scale = 3;
            swipe(stage(), -120);
            expect(router.replace).not.toHaveBeenCalled();
        });

        it('drops a gesture in flight when the page is pinched mid-way', () => {
            renderShell('page', 2);
            fireEvent.pointerDown(stage(), { pointerId: 1, isPrimary: true, clientX: 200, clientY: 300 });
            pinch(1.5);
            fireEvent.pointerUp(root() as HTMLElement, { pointerId: 1, clientX: 20, clientY: 300 });
            expect(router.replace).not.toHaveBeenCalled();
        });

        it('stops listening to the viewport when it unmounts', () => {
            const remove = vi.spyOn(viewport, 'removeEventListener');
            const { unmount } = renderShell('page', 2);
            unmount();
            expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
            remove.mockRestore();
        });
    });

    it('drops a gesture in flight when the photograph changes by another route', () => {
        // From the first photograph to the second, which still has a Next, so a gesture that survived would move.
        const { move } = renderShell('page', 1);
        fireEvent.pointerDown(stage(), { pointerId: 1, isPrimary: true, clientX: 200, clientY: 300 });
        move(2);
        fireEvent.pointerUp(root() as HTMLElement, { pointerId: 1, clientX: 20, clientY: 300 });
        expect(router.replace).not.toHaveBeenCalled();
        expect(announcer()).toHaveTextContent('Photograph 2 of 3');
    });

    it('stops listening when it unmounts', () => {
        const { unmount } = renderShell('page', 2);
        const element = root() as HTMLElement;
        const stageElement = stage();
        fireEvent.pointerDown(stageElement, { pointerId: 1, isPrimary: true, clientX: 200, clientY: 300 });
        unmount();
        element.append(stageElement);
        document.body.append(element);
        fireEvent.pointerUp(stageElement, { pointerId: 1, clientX: 20, clientY: 300 });
        swipe(stageElement, -80);
        expect(router.replace).not.toHaveBeenCalled();
    });
});

describe('ViewerShell, double-tap', () => {
    const setPointerCapture = vi.fn();
    beforeAll(() => {
        Object.assign(HTMLElement.prototype, { setPointerCapture });
    });
    afterAll(() => {
        delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture;
    });

    /** A pointer event at `t` ms, as the browser stamps it, from a touch unless `pointerType` says otherwise. */
    function pointer(target: EventTarget, type: string, { pointerId = 1, x = 200, y = 300, t = 0, pointerType = 'touch', isPrimary = true } = {}) {
        const event = new PointerEvent(type, { pointerId, clientX: x, clientY: y, pointerType, isPrimary, bubbles: true, cancelable: true });
        Object.defineProperty(event, 'timeStamp', { value: t });
        act(() => {
            target.dispatchEvent(event);
        });
    }
    /** One tap at `t`, lifted 50 ms later. */
    function tap(target: EventTarget, t: number, options: { pointerId?: number; x?: number; y?: number; pointerType?: string } = {}) {
        pointer(target, 'pointerdown', { ...options, t });
        pointer(target, 'pointerup', { ...options, t: t + 50 });
    }
    function scrolled(target: EventTarget, t: number) {
        const event = new Event('scroll');
        Object.defineProperty(event, 'timeStamp', { value: t });
        act(() => {
            target.dispatchEvent(event);
        });
    }
    const zoom = () => screen.getByRole('button', { name: 'Zoom' });
    const renderZoomable = (mode: ViewerMode = 'page', n = 2) => {
        const view = render(<ViewerShell mode={mode}>{photo(n, true)}</ViewerShell>);
        return { ...view, move: (to: number) => view.rerender(<ViewerShell mode={mode}>{photo(to, true)}</ViewerShell>) };
    };

    it('toggles Zoom, as the button does, in both modes, and leaves focus where it was', () => {
        for (const mode of ['page', 'modal'] as const) {
            const { unmount } = renderZoomable(mode);
            const focused = document.activeElement;
            expect(zoom()).toHaveAttribute('aria-pressed', 'false');
            tap(stage(), 1000);
            expect(zoom()).toHaveAttribute('aria-pressed', 'false');
            tap(stage(), 1150);
            expect(zoom()).toHaveAttribute('aria-pressed', 'true');
            expect(stage()).toHaveAttribute('data-zoomed', 'true');
            expect(document.activeElement).toBe(focused);
            // Zoomed, the stage is the scroll region, and a double-tap on it zooms back out.
            tap(stage(), 2000);
            tap(stage(), 2150);
            expect(zoom()).toHaveAttribute('aria-pressed', 'false');
            expect(router.replace).not.toHaveBeenCalled();
            unmount();
        }
    });

    it('takes touch only: a mouse or a pen double-click on the photograph does nothing', () => {
        renderZoomable();
        for (const [index, pointerType] of ['mouse', 'pen'].entries()) {
            tap(stage(), 1000 * (index + 1), { pointerType });
            tap(stage(), 1000 * (index + 1) + 150, { pointerType });
            expect(zoom(), pointerType).toHaveAttribute('aria-pressed', 'false');
        }
    });

    it('does nothing for two taps too far apart in time or place, or off the photograph', () => {
        renderZoomable();
        // Zoom after each pair, so a pair that fired is never undone by the next one.
        tap(stage(), 1000);
        tap(stage(), 1351);
        expect(zoom(), 'too far apart in time').toHaveAttribute('aria-pressed', 'false');
        tap(stage(), 3000, { x: 200 });
        tap(stage(), 3150, { x: 225 });
        expect(zoom(), 'too far apart in place').toHaveAttribute('aria-pressed', 'false');
        tap(step('Next photograph'), 5000);
        tap(step('Next photograph'), 5150);
        expect(zoom(), 'on Next').toHaveAttribute('aria-pressed', 'false');
        tap(screen.getByRole('button', { name: 'Show technical details' }), 7000);
        tap(screen.getByRole('button', { name: 'Show technical details' }), 7150);
        expect(zoom(), 'on the technical toggle').toHaveAttribute('aria-pressed', 'false');
    });

    /** A touchend on `target`, as the browser sends it after the lift's pointerup, and whether the page cancelled it. */
    function touchEnd(target: EventTarget): boolean {
        const event = new Event('touchend', { bubbles: true, cancelable: true });
        act(() => {
            target.dispatchEvent(event);
        });
        return event.defaultPrevented;
    }

    it('cancels the touchend of the tap that fired, and only that one, so the second tap clicks nothing the new layout put under it', () => {
        renderZoomable();
        pointer(stage(), 'pointerdown', { t: 1000 });
        pointer(stage(), 'pointerup', { t: 1050 });
        expect(touchEnd(stage()), 'the first tap').toBe(false);
        pointer(stage(), 'pointerdown', { t: 1150 });
        pointer(stage(), 'pointerup', { t: 1200 });
        expect(zoom()).toHaveAttribute('aria-pressed', 'true');
        expect(touchEnd(stage()), 'the second tap, which zoomed in').toBe(true);
        // Zooming out, the finger can end over Previous or Next. Its touchend is cancelled too, wherever it lands.
        tap(stage(), 2000);
        expect(touchEnd(stage())).toBe(false);
        pointer(stage(), 'pointerdown', { t: 2150 });
        pointer(stage(), 'pointerup', { t: 2200 });
        expect(zoom()).toHaveAttribute('aria-pressed', 'false');
        expect(touchEnd(step('Next photograph')), 'the second tap, which zoomed out').toBe(true);
        expect(router.replace).not.toHaveBeenCalled();
        // The next touch's touchend is its own, and a fire whose touchend never came (a synthetic tap) is dropped at the next touch.
        pointer(stage(), 'pointerdown', { t: 3000 });
        pointer(stage(), 'pointerup', { t: 3050 });
        expect(touchEnd(step('Next photograph')), 'a later tap').toBe(false);
        tap(stage(), 4000);
        tap(stage(), 4150);
        tap(step('Next photograph'), 5000);
        expect(touchEnd(step('Next photograph')), 'a tap after a fire with no touchend').toBe(false);
    });

    describe('where it zooms', () => {
        const fitted = { left: 0, top: 100, width: 400, height: 250 };
        const zoomedIn = { left: 0, top: 60, width: 1920, height: 1280 };
        beforeEach(() => {
            vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
                const box = this.tagName === 'FIGURE' ? (this.closest('[data-zoomed]') ? zoomedIn : fitted) : { left: 0, top: 0, width: 0, height: 0 };
                return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box } as DOMRect;
            });
        });
        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('zooms in on the tapped place, which stays under the finger', () => {
            renderZoomable();
            // A quarter across and a fifth down the fitted photograph.
            tap(stage(), 1000, { x: 100, y: 150 });
            tap(stage(), 1150, { x: 100, y: 150 });
            expect(zoom()).toHaveAttribute('aria-pressed', 'true');
            // The zoomed photograph's same place, 480 and 256 px into it, scrolled back under 100, 150.
            expect(stage().scrollLeft).toBe(0 + 0.25 * 1920 - 100);
            expect(stage().scrollTop).toBe(60 + 0.2 * 1280 - 150);
        });

        it('leaves the Zoom button\'s framing as it was, and zooming out scrolls nothing', () => {
            renderZoomable();
            act(() => {
                zoom().click();
            });
            expect(zoom()).toHaveAttribute('aria-pressed', 'true');
            expect([stage().scrollLeft, stage().scrollTop]).toEqual([0, 0]);
            tap(stage(), 1000, { x: 100, y: 150 });
            tap(stage(), 1150, { x: 100, y: 150 });
            expect(zoom()).toHaveAttribute('aria-pressed', 'false');
            expect([stage().scrollLeft, stage().scrollTop]).toEqual([0, 0]);
        });

        it('doesn\'t take its own scroll to the place for a fling, so a double-tap right after zooms back out', () => {
            renderZoomable();
            tap(stage(), 1000, { x: 100, y: 150 });
            tap(stage(), 1150, { x: 100, y: 150 });
            // The region's scroll event arrives at the next frame, or later on a busy one.
            scrolled(stage(), 1216);
            scrolled(stage(), 1290);
            tap(stage(), 1300, { x: 100, y: 150 });
            tap(stage(), 1450, { x: 100, y: 150 });
            expect(zoom()).toHaveAttribute('aria-pressed', 'false');
            // A scroll that moves the region on from there, the visitor's pan, still quiets the taps.
            tap(stage(), 3000, { x: 100, y: 150 });
            tap(stage(), 3150, { x: 100, y: 150 });
            expect(zoom()).toHaveAttribute('aria-pressed', 'true');
            scrolled(stage(), 3216);
            stage().scrollLeft += 40;
            scrolled(stage(), 3400);
            tap(stage(), 3500, { x: 100, y: 150 });
            tap(stage(), 3650, { x: 100, y: 150 });
            expect(zoom()).toHaveAttribute('aria-pressed', 'true');
        });
    });

    it('counts a touch\'s travel on the way, so a touch that goes out and comes back is no tap', () => {
        renderZoomable();
        tap(stage(), 1000);
        pointer(stage(), 'pointerdown', { t: 1150 });
        pointer(stage(), 'pointermove', { x: 230, t: 1170 });
        pointer(stage(), 'pointerup', { x: 201, t: 1200 });
        expect(zoom()).toHaveAttribute('aria-pressed', 'false');
    });

    it('never fires on a swipe, and a double-tap never moves: a swipe right after it still moves', () => {
        const { move } = renderZoomable();
        // A swipe, then a tap within the settle: no Zoom, and the swipe moved.
        pointer(stage(), 'pointerdown', { t: 1000 });
        pointer(stage(), 'pointerup', { x: 100, t: 1080 });
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(3), { scroll: false });
        move(3);
        tap(stage(), 1200);
        tap(stage(), 1300);
        expect(zoom()).toHaveAttribute('aria-pressed', 'false');
        // Twice to zoom in and out, which never moves, and the next swipe does.
        router.replace.mockClear();
        tap(stage(), 3000);
        tap(stage(), 3150);
        expect(zoom()).toHaveAttribute('aria-pressed', 'true');
        tap(stage(), 4000);
        tap(stage(), 4150);
        expect(zoom()).toHaveAttribute('aria-pressed', 'false');
        expect(router.replace).not.toHaveBeenCalled();
        pointer(stage(), 'pointerdown', { t: 4300 });
        pointer(stage(), 'pointerup', { x: 300, t: 4380 });
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(2), { scroll: false });
    });

    it('quiets taps during and right after any scroll, so a tap that stops a fling never zooms', () => {
        renderZoomable();
        // The zoomed photograph's pan flings on after the lift; the page's scroll does too.
        for (const target of [stage(), document]) {
            scrolled(target, 1000);
            scrolled(target, 1016);
            tap(stage(), 1100);
            tap(stage(), 1250);
            expect(zoom()).toHaveAttribute('aria-pressed', 'false');
        }
        // A pair that starts once the scroll has been still for the settle zooms.
        tap(stage(), 1316);
        tap(stage(), 1450);
        expect(zoom()).toHaveAttribute('aria-pressed', 'true');
    });

    it('never fires on a cancel or on two fingers', () => {
        renderZoomable();
        tap(stage(), 1000);
        pointer(stage(), 'pointerdown', { t: 1100 });
        pointer(stage(), 'pointercancel', { t: 1120 });
        // Within the settle after the cancel, even a clean pair does nothing.
        tap(stage(), 1200);
        tap(stage(), 1300);
        pointer(stage(), 'pointerdown', { pointerId: 2, t: 1600 });
        pointer(stage(), 'pointerdown', { pointerId: 3, t: 1610, isPrimary: false });
        pointer(stage(), 'pointerup', { pointerId: 3, t: 1640 });
        pointer(stage(), 'pointerup', { pointerId: 2, t: 1650 });
        expect(zoom()).toHaveAttribute('aria-pressed', 'false');
    });

    it('does nothing where Zoom does nothing, on a photo with no usable set, so a swipe still moves after it', () => {
        renderShell('page', 2);
        tap(stage(), 1000);
        tap(stage(), 1150);
        expect(zoom()).toHaveAttribute('aria-pressed', 'false');
        expect(stage()).not.toHaveAttribute('data-zoomed');
        pointer(stage(), 'pointerdown', { t: 2000 });
        pointer(stage(), 'pointerup', { x: 100, t: 2080 });
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(3), { scroll: false });
    });

    it('never pairs a tap on one photograph with a tap on the next', () => {
        const { move } = renderZoomable('page', 1);
        tap(stage(), 1000);
        move(2);
        tap(stage(), 1150);
        expect(zoom()).toHaveAttribute('aria-pressed', 'false');
    });

    describe('on a pinch-zoomed page', () => {
        const viewport = Object.assign(new EventTarget(), { scale: 2 });
        beforeEach(() => {
            Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
        });
        afterEach(() => {
            Reflect.deleteProperty(window, 'visualViewport');
        });

        it('leaves a double-tap to the browser', () => {
            renderZoomable();
            tap(stage(), 1000);
            tap(stage(), 1150);
            expect(zoom()).toHaveAttribute('aria-pressed', 'false');
        });
    });

    it('stops listening when it unmounts, the document\'s scroll listener included', () => {
        const removeFromDocument = vi.spyOn(document, 'removeEventListener');
        const { unmount } = renderZoomable();
        const removeFromRoot = vi.spyOn(root() as HTMLElement, 'removeEventListener');
        unmount();
        expect(removeFromDocument).toHaveBeenCalledWith('scroll', expect.any(Function), { capture: true });
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'touchend']) {
            expect(removeFromRoot).toHaveBeenCalledWith(type, expect.any(Function));
        }
        removeFromDocument.mockRestore();
    });
});

describe('ViewerShell, the photograph follows the finger (9a)', () => {
    const setPointerCapture = vi.fn();
    const fetchMock = vi.fn();
    beforeAll(() => {
        Object.assign(HTMLElement.prototype, { setPointerCapture });
    });
    afterAll(() => {
        delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture;
    });
    beforeEach(() => {
        fetchMock.mockImplementation(async (url: string) => {
            const photoId = /photos\/([^/?]+)/.exec(url)?.[1] ?? '';
            const n = Number(photoId.slice(-12));
            return new Response(JSON.stringify({ revisionId: `rev_${'a'.repeat(64)}`, photoId, image: imageOf(n), accent: `#00000${n}` }), { status: 200 });
        });
        vi.stubGlobal('fetch', fetchMock);
        // jsdom lays nothing out: a 390 px stage, as on a phone.
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(390);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    function renderWithImages(mode: ViewerMode, n: number) {
        const view = render(<ViewerShell mode={mode}>{photo(n, true)}</ViewerShell>);
        return { ...view, move: (to: number) => view.rerender(<ViewerShell mode={mode}>{photo(to, true)}</ViewerShell>) };
    }
    function pointer(target: EventTarget, type: string, { x = 200, y = 300, t = 0 } = {}) {
        const event = new PointerEvent(type, { pointerId: 1, clientX: x, clientY: y, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true });
        Object.defineProperty(event, 'timeStamp', { value: t });
        act(() => {
            target.dispatchEvent(event);
        });
    }
    const track = () => document.querySelector<HTMLElement>('[data-viewer-track]') as HTMLElement;
    const peeks = () => [...document.querySelectorAll('[data-viewer-peek]')].map((element) => element.getAttribute('data-viewer-peek'));
    const counter = () => document.querySelector('header p > span[aria-hidden="true"]')?.textContent;
    /** Lets the peek fetches resolve and their state land. */
    const settle = () => act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it('asks for no neighbor on a load, and for both, in the revision shown, once a finger goes down on the photograph', async () => {
        renderWithImages('page', 2);
        await settle();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(peeks()).toEqual([]);
        pointer(stage(), 'pointerdown');
        pointer(stage(), 'pointerup');
        await settle();
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
            `/api/catalog/series/fixture/photos/${id(1)}?revision=rev_${'a'.repeat(64)}`,
            `/api/catalog/series/fixture/photos/${id(3)}?revision=rev_${'a'.repeat(64)}`,
        ]);
        // The neighbors peek in beside the photograph, hidden from assistive technology and never a figure.
        expect(peeks()).toEqual(['previous', 'next']);
        for (const element of document.querySelectorAll('[data-viewer-peek]')) expect(element).toHaveAttribute('aria-hidden', 'true');
        expect(stage().querySelectorAll('figure')).toHaveLength(1);
        expect(stage().querySelectorAll('[data-viewer-peek] img[alt=""]')).toHaveLength(2);
        // Once each: another touch asks again for nothing.
        pointer(stage(), 'pointerdown');
        pointer(stage(), 'pointerup');
        await settle();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("asks #16's preview for the neighbors inside it, never the public endpoint", async () => {
        const basePath = `/curation/preview/rev_${'b'.repeat(64)}/site`;
        render(
            <SiteRoutesProvider basePath={basePath}>
                <ViewerShell mode="page">{photo(2, true)}</ViewerShell>
            </SiteRoutesProvider>,
        );
        pointer(stage(), 'pointerdown');
        pointer(stage(), 'pointerup');
        await settle();
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
            `${basePath}/api/catalog/series/fixture/photos/${id(1)}?revision=rev_${'a'.repeat(64)}`,
            `${basePath}/api/catalog/series/fixture/photos/${id(3)}?revision=rev_${'a'.repeat(64)}`,
        ]);
    });

    it('follows a sideways drag 1:1 from the claim, and meets the rubber band at the first photograph', () => {
        const { unmount } = renderWithImages('page', 2);
        pointer(stage(), 'pointerdown', { x: 200, t: 0 });
        pointer(root() as HTMLElement, 'pointermove', { x: 188, t: 16 });
        expect(track().style.transform).toBe('translate3d(0px, 0, 0)');
        pointer(root() as HTMLElement, 'pointermove', { x: 100, t: 200 });
        expect(track().style.transform).toBe('translate3d(-88px, 0, 0)');
        pointer(root() as HTMLElement, 'pointermove', { x: 300, t: 400 });
        expect(track().style.transform).toBe('translate3d(112px, 0, 0)');
        // Lifted slowly short of the rule, and with no Web Animations in jsdom, it's back at rest at once.
        pointer(root() as HTMLElement, 'pointerup', { x: 230, t: 800 });
        expect(router.replace).not.toHaveBeenCalled();
        expect(track().style.transform).toBe('');
        unmount();
        renderWithImages('page', 1);
        pointer(stage(), 'pointerdown', { x: 200, t: 0 });
        pointer(root() as HTMLElement, 'pointermove', { x: 212, t: 16 });
        pointer(root() as HTMLElement, 'pointermove', { x: 382, t: 200 });
        const offset = Number(/\((-?[\d.]+)px/.exec(track().style.transform)?.[1]);
        expect(offset).toBeCloseTo((1 - 1 / ((170 * 0.55) / 390 + 1)) * 390, 6);
        // Past 48 toward the end: it announces the end and slides back.
        pointer(root() as HTMLElement, 'pointerup', { x: 382, t: 600 });
        expect(router.replace).not.toHaveBeenCalled();
        expect(announcer()).toHaveTextContent('First photograph in Fixture series.');
        expect(track().style.transform).toBe('');
    });

    it('moves on a short fast flick', () => {
        renderWithImages('page', 2);
        pointer(stage(), 'pointerdown', { x: 200, t: 0 });
        pointer(root() as HTMLElement, 'pointermove', { x: 188, t: 8 });
        pointer(root() as HTMLElement, 'pointermove', { x: 175, t: 24 });
        pointer(root() as HTMLElement, 'pointerup', { x: 170, t: 32 });
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(3), { scroll: false });
    });

    it('shows the move in the counter and the accent rules at the lift, and remembers the latest press until the photograph arrives', async () => {
        const { move } = renderWithImages('page', 2);
        pointer(stage(), 'pointerdown', { x: 200, t: 0 });
        await settle();
        pointer(root() as HTMLElement, 'pointermove', { x: 150, t: 100 });
        pointer(root() as HTMLElement, 'pointerup', { x: 100, t: 400 });
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(3), { scroll: false });
        expect(counter()).toBe('03 / 03');
        // The root carries the accent for both rules, the arriving photograph's from its peek.
        expect(root()?.style.getPropertyValue('--cc-accent')).toBe('#000003');
        expect(document.querySelector<HTMLElement>('[data-viewer-photo]')?.style.getPropertyValue('--cc-accent')).toBe('');
        // While it's on its way, a key and a control ask for nothing yet, and a swipe can't start.
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        fireEvent.click(step('Previous photograph'));
        pointer(stage(), 'pointerdown', { x: 200, t: 600 });
        pointer(root() as HTMLElement, 'pointermove', { x: 150, t: 650 });
        pointer(root() as HTMLElement, 'pointerup', { x: 100, t: 700 });
        expect(router.replace).toHaveBeenCalledOnce();
        // It arrives, and the latest press, Previous, runs from there.
        move(3);
        expect(announcer()).toHaveTextContent('Photograph 3 of 3');
        expect(router.replace).toHaveBeenCalledTimes(2);
        expect(router.replace).toHaveBeenLastCalledWith(photoHref(2), { scroll: false });
        expect(counter()).toBe('02 / 03');
        // Once that one arrives there's nothing left to run.
        move(2);
        expect(router.replace).toHaveBeenCalledTimes(2);
        fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
        expect(router.replace).toHaveBeenLastCalledWith(photoHref(1), { scroll: false });
    });

    it('runs a remembered press toward an end as the end, once the photograph arrives', () => {
        const { move } = renderWithImages('page', 2);
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        expect(router.replace).toHaveBeenCalledOnce();
        move(3);
        expect(router.replace).toHaveBeenCalledOnce();
        expect(announcer()).toHaveTextContent('Last photograph in Fixture series.');
    });

    it('starts no swipe while a move by a key or a control is on its way: no follow, no settle, and one move', () => {
        const { move } = renderWithImages('page', 2);
        for (const press of [() => fireEvent.keyDown(document.body, { key: 'ArrowRight' }), () => fireEvent.click(step('Next photograph'))]) {
            router.replace.mockClear();
            press();
            expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(3), { scroll: false });
            // The other way, as a quick swipe back after a tap on Next goes.
            pointer(stage(), 'pointerdown', { x: 200, t: 0 });
            pointer(root() as HTMLElement, 'pointermove', { x: 215, t: 16 });
            pointer(root() as HTMLElement, 'pointermove', { x: 320, t: 100 });
            expect(track().style.transform).toBe('');
            expect(track()).not.toHaveAttribute('data-moving');
            pointer(root() as HTMLElement, 'pointerup', { x: 320, t: 120 });
            expect(router.replace).toHaveBeenCalledOnce();
            expect(counter()).toBe('03 / 03');
            move(3);
            expect(counter()).toBe('03 / 03');
            expect(track().style.transform).toBe('');
            expect(router.replace).toHaveBeenCalledOnce();
            move(2);
        }
    });

    it('drops a held gesture when a key or a control moves: the photograph slides back and follows no more', () => {
        renderWithImages('page', 2);
        pointer(stage(), 'pointerdown', { x: 200, t: 0 });
        pointer(root() as HTMLElement, 'pointermove', { x: 188, t: 16 });
        pointer(root() as HTMLElement, 'pointermove', { x: 140, t: 100 });
        expect(track().style.transform).toBe('translate3d(-48px, 0, 0)');
        fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(1), { scroll: false });
        // With no Web Animations in jsdom, the slide back lands at once.
        expect(track().style.transform).toBe('');
        pointer(root() as HTMLElement, 'pointermove', { x: 60, t: 200 });
        expect(track().style.transform).toBe('');
        pointer(root() as HTMLElement, 'pointerup', { x: 40, t: 220 });
        expect(router.replace).toHaveBeenCalledOnce();
        expect(counter()).toBe('01 / 03');
    });

    it('slides the photograph back when a second finger lands mid-drag, and neither lift moves', () => {
        renderWithImages('page', 2);
        const second = (type: string, x: number) => {
            const event = new PointerEvent(type, { pointerId: 2, clientX: x, clientY: 320, pointerType: 'touch', isPrimary: false, bubbles: true, cancelable: true });
            act(() => {
                stage().dispatchEvent(event);
            });
        };
        pointer(stage(), 'pointerdown', { x: 200, t: 0 });
        pointer(root() as HTMLElement, 'pointermove', { x: 188, t: 16 });
        pointer(root() as HTMLElement, 'pointermove', { x: 114, t: 100 });
        expect(track().style.transform).toBe('translate3d(-74px, 0, 0)');
        second('pointerdown', 260);
        expect(track().style.transform).toBe('');
        expect(track()).not.toHaveAttribute('data-moving');
        pointer(root() as HTMLElement, 'pointermove', { x: 60, t: 200 });
        expect(track().style.transform).toBe('');
        second('pointerup', 300);
        pointer(root() as HTMLElement, 'pointerup', { x: 40, t: 220 });
        expect(router.replace).not.toHaveBeenCalled();
        expect(counter()).toBe('02 / 03');
    });

    it('prefetches the neighbors\' pages in full once the Viewer is idle, and asks for no image or peek', async () => {
        const { move } = renderWithImages('page', 2);
        expect(router.prefetch).not.toHaveBeenCalled();
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 250));
        });
        expect(router.prefetch.mock.calls).toEqual([
            [photoHref(3), { kind: 'full' }],
            [photoHref(1), { kind: 'full' }],
        ]);
        expect(fetchMock).not.toHaveBeenCalled();
        move(3);
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 250));
        });
        // At the last photograph there's only the one before.
        expect(router.prefetch).toHaveBeenLastCalledWith(photoHref(2), { kind: 'full' });
        expect(router.prefetch).toHaveBeenCalledTimes(3);
    });

    it('keeps the peeks by revision: after a publish, a neighbor is asked for again in the new one', async () => {
        const revised = republished;
        const view = renderWithImages('page', 2);
        pointer(stage(), 'pointerdown');
        pointer(stage(), 'pointerup');
        await settle();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        view.rerender(<ViewerShell mode="page">{revised(3)}</ViewerShell>);
        await settle();
        // Photograph 2 was shown, but in the revision before, so it's asked for in the new one.
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(fetchMock.mock.calls[2][0]).toBe(`/api/catalog/series/fixture/photos/${id(2)}?revision=rev_${'b'.repeat(64)}`);
        expect(peeks()).toEqual(['previous']);
    });

    /** Photo n in a revision published after the fixture's. */
    const republished = (n: number) => {
        const viewer = { ...model(n, true, true), catalogRevision: `rev_${'b'.repeat(64)}` };
        return (
            <StoryViewer key={viewer.photo.id} viewer={viewer} closeHref="/work/fixture" previousHref={n > 1 ? photoHref(n - 1) : null} nextHref={n < 3 ? photoHref(n + 1) : null} pendingCopy={null} />
        );
    };

    it('drops the pages it prefetched when a peek says another revision is served, once for both neighbors', async () => {
        // The fixture's revision is the one before: the endpoint serves the republished one.
        const served = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation(async (url: string) => (url.includes(`rev_${'a'.repeat(64)}`) ? new Response('{}', { status: 409 }) : served(url)));
        const view = renderWithImages('page', 2);
        await settle();
        expect(router.refresh).not.toHaveBeenCalled();
        pointer(stage(), 'pointerdown');
        pointer(stage(), 'pointerup');
        await settle();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(router.refresh).toHaveBeenCalledOnce();
        expect(peeks()).toEqual([]);
        // The refresh renders the same photograph in the revision served, which asks for nothing more to be dropped,
        // and its neighbors peek in from that one.
        view.rerender(<ViewerShell mode="page">{republished(2)}</ViewerShell>);
        await settle();
        expect(router.refresh).toHaveBeenCalledOnce();
        expect(fetchMock).toHaveBeenCalledTimes(4);
        expect(peeks()).toEqual(['previous', 'next']);
    });

    it('drops the pages it prefetched when a move lands in another revision, and not on a move in the same one', async () => {
        const view = renderWithImages('page', 1);
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        view.rerender(<ViewerShell mode="page">{photo(2, true)}</ViewerShell>);
        await settle();
        expect(router.refresh).not.toHaveBeenCalled();
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        view.rerender(<ViewerShell mode="page">{republished(3)}</ViewerShell>);
        await settle();
        expect(router.refresh).toHaveBeenCalledOnce();
        fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
        view.rerender(<ViewerShell mode="page">{republished(2)}</ViewerShell>);
        await settle();
        expect(router.refresh).toHaveBeenCalledOnce();
    });

    it('waits for a move on its way to land before it drops the prefetched pages for a peek\'s 409', async () => {
        let answer: (response: Response) => void = () => undefined;
        fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (answer = resolve)));
        const { move } = renderWithImages('page', 3);
        pointer(stage(), 'pointerdown');
        pointer(stage(), 'pointerup');
        expect(fetchMock).toHaveBeenCalledOnce();
        fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
        answer(new Response('{}', { status: 409 }));
        await settle();
        expect(router.refresh).not.toHaveBeenCalled();
        move(2);
        await settle();
        expect(router.refresh).toHaveBeenCalledOnce();
    });

    it('shows the arriving photograph\'s ends on the arrows while its page is on its way, as the counter does', () => {
        const { move } = renderWithImages('page', 1);
        const previous = () => step('Previous photograph');
        const next = () => step('Next photograph');
        expect(previous()).toHaveAttribute('aria-disabled', 'true');
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        expect(counter()).toBe('02 / 03');
        expect(previous()).not.toHaveAttribute('aria-disabled');
        expect(next()).not.toHaveAttribute('aria-disabled');
        move(2);
        fireEvent.click(next());
        expect(counter()).toBe('03 / 03');
        expect(next()).toHaveAttribute('aria-disabled', 'true');
        expect(previous()).not.toHaveAttribute('aria-disabled');
        // A press of the end it shows is remembered like any other, and announces the end once the photograph is in.
        fireEvent.click(next());
        move(3);
        expect(next()).toHaveAttribute('aria-disabled', 'true');
        expect(announcer()).toHaveTextContent('Last photograph in Fixture series.');
        expect(router.replace).toHaveBeenCalledTimes(2);
    });

    describe('a move by a control or a key slides in', () => {
        const slides: { target: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions; progress: number | null }[] = [];
        beforeEach(() => {
            slides.length = 0;
            Object.assign(Element.prototype, {
                animate(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
                    const entry = { target: this, keyframes, options, progress: 0 as number | null };
                    if ('transform' in keyframes[0]) slides.push(entry);
                    return { currentTime: 0, onfinish: null, cancel: vi.fn(), effect: { getComputedTiming: () => ({ progress: entry.progress }) } } as unknown as Animation;
                },
            });
        });
        afterEach(() => {
            delete (Element.prototype as Partial<Element>).animate;
        });
        const parse = (easing: string | undefined) => (/^cubic-bezier\(([^)]+)\)$/.exec(easing ?? '')?.[1] ?? '').split(',').map(Number);
        const from = (slide: (typeof slides)[number]) => Number(/\((-?[\d.]+)px/.exec(String(slide.keyframes[0].transform))?.[1]);
        /** One stage and the gap: the 390 px stage and the 16 px between it and a neighbor. */
        const PITCH = 406;

        it('from the side it comes from, opening at the mockup\'s 1.5 slope and easing to its stop in 280 ms', () => {
            for (const [press, to, side] of [
                [() => fireEvent.keyDown(document.body, { key: 'ArrowRight' }), 3, 1],
                [() => fireEvent.click(step('Next photograph')), 3, 1],
                [() => fireEvent.keyDown(document.body, { key: 'ArrowLeft' }), 1, -1],
                [() => fireEvent.click(step('Previous photograph')), 1, -1],
            ] as const) {
                const { move, unmount } = renderWithImages('page', 2);
                slides.length = 0;
                press();
                move(to);
                expect(slides).toHaveLength(1);
                const [slide] = slides;
                expect(slide.target).toBe(track());
                expect(slide.keyframes).toEqual([{ transform: `translate3d(${side * PITCH}px, 0, 0)` }, { transform: 'translate3d(0px, 0, 0)' }]);
                expect(slide.options.duration).toBe(280);
                const [x1, y1, x2, y2] = parse(slide.options.easing as string);
                expect(y1 / x1).toBeCloseTo(1.5, 2);
                expect([x2, y2]).toEqual([0.36, 1]);
                unmount();
            }
        });

        it('from where the photograph it leaves is, when that one is still sliding in, so a remembered press never jumps', () => {
            const { move } = renderWithImages('page', 1);
            fireEvent.keyDown(document.body, { key: 'ArrowRight' });
            fireEvent.keyDown(document.body, { key: 'ArrowRight' });
            move(2);
            // Photograph 2 slides in, and the remembered press is on its way to 3.
            expect(router.replace).toHaveBeenLastCalledWith(photoHref(3), { scroll: false });
            const second = slides.at(-1)!;
            expect(from(second)).toBe(PITCH);
            // A quarter of the way in, by its curve: photograph 2 still sits most of a stage to the right when 3's page lands.
            second.progress = 0.25;
            move(3);
            const third = slides.at(-1)!;
            // Photograph 2 sits a stage left of 3 on the new track, so the track starts a stage right of where 2 was.
            expect(from(third)).toBeCloseTo(0.75 * PITCH + PITCH, 6);
            expect(third.keyframes[1]).toEqual({ transform: 'translate3d(0px, 0, 0)' });
            const [x1, y1] = parse(third.options.easing as string);
            expect(y1 / x1).toBeCloseTo(1.5, 2);
            // A press back the other way while 3 is still sliding in starts a stage left of where 3 is.
            third.progress = 0.5;
            fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
            move(2);
            expect(from(slides.at(-1)!)).toBeCloseTo(0.5 * from(third) - PITCH, 6);
            // One that had landed starts a whole stage over, as from rest.
            slides.at(-1)!.progress = null;
            fireEvent.keyDown(document.body, { key: 'ArrowRight' });
            move(3);
            expect(from(slides.at(-1)!)).toBe(PITCH);
        });
    });

    describe('the words under the photograph', () => {
        const animations: { target: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions; animation: { currentTime: number; onfinish: (() => void) | null; cancel: () => void } }[] = [];
        beforeEach(() => {
            animations.length = 0;
            Object.assign(Element.prototype, {
                animate(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
                    const animation = { currentTime: 0, onfinish: null, cancel: vi.fn() };
                    animations.push({ target: this, keyframes, options, animation });
                    return animation as unknown as Animation;
                },
            });
        });
        afterEach(() => {
            delete (Element.prototype as Partial<Element>).animate;
        });
        const reading = () => document.querySelector('[data-viewer-reading]') as HTMLElement;
        const leaving = () => document.querySelector('[data-viewer-leaving]') as HTMLElement;
        const fadesOf = (element: Element) => animations.filter((entry) => entry.target === element || element.contains(entry.target)).filter((entry) => 'opacity' in entry.keyframes[0]);

        it('keeps the old words, whole, until the new photograph arrives, then fades them out over 70 ms and the new ones in over 130', () => {
            const { move } = renderWithImages('page', 2);
            expect(leaving()).toBeEmptyDOMElement();
            expect(leaving()).toHaveAttribute('aria-hidden', 'true');
            fireEvent.keyDown(document.body, { key: 'ArrowRight' });
            // On its way, however long the page takes: the old words stay as they are, and nothing fades.
            expect(within(reading()).getByText('Fixture title 2')).toBeInTheDocument();
            expect(fadesOf(reading())).toEqual([]);
            expect(leaving()).toBeEmptyDOMElement();
            move(3);
            // The page is in: the old words cover the new ones and fade out, the new ones fade in after them.
            expect(within(reading()).getByText('Fixture title 3')).toBeInTheDocument();
            expect(leaving()).toHaveTextContent('Fixture title 2');
            expect(leaving().querySelector('[id]')).toBeNull();
            expect(leaving().firstElementChild).toHaveAttribute('inert');
            expect(leaving().querySelector('[data-viewer-reading]')).toBeNull();
            const out = fadesOf(leaving());
            expect(out).toHaveLength(1);
            expect(out[0].keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
            expect(out[0].options).toMatchObject({ duration: 70 });
            const fadesIn = fadesOf(reading());
            expect(fadesIn.length).toBe(reading().children.length);
            for (const entry of fadesIn) {
                expect(entry.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
                expect(entry.options).toMatchObject({ duration: 130, delay: 70, fill: 'backwards' });
            }
            // Its fade done, the copy goes.
            act(() => out[0].animation.onfinish?.());
            expect(leaving()).toBeEmptyDOMElement();
        });

        it('under reduced motion changes the words in place when the photograph arrives, with no fade', () => {
            setPrefersReducedMotion(true);
            const { move } = renderWithImages('page', 2);
            fireEvent.keyDown(document.body, { key: 'ArrowRight' });
            move(3);
            expect(within(reading()).getByText('Fixture title 3')).toBeInTheDocument();
            expect(leaving()).toBeEmptyDOMElement();
            expect(animations).toEqual([]);
        });
    });

    it('asks for each new photograph\'s neighbors once a finger has touched one, and the one it left peeks back in', async () => {
        const { move } = renderWithImages('page', 1);
        pointer(stage(), 'pointerdown');
        pointer(stage(), 'pointerup');
        await settle();
        expect(fetchMock).toHaveBeenCalledOnce();
        move(2);
        await settle();
        // Photograph 1 was shown, so only 3 is asked for.
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[1][0]).toContain(id(3));
        expect(peeks()).toEqual(['previous', 'next']);
    });

    it('under reduced motion follows nothing, asks for no neighbor, and changes the counter when the photograph arrives', async () => {
        setPrefersReducedMotion(true);
        const { move } = renderWithImages('page', 2);
        pointer(stage(), 'pointerdown', { x: 200, t: 0 });
        pointer(root() as HTMLElement, 'pointermove', { x: 150, t: 100 });
        expect(track().style.transform).toBe('');
        pointer(root() as HTMLElement, 'pointerup', { x: 100, t: 400 });
        await settle();
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(3), { scroll: false });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(counter()).toBe('02 / 03');
        move(3);
        expect(counter()).toBe('03 / 03');
        expect(peeks()).toEqual([]);
        expect(document.querySelectorAll('[data-moving]')).toHaveLength(0);
    });

    it('asks for no neighbor when the fetch fails, and still follows and moves', async () => {
        fetchMock.mockRejectedValue(new TypeError('offline'));
        renderWithImages('page', 2);
        pointer(stage(), 'pointerdown', { x: 200, t: 0 });
        await settle();
        pointer(root() as HTMLElement, 'pointermove', { x: 188, t: 16 });
        pointer(root() as HTMLElement, 'pointermove', { x: 150, t: 100 });
        expect(track().style.transform).toBe('translate3d(-38px, 0, 0)');
        pointer(root() as HTMLElement, 'pointerup', { x: 100, t: 400 });
        expect(router.replace).toHaveBeenCalledOnce();
        expect(peeks()).toEqual([]);
    });

    it('never follows a double-tap: the photograph stays at rest and Zoom toggles', () => {
        renderWithImages('page', 2);
        for (const t of [1000, 1150]) {
            pointer(stage(), 'pointerdown', { t });
            pointer(root() as HTMLElement, 'pointermove', { x: 203, t: t + 20 });
            expect(track().style.transform).toBe('');
            pointer(root() as HTMLElement, 'pointerup', { x: 203, t: t + 50 });
        }
        expect(screen.getByRole('button', { name: 'Zoom' })).toHaveAttribute('aria-pressed', 'true');
        expect(router.replace).not.toHaveBeenCalled();
    });
});
