import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ViewerHost from '../ViewerHost';

// The host only picks a mode and restores focus, so the shell stands in as a marked box.
const navigation = vi.hoisted(() => ({ pathname: '/work/fixture', children: [] as string[], modal: ['(__SLOT__)', '__DEFAULT__'] as string[] }));
vi.mock('next/navigation', () => ({
    usePathname: () => navigation.pathname,
    useSelectedLayoutSegments: (key = 'children') => (key === 'modal' ? navigation.modal : navigation.children),
}));
// The host reads the shell from viewerShellLoader. Here the load is a thenable that settles as it's asked and never
// rejects (as the real loader never does), so `use` renders the stand-in at once. Each ask is counted, and `loaded`
// says whether the shell is in.
const loader = vi.hoisted(() => ({ asks: 0, loaded: false, cancels: 0 }));
vi.mock('../viewerShellLoader', () => {
    const Shell = ({ mode, children }: { mode: string; children: ReactNode }) => (
        <div data-testid="shell" data-mode={mode} data-surface="viewer">
            {children}
        </div>
    );
    const settled = { status: 'fulfilled', value: Shell, then: (resolve: (value: typeof Shell) => void) => (resolve(Shell), settled) };
    return {
        loadViewerShell: () => settled,
        preloadViewerShell: () => {
            loader.asks++;
        },
        viewerShellLoaded: () => loader.loaded,
        cancelViewerShellLoad: () => {
            loader.cancels++;
        },
    };
});

beforeAll(() => {
    // A click on a link would try to navigate jsdom.
    document.addEventListener('click', (event) => event.preventDefault());
});

beforeEach(() => {
    Object.assign(loader, { asks: 0, loaded: false, cancels: 0 });
    Object.assign(navigation, { pathname: '/work/fixture', children: [], modal: ['(__SLOT__)', '__DEFAULT__'] });
});

afterEach(() => {
    document.body.innerHTML = '';
});

const SERIES = (
    <main>
        <a id="photo-a" href="/work/fixture/photo/a">
            Entry a
        </a>
        <a id="photo-b" href="/work/fixture/photo/b">
            Entry b
        </a>
        <a id="about" href="/about">
            About
        </a>
    </main>
);
const PHOTO = <p>Photo content</p>;
const MODAL = <p>Modal content</p>;

function host(children: ReactNode = SERIES, modal: ReactNode = MODAL) {
    return <ViewerHost modal={modal}>{children}</ViewerHost>;
}

function openModal(photo: string) {
    Object.assign(navigation, { pathname: `/work/fixture/photo/${photo}`, children: [], modal: ['(__SLOT__)', '(.)photo', photo] });
}

function closeModal() {
    Object.assign(navigation, { pathname: '/work/fixture', children: [], modal: ['(__SLOT__)', '__DEFAULT__'] });
}

