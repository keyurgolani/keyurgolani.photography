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
vi.mock('../ViewerShell', () => ({
    default: ({ mode, children }: { mode: string; children: ReactNode }) => (
        <div data-testid="shell" data-mode={mode} data-surface="viewer">
            {children}
        </div>
    ),
}));

beforeAll(() => {
    // A click on a link would try to navigate jsdom.
    document.addEventListener('click', (event) => event.preventDefault());
});

beforeEach(() => {
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
});
