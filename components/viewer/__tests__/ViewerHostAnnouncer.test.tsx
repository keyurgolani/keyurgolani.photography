import { act, fireEvent, render, screen } from '@testing-library/react';
import { AppRouterAnnouncer } from 'next/dist/client/components/app-router-announcer';
import { useLayoutEffect, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeLog, installAnnouncerLog, readAnnouncerLog, spokenOf } from '@/e2e/support/announcerLog';
import { quietRouteAnnouncer } from '../routeAnnouncer';
import ViewerHost from '../ViewerHost';

// #255: Back to the series from the modal, when the photograph that opened it is gone (a publish dropped it, #178),
// focuses the series heading, which says the page's name. Next 16.4.2's route announcer must not say it too. A Close
// that focuses the photograph's entry is a page change like any other, which the announcer speaks (#247). These run
// the real announcer, placed as Next's app router places it: a sibling after the page.

const navigation = vi.hoisted(() => ({ pathname: '/work/fixture', children: [] as string[], modal: ['(__SLOT__)', '__DEFAULT__'] as string[] }));
vi.mock('next/navigation', () => ({
    usePathname: () => navigation.pathname,
    useSelectedLayoutSegments: (key = 'children') => (key === 'modal' ? navigation.modal : navigation.children),
}));
// The shell stands in as a marked box that holds the announcer's host hidden while it's mounted, from a layout effect,
// as ViewerShell does (#247).
vi.mock('../viewerShellLoader', () => {
    const Shell = ({ mode, children }: { mode: string; children: ReactNode }) => {
        useLayoutEffect(() => quietRouteAnnouncer(), []);
        return (
            <div data-testid="shell" data-mode={mode} data-surface="viewer">
                {children}
            </div>
        );
    };
    const settled = { status: 'fulfilled', value: Shell, then: (resolve: (value: typeof Shell) => void) => (resolve(Shell), settled) };
    return { loadViewerShell: () => settled, preloadViewerShell: () => undefined, viewerShellLoaded: () => true, cancelViewerShellLoad: () => undefined };
});

beforeAll(() => {
    // A click on a link would try to navigate jsdom.
    document.addEventListener('click', (event) => event.preventDefault());
});

beforeEach(() => {
    Object.assign(navigation, { pathname: '/work/fixture', children: [], modal: ['(__SLOT__)', '__DEFAULT__'] });
    document.title = '';
});

afterEach(() => {
    document.body.innerHTML = '';
});

const SERIES_TITLE = 'Fixture series · Site';
const PHOTO_TITLE = 'Fixture series, photograph 1 of 2 · Site';
const GONE_TITLE = 'This photograph is no longer here · Site';
const ABOUT_TITLE = 'About · Site';

// Keyed, as the sequence's entries are, so the entry for a goes with its photograph rather than becoming b's.
const SERIES = (
    <article>
        <h1 id="series-title">Fixture series</h1>
        <a key="a" id="photo-a" href="/work/fixture/photo/a">
            Entry a
        </a>
        <a key="b" id="photo-b" href="/work/fixture/photo/b">
            Entry b
        </a>
    </article>
);
/** The series rendered again under the modal without the photograph that opened it (a publish dropped it). */
const WITHOUT_A = (
    <article>
        <h1 id="series-title">Fixture series</h1>
        <a key="b" id="photo-b" href="/work/fixture/photo/b">
            Entry b
        </a>
    </article>
);

/** Next's app router as far as the announcer goes: the layout's ViewerHost, then AppRouterAnnouncer after it. */
function App({ route, page, modal }: { route: string; page: ReactNode; modal: ReactNode }) {
    return (
        <>
            <ViewerHost modal={modal}>{page}</ViewerHost>
            <AppRouterAnnouncer tree={[route, {}] as never} />
        </>
    );
}

const host = () => document.querySelector('next-route-announcer');
const said = () => host()?.shadowRoot?.textContent ?? null;
/** Lets a MutationObserver's records arrive. */
const settle = () => act(async () => await Promise.resolve());

