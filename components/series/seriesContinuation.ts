// Types only: the projection is server-only.
import type { SeriesEntry } from '@/lib/catalog/projections/series';

/**
 * The client half of #6's series continuation: fetching one page, and the
 * loaded extent kept in the history entry so Back can load the same pages
 * again before #5's return looks for its photograph.
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
    /** Entries loaded, the first page included. */
    loaded: number;
}

export type PageAnswer =
    | { kind: 'ok'; entries: SeriesEntry[]; nextHref: string | null }
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

/** One continuation page from `href`, a path the server made. An abort rejects with the signal's reason, for the caller to drop. */
export async function fetchSeriesPage(href: string, revisionId: string, signal: AbortSignal): Promise<PageAnswer> {
    let response: Response;
    try {
        response = await fetch(href, { signal, headers: { Accept: 'application/json' } });
    } catch (error) {
        if (signal.aborted) throw error;
        return { kind: 'error' };
    }
    if (response.status === 409 || response.status === 404 || response.status === 400) return { kind: 'stale' };
    if (!response.ok) return { kind: 'error' };
    let body: { revisionId?: unknown; entries?: unknown; nextHref?: unknown };
    try {
        body = await response.json();
    } catch (error) {
        if (signal.aborted) throw error;
        return { kind: 'error' };
    }
    const { entries, nextHref } = body;
    if (body.revisionId !== revisionId || !Array.isArray(entries) || entries.length === 0 || !entries.every(isEntry)) return { kind: 'error' };
    if (nextHref !== null && (typeof nextHref !== 'string' || !nextHref.startsWith(PAGES_PATH))) return { kind: 'error' };
    return { kind: 'ok', entries, nextHref };
}

/** The extent the history entry holds for this page, or null when it holds none, or one for another revision or series. */
export function readSeriesPages(state: unknown, revisionId: string, slug: string, total: number): number | null {
    if (typeof state !== 'object' || state === null) return null;
    const saved = (state as Record<string, unknown>)[SERIES_PAGES_KEY];
    if (typeof saved !== 'object' || saved === null) return null;
    const { revisionId: savedRevision, slug: savedSlug, loaded } = saved as Record<string, unknown>;
    if (savedRevision !== revisionId || savedSlug !== slug) return null;
    if (typeof loaded !== 'number' || !Number.isInteger(loaded) || loaded < 1 || loaded > total) return null;
    return loaded;
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
