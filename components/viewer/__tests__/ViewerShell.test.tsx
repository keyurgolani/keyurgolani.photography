import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishedViewerPhoto, ViewerImage } from '@/lib/catalog/projections/viewer';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '@/lib/identity/variants';
import { mediaUrl } from '@/lib/media/url';
import StoryViewer from '../StoryViewer';
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
        renderShell('modal', 2);
        swipe(stage(), -80);
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(3), { scroll: false });
        swipe(stage(), 80);
        expect(router.replace).toHaveBeenLastCalledWith(photoHref(1), { scroll: false });
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
