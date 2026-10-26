'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import ViewerChrome, { type ViewerChromeActions } from './ViewerChrome';
import { ViewerContext, type ViewerChromeState, type ViewerMode, type ViewerShellContext } from './viewerContext';
import { stepForKey, type ViewerStep } from './viewerKeys';
import { useDoubleTap } from './useDoubleTap';
import { useSwipe } from './useSwipe';
import { boundaryText, positionText } from './viewerLabels';
import styles from './StoryViewer.module.css';

function sameChrome(a: ViewerChromeState | null, b: ViewerChromeState): boolean {
    if (a === null) return false;
    return (Object.keys(b) as (keyof ViewerChromeState)[]).every((key) => a[key] === b[key]);
}

/**
 * The Viewer's frame for one session (#9). The [slug] layout keeps it mounted
 * across every move, so the controls it renders (Close, Zoom, Previous, Next)
 * keep keyboard focus while the photograph under them changes. Each
 * photograph (StoryViewer) reports its position and neighbors, and until the
 * first report the photograph renders the controls itself, so the server
 * HTML is whole.
 *
 * - `page`, a directly loaded Viewer URL: a `<main>` with page semantics.
 *   Nothing is inert, focus isn't moved on load, Close links to the series,
 *   and Escape never navigates.
 * - `modal`, opened from the series page through the intercepted route: a
 *   native `<dialog>` opened with `showModal()`, so everything else on the
 *   page, fixed chrome included, is inert and focus moves inside. It's named
 *   by the header line. Close and Escape go back one history entry to the
 *   series, once, however many Escape and close events arrive. The host puts
 *   focus back on the opener.
 *
 * In both, Left and Right move (see stepForKey), and so does a horizontal
 * swipe on the photograph (see useSwipe). A double-tap on the photograph
 * toggles Zoom, as the Zoom button does (see useDoubleTap). Previous and
 * Next replace the history entry without scrolling, an end announces itself
 * and doesn't move, and each move is announced in a polite live region
 * that's empty at mount.
 * Zoom resets on every move. Nothing slides: the photograph never follows
 * the finger, and the next one replaces it in place, so reduced motion has
 * no slide to remove and the header and the region give the new position at
 * once.
 */
