import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { SeriesChapter, SeriesEntry } from '@/lib/catalog/projections/series';
import SiteRoutesProvider from '@/components/site/SiteRoutes';
import SeriesSequence, { type SeriesSequenceProps } from '../SeriesSequence';
import { SERIES_PAGES_KEY, SERIES_RESTORED_EVENT } from '../seriesContinuation';
import { addedLabel, failedLabel, OFFLINE, RELOAD_SERIES, SERIES_UPDATED, SHOW_EARLIER, SHOW_MORE, showingLabel, tryAgainLabel } from '../seriesCopy';

// #6's Show more on #5's sequence: appending pages in authored order,
// keeping focus and scroll, every state, cancellation, and the Back restore.

const REVISION = `rev_${'a'.repeat(64)}`;
const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PAGE_1 = '/api/catalog/series/fixture-long/pages/CURSOR1';
const PAGE_2 = '/api/catalog/series/fixture-long/pages/CURSOR2';
const PAGE_3 = '/api/catalog/series/fixture-long/pages/CURSOR3';

function entry(position: number): SeriesEntry {
    return { photoId: id(position), position, title: null, description: `Fixture photograph ${position}`, href: `/work/fixture-long/photo/${id(position)}`, image: null };
}
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, n) => entry(from + n));
const CHAPTERS: SeriesChapter[] = [{ id: 'ch-one', title: 'Fixture chapter one', startPosition: 150 }];

const PAGES: Record<string, { entries: SeriesEntry[]; prevHref: string | null; nextHref: string | null }> = {
    [PAGE_1]: { entries: range(1, 100), prevHref: null, nextHref: PAGE_2 },
    [PAGE_2]: { entries: range(101, 200), prevHref: PAGE_1, nextHref: PAGE_3 },
    [PAGE_3]: { entries: range(201, 250), prevHref: PAGE_2, nextHref: null },
};

const props = (overrides: Partial<SeriesSequenceProps> = {}): SeriesSequenceProps => ({
    revisionId: REVISION,
    slug: 'fixture-long',
    href: '/work/fixture-long',
    entries: range(1, 100),
    total: 250,
    prevHref: null,
    nextHref: PAGE_2,
    chapters: CHAPTERS,
    ...overrides,
});

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
const pageAnswer = (href: string, revisionId = REVISION) => json({ revisionId, ...PAGES[href] });

let fetch: MockInstance<typeof globalThis.fetch>;
/** Calls a live component made: React's development remount drops the first restore. */
const liveCalls = () => fetch.mock.calls.filter(([, init]) => !(init as { signal: AbortSignal }).signal.aborted).map(([url]) => String(url));

const flush = () =>
    act(async () => {
        for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    });

function show(overrides: Partial<SeriesSequenceProps> = {}) {
    return render(
        <StrictMode>
            <SeriesSequence {...props(overrides)} />
        </StrictMode>,
    );
}

const more = () => screen.getByRole('button', { name: SHOW_MORE });
const status = () => screen.getByRole('status', { name: '' })?.textContent ?? '';
const positions = () => [...document.querySelectorAll('[data-position]')].map((node) => Number(node.textContent));
const link = (position: number) => document.getElementById(`photo-${id(position)}`);

beforeEach(() => {
    window.history.replaceState({ __NA: true, kept: 'yes' }, '', '/work/fixture-long');
    fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => pageAnswer(String(url)));
});

afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
});

