import { act, render } from '@testing-library/react';
import { AppRouterAnnouncer } from 'next/dist/client/components/app-router-announcer';
import { useLayoutEffect, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeLog, installAnnouncerLog, readAnnouncerLog, spokenOf, type AnnouncerStep } from '@/test/helpers/announcerLog';
import { quietRouteAnnouncer } from '@/components/viewer/routeAnnouncer';
import { RESTORE_WAIT_MS, RETURN_KEY, SERIES_TITLE_ID } from '../returnPosition';
import { SERIES_PAGES_KEY, SERIES_RESTORED_EVENT } from '../seriesContinuation';
import SeriesReturn from '../SeriesReturn';

// #255, SeriesReturn's two falls to the series heading after a page change: the return that lands on the server's
// answer for ?photo= without its photograph (landReturn), and the return to a page that is already that answer (the
// missing photograph's return). The heading says the page's name, so Next 16.4.2's route announcer must not say it
// for the navigation that lands there, and no alert with the name may sit beside the focused heading. These run the
// real announcer, placed as Next's app router places it: a sibling after the page.

const navigation = vi.hoisted(() => ({ pathname: '/work/harbor', replace: (() => undefined) as (href: string, options?: unknown) => void }));
vi.mock('next/navigation', () => ({ usePathname: () => navigation.pathname, useRouter: () => ({ replace: (href: string, options?: unknown) => navigation.replace(href, options) }) }));

const A = 'ph_00000000-0000-4000-8000-000000000001';
/** A photograph that left the revision: no entry for it on any page. */
const LEFT = 'ph_00000000-0000-4000-8000-000000000009';
const NEXT_KEYS = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: ['', {}], renderedSearch: '' } };
const PROPS = { path: '/work/harbor', slug: 'harbor', revisionId: 'rev_a', total: 3, firstPosition: 1, focusPhotoId: null as string | null };
const SERIES_TITLE = 'Harbor · Site';
const PHOTO_TITLE = 'Harbor, photograph 2 of 3 · Site';

const PAGE = `
    <main>
        <h1 id="${SERIES_TITLE_ID}">Harbor</h1>
        <section aria-labelledby="series-sequence">
            <h2 id="series-sequence">Sequence</h2>
            <ol><li><a id="photo-${A}" href="/work/harbor/photo/${A}">1</a></li></ol>
        </section>
    </main>`;

