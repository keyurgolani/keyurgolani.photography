'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { isViewerPath } from '@/components/viewer/viewerKeys';
import { PHOTO_PARAM, photoParamOf } from '@/lib/catalog/routes';
import { redirectLocation } from '@/lib/site/redirect';
import {
    arrivalOf,
    clearReturn,
    entryId,
    focusHeading,
    focusInView,
    openerElement,
    openerOf,
    readReturn,
    RESTORE_WAIT_MS,
    restoreReturn,
    scheduleRestore,
    withArrival,
    withReturn,
    type SeriesReturn as ReturnRecord,
} from './returnPosition';
import { SERIES_PAGES_KEY } from './seriesContinuation';

export interface SeriesReturnProps {
    /** The series path, `/work/<slug>`, whose Viewer links count. */
    path: string;
    slug: string;
    /** The revision the page came from, so a stored #6 extent from another revision isn't waited for. */
    revisionId: string;
    /** Every member that resolves, which bounds #6's extent. */
    total: number;
    /** The first position of the server's page: 1, or later for `?photo=` (B5), when #6 may load pages before it. */
    firstPosition: number;
    /**
     * The photograph `?photo=` named, as the server found it in this
     * revision (B5), or null: no parameter, or one that names none of this
     * series' photographs. The page the server rendered holds it.
     */
    focusPhotoId: string | null;
}

const subscribeNever = () => () => undefined;

/** The one photo ID the URL's `?photo=` names, or null (absent, repeated, or not a photo ID). */
function photoInUrl(): string | null {
    const values = new URLSearchParams(window.location.search).getAll(PHOTO_PARAM);
    return values.length === 1 ? photoParamOf(values[0]) : null;
}

/** The series path with `?photo=<photoId>` set, the visitor's other parameters kept, built as every redirect's Location is (redirectLocation(), with its cap). */
function hrefWithPhoto(path: string, photoId: string): string {
    const query = new URLSearchParams(window.location.search);
    query.set(PHOTO_PARAM, photoId);
    return redirectLocation(path, query);
}

/** What a return needs back once the server's page for its photograph lands: the record, and #6's extent, which the navigation drops (#6's limit 24). */
interface HeldKeys {
    record: ReturnRecord;
    pages: unknown;
}

/** Puts `held` back into the current entry, keeping whatever Next wrote there. */
function writeBack(held: HeldKeys): void {
    const state: unknown = window.history.state;
    const base = typeof state === 'object' && state !== null ? state : {};
    const pages = held.pages === undefined ? {} : { [SERIES_PAGES_KEY]: held.pages };
    window.history.replaceState(withReturn({ ...base, ...pages }, held.record), '');
}

/**
 * A return that asked the server for its photograph's page (`?photo=`), until
 * that page lands. Module scope, not a ref, so it's found whether the answer
 * renders this component again in place (Next 16, for a query-only replace)
 * or the series page under it mounts afresh. Its own marker is the URL it
 * asked for, so nothing depends on how Next rewrites the entry.
 */
let pendingFind: (HeldKeys & { path: string; timer: ReturnType<typeof setTimeout> }) | null = null;

function endFind(): void {
    if (pendingFind !== null) clearTimeout(pendingFind.timer);
    pendingFind = null;
}

/**
 * Focus `held`'s photograph if it's on the page, else the heading, and use the
 * record up. Focus the visitor moved during the round trip stays where it is.
 */
function landReturn(held: HeldKeys): void {
    const focused = document.activeElement;
    if (focused === null || focused === document.body) {
        const target = openerElement(held.record);
        if (target === null) focusHeading();
        else focusInView(target);
    }
    clearReturn();
}

/** The document's own navigation type: `reload`, `back_forward`, or `navigate`. */
function navigationType(): string | undefined {
    const [entry] = typeof performance === 'undefined' ? [] : performance.getEntriesByType('navigation');
    return (entry as PerformanceNavigationTiming | undefined)?.type;
}

/**
 * The series page's return position (#5), kept in platform history and found
 * again by element IDs. Renders nothing.
 *
 * - A plain activation of the cover or a sequence entry writes
 *   `{ photoId, opener, scrollY }` into the series' own history entry, as a
 *   spread so Next's router keys and #6's extent survive. The URL stays as
 *   it is, so a reload or a copied link starts where the page does. The
 *   Viewer then pushes its own entry, and its Previous and Next replace that
 *   one, so this record still names the photograph that opened it.
 * - The URL's `?photo=` comes only from outside: an inbound deep link, or
 *   Close on a directly loaded photograph (B5). With no return record, a
 *   document load or a soft navigation to it focuses that photograph's
 *   entry, in the middle of the view, once per history entry, and only when
 *   the server found it. A photograph the server didn't find gets the plain
 *   page, with nothing moved.
 * - When a return's saved pages can't bring its photograph back (no extent,
 *   one for another revision, or one that ended without it), it asks the
 *   server once for the page that holds it, with `?photo=` and no scroll.
 *   When that page lands (in place, or mounted afresh), it writes
 *   `kgSeriesPages` and `kgSeriesReturn` back before #6 reads them (the
 *   navigation drops both, #6's limit 24), and focuses the photograph. Only
 *   when the server's answer doesn't hold it (it left the revision) does
 *   focus go to the series heading. If the answer never lands,
 *   RESTORE_WAIT_MS later focus goes there. Either way it moves focus only
 *   from the body, never from where the visitor put it, and the record is
 *   used up.
 * - Back to a series page that mounts again (after a reload on the Viewer,
 *   or any return that renders the page afresh) restores the scroll offset
 *   and focuses the opener. When the opener is past what's loaded and #6 is
 *   loading the entry's stored pages again, that waits for #6's event. A
 *   reload of the series page itself restores nothing.
 * - Closing the intercepted Viewer (#9), by Close, Escape, or Back, leaves
 *   this page mounted. #9's host puts focus back on the opener; this puts the
 *   scroll offset back too, in case the page moved under the modal.
 * - Every restore, and the reload that skips one, takes the record out of the
 *   entry. So a later Back to the series from anywhere but the Viewer (Work,
 *   another site) leaves the visitor where the browser puts them. Forward to
 *   the Viewer and Back again doesn't refocus either.
 */
