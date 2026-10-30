'use client';

import { usePathname, useSelectedLayoutSegments } from 'next/navigation';
import { lazy, useEffect, useRef, type ReactNode } from 'react';
import { loadViewerShell } from './viewerShellLoader';
import { isViewerPath } from './viewerKeys';
import { whenIdle } from './whenIdle';

// Lazy, so the Viewer's styles stay out of the series page's first load (viewerShellLoader).
const ViewerShell = lazy(loadViewerShell);

// A direct load of a photo page asks for the shell as soon as this module runs, ahead of hydration.
if (typeof window !== 'undefined' && isViewerPath(window.location.pathname)) void loadViewerShell().catch(() => {});

/** The intercepted route's segment in the `@modal` slot. */
const MODAL_SEGMENT = '(.)photo';

interface Opener {
    element: HTMLElement;
    /** The photograph the link opened, so its series entry, `id="photo-<photoId>"`, can stand in for a re-rendered link. */
    photoId: string;
}

/** The last segment of a Viewer path, its photo ID. */
function photoIdOf(pathname: string): string {
    return pathname.replace(/\/$/, '').split('/').pop() ?? '';
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
 * modal closes, however many moves came between. If that link is no longer
 * in the document, focus goes to the series entry of the photograph that
 * opened the modal, `photo-<photoId>`.
 */
export default function ViewerHost({ children, modal }: { children: ReactNode; modal: ReactNode }) {
    const pathname = usePathname();
    const onPhotoPage = useSelectedLayoutSegments()[0] === 'photo';
    // Next wraps the slot's tree in a `(__SLOT__)` segment, so look for the route's own segment anywhere in it.
    const slotHoldsPhoto = useSelectedLayoutSegments('modal').includes(MODAL_SEGMENT) && isViewerPath(pathname);
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
            opener.current = { element: link, photoId: photoIdOf(url.pathname) };
        };
        // Capture, so it's recorded before the link's own handler starts the navigation.
        document.addEventListener('click', onClick, true);
        return () => document.removeEventListener('click', onClick, true);
    }, []);

    // On the series page, the shell and its styles load ahead of an open: on a photo link's intent (a pointer over
    // it, focus on it, a touch on it) and once the browser is idle.
    useEffect(() => {
        if (onPhotoPage) return;
        const onIntent = (event: Event) => {
            const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
            if (link === null || link.closest('[data-surface="viewer"]') !== null) return;
            if (isViewerPath(new URL(link.href, window.location.href).pathname)) void loadViewerShell().catch(() => {});
        };
        const intents = ['pointerover', 'focusin', 'touchstart'] as const;
        for (const type of intents) document.addEventListener(type, onIntent, { capture: true, passive: true });
        const cancelIdle = whenIdle(() => void loadViewerShell().catch(() => {}));
        return () => {
            for (const type of intents) document.removeEventListener(type, onIntent, { capture: true });
            cancelIdle();
        };
    }, [onPhotoPage]);

    useEffect(() => {
        if (wasOpen.current && !modalOpen) {
            const recorded = opener.current;
            opener.current = null;
            // The series page stays mounted under the modal, so the opener is normally the same node. If the series re-rendered its
            // entries (Show more, #6), the old node is gone: focus the entry for the photograph that opened the modal, not the one shown last.
            const target = recorded?.element.isConnected ? recorded.element : recorded?.photoId ? document.getElementById(`photo-${recorded.photoId}`) : null;
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
