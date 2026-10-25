'use client';

import { usePathname, useSelectedLayoutSegments } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';
import ViewerShell from './ViewerShell';
import { isViewerPath } from './viewerKeys';

/** The intercepted route's segment in the `@modal` slot. */
const MODAL_SEGMENT = '(.)photo';

interface Opener {
    element: HTMLElement;
    id: string;
}

/**
 * The Viewer's host in `app/work/[slug]/layout.tsx` (#9), above both the
 * page (`children`) and the `@modal` slot, so one ViewerShell outlives every
 * move in either mode.
 *
 * - The child is a photo page (a direct load, or a refresh): page mode. A
 *   move from a photo page matches the interception too, since its URL is
 *   under `/work/<slug>`, so after one the photograph arrives in `@modal`.
 *   The page shell shows it in place of the child, so the move never opens
 *   a dialog over the page.
 * - Otherwise (#5's series page), an intercepted photo opens in the modal
 *   shell over it. The slot keeps its last photo after a soft navigation that
 *   doesn't match it, so the modal shows only while the URL is a Viewer URL.
 *
 * It records the link that opened the modal when it's activated, since
 * Safari doesn't focus a link on click, and puts focus back on it when the
 * modal closes, however many moves came between.
 */
export default function ViewerHost({ children, modal }: { children: ReactNode; modal: ReactNode }) {
    const pathname = usePathname();
    const onPhotoPage = useSelectedLayoutSegments()[0] === 'photo';
    const slotHoldsPhoto = useSelectedLayoutSegments('modal')[0] === MODAL_SEGMENT && isViewerPath(pathname);
    const modalOpen = !onPhotoPage && slotHoldsPhoto;
    const opener = useRef<Opener | null>(null);
    const wasOpen = useRef(false);

    useEffect(() => {
        const onClick = (event: MouseEvent) => {
            if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
            if (link === null || link.closest('[data-surface="viewer"]') !== null) return;
            const url = new URL(link.href, window.location.href);
            if (url.origin !== window.location.origin || !isViewerPath(url.pathname)) return;
            opener.current = { element: link, id: link.id };
        };
        // Capture, so it's recorded before the link's own handler starts the navigation.
        document.addEventListener('click', onClick, true);
        return () => document.removeEventListener('click', onClick, true);
    }, []);

    useEffect(() => {
        if (wasOpen.current && !modalOpen) {
            const recorded = opener.current;
            opener.current = null;
            // The series page stays mounted under the modal, so the opener is normally the same node. If it was re-rendered, find it by id.
            const target = recorded?.element.isConnected ? recorded.element : recorded?.id ? document.getElementById(recorded.id) : null;
            target?.focus();
        }
        wasOpen.current = modalOpen;
    }, [modalOpen]);

    if (onPhotoPage) return <ViewerShell mode="page">{slotHoldsPhoto ? modal : children}</ViewerShell>;
    return (
        <>
            {children}
            {modalOpen ? <ViewerShell mode="modal">{modal}</ViewerShell> : null}
        </>
    );
}