describe('SeriesSequence', () => {
    it('renders the first page with the count and Show more, and no control for a one-page series', () => {
        const view = show();
        expect(positions()).toEqual(range(1, 100).map((item) => item.position));
        expect(more()).toBeInTheDocument();
        expect(status()).toBe(showingLabel(1, 100, 250));
        expect(status()).toBe('Showing photographs 1 to 100 of 250.');
        // No Show earlier on a page that starts at 1.
        expect(screen.queryByRole('button', { name: SHOW_EARLIER })).toBeNull();
        // Entries are named against the whole series, not the loaded part.
        expect(link(1)).toHaveAttribute('aria-label', expect.stringContaining('250'));
        view.unmount();
        show({ entries: range(1, 10), total: 10, nextHref: null, chapters: [] });
        expect(screen.queryByRole('button')).toBeNull();
        expect(screen.queryByRole('status')).toBeNull();
    });

    it('appends the next page in authored order, keeping the earlier entries in place, and moves focus to the first new entry (B5)', async () => {
        show();
        const first = link(1);
        more().focus();
        fireEvent.click(more());
        expect(more()).toHaveAttribute('aria-disabled', 'true');
        expect(document.activeElement).toBe(more());
        expect(screen.getByText('Loading photographs 101 to 200')).toBeInTheDocument();
        await flush();
        expect(liveCalls()).toEqual([PAGE_2]);
        expect(positions()).toEqual(range(1, 200).map((item) => item.position));
        expect(link(1)).toBe(first);
        expect(document.activeElement).toBe(link(101));
        expect(more()).not.toHaveAttribute('aria-disabled');
        expect(status()).toBe(addedLabel(101, 200, 250));
        expect(status()).toBe('Added photographs 101 to 200 of 250.');
    });

    it('moves focus to the first new entry after an append from the body too, as Safari leaves a clicked button unfocused, but never from elsewhere', async () => {
        show();
        fireEvent.click(more());
        await flush();
        expect(document.activeElement).toBe(link(101));
        link(5)?.focus();
        fireEvent.click(more());
        await flush();
        expect(document.activeElement).toBe(link(5));
    });

    it('cuts chapters as pages arrive: a chapter shows once its first photograph has loaded, and the run before it stays one list', async () => {
        show();
        expect(screen.queryByRole('heading', { name: 'Fixture chapter one' })).toBeNull();
        fireEvent.click(more());
        await flush();
        const heading = screen.getByRole('heading', { name: 'Fixture chapter one' });
        const chapter = heading.closest('section') as HTMLElement;
        expect(within(chapter).getAllByRole('listitem')[0]).toContainElement(link(150));
        // 101 to 149 continue the lead list that holds 1 to 100.
        expect(link(149)?.closest('ol')).toBe(link(1)?.closest('ol'));
        expect(link(150)?.closest('ol')).toHaveAttribute('start', '150');
    });

    it('ends with every photograph shown, the control gone, and focus on the first new entry if the control had it', async () => {
        show();
        more().focus();
        fireEvent.click(more());
        await flush();
        // Focus went to the first new entry; a keyboard visitor comes back to the control for the next page.
        more().focus();
        fireEvent.click(more());
        await flush();
        expect(positions().at(-1)).toBe(250);
        expect(screen.queryByRole('button')).toBeNull();
        expect(status()).toBe('Added photographs 201 to 250 of 250. End of series.');
        expect(document.activeElement).toBe(link(201));
    });

    it('leaves focus alone at the end when something else had it', async () => {
        show({ entries: range(1, 200), nextHref: PAGE_3 });
        link(3)?.focus();
        fireEvent.click(more());
        await flush();
        expect(status()).toBe('Added photographs 201 to 250 of 250. End of series.');
        expect(document.activeElement).toBe(link(3));
    });

    it('keeps what loaded and offers Try again after a network error or a server error, which asks for the same page', async () => {
        fetch.mockImplementation(async () => {
            throw new TypeError('Failed to fetch');
        });
        show();
        more().focus();
        fireEvent.click(more());
        await flush();
        expect(status()).toBe(failedLabel(101, 200));
        expect(status()).toBe('Couldn’t load photographs 101 to 200.');
        const retry = screen.getByRole('button', { name: tryAgainLabel(101, 200) });
        expect(retry).toHaveAccessibleName('Try again: photographs 101 to 200');
        expect(document.activeElement).toBe(retry);
        expect(positions()).toHaveLength(100);
        fetch.mockImplementation(async () => json({ reason: 'internal' }, 500));
        fireEvent.click(retry);
        await flush();
        expect(status()).toBe(failedLabel(101, 200));
        fetch.mockImplementation(async (url) => pageAnswer(String(url)));
        fireEvent.click(screen.getByRole('button', { name: tryAgainLabel(101, 200) }));
        await flush();
        expect(liveCalls()).toEqual([PAGE_2, PAGE_2, PAGE_2]);
        expect(positions()).toHaveLength(200);
    });

    it('treats a page for another revision, or a page that doesn\'t continue the sequence, as an error', async () => {
        fetch.mockImplementation(async (url) => pageAnswer(String(url), `rev_${'b'.repeat(64)}`));
        show();
        fireEvent.click(more());
        await flush();
        expect(status()).toBe(failedLabel(101, 200));
        fetch.mockImplementation(async () => pageAnswer(PAGE_3));
        fireEvent.click(screen.getByRole('button', { name: tryAgainLabel(101, 200) }));
        await flush();
        expect(status()).toBe(failedLabel(101, 200));
        expect(positions()).toHaveLength(100);
    });

    it.each([409, 404, 400])('stops at a %i, keeps what loaded, and links to the current series, moving focus there from the control', async (code) => {
        fetch.mockImplementation(async () => json({ reason: 'revision-changed' }, code));
        show();
        more().focus();
        fireEvent.click(more());
        await flush();
        expect(status()).toBe(SERIES_UPDATED);
        const reload = screen.getByRole('link', { name: RELOAD_SERIES });
        expect(reload).toHaveAttribute('href', '/work/fixture-long');
        expect(document.activeElement).toBe(reload);
        expect(screen.queryByRole('button')).toBeNull();
        expect(positions()).toHaveLength(100);
    });

    it('asks once however often the control is pressed while it loads', async () => {
        show();
        fireEvent.click(more());
        fireEvent.click(more());
        fireEvent.click(more());
        await flush();
        expect(liveCalls()).toEqual([PAGE_2]);
        expect(positions()).toHaveLength(200);
    });

    it('aborts its request on unmount', async () => {
        fetch.mockImplementation(() => new Promise<Response>(() => undefined));
        const view = show();
        fireEvent.click(more());
        await flush();
        const signal = (fetch.mock.calls.at(-1)?.[1] as { signal: AbortSignal }).signal;
        expect(signal.aborted).toBe(false);
        view.unmount();
        expect(signal.aborted).toBe(true);
    });

    it.each(['https://elsewhere.test/x', '/api/other', '//elsewhere.test/api/catalog/series/x'])('never follows a next page the server didn\'t mint (%s): the page is an error and nothing goes there', async (foreign) => {
        fetch.mockImplementation(async (url) => (String(url) === PAGE_2 ? json({ revisionId: REVISION, entries: range(101, 200), prevHref: PAGE_1, nextHref: foreign }) : json({}, 500)));
        show();
        fireEvent.click(more());
        await flush();
        expect(status()).toBe(failedLabel(101, 200));
        expect(positions()).toHaveLength(100);
        fireEvent.click(screen.getByRole('button', { name: tryAgainLabel(101, 200) }));
        await flush();
        expect(fetch.mock.calls.map(([url]) => String(url)).filter((url) => url !== PAGE_2)).toEqual([]);
    });

    it("follows only the preview's own mirror inside #16's preview, never the public endpoint", async () => {
        const base = `/curation/preview/${REVISION}/site`;
        const mirror2 = `${base}${PAGE_2}`;
        const mirror3 = `${base}${PAGE_3}`;
        const preview: Record<string, unknown> = { [mirror2]: { revisionId: REVISION, entries: range(101, 200), prevHref: null, nextHref: mirror3 }, [mirror3]: { revisionId: REVISION, entries: range(201, 250), prevHref: null, nextHref: PAGE_3 } };
        fetch.mockImplementation(async (url) => (String(url) in preview ? json(preview[String(url)]) : json({}, 500)));
        window.history.replaceState(null, '', `${base}/work/fixture-long`);
        render(
            <SiteRoutesProvider basePath={base}>
                <SeriesSequence {...props({ href: `${base}/work/fixture-long`, nextHref: mirror2 })} />
            </SiteRoutesProvider>,
        );
        fireEvent.click(more());
        await flush();
        expect(positions()).toHaveLength(200);
        // The second mirror page names the public endpoint next: refused, so nothing leaves the preview.
        fireEvent.click(more());
        await flush();
        expect(status()).toBe(failedLabel(201, 250));
        expect(positions()).toHaveLength(200);
        expect(fetch.mock.calls.map(([url]) => String(url)).every((url) => url.startsWith(`${base}/api/catalog/series/`))).toBe(true);
    });

    it('writes an extent that arrives while another entry is current (the modal Viewer) only once the series entry is back', async () => {
        let resolve: (response: Response) => void = () => undefined;
        fetch.mockImplementation(() => new Promise<Response>((done) => (resolve = done)));
        show();
        fireEvent.click(more());
        await flush();
        // The modal Viewer pushes its own entry while the page is on its way.
        window.history.pushState({ __NA: true, viewer: true }, '', `/work/fixture-long/photo/${id(150)}`);
        resolve(pageAnswer(PAGE_2));
        await flush();
        expect(positions()).toHaveLength(200);
        expect(window.history.state).toEqual({ __NA: true, viewer: true });
        // Close is one Back to the series entry.
        await act(async () => {
            const popped = new Promise((done) => window.addEventListener('popstate', done, { once: true }));
            window.history.back();
            await popped;
        });
        expect(window.location.pathname).toBe('/work/fixture-long');
        expect(window.history.state).toEqual({ __NA: true, kept: 'yes', [SERIES_PAGES_KEY]: { revisionId: REVISION, slug: 'fixture-long', first: 1, loaded: 200 } });
    });

    it('records the loaded extent in the history entry, keeping the keys already there', async () => {
        show();
        fireEvent.click(more());
        await flush();
        expect(window.history.state).toEqual({ __NA: true, kept: 'yes', [SERIES_PAGES_KEY]: { revisionId: REVISION, slug: 'fixture-long', first: 1, loaded: 200 } });
    });

    it('says when it\'s offline as well as which photographs couldn\'t load', async () => {
        fetch.mockImplementation(async () => {
            throw new TypeError('Failed to fetch');
        });
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        show();
        fireEvent.click(more());
        await flush();
        expect(status()).toBe(`${failedLabel(101, 200)} ${OFFLINE}`);
        expect(status()).toBe('Couldn’t load photographs 101 to 200. You appear to be offline.');
    });

    it('formats counts past a thousand with a comma', () => {
        expect(showingLabel(1001, 1100, 1200)).toBe('Showing photographs 1,001 to 1,100 of 1,200.');
        expect(tryAgainLabel(1101, 1200)).toBe('Try again: photographs 1,101 to 1,200');
    });
});

