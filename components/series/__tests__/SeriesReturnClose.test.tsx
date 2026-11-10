import { act, fireEvent, render, screen } from '@testing-library/react';
import { AppRouterAnnouncer } from 'next/dist/client/components/app-router-announcer';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishedViewerPhoto } from '@/lib/catalog/projections/viewer';
import { describeLog, installAnnouncerLog, readAnnouncerLog, shownHolding, spokenOf, type AnnouncerStep } from '@/test/helpers/announcerLog';
import StoryViewer from '@/components/viewer/StoryViewer';
import ViewerShell from '@/components/viewer/ViewerShell';
import { RESTORE_WAIT_MS, SERIES_TITLE_ID } from '../returnPosition';
import SeriesReturn from '../SeriesReturn';

// #256: a photograph's own page (the Viewer loaded directly) closes with a link to the series, `?photo=<id>`. Next's
// route announcer is the only thing that says where that lands, and in WebKit it can write nothing (it reads the h1
// during the title's swap, then finds the text unchanged). So the series page reached from that Close puts focus where
// the modal's Close does: on the photograph's entry, or on the series heading when the entry isn't there, under #255's
// landing hold, so the page's name is said once. A series page reached any other way moves nothing new. These run the
// real ViewerShell and Next 16.4.2's real announcer, placed as Next's app router places it.

const navigation = vi.hoisted(() => ({ pathname: '/work/fixture/photo/x', replace: vi.fn(), back: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), forward: vi.fn() }));
vi.mock('next/navigation', () => ({
    usePathname: () => navigation.pathname,
    useRouter: () => navigation,
    useParams: () => ({ slug: 'fixture' }),
}));
vi.mock('next/link', () => ({
    default: ({ href, replace, prefetch, children, ...rest }: { href: string; replace?: boolean; prefetch?: boolean | null; children: ReactNode }) => (
        <a href={href} data-replace={String(Boolean(replace))} data-prefetch={String(prefetch)} {...rest}>
            {children}
        </a>
    ),
}));

beforeAll(() => {
    // A click on a link would try to navigate jsdom.
    document.addEventListener('click', (event) => event.preventDefault());
});

