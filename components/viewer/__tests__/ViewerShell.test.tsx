import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishedViewerPhoto } from '@/lib/catalog/projections/viewer';
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

/** Photo n of 3 in the fixture series, with its neighbors, and no image so nothing loads. */
function model(n: number, technical = true): PublishedViewerPhoto {
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
            image: null,
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
function photo(n: number) {
    const viewer = model(n);
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
        fireEvent.keyDown(document.body, { key: 'ArrowRight' });
        expect(router.replace).toHaveBeenLastCalledWith(photoHref(3), { scroll: false });
        router.replace.mockClear();
        for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
            fireEvent.keyDown(document.body, { key: 'ArrowLeft', [modifier]: true });
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
        expect(router.replace).not.toHaveBeenCalled();
        const next = step('Next photograph');
        next.focus();
        fireEvent.keyDown(next, { key: 'ArrowRight' });
        expect(router.replace).toHaveBeenCalledExactlyOnceWith(photoHref(2), { scroll: false });
        move(2);
        expect(document.activeElement).toBe(next);
        expect(within(dialog() as HTMLElement).getByRole('status')).toHaveTextContent('Photograph 2 of 3');
        // The moves never open a second dialog or show it again.
        expect(showModal).toHaveBeenCalledOnce();
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
        expect(router.back).not.toHaveBeenCalled();
        expect(router.replace).not.toHaveBeenCalled();
    });
});
