import { act, render } from '@testing-library/react';
import { AppRouterAnnouncer } from 'next/dist/client/components/app-router-announcer';
import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeLog, installAnnouncerLog, readAnnouncerLog, spokenOf } from '@/e2e/support/announcerLog';
import { quietRouteAnnouncer, useLandingHold } from '../routeAnnouncer';

// #255: when a navigation lands with focus on a heading that names the page, the heading says the name, so Next
// 16.4.2's route announcer (next/dist/client/components/app-router-announcer.js) must not say it too. The announcer
// writes in its own passive effect for the router's new tree: it calls setRouteAnnouncement, and the write itself lands
// in the commit that update makes. useLandingHold's hold, taken in a passive effect of the same landing, holds the host
// aria-hidden until that commit, empties the write there, and lets the host go. These run the real announcer, placed
// as Next's app router places it: a sibling after the page.

beforeEach(() => {
    document.title = '';
});

afterEach(() => {
    document.body.innerHTML = '';
});

const SERIES_TITLE = 'Fixture series · Site';
const PHOTO_TITLE = 'Fixture series, photograph 2 of 3 · Site';
const WORK_TITLE = 'Work · Site';

/** Next's app router as far as the announcer goes: the page, then AppRouterAnnouncer after it, as app-router.js has it. */
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

/** The Viewer as far as the announcer goes: it holds the host hidden while it's mounted, from a layout effect (ViewerShell). */
function Viewer() {
    useLayoutEffect(() => quietRouteAnnouncer(), []);
    return <p>Viewer</p>;
}

/** A page whose landing focuses its heading from a passive effect and takes the landing hold, as ViewerHost and SeriesReturn do. */
function HeadingPage({ hold = true }: { hold?: boolean }) {
    const holdLanding = useLandingHold();
    useEffect(() => {
        document.getElementById('series-title')?.focus();
        if (hold) holdLanding();
    }, [hold, holdLanding]);
    return (
        <h1 id="series-title" tabIndex={-1}>
            Fixture series
        </h1>
    );
}

let logs = 0;
/** Starts an announcer log (e2e/support/announcerLog.ts), and returns its reader. */
function record() {
    const key = `unit-${++logs}`;
    installAnnouncerLog(key);
    return async () => {
        await settle();
        return readAnnouncerLog(key);
    };
}

/** From the Viewer, the series page: the photograph's title written while the Viewer held the host. */
async function fromViewer() {
    document.title = SERIES_TITLE;
    const view = render(<App route="series" page={<main>Series</main>} />);
    await settle();
    navigate(view, 'photo', PHOTO_TITLE, <Viewer />);
    await settle();
    expect(host()).toHaveAttribute('aria-hidden', 'true');
    return view;
}

describe('useLandingHold, with Next 16.4.2\'s announcer', () => {
    it('keeps the landing\'s write from being heard: the host is hidden when it lands, the write is emptied, and the host is let go in that commit', async () => {
        const view = await fromViewer();
        const read = record();
        navigate(view, 'series', SERIES_TITLE, <HeadingPage />);
        const steps = await read();
        expect(document.activeElement).toBe(document.getElementById('series-title'));
        expect(spokenOf(steps), describeLog(steps)).toEqual([]);
        // Next did write the series page's title, while the host was hidden, and it was emptied before the host was let go.
        const written = steps.findIndex((step) => step.kind === 'text' && step.text === SERIES_TITLE);
        expect(written, describeLog(steps)).toBeGreaterThanOrEqual(0);
        expect(steps[written].hidden).toBe(true);
        const emptied = steps.findIndex((step, index) => index > written && step.kind === 'text' && step.text === '');
        expect(emptied, describeLog(steps)).toBeGreaterThan(written);
        expect(steps[emptied].hidden).toBe(true);
        expect(steps.at(-1), describeLog(steps)).toMatchObject({ kind: 'hidden', hidden: false, text: '' });
        // Nothing left hidden, and no alert with the page's name beside the focused heading.
        expect(host()).not.toHaveAttribute('aria-hidden');
        expect(said()).toBe('');
    });

    it('lets the next page change be heard as before', async () => {
        const view = await fromViewer();
        navigate(view, 'series', SERIES_TITLE, <HeadingPage />);
        await settle();
        const read = record();
        navigate(view, 'work', WORK_TITLE, <main>Work</main>);
        const steps = await read();
        expect(spokenOf(steps), describeLog(steps)).toEqual([WORK_TITLE]);
        expect(said()).toBe(WORK_TITLE);
        expect(host()).not.toHaveAttribute('aria-hidden');
    });

    it('a landing that takes no hold is heard, as #247 has it', async () => {
        const view = await fromViewer();
        const read = record();
        navigate(view, 'series', SERIES_TITLE, <HeadingPage hold={false} />);
        const steps = await read();
        expect(spokenOf(steps), describeLog(steps)).toEqual([SERIES_TITLE]);
    });

    it('lets the host go in the next commit when the landing has no write (the title didn\'t change)', async () => {
        document.title = SERIES_TITLE;
        const view = render(<App route="series" page={<main>Series</main>} />);
        await settle();
        const read = record();
        navigate(view, 'series-again', SERIES_TITLE, <HeadingPage />);
        const steps = await read();
        expect(spokenOf(steps)).toEqual([]);
        expect(steps.filter((step) => step.kind === 'hidden').map((step) => step.hidden), describeLog(steps)).toEqual([true, false]);
        expect(host()).not.toHaveAttribute('aria-hidden');
    });

    it('lets the host go when the page unmounts before its hold has passed', async () => {
        // The landing's own passive flush also takes the page away, so the hold's update is dropped with it.
        function Parent() {
            const [shown, setShown] = useState(true);
            return shown ? <Leaving onLanded={() => setShown(false)} /> : <main>Elsewhere</main>;
        }
        function Leaving({ onLanded }: { onLanded: () => void }) {
            const holdLanding = useLandingHold();
            useEffect(() => {
                holdLanding();
                onLanded();
            }, [holdLanding, onLanded]);
            return null;
        }
        const view = await fromViewer();
        navigate(view, 'series', SERIES_TITLE, <Parent />);
        await settle();
        expect(document.body).toHaveTextContent('Elsewhere');
        expect(host()).not.toHaveAttribute('aria-hidden');
    });

    it('keeps one hold for two landings in a row, and lets the host go once both have passed', async () => {
        function Twice() {
            const holdLanding = useLandingHold();
            useEffect(() => {
                holdLanding();
                holdLanding();
            }, [holdLanding]);
            return null;
        }
        const view = await fromViewer();
        const read = record();
        navigate(view, 'series', SERIES_TITLE, <Twice />);
        const steps = await read();
        expect(spokenOf(steps), describeLog(steps)).toEqual([]);
        expect(host()).not.toHaveAttribute('aria-hidden');
        // And the Viewer's own hold is untouched by it: a later Viewer still hides the host.
        navigate(view, 'photo', PHOTO_TITLE, <Viewer />);
        await settle();
        expect(host()).toHaveAttribute('aria-hidden', 'true');
    });
});
