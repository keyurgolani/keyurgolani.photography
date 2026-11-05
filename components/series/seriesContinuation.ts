// Types only: the projection is server-only.
import type { SeriesEntry } from '@/lib/catalog/projections/series';

/**
 * The client half of #6's series continuation: fetching one page, and the
 * loaded extent kept in the history entry so Back can load the same pages
 * again before #5's return looks for its photograph. After a deep entry
 * (`?photo=`, B5) the extent can start past position 1, and Show earlier
 * pages run back toward it.
 */

/** The history key for the loaded extent. Spread into `history.state`, next to Next's router keys and #5's `kgSeriesReturn`. */
export const SERIES_PAGES_KEY = 'kgSeriesPages';

/**
 * Fired on the sequence `<section>` (it bubbles) when a restore after Back
 * ends, whether it reached the extent or stopped early. While the restore
 * runs the section is `aria-busy="true"`. #5's return waits for this when
 * its photograph isn't in the DOM and the entry holds an extent
 * readSeriesPages() accepts, then looks once more.
 */
export const SERIES_RESTORED_EVENT = 'kg:series-entries-restored';

export interface SeriesPagesState {
    revisionId: string;
    slug: string;
    /** The first position loaded, 1 unless the page opened deep (B5). An extent written before B5 has none, and reads as 1. */
    first: number;
    /** The last position loaded. With `first` at 1 it's the count, as it always was. */
    loaded: number;
}

/** The positions an extent covers, both ends included. */
export interface SeriesExtent {
    first: number;
    last: number;
}

export type PageAnswer =
    | { kind: 'ok'; entries: SeriesEntry[]; prevHref: string | null; nextHref: string | null }
    /** 409, or a 400 or 404, which only a changed revision explains: the page has to be loaded again. */
    | { kind: 'stale' }
    /** A network error, a 5xx, or a body that isn't a page for this revision: worth a retry. */
    | { kind: 'error' };

const PAGES_PATH = '/api/catalog/series/';

function isEntry(value: unknown): value is SeriesEntry {
    if (typeof value !== 'object' || value === null) return false;
    const entry = value as Record<string, unknown>;
    return typeof entry.photoId === 'string' && typeof entry.position === 'number' && typeof entry.href === 'string';
}

/** A page path the server made for this site: null, or under `pagesPath`. */
const ownPath = (value: unknown, pagesPath: string) => value === null || (typeof value === 'string' && value.startsWith(pagesPath));

/**
 * One continuation page from `href`, a path the server made. An abort
 * rejects with the signal's reason, for the caller to drop. The next and
 * previous pages' paths have to start with `pagesPath`: the public
 * endpoint's, or a preview's mirror of it (#16), so a page never sends the
 * sequence somewhere else. A body from before B5, with no `prevHref`, reads
 * as having none.
 */
export async function fetchSeriesPage(href: string, revisionId: string, signal: AbortSignal, pagesPath: string = PAGES_PATH): Promise<PageAnswer> {
    let response: Response;
    try {
        response = await fetch(href, { signal, headers: { Accept: 'application/json' } });
    } catch (error) {
        if (signal.aborted) throw error;
        return { kind: 'error' };
    }
    if (response.status === 409 || response.status === 404 || response.status === 400) return { kind: 'stale' };
    if (!response.ok) return { kind: 'error' };
    let body: { revisionId?: unknown; entries?: unknown; prevHref?: unknown; nextHref?: unknown };
    try {
        body = await response.json();
    } catch (error) {
        if (signal.aborted) throw error;
        return { kind: 'error' };
    }
    const { entries, nextHref, prevHref = null } = body;
    if (body.revisionId !== revisionId || !Array.isArray(entries) || entries.length === 0 || !entries.every(isEntry)) return { kind: 'error' };
    if (!ownPath(nextHref, pagesPath) || !ownPath(prevHref, pagesPath)) return { kind: 'error' };
    return { kind: 'ok', entries, prevHref: prevHref as string | null, nextHref: nextHref as string | null };
}

const isPosition = (value: unknown, total: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= total;

/** The extent the history entry holds for this page, or null when it holds none, one for another revision or series, or one out of range. */
export function readSeriesPages(state: unknown, revisionId: string, slug: string, total: number): SeriesExtent | null {
    if (typeof state !== 'object' || state === null) return null;
    const saved = (state as Record<string, unknown>)[SERIES_PAGES_KEY];
    if (typeof saved !== 'object' || saved === null) return null;
    const { revisionId: savedRevision, slug: savedSlug, first = 1, loaded } = saved as Record<string, unknown>;
    if (savedRevision !== revisionId || savedSlug !== slug) return null;
    if (!isPosition(first, total) || !isPosition(loaded, total) || first > loaded) return null;
    return { first, last: loaded };
}

/**
 * Record the extent in the current history entry, keeping every key already
 * there (Next's router state among them), but only while that entry is the
 * series page at `seriesPath`. A page that arrives while #9's modal Viewer
 * is open would otherwise land in the Viewer's entry. Returns whether it
 * wrote, so the caller can keep the extent and write it once the series
 * entry is current again.
 *
 * Next drops this key whenever a soft navigation replaces the current entry
 * (`router.refresh()`, `router.replace()`, a link to the current URL), so
 * anything that adds one of those to the series page has to write it again.
 */
export function writeSeriesPages(pages: SeriesPagesState, seriesPath: string): boolean {
    if (window.location.pathname !== seriesPath) return false;
    const current = window.history.state;
    const base = typeof current === 'object' && current !== null ? current : {};
    window.history.replaceState({ ...base, [SERIES_PAGES_KEY]: pages }, '');
    return true;
}