export default function ViewerShell({ mode, children }: { mode: ViewerMode; children: ReactNode }) {
    const router = useRouter();
    const [chrome, setChrome] = useState<ViewerChromeState | null>(null);
    const [zoomed, setZoomed] = useState(false);
    const [message, setMessage] = useState('');
    const headingId = useId();
    const rootRef = useRef<HTMLElement | null>(null);
    const closing = useRef(false);
    const shownPhoto = useRef<string | null>(null);
    const movedWith = useRef<{ direction: ViewerStep; held: Element | null } | null>(null);

    const report = useCallback((state: ViewerChromeState) => {
        setChrome((current) => (sameChrome(current, state) ? current : state));
    }, []);

    const close = useCallback(() => {
        // One close, one Back: a quick second Escape fires close as well as cancel, and two Backs would leave the site.
        if (closing.current) return;
        closing.current = true;
        router.back();
    }, [router]);

    const step = useCallback(
        (direction: ViewerStep) => {
            if (chrome === null) return;
            const href = direction === 'previous' ? chrome.previousHref : chrome.nextHref;
            if (href === null) {
                setMessage(boundaryText(direction, chrome.seriesTitle));
                return;
            }
            setZoomed(false);
            movedWith.current = { direction, held: document.activeElement };
            router.replace(href, { scroll: false });
        },
        [chrome, router],
    );

    // A new photograph: announce its position, and if focus was inside the photograph that left, put it on the control for the direction moved.
    // Focus that was on the page itself (a swipe, or an arrow with nothing focused) stays there: a move never moves keyboard focus.
    useLayoutEffect(() => {
        if (chrome === null || chrome.photoId === shownPhoto.current) return;
        const first = shownPhoto.current === null;
        shownPhoto.current = chrome.photoId;
        if (first) return;
        setZoomed(false);
        setMessage(positionText(chrome.position, chrome.total));
        const root = rootRef.current;
        const moved = movedWith.current;
        movedWith.current = null;
        const active = document.activeElement;
        const lost = moved?.held != null && !moved.held.isConnected;
        if (root && lost && (active === null || active === document.body)) {
            root.querySelector<HTMLElement>(`[data-viewer-step="${moved.direction}"]`)?.focus();
        }
    }, [chrome]);

    // The modal: open it once the shell holds the controls, so showModal() moves focus onto Close, which stays.
    const ready = chrome !== null;
    useLayoutEffect(() => {
        const dialog = rootRef.current;
        if (mode !== 'modal' || !ready || !(dialog instanceof HTMLDialogElement)) return;
        const onCancel = (event: Event) => {
            event.preventDefault();
            close();
        };
        dialog.addEventListener('cancel', onCancel);
        dialog.addEventListener('close', close);
        if (!dialog.open) dialog.showModal();
        return () => {
            dialog.removeEventListener('cancel', onCancel);
            dialog.removeEventListener('close', close);
            if (dialog.open) dialog.close();
        };
    }, [mode, ready, close]);

    const zoomedRef = useRef(zoomed);
    const stepRef = useRef(step);
    useEffect(() => {
        zoomedRef.current = zoomed;
        stepRef.current = step;
    }, [zoomed, step]);

    // Keys come from the document in both modes, so they still work when focus falls to the body under the open
    // modal (Tab past the end, or a tap on the photograph in WebKit). In the modal, a key aimed anywhere but the
    // body or the dialog is someone else's; the inert page behind it can't hold focus anyway.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (mode === 'modal') {
                const root = rootRef.current;
                const target = event.target;
                const inside = root !== null && target instanceof Node && root.contains(target);
                if (!inside && target !== document.body) return;
            }
            const direction = stepForKey(event, zoomedRef.current);
            if (direction === null) return;
            event.preventDefault();
            stepRef.current(direction);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [mode]);

    const pinched = useSwipe(rootRef, { zoomed, zoomedRef, stepRef, photoId: chrome?.photoId ?? null });

    // A double-tap on the photograph is Zoom, and does nothing where Zoom does nothing (no usable set), so it can't leave
    // the shell zoomed with nothing on screen to show it, which would stop the swipe.
    const hasImage = chrome?.hasImage ?? false;
    const toggleZoom = useCallback(() => setZoomed((value) => !value), []);
    const doubleTapRef = useRef<() => void>(() => undefined);
    useEffect(() => {
        doubleTapRef.current = hasImage ? toggleZoom : () => undefined;
    }, [hasImage, toggleZoom]);
    useDoubleTap(rootRef, { toggleRef: doubleTapRef, photoId: chrome?.photoId ?? null });

    const actions = useMemo<ViewerChromeActions>(() => ({ step, close }), [step, close]);
    const context = useMemo<ViewerShellContext>(() => ({ mode, claimed: chrome !== null, zoomed, headingId, report }), [mode, chrome, zoomed, headingId, report]);
    const surface = (chrome?.accent ? { '--cc-accent': chrome.accent } : undefined) as CSSProperties | undefined;

    const body = (
        <ViewerContext.Provider value={context}>
            {chrome !== null && (
                <ViewerChrome state={chrome} mode={mode} headingId={headingId} zoomed={zoomed} onZoom={toggleZoom} actions={actions} />
            )}
            {children}
            <p className="sr-only" role="status" aria-live="polite" data-viewer-announcer="">
                {message}
            </p>
        </ViewerContext.Provider>
    );

    if (mode === 'modal') {
        return (
            <dialog
                ref={(node) => {
                    rootRef.current = node;
                }}
                data-surface="viewer"
                data-viewer-mode="modal"
                data-pinched={pinched ? '' : undefined}
                aria-labelledby={headingId}
                className={styles.viewer}
                style={surface}
            >
                {body}
            </dialog>
        );
    }
    return (
        <main
            ref={(node) => {
                rootRef.current = node;
            }}
            data-surface="viewer"
            data-viewer-mode="page"
            data-pinched={pinched ? '' : undefined}
            className={styles.viewer}
            style={surface}
        >
            {body}
        </main>
    );
}
