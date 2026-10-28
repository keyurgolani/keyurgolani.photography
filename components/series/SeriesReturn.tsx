'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { isViewerPath } from '@/components/viewer/viewerKeys';
import { clearReturn, openerOf, readReturn, restoreReturn, scheduleRestore, withReturn } from './returnPosition';

export interface SeriesReturnProps {
    /** The series path, `/work/<slug>`, whose Viewer links count. */
    path: string;
    slug: string;
    /** The revision the page came from, so a stored #6 extent from another revision isn't waited for. */
    revisionId: string;
    /** Every member that resolves, which bounds #6's extent. */
    total: number;
}

const subscribeNever = () => () => undefined;

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
 *   spread so Next's router keys and #6's extent survive. The Viewer then
 *   pushes its own entry, and its Previous and Next replace that one, so this
 *   record still names the photograph that opened it.
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
export default function SeriesReturn({ path, slug, revisionId, total }: SeriesReturnProps) {
    const pathname = usePathname();
    // True only while this render hydrates server HTML, so the mount can tell a document load from a client render.
    const hydrating = useSyncExternalStore(subscribeNever, () => false, () => true);
    const hydrated = useRef(hydrating);
    const previousPath = useRef<string | null>(null);

    useEffect(() => {
        const onClick = (event: MouseEvent) => {
            if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
            if (link === null) return;
            const opener = openerOf(link, path, window.location.href);
            if (opener === null) return;
            window.history.replaceState(withReturn(window.history.state, { ...opener, scrollY: window.scrollY }), '');
        };
        // Capture, so the record is in the series' entry before the link's own handler pushes the Viewer's.
        document.addEventListener('click', onClick, true);
        return () => document.removeEventListener('click', onClick, true);
    }, [path]);

    useEffect(() => {
        const record = readReturn(window.history.state);
        if (record === null) return;
        // The visitor reloaded the series page: the browser keeps its own place, nothing was just closed, and the record is spent.
        if (hydrated.current && navigationType() === 'reload') return clearReturn();
        return scheduleRestore(record, { slug, revisionId, total });
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