/** The series page, then entry a opened in the modal: the photograph's title written while the shell held the host. */
async function openA(page: ReactNode = SERIES) {
    document.title = SERIES_TITLE;
    const view = render(<App route="series" page={page} modal={null} />);
    await settle();
    fireEvent.click(screen.getByText('Entry a'));
    Object.assign(navigation, { pathname: '/work/fixture/photo/a', modal: ['(__SLOT__)', '(.)photo', 'a'] });
    document.title = PHOTO_TITLE;
    view.rerender(<App route="photo-a" page={page} modal={<p>Photo a</p>} />);
    await settle();
    expect(host()).toHaveAttribute('aria-hidden', 'true');
    return view;
}

/** The modal closes (Close, Escape, Back, or Back to the series): the series page's tree and title. */
function close(view: ReturnType<typeof render>, page: ReactNode) {
    Object.assign(navigation, { pathname: '/work/fixture', modal: ['(__SLOT__)', '__DEFAULT__'] });
    document.title = SERIES_TITLE;
    view.rerender(<App route="series" page={page} modal={null} />);
}

let logs = 0;
function record() {
    const key = `host-${++logs}`;
    installAnnouncerLog(key);
    return async () => {
        await settle();
        return readAnnouncerLog(key);
    };
}

describe('ViewerHost and Next\'s route announcer (#255)', () => {
    it('Back to the series onto the heading, when the photograph is gone: the heading says the name, the announcer doesn\'t, and nothing stays hidden', async () => {
        const view = await openA();
        // A publish dropped photograph a: the revision check's refresh shows ViewerUnavailable over the series without it.
        document.title = GONE_TITLE;
        view.rerender(<App route="photo-a-gone" page={WITHOUT_A} modal={<p>This photograph is no longer here</p>} />);
        await settle();
        const read = record();
        close(view, WITHOUT_A);
        const steps = await read();
        expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Fixture series' }));
        expect(spokenOf(steps), describeLog(steps)).toEqual([]);
        expect(host()).not.toHaveAttribute('aria-hidden');
        // No alert with the page's name beside the focused heading.
        expect(said()).not.toContain('Fixture series');
    });

    it('then a page change that focuses no heading is heard', async () => {
        const view = await openA();
        view.rerender(<App route="photo-a-gone" page={WITHOUT_A} modal={<p>This photograph is no longer here</p>} />);
        await settle();
        close(view, WITHOUT_A);
        await settle();
        const read = record();
        Object.assign(navigation, { pathname: '/about' });
        document.title = ABOUT_TITLE;
        view.rerender(<App route="about" page={<main>About</main>} modal={null} />);
        const steps = await read();
        expect(spokenOf(steps), describeLog(steps)).toEqual([ABOUT_TITLE]);
        expect(host()).not.toHaveAttribute('aria-hidden');
    });

    it('a Close that focuses the photograph\'s entry is heard as before (#247)', async () => {
        const view = await openA();
        const read = record();
        close(view, SERIES);
        const steps = await read();
        expect(document.activeElement).toBe(screen.getByText('Entry a'));
        expect(spokenOf(steps), describeLog(steps)).toEqual([SERIES_TITLE]);
        expect(host()).not.toHaveAttribute('aria-hidden');
    });

    it('a move in the modal is the Viewer\'s alone, as before (#247)', async () => {
        const view = await openA();
        const read = record();
        Object.assign(navigation, { pathname: '/work/fixture/photo/b', modal: ['(__SLOT__)', '(.)photo', 'b'] });
        document.title = 'Fixture series, photograph 2 of 2 · Site';
        view.rerender(<App route="photo-b" page={SERIES} modal={<p>Photo b</p>} />);
        const steps = await read();
        expect(spokenOf(steps), describeLog(steps)).toEqual([]);
        expect(host()).toHaveAttribute('aria-hidden', 'true');
    });
});
