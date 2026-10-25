// The series page's return position (#5): what it keeps in the series' own
// history entry when a photograph opens the Viewer, and how it puts the
// visitor back. No React and no imports, so a unit test reads it alone.

/** The key in `history.state`. Next keeps its router keys in the same object, so every write spreads it. */
export const RETURN_KEY = 'kgSeriesReturn';
/** #6's loaded extent, `{ revisionId, slug, loaded }`, which a remounted series page loads again before it restores. */
export const EXTENT_KEY = 'kgSeriesPages';
/** What #6 fires, bubbling from the sequence section, once a stored extent is loaded again or has failed. */
export const ENTRIES_RESTORED_EVENT = 'kg:series-entries-restored';
/** The cover's link. Entries are `photo-<photoId>`. */
export const COVER_ID = 'series-cover';
/** How long a restore waits for #6's event before it restores with what's there, so focus is never left waiting. */
export const RESTORE_WAIT_MS = 10_000;

/** Which link opened the Viewer: the cover, or the photograph's own sequence entry. */
export type Opener = 'cover' | 'entry';

export interface SeriesReturn {
    /** The photograph the link opened. */
    photoId: string;
    opener: Opener;
    /** The page's scroll offset when the link was activated, in CSS px. */
    scrollY: number;
}

/** Photo IDs as #13 mints them, and nothing that could reach outside `photo-<photoId>`. */
const PHOTO_ID = /^[A-Za-z0-9_-]{1,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The series entry's state with `record` added, keeping every other key (Next's router keys and #6's extent). */
export function withReturn(state: unknown, record: SeriesReturn): Record<string, unknown> {
    return { ...(isRecord(state) ? state : {}), [RETURN_KEY]: { photoId: record.photoId, opener: record.opener, scrollY: record.scrollY } };
}

/** The record in `state`, or null when there's none or it isn't one this page wrote. */
export function readReturn(state: unknown): SeriesReturn | null {
    const value = isRecord(state) ? state[RETURN_KEY] : undefined;
    if (!isRecord(value)) return null;
    const { photoId, opener, scrollY } = value;
    if (typeof photoId !== 'string' || !PHOTO_ID.test(photoId)) return null;
    if (opener !== 'cover' && opener !== 'entry') return null;
    if (typeof scrollY !== 'number' || !Number.isFinite(scrollY) || scrollY < 0) return null;
    return { photoId, opener, scrollY };
}

/** The element id of a photograph's sequence entry. */
export const entryId = (photoId: string) => `photo-${photoId}`;

/**
 * Whether `state` holds #6's loaded extent for this series in this revision,
 * the one case where #6 loads pages again on mount and fires
 * ENTRIES_RESTORED_EVENT when it's done.
 */
export function hasStoredExtent(state: unknown, series: { slug: string; revisionId: string }): boolean {
    const extent = isRecord(state) ? state[EXTENT_KEY] : undefined;
    if (!isRecord(extent)) return false;
    return extent.slug === series.slug && extent.revisionId === series.revisionId && Number.isInteger(extent.loaded) && (extent.loaded as number) > 0;
}

/**
 * The opener a plain activation of `link` records, or null when it isn't one
 * of this page's Viewer entries: the cover (`series-cover`) or a sequence
 * entry (`photo-<photoId>`), linking to a Viewer URL under `seriesPath`.
 */
export function openerOf(link: { id: string; href: string }, seriesPath: string, base: string): { opener: Opener; photoId: string } | null {
    let url: URL;
    try {
        url = new URL(link.href, base);
    } catch {
        return null;
    }
    if (url.origin !== new URL(base).origin) return null;
    const prefix = `${seriesPath.replace(/\/$/, '')}/photo/`;
    if (!url.pathname.startsWith(prefix)) return null;
    const photoId = url.pathname.slice(prefix.length).replace(/\/$/, '');
    if (!PHOTO_ID.test(photoId)) return null;
    if (link.id === COVER_ID) return { opener: 'cover', photoId };
    if (link.id === entryId(photoId)) return { opener: 'entry', photoId };
    return null;
}

/**
 * Puts the visitor back where `record` says: the scroll offset first, then
 * focus on the link that opened the Viewer, without moving the page again.
 * If the layout changed so that link is out of view at that offset (another
 * viewport size after a reload), it's scrolled into view. A cover link that's
 * gone falls back to the photograph's entry. When neither is on the page
 * (the photograph left the revision) only the scroll offset comes back; the
 * heading fallback is deferred.
 */
export function restoreReturn(record: SeriesReturn, doc: Document = document): HTMLElement | null {
    const view = doc.defaultView;
    view?.scrollTo({ top: record.scrollY, left: 0, behavior: 'instant' });
    const target = (record.opener === 'cover' ? doc.getElementById(COVER_ID) : null) ?? doc.getElementById(entryId(record.photoId));
    if (target === null) return null;
    const box = target.getBoundingClientRect();
    const height = view?.innerHeight ?? 0;
    if (box.bottom <= 0 || box.top >= height) target.scrollIntoView({ block: 'center', behavior: 'instant' });
    target.focus({ preventScroll: true });
    return target;
}

/** The sequence section, which #6 marks `aria-busy` while it loads a stored extent again. */
function sequenceSection(doc: Document): Element | null {
    return doc.getElementById('series-sequence')?.closest('section') ?? null;
}

/**
 * Restores `record` now, or, while #6 loads a stored extent again, once it
 * fires ENTRIES_RESTORED_EVENT (or RESTORE_WAIT_MS passes), so the scroll
 * offset and the opener exist by then. Returns the cancel.
 */
export function scheduleRestore(record: SeriesReturn, series: { slug: string; revisionId: string }): () => void {
    const wait = sequenceSection(document)?.getAttribute('aria-busy') === 'true' || hasStoredExtent(window.history.state, series);
    if (!wait) {
        restoreReturn(record);
        return () => undefined;
    }
    let pending = true;
    const stop = () => {
        pending = false;
        window.removeEventListener(ENTRIES_RESTORED_EVENT, finish);
        window.clearTimeout(timer);
    };
    function finish() {
        if (!pending) return;
        stop();
        restoreReturn(record);
    }
    window.addEventListener(ENTRIES_RESTORED_EVENT, finish);
    const timer = window.setTimeout(finish, RESTORE_WAIT_MS);
    return stop;
}
