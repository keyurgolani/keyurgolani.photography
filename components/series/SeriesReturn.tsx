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
    RETURN_KEY,
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

/**
 * The series URL with `?photo=<photoId>` in place of any there, the other
 * parameters and the hash kept, built as every redirect's Location is
 * (redirectLocation(), with its length cap), or null when the path isn't
 * one it takes.
 */
function urlWithPhoto(photoId: string): string | null {
    const { pathname, search, hash } = window.location;
    const query = new URLSearchParams(search);
    query.set(PHOTO_PARAM, photoId);
    try {
        return `${redirectLocation(pathname, query)}${hash}`;
    } catch {
        return null;
    }
}

/** The keys a refresh drops (#6's limit 24) that the return still needs: the record and #6's extent. */
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
 *   spread so Next's router keys and #6's extent survive, and `?photo=` into
 *   its URL (B5), so the entry names its photograph even after a reload or
 *   in a copied link. The Viewer then pushes its own entry, and its Previous
 *   and Next replace that one, so this record still names the photograph
 *   that opened it.
 * - The URL's `?photo=` is read first (B5). With no return record, a
 *   document load or a soft navigation to it (a shared link, or Close from
 *   a directly loaded photograph) focuses that photograph's entry, in the
 *   middle of the view, once per history entry, and only when the server
 *   found it. A photograph the server didn't find gets the plain page, with
 *   nothing moved.
 * - A return record whose photograph isn't on a page that mounted from the
 *   router's cache (Back restored another page than the one `?photo=`
 *   names) refreshes once, so the server sends the page that holds it. The
 *   refresh drops `kgSeriesPages` and `kgSeriesReturn` (#6's limit 24), so
 *   both are written back as it lands, before #6 looks for its extent, and
 *   the photograph is focused without the saved offset, which was for the
 *   other page. When the opened photograph left the revision, focus goes to
 *   the series heading.
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
    /** The keys a refresh this mount asked for will drop, until it lands. At most one refresh per mount. */
    const refreshing = useRef<HeldKeys | null>(null);
    const refreshed = useRef(false);

    useEffect(() => {
        const onClick = (event: MouseEvent) => {
            if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
            if (link === null) return;
            const opener = openerOf(link, path, window.location.href);
            if (opener === null) return;
            const state = withArrival(withReturn(window.history.state, { ...opener, scrollY: window.scrollY }), opener.photoId);
            // The state keeps Next's own keys, so Next leaves the write alone and reads the URL back on the next traversal.
            const url = window.location.pathname === path ? urlWithPhoto(opener.photoId) : null;
            if (url === null) window.history.replaceState(state, '');
            else window.history.replaceState(state, '', url);
        };
        // Capture, so the record is in the series' entry before the link's own handler pushes the Viewer's.
        document.addEventListener('click', onClick, true);
        return () => document.removeEventListener('click', onClick, true);
    }, [path]);

    useEffect(() => {
        const state: unknown = window.history.state;
        const record = readReturn(state);
        const asked = photoInUrl();
        const documentLoad = hydrated.current;
        // The visitor reloaded the series page: the browser keeps its own place, nothing was just closed, and the record is spent.
        if (documentLoad && navigationType() === 'reload') {
            if (record !== null) clearReturn();
            return;
        }
        if (record !== null && (asked === null || asked === record.photoId)) {
            // A render from the router's cache can be another page than the one ?photo= names: ask the server for this URL's,
            // once. The layout effect below restores when it lands, so this mount never restores from the cached page.
            if (asked !== null && !documentLoad && openerElement(record) === null) {
                if (refreshed.current) return;
                refreshed.current = true;
                refreshing.current = { record, pages: (state as Record<string, unknown>)[SERIES_PAGES_KEY] };
                router.refresh();
                return;
            }
            return scheduleRestore(record, { slug, revisionId, total, first: firstPosition });
        }
        // A record for another photograph than the URL names isn't this entry's return.
        if (record !== null) clearReturn();
        if (asked === null || asked !== focusPhotoId || arrivalOf(state) === asked) return;
        const target = document.getElementById(entryId(asked));
        if (target === null) return;
        focusInView(target);
        window.history.replaceState(withArrival(window.history.state, asked), '');
        // Once per mount, with the props it arrived on: a refresh in place is no return.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // The refresh this mount asked for has landed once Next has rewritten the entry without the record. Before #6's
    // effects read the extent, put both keys back, then focus the photograph, or the heading if it left the revision.
    useLayoutEffect(() => {
        const held = refreshing.current;
        const state: unknown = window.history.state;
        if (held === null || (typeof state === 'object' && state !== null && RETURN_KEY in state)) return;
        refreshing.current = null;
        writeBack(held);
        const target = openerElement(held.record);
        if (target === null) focusHeading();
        else focusInView(target);
        window.history.replaceState(withArrival(window.history.state, held.record.photoId), '');
        clearReturn();
    });

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
