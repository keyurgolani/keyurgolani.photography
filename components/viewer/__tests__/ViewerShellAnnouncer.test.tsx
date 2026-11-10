import { act, render } from '@testing-library/react';
import { AppRouterAnnouncer } from 'next/dist/client/components/app-router-announcer';
import { Component, StrictMode, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishedViewerPhoto } from '@/lib/catalog/projections/viewer';
import StoryViewer from '../StoryViewer';
import ViewerShell from '../ViewerShell';
import ViewerUnavailable from '../ViewerUnavailable';
import { describeLog, installAnnouncerLog, readAnnouncerLog, shownHolding, spokenOf } from '@/test/helpers/announcerLog';

// #247: each Viewer move is a client-side navigation, so Next 16.4.2's route announcer
// (next/dist/client/components/app-router-announcer.js) writes the new title into its assertive alert, and on a
// photograph's own page a screen reader hears the move twice. While the Viewer is mounted it keeps the announcer's
// host, <next-route-announcer>, aria-hidden, and takes that off as it goes, before the announcer writes the next page's
// title. These run the real announcer, placed as Next's app router places it: a sibling after the page.

const router = vi.hoisted(() => ({ replace: vi.fn(), back: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), forward: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router, useParams: () => ({ slug: 'fixture', photoId: id(2) }) }));
vi.mock('next/link', () => ({
    default: ({ href, replace, prefetch, children, ...rest }: { href: string; replace?: boolean; prefetch?: boolean | null; children: ReactNode }) => (
        <a href={href} data-replace={String(Boolean(replace))} data-prefetch={String(prefetch)} {...rest}>
            {children}
        </a>
    ),
}));

beforeAll(() => {
    Object.assign(HTMLDialogElement.prototype, {
        showModal(this: HTMLDialogElement) {
            this.setAttribute('open', '');
        },
        close(this: HTMLDialogElement) {
            if (!this.hasAttribute('open')) return;
            this.removeAttribute('open');
            this.dispatchEvent(new Event('close'));
        },
    });
});

beforeEach(() => {
    vi.clearAllMocks();
    document.title = '';
});

afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const photoHref = (n: number) => `/work/fixture/photo/${id(n)}`;
const SERIES_TITLE = 'Fixture series · Site';
const titleOf = (n: number) => `Fixture series, photograph ${n} of 3 · Site`;

function model(n: number): PublishedViewerPhoto {
    return {
        catalogRevision: `rev_${'a'.repeat(64)}`,
        series: { id: 'ser_fixture', slug: 'fixture', title: 'Fixture series', accent: '#a0b0c0' },
        photo: {
            id: id(n),
            title: null,
            description: null,
            caption: null,
            alt: '',
            descriptionPending: false,
            namedByPlace: false,
            image: null,
            shareImage: null,
            accent: null,
            technical: {},
        },
        position: n,
        total: 3,
        previousPhotoId: n > 1 ? id(n - 1) : null,
        nextPhotoId: n < 3 ? id(n + 1) : null,
    };
}

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

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() {
        return { failed: true };
    }
    render() {
        return this.state.failed ? <p>Something went wrong</p> : this.props.children;
    }
}

function Throws(): never {
    throw new Error('The catalog is unavailable');
}

/**
 * Next's app router as far as the announcer goes: the page, then AppRouterAnnouncer after it (app-router.js), whose
 * effect reads document.title each time the router's tree changes. `route` stands in for that tree.
 */
function App({ route, page }: { route: string; page: ReactNode }) {
    return (
        <>
            {page}
            <AppRouterAnnouncer tree={[route, {}] as never} />
        </>
    );
}

/** A navigation: the new page's title, then the router's commit of its tree. */
function navigate(view: ReturnType<typeof render>, route: string, title: string, page: ReactNode) {
    document.title = title;
    view.rerender(<App route={route} page={page} />);
}

const host = () => document.querySelector('next-route-announcer');
const said = () => host()?.shadowRoot?.textContent ?? null;
/** Lets a MutationObserver's records arrive. */
const settle = () => act(async () => await Promise.resolve());

/**
 * Every change to the announcer's host attributes and its shadow root's text, in the order they happened: one
 * observer for both, so its records keep the order of the DOM changes. Each change reads its own value from the
 * records' old values (test/helpers/announcerLog.ts), not the value at the callback, so the release emptying the
 * stale title (#255) and Next's next write, in one task, stay two changes.
 */