describe('SeriesSequence on Back', () => {
    const saved = (pages: unknown) => window.history.replaceState({ __NA: true, [SERIES_PAGES_KEY]: pages }, '');

    it('loads the pages the history entry had, busy while it does, then fires the restored event with the entries in the DOM', async () => {
        saved({ revisionId: REVISION, slug: 'fixture-long', loaded: 250 });
        const seen: number[] = [];
        const listener = () => seen.push(positions().length);
        document.addEventListener(SERIES_RESTORED_EVENT, listener);
        try {
            show();
            const section = document.querySelector('section[aria-labelledby="series-sequence"]') as HTMLElement;
            expect(section).toHaveAttribute('aria-busy', 'true');
            await flush();
            expect(liveCalls()).toEqual([PAGE_2, PAGE_3]);
            expect(section).not.toHaveAttribute('aria-busy');
            expect(seen).toEqual([250]);
            expect(link(250)).not.toBeNull();
            expect(status()).toBe(showingLabel(1, 250, 250));
        } finally {
            document.removeEventListener(SERIES_RESTORED_EVENT, listener);
        }
    });

    it('loads only as far as the entry had', async () => {
        saved({ revisionId: REVISION, slug: 'fixture-long', loaded: 200 });
        show();
        await flush();
        expect(liveCalls()).toEqual([PAGE_2]);
        expect(status()).toBe(showingLabel(1, 200, 250));
    });

    it.each([
        ['another revision', { revisionId: `rev_${'b'.repeat(64)}`, slug: 'fixture-long', loaded: 200 }],
        ['another series', { revisionId: REVISION, slug: 'fixture-other', loaded: 200 }],
        ['no more than the first page', { revisionId: REVISION, slug: 'fixture-long', loaded: 100 }],
        ['more than the series holds', { revisionId: REVISION, slug: 'fixture-long', loaded: 251 }],
        ['a fraction', { revisionId: REVISION, slug: 'fixture-long', loaded: 150.5 }],
        ['a string', { revisionId: REVISION, slug: 'fixture-long', loaded: '200' }],
        ['nothing', null],
    ])('ignores an extent for %s and shows the first page', async (_case, pages) => {
        saved(pages);
        show();
        await flush();
        expect(fetch).not.toHaveBeenCalled();
        expect(positions()).toHaveLength(100);
    });

    it('keeps the pages it restored when one fails, fires the event, and Try again resumes from that page', async () => {
        saved({ revisionId: REVISION, slug: 'fixture-long', loaded: 250 });
        fetch.mockImplementation(async (url) => (String(url) === PAGE_3 ? json({}, 503) : pageAnswer(String(url))));
        const fired = vi.fn();
        document.addEventListener(SERIES_RESTORED_EVENT, fired);
        try {
            show();
            await flush();
            expect(positions()).toHaveLength(200);
            expect(fired).toHaveBeenCalledTimes(1);
            expect(status()).toBe(failedLabel(201, 250));
            fetch.mockImplementation(async (url) => pageAnswer(String(url)));
            fireEvent.click(screen.getByRole('button', { name: tryAgainLabel(201, 250) }));
            await flush();
            expect(liveCalls().at(-1)).toBe(PAGE_3);
            expect(positions()).toHaveLength(250);
        } finally {
            document.removeEventListener(SERIES_RESTORED_EVENT, fired);
        }
    });
});

