'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import ViewerChrome, { type ViewerChromeActions } from './ViewerChrome';
import { ViewerContext, type ViewerChromeState, type ViewerMode, type ViewerShellContext } from './viewerContext';
import { stepForKey, type ViewerStep } from './viewerKeys';
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
 * In both, Left and Right move (see stepForKey), Previous and Next replace
 * the history entry without scrolling, an end announces itself and doesn't
 * move, and each move is announced in a polite live region that's empty at
 * mount. Zoom resets on every move.
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
    const movedWith = useRef<ViewerStep | null>(null);

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
            movedWith.current = direction;
            router.replace(href, { scroll: false });
        },
        [chrome, router],
    );

    // A new photograph: announce its position, and if focus was inside the photograph that left, put it on the control for the direction moved.
    useLayoutEffect(() => {
        if (chrome === null || chrome.photoId === shownPhoto.current) return;
        const first = shownPhoto.current === null;
        shownPhoto.current = chrome.photoId;
        if (first) return;
        setZoomed(false);
        setMessage(positionText(chrome.position, chrome.total));
        const root = rootRef.current;
        const direction = movedWith.current;
        movedWith.current = null;
        const active = document.activeElement;
        if (root && direction && (active === null || active === document.body)) {
            root.querySelector<HTMLElement>(`[data-viewer-step="${direction}"]`)?.focus();
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

    // Keys: on the dialog in the modal, so nothing behind it reacts, and on the document on a page.
    useEffect(() => {
        const target: EventTarget | null = mode === 'modal' ? rootRef.current : document;
        if (target === null) return;
        const onKey = (event: Event) => {
            const direction = stepForKey(event as KeyboardEvent, zoomedRef.current);
            if (direction === null) return;
            event.preventDefault();
            stepRef.current(direction);
        };
        target.addEventListener('keydown', onKey);
        return () => target.removeEventListener('keydown', onKey);
    }, [mode]);

    const actions = useMemo<ViewerChromeActions>(() => ({ step, close }), [step, close]);
    const context = useMemo<ViewerShellContext>(() => ({ mode, claimed: chrome !== null, zoomed, headingId, report }), [mode, chrome, zoomed, headingId, report]);
    const surface = (chrome?.accent ? { '--cc-accent': chrome.accent } : undefined) as CSSProperties | undefined;

    const body = (
        <ViewerContext.Provider value={context}>
            {chrome !== null && (
                <ViewerChrome state={chrome} mode={mode} headingId={headingId} zoomed={zoomed} onZoom={() => setZoomed((value) => !value)} actions={actions} />
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
            className={styles.viewer}
            style={surface}
        >
            {body}
        </main>
    );
}