describe('ViewerHost', () => {
    it('passes the series page through untouched when no photo is open', () => {
        render(host());
        expect(screen.queryByTestId('shell')).toBeNull();
        expect(screen.getByText('Entry a')).toBeInTheDocument();
        expect(screen.queryByText('Modal content')).toBeNull();
    });

    it('wraps a photo page in the page shell, and shows a move\'s intercepted photo there, never a modal', () => {
        Object.assign(navigation, { pathname: '/work/fixture/photo/a', children: ['photo', 'a'] });
        const view = render(host(PHOTO));
        expect(screen.getByTestId('shell')).toHaveAttribute('data-mode', 'page');
        expect(screen.getByTestId('shell')).toHaveTextContent('Photo content');
        const shell = screen.getByTestId('shell');
        // A move from a photo page is intercepted into the slot: the same page shell shows it in place of the child.
        Object.assign(navigation, { pathname: '/work/fixture/photo/b', modal: ['(__SLOT__)', '(.)photo', 'b'] });
        view.rerender(host(PHOTO));
        expect(screen.getAllByTestId('shell')).toEqual([shell]);
        expect(shell).toHaveAttribute('data-mode', 'page');
        expect(shell).toHaveTextContent('Modal content');
        expect(shell).not.toHaveTextContent('Photo content');
    });

    it('opens an intercepted photo over the series in the modal shell, and keeps the series mounted under it', () => {
        const view = render(host());
        const entry = screen.getByText('Entry a');
        openModal('a');
        view.rerender(host());
        expect(screen.getByTestId('shell')).toHaveAttribute('data-mode', 'modal');
        expect(screen.getByTestId('shell')).toHaveTextContent('Modal content');
        expect(screen.getByText('Entry a')).toBe(entry);
    });

    it('shows no modal for a photo the slot kept after a navigation it didn\'t match', () => {
        Object.assign(navigation, { pathname: '/work/fixture', modal: ['(__SLOT__)', '(.)photo', 'b'] });
        render(host());
        expect(screen.queryByTestId('shell')).toBeNull();
    });

    it('puts focus back on the entry that opened the modal when it closes, after any number of moves', () => {
        const view = render(host());
        const entry = screen.getByText('Entry a');
        fireEvent.click(entry);
        openModal('a');
        view.rerender(host());
        // Moves inside the modal, with focus somewhere in it.
        const inside = document.createElement('button');
        screen.getByTestId('shell').append(inside);
        inside.focus();
        openModal('b');
        view.rerender(host());
        openModal('c');
        view.rerender(host());
        closeModal();
        view.rerender(host());
        expect(screen.queryByTestId('shell')).toBeNull();
        expect(document.activeElement).toBe(entry);
    });

    it('finds the opener by id when the series page rendered it again', () => {
        const view = render(host());
        fireEvent.click(screen.getByText('Entry b'));
        openModal('b');
        view.rerender(host());
        // A new series tree, with a new node for the same entry.
        const fresh = (
            <main>
                <a id="photo-b" href="/work/fixture/photo/b">
                    Entry b again
                </a>
            </main>
        );
        view.rerender(host(fresh));
        closeModal();
        view.rerender(host(fresh));
        expect(document.activeElement).toBe(screen.getByText('Entry b again'));
    });

    // A link to a photograph that isn't its series entry, like the cover, beside the entries that carry `photo-<photoId>`.
    const WITH_COVER = (
        <main>
            <a href="/work/fixture/photo/a">Cover a</a>
            <a id="photo-a" href="/work/fixture/photo/a">
                Entry a
            </a>
            <a id="photo-b" href="/work/fixture/photo/b">
                Entry b
            </a>
        </main>
    );

    it('keeps focus on the link that opened the modal while it\'s still in the document, even when it isn\'t the entry', () => {
        const view = render(host(WITH_COVER));
        const cover = screen.getByText('Cover a');
        fireEvent.click(cover);
        openModal('a');
        view.rerender(host(WITH_COVER));
        closeModal();
        view.rerender(host(WITH_COVER));
        expect(document.activeElement).toBe(cover);
    });

    it('focuses the entry of the photograph that opened the modal, not the one shown last, once the opener left the document', () => {
        const view = render(host(WITH_COVER));
        const cover = screen.getByText('Cover a');
        fireEvent.click(cover);
        openModal('a');
        view.rerender(host(WITH_COVER));
        openModal('b');
        view.rerender(host(WITH_COVER));
        // The series re-rendered its entries under the modal (Show more, #6), so the link that was clicked is gone.
        // A new root element, so React mounts new nodes rather than reusing the old ones in place.
        const fresh = (
            <section>
                <a id="photo-a" href="/work/fixture/photo/a">
                    Entry a again
                </a>
                <a id="photo-b" href="/work/fixture/photo/b">
                    Entry b again
                </a>
            </section>
        );
        view.rerender(host(fresh));
        expect(cover.isConnected).toBe(false);
        closeModal();
        view.rerender(host(fresh));
        expect(document.activeElement).toBe(screen.getByText('Entry a again'));
    });

    it('records only a plain click on a Viewer link outside the Viewer', () => {
        const view = render(host());
        const entry = screen.getByText('Entry a');
        fireEvent.click(entry);
        // A modified click opens a tab, a link that isn't a Viewer URL opens nothing here, and a link inside the Viewer is a move.
        fireEvent.click(screen.getByText('Entry b'), { metaKey: true });
        fireEvent.click(screen.getByText('About'));
        fireEvent.click(screen.getByText('Entry b'), { button: 1 });
        openModal('a');
        view.rerender(host(SERIES, <a href="/work/fixture/photo/c">Inside link</a>));
        fireEvent.click(screen.getByText('Inside link'));
        closeModal();
        view.rerender(host());
        expect(document.activeElement).toBe(entry);
    });

    it.each(['altKey', 'ctrlKey', 'metaKey', 'shiftKey'])('doesn\'t take a click with %s as the opener', (modifier) => {
        const view = render(host());
        const entry = screen.getByText('Entry a');
        fireEvent.click(entry);
        // The modified click opens a tab or a window, so the plain click before it stays the opener.
        fireEvent.click(screen.getByText('Entry b'), { [modifier]: true });
        openModal('a');
        view.rerender(host());
        closeModal();
        view.rerender(host());
        expect(document.activeElement).toBe(entry);
    });

    it('forgets the opener once focus is back on it, so a later modal nothing opened moves no focus', () => {
        const view = render(host());
        const entry = screen.getByText('Entry a');
        fireEvent.click(entry);
        openModal('a');
        view.rerender(host());
        closeModal();
        view.rerender(host());
        expect(document.activeElement).toBe(entry);
        entry.blur();
        // A second open with no click on the series, for example Forward back into the Viewer.
        openModal('b');
        view.rerender(host());
        closeModal();
        view.rerender(host());
        expect(document.activeElement).toBe(document.body);
    });

    it('moves no focus when nothing opened the modal from the series', () => {
        const view = render(host());
        openModal('a');
        view.rerender(host());
        closeModal();
        view.rerender(host());
        expect(document.activeElement).toBe(document.body);
    });
    it("loads the shell and its styles ahead of an open, on a photo link's intent and once the browser is idle", () => {
        const idle: (() => void)[] = [];
        vi.stubGlobal('requestIdleCallback', (task: () => void) => idle.push(task));
        vi.stubGlobal('cancelIdleCallback', () => {});
        const view = render(host());
        try {
            expect(loader.asks, 'nothing at first').toBe(0);
            fireEvent.pointerOver(screen.getByText('About'));
            expect(loader.asks, 'not for a link that opens no photo').toBe(0);
            fireEvent.pointerOver(screen.getByText('Entry a'));
            fireEvent.focusIn(screen.getByText('Entry b'));
            fireEvent.touchStart(screen.getByText('Entry a'));
            expect(loader.asks, 'a pointer over, focus on, and a touch on a photo link').toBe(3);
            idle.forEach((task) => task());
            expect(loader.asks, 'and once idle').toBe(4);
        } finally {
            view.unmount();
            vi.unstubAllGlobals();
        }
    });

    it('asks for nothing ahead on a photo page, which renders the shell itself', () => {
        Object.assign(navigation, { pathname: '/work/fixture/photo/a', children: ['photo', 'a'] });
        render(host(PHOTO));
        const asked = loader.asks;
        fireEvent.pointerOver(screen.getByText('Photo content'));
        expect(loader.asks).toBe(asked);
    });
    it('stops listening for intent once the shell is in, and stops a load still waiting when the series goes', () => {
        const view = render(host());
        loader.loaded = true;
        fireEvent.pointerOver(screen.getByText('Entry a'));
        loader.loaded = false;
        fireEvent.pointerOver(screen.getByText('Entry b'));
        expect(loader.asks, 'the listeners went with the first intent after the load').toBe(0);
        view.unmount();
        expect(loader.cancels).toBe(1);
    });

    it('marks the photo link busy while its open waits on the shell, and clears it once the modal opens', () => {
        const view = render(host());
        const entry = screen.getByText('Entry a');
        fireEvent.click(entry);
        expect(entry).toHaveAttribute('aria-busy', 'true');
        expect(entry.style.cursor).toBe('progress');
        // A second photo clicked meanwhile takes the mark over.
        const other = screen.getByText('Entry b');
        fireEvent.click(other);
        expect(entry).not.toHaveAttribute('aria-busy');
        expect(other).toHaveAttribute('aria-busy', 'true');
        openModal('b');
        view.rerender(host());
        expect(other).not.toHaveAttribute('aria-busy');
        expect(other.style.cursor).toBe('');
        // With the shell in, a click marks nothing.
        closeModal();
        view.rerender(host());
        loader.loaded = true;
        fireEvent.click(entry);
        expect(entry).not.toHaveAttribute('aria-busy');
    });
});