let watches = 0;
function watch() {
    const key = `watch-${++watches}`;
    installAnnouncerLog(key);
    return {
        order: () =>
            readAnnouncerLog(key)
                .filter((step) => step.kind !== 'focus')
                .map((step) => (step.kind === 'hidden' ? `aria-hidden=${step.hidden ? 'true' : 'null'}` : `text=${step.text}`)),
    };
}

describe('Next\'s route announcer while the Viewer is mounted (#247)', () => {
    it('on a direct load, marks the host Next makes after the Viewer mounted, keeps it marked across moves, and unmarks it before Close\'s title', async () => {
        document.title = titleOf(1);
        const page = (n: number) => <ViewerShell mode="page">{photo(n)}</ViewerShell>;
        const view = render(<App route="1" page={page(1)} />);
        await settle();
        // The Viewer's effects ran first: Next's announcer makes its host in its own effect, after the page's.
        expect(host()).not.toBeNull();
        expect(host()).toHaveAttribute('aria-hidden', 'true');
        expect(said()).toBe('');

        navigate(view, '2', titleOf(2), page(2));
        await settle();
        // Next writes the title regardless: the mark is what keeps a screen reader from saying it.
        expect(said()).toBe(titleOf(2));
        expect(host()).toHaveAttribute('aria-hidden', 'true');
        expect(document.querySelectorAll('next-route-announcer')).toHaveLength(1);

        const changes = watch();
        // Close: the link to the series, which drops the Viewer in the same commit as the series page's tree.
        navigate(view, 'series', SERIES_TITLE, <main>Series page</main>);
        await settle();
        expect(host()).not.toHaveAttribute('aria-hidden');
        expect(said()).toBe(SERIES_TITLE);
        // The mark went before the series page's title was written, so that title is spoken.
        const order = changes.order();
        expect(order.indexOf('aria-hidden=null')).toBeGreaterThanOrEqual(0);
        expect(order.indexOf('aria-hidden=null')).toBeLessThan(order.indexOf(`text=${SERIES_TITLE}`));
    });

    it('in the modal, marks the host the series page already has, before the open\'s title lands, and unmarks it on Close', async () => {
        document.title = SERIES_TITLE;
        const series = <main>Series page</main>;
        const view = render(<App route="series" page={series} />);
        await settle();
        expect(host()).not.toHaveAttribute('aria-hidden');
        const changes = watch();
        const page = (n: number) => (
            <>
                {series}
                <ViewerShell mode="modal">{photo(n)}</ViewerShell>
            </>
        );
        navigate(view, '2', titleOf(2), page(2));
        await settle();
        expect(order(changes.order())).toEqual(['aria-hidden=true', `text=${titleOf(2)}`]);

        navigate(view, '3', titleOf(3), page(3));
        await settle();
        expect(said()).toBe(titleOf(3));
        expect(host()).toHaveAttribute('aria-hidden', 'true');

        const closing = watch();
        navigate(view, 'series', SERIES_TITLE, series);
        await settle();
        expect(host()).not.toHaveAttribute('aria-hidden');
        expect(said()).toBe(SERIES_TITLE);
        // The stale title emptied while the host is still hidden (#255), then the mark off, then Next's write.
        expect(order(closing.order())).toEqual(['text=', 'aria-hidden=null', `text=${SERIES_TITLE}`]);
    });

    it('keeps the mark while ViewerUnavailable is its child, and takes it off when the Viewer goes', async () => {
        const view = render(<App route="2" page={<ViewerShell mode="page">{photo(2)}</ViewerShell>} />);
        await settle();
        navigate(view, 'gone', 'This photograph is no longer here · Site', <ViewerShell mode="page"><ViewerUnavailable /></ViewerShell>);
        await settle();
        expect(host()).toHaveAttribute('aria-hidden', 'true');
        navigate(view, 'series', SERIES_TITLE, <main>Series page</main>);
        await settle();
        expect(host()).not.toHaveAttribute('aria-hidden');
        expect(said()).toBe(SERIES_TITLE);
    });

    it('never leaves the mark behind when an error takes the Viewer\'s place', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const page = (child: ReactNode) => <Boundary>{child}</Boundary>;
        const view = render(<App route="2" page={page(<ViewerShell mode="page">{photo(2)}</ViewerShell>)} />);
        await settle();
        expect(host()).toHaveAttribute('aria-hidden', 'true');
        // A move whose route throws: the error boundary above the Viewer renders the error page in its place.
        navigate(view, 'error', 'Error · Site', page(<ViewerShell mode="page"><Throws /></ViewerShell>));
        await settle();
        expect(document.body).toHaveTextContent('Something went wrong');
        expect(host()).not.toHaveAttribute('aria-hidden');
        expect(said()).toBe('Error · Site');
    });

    it('keeps the mark through Strict Mode\'s second run of its effects, and takes it off at unmount', async () => {
        const view = render(
            <StrictMode>
                <App route="2" page={<ViewerShell mode="page">{photo(2)}</ViewerShell>} />
            </StrictMode>,
        );
        await settle();
        expect(host()).toHaveAttribute('aria-hidden', 'true');
        view.rerender(
            <StrictMode>
                <App route="series" page={<main>Series page</main>} />
            </StrictMode>,
        );
        await settle();
        expect(host()).not.toHaveAttribute('aria-hidden');
    });

    it('marks nothing but the announcer\'s host', async () => {
        render(<App route="2" page={<ViewerShell mode="page">{photo(2)}</ViewerShell>} />);
        await settle();
        expect([...document.querySelectorAll('[aria-hidden="true"]')].filter((node) => node.closest('[data-surface="viewer"]') === null)).toEqual([host()]);
    });
});