beforeEach(() => {
    vi.clearAllMocks();
    document.title = '';
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    Element.prototype.scrollIntoView = vi.fn();
    vi.spyOn(performance, 'getEntriesByType').mockImplementation((type: string) => (type === 'navigation' ? [{ type: 'navigate' } as unknown as PerformanceEntry] : []));
    window.history.replaceState({ __NA: true }, '', '/work/fixture/photo/x');
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const photoHref = (n: number) => `/work/fixture/photo/${id(n)}`;
const closeHref = (n: number) => `/work/fixture?photo=${id(n)}`;
const SERIES_TITLE = 'Fixture series · Site';
const titleOf = (n: number) => `Fixture series, photograph ${n} of 3 · Site`;
const PROPS = { path: '/work/fixture', slug: 'fixture', revisionId: 'rev_a', total: 3, firstPosition: 1 };

function model(n: number): PublishedViewerPhoto {
    return {
        catalogRevision: `rev_${'a'.repeat(64)}`,
        series: { id: 'ser_fixture', slug: 'fixture', title: 'Fixture series', accent: '#a0b0c0' },
        photo: { id: id(n), title: null, description: null, caption: null, alt: '', descriptionPending: false, namedByPlace: false, image: null, shareImage: null, accent: null, technical: {} },
        position: n,
        total: 3,
        previousPhotoId: n > 1 ? id(n - 1) : null,
        nextPhotoId: n < 3 ? id(n + 1) : null,
    };
}

/** The Viewer as a page: the photograph's own page, loaded directly. */
function viewerPage(n: number) {
    const viewer = model(n);
    return (
        <ViewerShell mode="page">
            <StoryViewer
                key={viewer.photo.id}
                viewer={viewer}
                closeHref={closeHref(n)}
                previousHref={viewer.previousPhotoId === null ? null : photoHref(n - 1)}
                nextHref={viewer.nextPhotoId === null ? null : photoHref(n + 1)}
                pendingCopy={null}
            />
        </ViewerShell>
    );
}

/** The series page as the server renders it for `?photo=`: its entries, and the photograph the server found, or null. */
function seriesPage(entries: number[], focusPhotoId: string | null) {
    return (
        <main>
            <h1 id={SERIES_TITLE_ID}>Fixture series</h1>
            <ol>
                {entries.map((n) => (
                    <li key={n}>
                        <a id={`photo-${id(n)}`} href={photoHref(n)}>
                            Photograph {n}
                        </a>
                    </li>
                ))}
            </ol>
            <a id="all-work" href="/work">
                All work
            </a>
            <SeriesReturn {...PROPS} focusPhotoId={focusPhotoId} />
        </main>
    );
}

/** Next's app router as far as the announcer goes: the page, then AppRouterAnnouncer after it. */
function App({ route, page }: { route: string; page: ReactNode }) {
    return (
        <>
            {page}
            <AppRouterAnnouncer tree={[route, {}] as never} />
        </>
    );
}

const host = () => document.querySelector('next-route-announcer');
const said = () => host()?.shadowRoot?.textContent ?? null;
const heading = () => document.getElementById(SERIES_TITLE_ID);
/** Lets a MutationObserver's records arrive. */
const settle = () => act(async () => await Promise.resolve());

let logs = 0;
function record() {
    const key = `close-${++logs}`;
    installAnnouncerLog(key);
    return async (): Promise<AnnouncerStep[]> => {
        await settle();
        return readAnnouncerLog(key);
    };
}

/** A navigation: the URL Next writes, the new title, then the router's commit of the new tree. */
function navigate(view: ReturnType<typeof render>, url: string, title: string, page: ReactNode) {
    window.history.pushState({ __NA: true }, '', url);
    navigation.pathname = new URL(url, window.location.href).pathname;
    document.title = title;
    view.rerender(<App route={url} page={page} />);
}

/** The Viewer loaded directly on photograph 1, then a move to photograph 2, under the Viewer's hold. */
async function onViewerAfterMove() {
    navigation.pathname = '/work/fixture/photo/1';
    document.title = titleOf(1);
    const view = render(<App route="photo-1" page={viewerPage(1)} />);
    await settle();
    navigate(view, photoHref(2), titleOf(2), viewerPage(2));
    await settle();
    expect(host()).toHaveAttribute('aria-hidden', 'true');
    return view;
}

const close = () => fireEvent.click(screen.getByRole('link', { name: 'Close' }));
const named = (steps: AnnouncerStep[]) => spokenOf(steps).filter((text) => text.startsWith('Fixture series'));

describe('the series page reached from a photograph\'s own page\'s Close (#256)', () => {
    it('lands on the photograph\'s entry, as the modal\'s Close does, and the announcer says the page', async () => {
        const view = await onViewerAfterMove();
        const read = record();
        close();
        navigate(view, closeHref(2), SERIES_TITLE, seriesPage([1, 2, 3], id(2)));
        const steps = await read();
        expect(document.activeElement).toBe(document.getElementById(`photo-${id(2)}`));
        expect(named(steps), describeLog(steps)).toEqual([SERIES_TITLE]);
        expect(shownHolding(steps), describeLog(steps)).toEqual([]);
        expect(host()).not.toHaveAttribute('aria-hidden');
    });

    it('lands on the heading when the photograph is no longer on the page, under the landing hold: the name is said once, by the heading', async () => {
        const view = await onViewerAfterMove();
        const read = record();
        close();
        // A publish dropped photograph 2 while its page was open: the server's series page doesn't hold it.
        navigate(view, closeHref(2), SERIES_TITLE, seriesPage([1, 3], null));
        const steps = await read();
        expect(document.activeElement).toBe(heading());
        expect(named(steps), describeLog(steps)).toEqual([]);
        expect(shownHolding(steps), describeLog(steps)).toEqual([]);
        expect(host()).not.toHaveAttribute('aria-hidden');
        expect(said()).not.toContain('Fixture series');
    });

    it('lets the next page change be heard after that landing', async () => {
        const view = await onViewerAfterMove();
        close();
        navigate(view, closeHref(2), SERIES_TITLE, seriesPage([1, 3], null));
        await settle();
        const read = record();
        navigate(view, '/work', 'Work · Site', <main>Work</main>);
        const steps = await read();
        expect(spokenOf(steps), describeLog(steps)).toEqual(['Work · Site']);
    });

    it('lands once: Back to that entry and Forward again moves nothing the second time', async () => {
        const view = await onViewerAfterMove();
        close();
        navigate(view, closeHref(2), SERIES_TITLE, seriesPage([1, 3], null));
        await settle();
        expect(document.activeElement).toBe(heading());
        const entry = window.history.state as object;
        navigate(view, '/work', 'Work · Site', <main>Work</main>);
        await settle();
        // Back to the series entry: the same history state, and the page mounts again.
        window.history.replaceState(entry, '', closeHref(2));
        navigation.pathname = '/work/fixture';
        document.title = SERIES_TITLE;
        view.rerender(<App route="series-again" page={seriesPage([1, 3], null)} />);
        await settle();
        expect(document.activeElement).toBe(document.body);
    });
});

describe('a series page reached any other way moves nothing new (#256)', () => {
    it('the same ?photo= for a photograph that isn\'t there, from a link that isn\'t the Viewer\'s Close', async () => {
        const view = await onViewerAfterMove();
        // Browser Back, or any link to that URL: no Close was pressed.
        navigate(view, closeHref(2), SERIES_TITLE, seriesPage([1, 3], null));
        await settle();
        expect(document.activeElement).toBe(document.body);
    });

    it('a plain series visit, with no ?photo=', async () => {
        document.title = 'Work · Site';
        navigation.pathname = '/work';
        const view = render(<App route="work" page={<main>Work</main>} />);
        await settle();
        navigate(view, '/work/fixture', SERIES_TITLE, seriesPage([1, 2, 3], null));
        await settle();
        expect(document.activeElement).toBe(document.body);
    });

    it('a Close whose landing never came, before a later visit to the same URL', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
        const view = await onViewerAfterMove();
        close();
        // The Close's own navigation went elsewhere, and the series page came much later, from another link.
        navigate(view, '/about', 'About · Site', <main>About</main>);
        await settle();
        act(() => {
            vi.advanceTimersByTime(RESTORE_WAIT_MS + 1);
        });
        navigate(view, closeHref(2), SERIES_TITLE, seriesPage([1, 3], null));
        await settle();
        expect(document.activeElement).toBe(document.body);
    });

    it('a Close to another series', async () => {
        const view = await onViewerAfterMove();
        close();
        navigation.pathname = '/work/other';
        window.history.pushState({ __NA: true }, '', `/work/other?photo=${id(2)}`);
        document.title = 'Other · Site';
        view.rerender(<App route="other" page={<main><h1 id={SERIES_TITLE_ID}>Other</h1><SeriesReturn {...PROPS} path="/work/other" slug="other" focusPhotoId={null} /></main>} />);
        await settle();
        expect(document.activeElement).toBe(document.body);
    });
});