export default function SeriesReturn({ path, slug, revisionId, total, firstPosition, focusPhotoId }: SeriesReturnProps) {
    const pathname = usePathname();
    const router = useRouter();
    // True only while this render hydrates server HTML, so the mount can tell a document load from a client render.
    const hydrating = useSyncExternalStore(subscribeNever, () => false, () => true);
    const hydrated = useRef(hydrating);
    const previousPath = useRef<string | null>(null);
    /** Set when this mount is the page a return asked the server for, which the layout effect has already handled. */
    const landed = useRef(false);

    useEffect(() => {
        const onClick = (event: MouseEvent) => {
            if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
            if (link === null) return;
            const opener = openerOf(link, path, window.location.href);
            if (opener === null) return;
            // The return lives in the entry's state, never in its URL, so a reload or a copied link starts where the page does.
            // A deep link's own ?photo= has had its turn once something on its page is opened.
            const state = withReturn(window.history.state, { ...opener, scrollY: window.scrollY });
            const asked = photoInUrl();
            window.history.replaceState(asked === null ? state : withArrival(state, asked), '');
        };
        // Capture, so the record is in the series' entry before the link's own handler pushes the Viewer's.
        document.addEventListener('click', onClick, true);
        return () => document.removeEventListener('click', onClick, true);
    }, [path]);

    // The page a return asked the server for has landed: put #6's extent and the record back before #6's effects read
    // them, then focus the photograph, or the heading when the server's page doesn't hold it (it left the revision).
    // After every commit, not once per mount: Next 16 keys the page segment `__PAGE__` whatever the query, so a replace
    // that only adds ?photo= renders this component again in place (SeriesSequence, keyed by the server's page, is the
    // one that mounts afresh). Next writes the new URL in an insertion effect of that same commit, so the URL check
    // passes only once the answer's page is in the DOM, and #6 reads its extent in a passive effect, after this one.
    useLayoutEffect(() => {
        const held = pendingFind;
        if (held === null || held.path !== path || photoInUrl() !== held.record.photoId) return;
        endFind();
        landed.current = true;
        writeBack(held);
        window.history.replaceState(withArrival(window.history.state, held.record.photoId), '');
        landReturn(held);
    });

    useEffect(() => {
        if (landed.current) return;
        const state: unknown = window.history.state;
        const record = readReturn(state);
        const asked = photoInUrl();
        // The visitor reloaded the series page: the browser keeps its own place, nothing was just closed, and the record is spent.
        if (hydrated.current && navigationType() === 'reload') {
            if (record !== null) clearReturn();
            if (asked !== null) window.history.replaceState(withArrival(window.history.state, asked), '');
            return;
        }
        // A return from the Viewer comes first, whatever a deep link's ?photo= named before the visitor opened something.
        if (record !== null) {
            // The saved pages couldn't bring the photograph back. When this page is already the server's answer for it,
            // it left the revision; else ask the server once for the page that holds it, with ?photo=.
            const missing = (lost: ReturnRecord) => {
                if (photoInUrl() === lost.photoId) {
                    focusHeading();
                    return;
                }
                endFind();
                const held = { record: lost, pages: (state as Record<string, unknown>)[SERIES_PAGES_KEY], path };
                const timer = setTimeout(() => {
                    // The answer never landed: put focus somewhere sensible and use the record up.
                    if (pendingFind?.timer !== timer) return;
                    endFind();
                    landReturn(held);
                }, RESTORE_WAIT_MS);
                pendingFind = { ...held, timer };
                router.replace(hrefWithPhoto(path, lost.photoId), { scroll: false });
            };
            return scheduleRestore(record, { slug, revisionId, total, first: firstPosition }, missing);
        }
        if (asked === null || asked !== focusPhotoId || arrivalOf(state) === asked) return;
        const target = document.getElementById(entryId(asked));
        if (target === null) return;
        focusInView(target);
        window.history.replaceState(withArrival(window.history.state, asked), '');
        // Once per mount, with the props it arrived on: a refresh in place is no return.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const previous = previousPath.current;
        previousPath.current = pathname;
        if (previous === null || pathname !== path || !isViewerPath(previous)) return;
        const record = readReturn(window.history.state);
        if (record === null) return;
        restoreReturn(record);
        clearReturn();
    }, [pathname, path]);

    return null;
}