// #255: the alert keeps the last title Next wrote while the Viewer held the host. Shown again as it was, a screen
// reader could read that stale title out, so the Viewer's release empties it first, and the series page's title is
// Next's own next write.
describe('the title Next wrote while the Viewer held the host, on Close (#255)', () => {
    let logs = 0;
    function record() {
        const key = `shell-${++logs}`;
        installAnnouncerLog(key);
        return async () => {
            await settle();
            return readAnnouncerLog(key);
        };
    }

    it('in the modal: a move says nothing, and Close never shows the stale title, then says the series page', async () => {
        document.title = SERIES_TITLE;
        const series = <main>Series page</main>;
        const view = render(<App route="series" page={series} />);
        await settle();
        const page = (n: number) => (
            <>
                {series}
                <ViewerShell mode="modal">{photo(n)}</ViewerShell>
            </>
        );
        const moving = record();
        navigate(view, '2', titleOf(2), page(2));
        await settle();
        navigate(view, '3', titleOf(3), page(3));
        const moves = await moving();
        expect(spokenOf(moves), describeLog(moves)).toEqual([]);
        expect(said()).toBe(titleOf(3));

        const closing = record();
        navigate(view, 'series', SERIES_TITLE, series);
        const steps = await closing();
        expect(shownHolding(steps), describeLog(steps)).toEqual([]);
        expect(spokenOf(steps), describeLog(steps)).toEqual([SERIES_TITLE]);
        expect(host()).not.toHaveAttribute('aria-hidden');
        expect(said()).toBe(SERIES_TITLE);
    });

    it('on a page: Close never shows the stale title, then says the series page', async () => {
        document.title = titleOf(1);
        const page = (n: number) => <ViewerShell mode="page">{photo(n)}</ViewerShell>;
        const view = render(<App route="1" page={page(1)} />);
        await settle();
        navigate(view, '2', titleOf(2), page(2));
        await settle();
        expect(said()).toBe(titleOf(2));
        const closing = record();
        navigate(view, 'series', SERIES_TITLE, <main>Series page</main>);
        const steps = await closing();
        expect(shownHolding(steps), describeLog(steps)).toEqual([]);
        expect(spokenOf(steps), describeLog(steps)).toEqual([SERIES_TITLE]);
        expect(said()).toBe(SERIES_TITLE);
    });

    it('when the next page has the same title, nothing is said and nothing stale is shown', async () => {
        document.title = SERIES_TITLE;
        const view = render(<App route="2" page={<ViewerShell mode="page">{photo(2)}</ViewerShell>} />);
        await settle();
        navigate(view, '3', titleOf(3), <ViewerShell mode="page">{photo(3)}</ViewerShell>);
        await settle();
        const closing = record();
        navigate(view, 'series', titleOf(3), <main>Series page</main>);
        const steps = await closing();
        expect(shownHolding(steps), describeLog(steps)).toEqual([]);
        expect(spokenOf(steps), describeLog(steps)).toEqual([]);
        expect(host()).not.toHaveAttribute('aria-hidden');
    });
});

/** The changes with repeats of the same state dropped, as React may write the same text twice. */
function order(changes: string[]): string[] {
    return changes.filter((change, index) => change !== changes[index - 1]);
}
