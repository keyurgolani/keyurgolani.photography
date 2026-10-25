'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { isViewerPath } from '@/components/viewer/viewerKeys';
import { openerOf, readReturn, restoreReturn, scheduleRestore, withReturn } from './returnPosition';

export interface SeriesReturnProps {
    /** The series path, `/work/<slug>`, whose Viewer links count. */
    path: string;
    slug: string;
    /** The revision the page came from, so a stored #6 extent from another revision isn't waited for. */
    revisionId: string;
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
 *   and focuses the opener, after #6's entries when it's loading a stored
 *   extent. A reload of the series page itself restores nothing.
 * - Closing the intercepted Viewer (#9), by Close, Escape, or Back, leaves
 *   this page mounted. #9's host puts focus back on the opener; this puts the
 *   scroll offset back too, in case the page moved under the modal.
 */
export default function SeriesReturn({ path, slug, revisionId }: SeriesReturnProps) {
    const pathname = usePathname();
    // True only while this render hydrates server HTML, so the mount can tell a document load from a client render.
    const hydrating = useSyncExternalStore(subscribeNever, () => false, () => true);
    const hydrated = useRef(hydrating);
    // The series this mount arrived on. A later refresh in place is no return.
    const arrivedOn = useRef({ slug, revisionId });
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
        // The visitor reloaded the series page: the browser keeps its own place, and nothing was just closed.
        if (hydrated.current && navigationType() === 'reload') return;
        return scheduleRestore(record, arrivedOn.current);
    }, []);

    useEffect(() => {
        const previous = previousPath.current;
        previousPath.current = pathname;
        if (previous === null || pathname !== path || !isViewerPath(previous)) return;
        const record = readReturn(window.history.state);
        if (record !== null) restoreReturn(record);
    }, [pathname, path]);

    return null;
}