describe('SeriesSequence on a deep entry (?photo=, B5)', () => {
    /** The server's page for ?photo= of photograph 150: 101 to 200, with the pages on either side. */
    const deep = (overrides: Partial<SeriesSequenceProps> = {}) => show({ entries: range(101, 200), prevHref: PAGE_1, nextHref: PAGE_3, ...overrides });
    const earlier = () => screen.getByRole('button', { name: SHOW_EARLIER });
    beforeEach(() => {
        // Each entry's top in the view follows its place in the list, 50 px apart from 120, so 100 entries put in above push the old ones down by 5000.
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
            const index = [...document.querySelectorAll('[id^="photo-"]')].indexOf(this);
            const top = index === -1 ? 0 : 120 + 50 * index;
            return { top, bottom: top + 40, left: 0, right: 100, width: 100, height: 40, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
        });
        window.scrollBy = vi.fn() as unknown as typeof window.scrollBy;
        Element.prototype.scrollIntoView = vi.fn();
    });

    it('serves Show earlier as a link to the plain series page with JavaScript off, and the script takes it over as a button', () => {
        const html = renderToString(<SeriesSequence {...props({ entries: range(101, 200), prevHref: PAGE_1, nextHref: PAGE_3 })} />);
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const link = [...doc.querySelectorAll('a')].find((node) => node.textContent === SHOW_EARLIER);
        expect(link?.getAttribute('href')).toBe('/work/fixture-long');
        deep();
        expect(earlier().tagName).toBe('BUTTON');
        expect(screen.queryByRole('link', { name: SHOW_EARLIER })).toBeNull();
    });

    it('shows Show earlier above the entries and Show more below, with the range it shows', () => {
        deep();
        const button = earlier();
        expect(button.compareDocumentPosition(link(101) as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(more().compareDocumentPosition(link(200) as Node) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
        expect(positions()).toEqual(range(101, 200).map((item) => item.position));
        expect(link(101)?.closest('ol')).toHaveAttribute('start', '101');
        expect(status()).toBe('Showing photographs 101 to 200 of 250.');
    });

    it('puts a chapter that started before the loaded pages over them, then joins them up when the earlier page arrives', async () => {
        deep({ chapters: [{ id: 'ch-early', title: 'Fixture chapter early', startPosition: 50 }] });
        const heading = screen.getByRole('heading', { name: 'Fixture chapter early' });
        expect(link(101)?.closest('section')).toBe(heading.closest('section'));
        fireEvent.click(earlier());
        await flush();
        expect(screen.getAllByRole('heading', { name: 'Fixture chapter early' })).toHaveLength(1);
        expect(link(49)?.closest('ol')).toHaveAttribute('start', '1');
        expect(link(50)?.closest('ol')).toHaveAttribute('start', '50');
        expect(link(150)?.closest('ol')).toBe(link(50)?.closest('ol'));
    });

    it('loads the page before, keeping the old first entry where it was in the view, and moves focus to the last new entry', async () => {
        deep();
        earlier().focus();
        fireEvent.click(earlier());
        expect(earlier()).toHaveAttribute('aria-disabled', 'true');
        expect(screen.getByText('Loading photographs 1 to 100')).toBeInTheDocument();
        await flush();
        expect(liveCalls()).toEqual([PAGE_1]);
        expect(positions()).toEqual(range(1, 200).map((item) => item.position));
        expect(window.scrollBy).toHaveBeenCalledWith({ top: 5000, left: 0, behavior: 'instant' });
        expect(document.activeElement).toBe(link(100));
        expect(status()).toBe('Added photographs 1 to 100 of 250. Start of series.');
        expect(screen.queryByRole('button', { name: SHOW_EARLIER })).toBeNull();
        expect(window.history.state[SERIES_PAGES_KEY]).toEqual({ revisionId: REVISION, slug: 'fixture-long', first: 1, loaded: 200 });
    });

    it('takes only the page before from an earlier page, never its next', async () => {
        fetch.mockImplementation(async (url) => (String(url) === PAGE_1 ? json({ revisionId: REVISION, entries: range(1, 100), prevHref: null, nextHref: '/api/catalog/series/fixture-long/pages/ELSEWHERE' }) : pageAnswer(String(url))));
        deep();
        fireEvent.click(earlier());
        await flush();
        fireEvent.click(more());
        await flush();
        expect(liveCalls()).toEqual([PAGE_1, PAGE_3]);
        expect(positions().at(-1)).toBe(250);
    });

    it('drops an earlier page that doesn\'t end where the loaded ones start, and names its range on Try again', async () => {
        fetch.mockImplementation(async () => pageAnswer(PAGE_3));
        deep();
        earlier().focus();
        fireEvent.click(earlier());
        await flush();
        expect(positions()).toHaveLength(100);
        expect(status()).toBe('Couldn’t load photographs 1 to 100.');
        const retry = screen.getByRole('button', { name: 'Try again: photographs 1 to 100' });
        expect(document.activeElement).toBe(retry);
        // Show more still says Show more.
        expect(more()).toBeInTheDocument();
    });

    it.each(['https://elsewhere.test/x', '/api/other', '//elsewhere.test/api/catalog/series/x'])('never follows a page before that the server didn\'t mint (%s): the page is an error and nothing goes there', async (foreign) => {
        fetch.mockImplementation(async (url) => (String(url) === PAGE_2 ? json({ revisionId: REVISION, entries: range(101, 200), prevHref: foreign, nextHref: PAGE_3 }) : json({}, 500)));
        show({ entries: range(201, 250), prevHref: PAGE_2, nextHref: null });
        fireEvent.click(earlier());
        await flush();
        expect(positions()).toEqual(range(201, 250).map((item) => item.position));
        fireEvent.click(screen.getByRole('button', { name: 'Try again: photographs 101 to 200' }));
        await flush();
        expect(liveCalls()).toEqual([PAGE_2, PAGE_2]);
    });

    it('asks once however often either control is pressed while one loads', async () => {
        deep();
        fireEvent.click(earlier());
        fireEvent.click(more());
        fireEvent.click(earlier());
        await flush();
        expect(liveCalls()).toEqual([PAGE_1]);
    });

    it('keeps Show earlier on the last page, where Show more has ended', () => {
        show({ entries: range(201, 250), prevHref: PAGE_2, nextHref: null });
        expect(earlier()).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: SHOW_MORE })).toBeNull();
        expect(status()).toBe('Showing photographs 201 to 250 of 250.');
    });

    it('restores an extent on both sides of the deep page on Back, then fires the restored event once', async () => {
        window.history.replaceState({ __NA: true, [SERIES_PAGES_KEY]: { revisionId: REVISION, slug: 'fixture-long', first: 1, loaded: 250 } }, '');
        const fired = vi.fn();
        document.addEventListener(SERIES_RESTORED_EVENT, fired);
        try {
            deep();
            await flush();
            expect(liveCalls().sort()).toEqual([PAGE_1, PAGE_3]);
            expect(positions()).toEqual(range(1, 250).map((item) => item.position));
            expect(fired).toHaveBeenCalledTimes(1);
        } finally {
            document.removeEventListener(SERIES_RESTORED_EVENT, fired);
        }
    });

    it.each([
        ['a first past the last', { first: 201, loaded: 200 }],
        ['a first below 1', { first: 0, loaded: 200 }],
        ['a fractional first', { first: 1.5, loaded: 200 }],
    ])('ignores an extent with %s', async (_case, extent) => {
        window.history.replaceState({ __NA: true, [SERIES_PAGES_KEY]: { revisionId: REVISION, slug: 'fixture-long', ...extent } }, '');
        deep();
        await flush();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('reads an extent written before B5, with no first, as starting at 1', async () => {
        window.history.replaceState({ __NA: true, [SERIES_PAGES_KEY]: { revisionId: REVISION, slug: 'fixture-long', loaded: 200 } }, '');
        show();
        await flush();
        expect(liveCalls()).toEqual([PAGE_2]);
    });
});
