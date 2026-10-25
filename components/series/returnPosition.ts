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

export interface RestoreOptions {
    /** Put the scroll offset back. Off once the visitor has moved the page themselves. */
    scroll?: boolean;
    /** Focus the opener only when nothing else has focus, so a late restore never takes it from where the visitor went. */
    onlyIfIdle?: boolean;
}

/** Whether focus is on nothing in particular: the body, or no element at all. */
function focusIsIdle(doc: Document): boolean {
    return doc.activeElement === null || doc.activeElement === doc.body;
}

/**
 * Puts the visitor back where `record` says: the scroll offset first, then
 * focus on the link that opened the Viewer, without moving the page again.
 * If the layout changed so that link isn't wholly in view at that offset
 * (another viewport size after a reload), it's scrolled the least distance
 * that shows it, within the page's scroll padding. A cover link that's gone
 * falls back to the photograph's entry. When neither is on the page (the
 * photograph left the revision) only the scroll offset comes back; the
 * heading fallback is deferred.
 */
export function restoreReturn(record: SeriesReturn, { scroll = true, onlyIfIdle = false }: RestoreOptions = {}, doc: Document = document): HTMLElement | null {
    const view = doc.defaultView;
    if (scroll) view?.scrollTo({ top: record.scrollY, left: 0, behavior: 'instant' });
    const target = openerElement(record, doc);
    if (target === null) return null;
    if (onlyIfIdle && !focusIsIdle(doc)) return null;
    if (scroll) {
        const box = target.getBoundingClientRect();
        if (box.top < 0 || box.bottom > (view?.innerHeight ?? 0)) target.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
    target.focus({ preventScroll: true });
    return target;
}

/** Takes the record out of the series' entry with the same spread, so it's used once: a later Back that isn't from the Viewer moves nothing. */
export function clearReturn(): void {
    const state: unknown = window.history.state;
    if (!isRecord(state) || !(RETURN_KEY in state)) return;
    const rest = { ...state };
    delete rest[RETURN_KEY];
    window.history.replaceState(rest, '');
}

/** What the visitor does that means they've taken over: a key, a press, or the wheel. */
const INPUT_EVENTS = ['keydown', 'pointerdown', 'wheel'] as const;

/**
 * Restores `record` and uses it up. It restores at once unless its opener
 * isn't on the page yet and #6 is loading this history entry's pages again
 * (the entry holds an extent readSeriesPages() accepts for this series,
 * which #6 starts loading in the same commit). Then it waits for #6's
 * SERIES_RESTORED_EVENT. RESTORE_WAIT_MS caps that wait with what's there,
 * and a later event still focuses the opener. Either way a delayed restore
 * skips the scroll once the visitor has pressed a key, pressed a pointer or
 * turned the wheel, and moves focus only from the body. Returns the cancel.
 */
export function scheduleRestore(record: SeriesReturn, series: SeriesOnPage): () => void {
    const restoring = readSeriesPages(window.history.state, series.revisionId, series.slug, series.total) !== null;
    if (openerElement(record, document) !== null || !restoring) {
        restoreReturn(record);
        clearReturn();
        return () => undefined;
    }
    let moved = false;
    const onInput = () => {
        moved = true;
    };
    const late = () => restoreReturn(record, { scroll: !moved, onlyIfIdle: true });
    const stop = () => {
        window.removeEventListener(SERIES_RESTORED_EVENT, onRestored);
        window.clearTimeout(timer);
        for (const type of INPUT_EVENTS) window.removeEventListener(type, onInput, true);
    };
    function onRestored() {
        stop();
        late();
        clearReturn();
    }
    // The timeout restores what it can and keeps listening, so #6 finishing later still brings focus back.
    function onTimeout() {
        late();
        clearReturn();
    }
    for (const type of INPUT_EVENTS) window.addEventListener(type, onInput, { capture: true, passive: true });
    window.addEventListener(SERIES_RESTORED_EVENT, onRestored);
    const timer = window.setTimeout(onTimeout, RESTORE_WAIT_MS);
    return stop;
}

