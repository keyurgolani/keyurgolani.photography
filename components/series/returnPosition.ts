// The series page's return position (#5): what it keeps in the series' own
// history entry when a photograph opens the Viewer, and how it puts the
// visitor back. No React. The return contract with #6 (the stored extent,
// `aria-busy`, and the restored event) comes from seriesContinuation.ts.
import { readSeriesPages, SERIES_RESTORED_EVENT } from './seriesContinuation';

/** The key in `history.state`. Next keeps its router keys in the same object, so every write spreads it. */
export const RETURN_KEY = 'kgSeriesReturn';
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

/** What a restore needs to know about the page: #6's extent is only for this slug, revision, and total. */
export interface SeriesOnPage {
    slug: string;
    revisionId: string;
    /** Every member that resolves. */
    total: number;
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

/** The link `record` returns to: the cover when it opened the Viewer and is still there, else the photograph's entry. */
function openerElement(record: SeriesReturn, doc: Document): HTMLElement | null {
    return (record.opener === 'cover' ? doc.getElementById(COVER_ID) : null) ?? doc.getElementById(entryId(record.photoId));
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
    const target = openerElement(record, doc);
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
 * Restores `record` now, or, when its opener isn't on the page yet and #6
 * is loading this history entry's pages again (the section is `aria-busy`,
 * or the entry holds an extent for this series, which #6 starts loading in
 * the same commit), once #6 fires SERIES_RESTORED_EVENT. RESTORE_WAIT_MS
 * caps the wait, so focus never waits forever. Returns the cancel.
 */
export function scheduleRestore(record: SeriesReturn, series: SeriesOnPage): () => void {
    const restoring = sequenceSection(document)?.getAttribute('aria-busy') === 'true' || readSeriesPages(window.history.state, series.revisionId, series.slug, series.total) !== null;
    if (openerElement(record, document) !== null || !restoring) {
        restoreReturn(record);
        return () => undefined;
    }
    // Whichever comes first, the event or the timeout, removes both, so the restore runs once.
    const stop = () => {
        window.removeEventListener(SERIES_RESTORED_EVENT, finish);
        window.clearTimeout(timer);
    };
    function finish() {
        stop();
        restoreReturn(record);
    }
    window.addEventListener(SERIES_RESTORED_EVENT, finish);
    const timer = window.setTimeout(finish, RESTORE_WAIT_MS);
    return stop;
}