beforeEach(() => {
    navigation.pathname = '/work/harbor';
    navigation.replace = () => undefined;
    document.body.innerHTML = PAGE;
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    Element.prototype.scrollIntoView = vi.fn();
    vi.spyOn(performance, 'getEntriesByType').mockImplementation((type: string) => (type === 'navigation' ? [{ type: 'navigate' } as unknown as PerformanceEntry] : []));
    document.title = '';
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

/** Next's app router as far as the announcer goes: the page, then AppRouterAnnouncer after it, as app-router.js has it. */
function App({ route, page }: { route: string; page: ReactNode }) {
    return (
        <>
            {page}
            <AppRouterAnnouncer tree={[route, {}] as never} />
        </>
    );
}

/** The Viewer as a page (after a reload on it), as far as the announcer goes: it holds the host hidden while mounted. */
function Viewer() {
    useLayoutEffect(() => quietRouteAnnouncer(), []);
    return <p>Viewer</p>;
}

const host = () => document.querySelector('next-route-announcer');
const said = () => host()?.shadowRoot?.textContent ?? null;
const heading = () => document.getElementById(SERIES_TITLE_ID);
/** Lets a MutationObserver's records arrive. */
const settle = () => act(async () => await Promise.resolve());
const at = (search: string, state: object) => window.history.replaceState({ ...state }, '', `/work/harbor${search}`);
const stored = (record: object, extra: object = {}) => ({ ...NEXT_KEYS, ...extra, [RETURN_KEY]: record });

let logs = 0;
function record() {
    const key = `return-${++logs}`;
    installAnnouncerLog(key);
    return async (): Promise<AnnouncerStep[]> => {
        await settle();
        return readAnnouncerLog(key);
    };
}

/** On the Viewer's page, with the photograph's title written while the Viewer held the host. */
async function onViewer() {
    document.title = PHOTO_TITLE;
    const view = render(<App route="photo" page={<Viewer />} />);
    await settle();
    expect(host()).toHaveAttribute('aria-hidden', 'true');
    return view;
}

/** Back to the series: the history entry's URL and state, then the router's commit of the series page's tree. */
function back(view: ReturnType<typeof render>, search: string, state: object, title: string, props: Partial<typeof PROPS> = {}) {
    at(search, state);
    document.title = title;
    view.rerender(<App route={`series${search}`} page={<SeriesReturn {...PROPS} {...props} />} />);
}

/** The steps from the heading taking focus on, and the texts heard there. */
function fromHeading(steps: AnnouncerStep[]) {
    const index = steps.findIndex((step) => step.kind === 'focus' && step.focus === SERIES_TITLE_ID);
    expect(index, describeLog(steps)).toBeGreaterThanOrEqual(0);
    return steps.slice(index);
}

describe('the missing photograph\'s return (SeriesReturn.tsx\'s `missing`): Back to a page that is the server\'s answer for its ?photo=', () => {
    it('lands on the heading in the Back\'s own commit: the heading says the name and the announcer doesn\'t', async () => {
        const view = await onViewer();
        const read = record();
        back(view, `?photo=${LEFT}`, stored({ photoId: LEFT, opener: 'entry', scrollY: 640 }), SERIES_TITLE);
        const steps = await read();
        expect(document.activeElement).toBe(heading());
        expect(spokenOf(steps), describeLog(steps)).toEqual([]);
        expect(host()).not.toHaveAttribute('aria-hidden');
        expect(said()).not.toContain('Harbor');
    });

    it('lands on the heading after #6\'s restored pages end without it: no write then, and no alert with the name beside the heading', async () => {
        const view = await onViewer();
        const read = record();
        // #6 is loading this entry's saved pages again, so the return waits for its event. The Back is heard meanwhile:
        // nothing has focus yet, and nobody knows yet where it will go.
        back(view, `?photo=${LEFT}`, stored({ photoId: LEFT, opener: 'entry', scrollY: 640 }, { [SERIES_PAGES_KEY]: { revisionId: 'rev_a', slug: 'harbor', first: 1, loaded: 3 } }), SERIES_TITLE);
        await settle();
        expect(document.activeElement).toBe(document.body);
        act(() => {
            document.querySelector('section')?.dispatchEvent(new Event(SERIES_RESTORED_EVENT, { bubbles: true }));
        });
        const steps = await read();
        expect(document.activeElement).toBe(heading());
        expect(spokenOf(steps), describeLog(steps)).toEqual([SERIES_TITLE]);
        // From the heading's focus on, nothing is written: the event is no navigation.
        expect(spokenOf(fromHeading(steps)), describeLog(steps)).toEqual([]);
        expect(host()).not.toHaveAttribute('aria-hidden');
        expect(said()).not.toContain('Harbor');
    });
});

describe('landReturn: a return that asked the server for its photograph\'s page, which doesn\'t hold it (it left the revision)', () => {
    /** Back to the series, whose saved pages can't bring the photograph back, so it asks the server with ?photo=. */
    async function backAndAsk(title: string) {
        const replace = vi.fn();
        navigation.replace = replace;
        const view = await onViewer();
        const read = record();
        back(view, '', stored({ photoId: LEFT, opener: 'entry', scrollY: 640 }), title);
        await settle();
        expect(replace).toHaveBeenCalledWith(`/work/harbor?photo=${LEFT}`, { scroll: false });
        expect(document.activeElement).toBe(document.body);
        return { view, read };
    }

    /** Next answers in place: the URL first (its insertion effect), then the answer's tree, in one commit. */
    function answer(view: ReturnType<typeof render>, title: string) {
        window.history.replaceState({ ...NEXT_KEYS }, '', `/work/harbor?photo=${LEFT}`);
        document.title = title;
        view.rerender(<App route={`series?photo=${LEFT}`} page={<SeriesReturn {...PROPS} />} />);
    }

    it('lands on the heading in the answer\'s commit, which writes nothing when the title is the same: no alert with the name beside the heading', async () => {
        const { view, read } = await backAndAsk(SERIES_TITLE);
        answer(view, SERIES_TITLE);
        const steps = await read();
        expect(document.activeElement).toBe(heading());
        // The Back was heard as the page change it is, with focus on nothing. The answer's navigation wrote nothing.
        expect(spokenOf(steps), describeLog(steps)).toEqual([SERIES_TITLE]);
        expect(spokenOf(fromHeading(steps)), describeLog(steps)).toEqual([]);
        expect(host()).not.toHaveAttribute('aria-hidden');
        expect(said()).not.toContain('Harbor');
    });

    it('keeps the answer\'s own write from being heard when it has one: Next can read the h1 for the Back while the title is replaced', async () => {
        // The Back's effect ran with the title empty, so Next took the h1's text; the answer's has the title. The e2e
        // run saw it so in desktop Chromium (e2e/series-announcements.spec.ts).
        const { view, read } = await backAndAsk('');
        answer(view, SERIES_TITLE);
        const steps = await read();
        expect(document.activeElement).toBe(heading());
        expect(spokenOf(steps), describeLog(steps)).toEqual(['Harbor']);
        expect(spokenOf(fromHeading(steps)), describeLog(steps)).toEqual([]);
        expect(host()).not.toHaveAttribute('aria-hidden');
        expect(said()).not.toContain('Harbor');
    });

    it('lands on the heading when the answer never comes, RESTORE_WAIT_MS later: no navigation, no write, and no alert with the name beside it', async () => {
        vi.useFakeTimers();
        const { read } = await backAndAsk(SERIES_TITLE);
        act(() => {
            vi.advanceTimersByTime(RESTORE_WAIT_MS);
        });
        const steps = await read();
        expect(document.activeElement).toBe(heading());
        expect(spokenOf(fromHeading(steps)), describeLog(steps)).toEqual([]);
        expect(host()).not.toHaveAttribute('aria-hidden');
        expect(said()).not.toContain('Harbor');
    });

    it('a return whose answer holds the photograph lands on its entry, and the announcer is left as it was', async () => {
        const { view, read } = await backAndAsk(SERIES_TITLE);
        const late = document.createElement('a');
        late.id = `photo-${LEFT}`;
        late.href = `/work/harbor/photo/${LEFT}`;
        document.querySelector('ol')?.append(late);
        answer(view, SERIES_TITLE);
        const steps = await read();
        expect(document.activeElement).toBe(late);
        expect(spokenOf(steps), describeLog(steps)).toEqual([SERIES_TITLE]);
        expect(said()).toBe(SERIES_TITLE);
        expect(host()).not.toHaveAttribute('aria-hidden');
    });
});
