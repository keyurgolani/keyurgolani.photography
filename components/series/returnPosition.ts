// The series page's return position (#5): what it keeps in the series' own
// history entry when a photograph opens the Viewer, and how it puts the
// visitor back. No React. The return contract with #6 (the stored extent
// and the restored event) comes from seriesContinuation.ts.
import { readSeriesPages, SERIES_RESTORED_EVENT } from './seriesContinuation';

/** The key in `history.state`. Next keeps its router keys in the same object, so every write spreads it. */
export const RETURN_KEY = 'kgSeriesReturn';
/** The cover's link. Entries are `photo-<photoId>`. */
export const COVER_ID = 'series-cover';
/** The series page's h1, where focus goes when the photograph to return to is gone (#5, B5). */
export const SERIES_TITLE_ID = 'series-title';
/**
 * The key in `history.state` that says this entry's `?photo=` has had its
 * one focus (B5): set when a deep link's arrival focuses its entry, and when
 * an activation writes `?photo=`, so a later Back to the entry from Work or
 * another site leaves the visitor where the browser puts them, as before.
 */
export const ARRIVAL_KEY = 'kgSeriesArrival';
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
    /** The first position of the server's page: 1, or later for `?photo=` (B5). */
    first?: number;
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
export function openerElement(record: SeriesReturn, doc: Document = document): HTMLElement | null {
    return (record.opener === 'cover' ? doc.getElementById(COVER_ID) : null) ?? doc.getElementById(entryId(record.photoId));
}

/** The entry's state with the arrival mark for `photoId` added, keeping every other key. */
export function withArrival(state: unknown, photoId: string): Record<string, unknown> {
    return { ...(isRecord(state) ? state : {}), [ARRIVAL_KEY]: photoId };
}

/** The photograph whose `?photo=` focus this entry has had, or null. */
export function arrivalOf(state: unknown): string | null {
    const value = isRecord(state) ? state[ARRIVAL_KEY] : undefined;
    return typeof value === 'string' && PHOTO_ID.test(value) ? value : null;
}

/**
 * Lets the series heading take focus from script only: `tabindex="-1"`
 * while it has focus, taken off again when focus leaves, so the server HTML
 * and the Tab order stay as they were.
 */
function focusableHeading(heading: HTMLElement): HTMLElement {
    if (!heading.hasAttribute('tabindex')) {
        heading.setAttribute('tabindex', '-1');
        heading.addEventListener('blur', () => heading.removeAttribute('tabindex'), { once: true });
    }
    return heading;
}

/** The series heading, ready to take focus, or null when the page has none. */
function headingOf(doc: Document): HTMLElement | null {
    const heading = doc.getElementById(SERIES_TITLE_ID);
    return heading === null ? null : focusableHeading(heading);
}

/** Focuses the series heading, as #5's fallback does, and returns it. Null when there's none. */
export function focusHeading(doc: Document = document): HTMLElement | null {
    const heading = headingOf(doc);
    heading?.focus();
    return heading;
}

/**
 * Focuses `target` and brings it to the middle of the view, for a return or
 * an arrival with no offset of its own to put back: a deep link's entry
 * (B5), or the photograph after a refresh replaced the page it came back to.
 */
export function focusInView(target: HTMLElement): HTMLElement {
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'center', behavior: 'instant' });
    return target;
}

export interface RestoreOptions {
    /** Put the scroll offset back. Off once the visitor has moved the page themselves. */
    scroll?: boolean;
    /** Focus the opener only when nothing else has focus, so a late restore never takes it from where the visitor went. */
    onlyIfIdle?: boolean;
    /**
     * Fall back to the series heading when neither the cover nor the entry
     * is on the page. Off by default: only a caller that knows the
     * photograph left the revision (the server said so) turns it on.
     */
    heading?: boolean;
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
 * falls back to the photograph's entry. When neither is on the page, focus
 * stays where it is, unless `heading` says the photograph is known to have
 * left the revision: then it goes to the series heading, `#series-title`,
 * the same way (B5).
 */
export function restoreReturn(record: SeriesReturn, { scroll = true, onlyIfIdle = false, heading = false }: RestoreOptions = {}, doc: Document = document): HTMLElement | null {
    const view = doc.defaultView;
    if (scroll) view?.scrollTo({ top: record.scrollY, left: 0, behavior: 'instant' });
    const opener = openerElement(record, doc);
    const target = opener ?? (heading && !(onlyIfIdle && !focusIsIdle(doc)) ? headingOf(doc) : null);
    if (target === null) return null;
    if (onlyIfIdle && !focusIsIdle(doc)) return null;
    const box = target.getBoundingClientRect();
    const whollyInView = box.top >= 0 && box.bottom <= (view?.innerHeight ?? 0);
    if (!whollyInView) {
        // With the scroll off (the visitor has moved), an opener out of view keeps its focus off too, so nothing jumps.
        if (!scroll) return null;
        target.scrollIntoView({ block: 'nearest', behavior: 'instant' });
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
 * Restores `record` and uses it up. It restores at once unless #6 is
 * loading this history entry's pages again (the entry holds an extent
 * readSeriesPages() accepts for this series, which #6 starts loading in the
 * same commit) and either its opener isn't on the page yet or the extent
 * starts before the server's page (B5's deep entry), whose earlier pages
 * would move the page under a restored offset. Then it waits for #6's
 * SERIES_RESTORED_EVENT. RESTORE_WAIT_MS caps that wait with what's there,
 * and a later event still focuses the opener. When the restore is done (at
 * once, or on the event, never at the timeout) and the photograph still
 * isn't on the page, it hands the record to `onMissing`: the saved pages
 * couldn't bring it back, and only the server can say whether it's in the
 * revision at all (B5). Either way a delayed restore
 * skips the scroll once the visitor has pressed a key, pressed a pointer or
 * turned the wheel, and moves focus only from the body. Returns the cancel.
 */
export function scheduleRestore(record: SeriesReturn, series: SeriesOnPage, onMissing: (record: SeriesReturn) => void = () => undefined): () => void {
    const extent = readSeriesPages(window.history.state, series.revisionId, series.slug, series.total);
    const prepends = extent !== null && extent.first < (series.first ?? 1);
    if (extent === null || (openerElement(record, document) !== null && !prepends)) {
        restoreReturn(record);
        clearReturn();
        if (openerElement(record, document) === null) onMissing(record);
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
        if (openerElement(record, document) === null) onMissing(record);
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

