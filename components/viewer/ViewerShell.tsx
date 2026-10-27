'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { usePrefersReducedMotion } from '@/components/motion/usePrefersReducedMotion';
import { useSiteRoutes } from '@/components/site/siteRoutesContext';
import { StageMotion } from './stageMotion';
import ViewerChrome, { type ViewerChromeActions } from './ViewerChrome';
import { ViewerContext, peekKey, type ViewerChromeState, type ViewerMode, type ViewerPeek, type ViewerShellContext } from './viewerContext';
import { stepForKey, type ViewerStep } from './viewerKeys';
import { useDoubleTap } from './useDoubleTap';
import { useSwipe, type SwipeShell } from './useSwipe';
import { accentValue, boundaryText, positionText } from './viewerLabels';
import styles from './StoryViewer.module.css';

function sameChrome(a: ViewerChromeState | null, b: ViewerChromeState): boolean {
    if (a === null) return false;
    return (Object.keys(b) as (keyof ViewerChromeState)[]).every((key) => a[key] === b[key]);
}

const NO_PEEKS: ReadonlyMap<string, ViewerPeek> = new Map();

type PrefetchOptions = NonNullable<Parameters<ReturnType<typeof useRouter>['prefetch']>[1]>;
/**
 * Next's `PrefetchKind.FULL`, which `next/navigation` doesn't export: the whole page, not only up to a loading
 * boundary, since the Viewer's page is dynamic and has none.
 */
const FULL_PREFETCH = { kind: 'full' } as unknown as PrefetchOptions;

/** Runs `task` once the browser is idle, or soon where it can't say; returns the cancel. */
function whenIdle(task: () => void): () => void {
    if (typeof window.requestIdleCallback === 'function') {
        const handle = window.requestIdleCallback(task, { timeout: 2000 });
        return () => window.cancelIdleCallback(handle);
    }
    const handle = window.setTimeout(task, 200);
    return () => window.clearTimeout(handle);
}

/** The endpoint's answer when the revision asked for isn't the one it serves any more. */
const REVISED = 'revised';

/**
 * A neighbor's peek from 9a's endpoint, in the revision this photograph came from, or null when it can't be had (an
 * error, a network failure): the photograph then follows the finger with nothing beside it. REVISED when the endpoint
 * serves another revision (its 409), so this photograph's page is from the one before.
 */
async function fetchPeek(catalogApiHref: (path: string) => string, slug: string, photoId: string, revisionId: string): Promise<ViewerPeek | typeof REVISED | null> {
    try {
        // Through the site's routes, so #16's preview asks its own mirror and never the public endpoint.
        const path = catalogApiHref(`series/${encodeURIComponent(slug)}/photos/${encodeURIComponent(photoId)}?revision=${encodeURIComponent(revisionId)}`);
        const response = await fetch(path, { headers: { accept: 'application/json' } });
        if (response.status === 409) return REVISED;
        if (!response.ok) return null;
        const body: unknown = await response.json();
        if (typeof body !== 'object' || body === null || (body as { photoId?: unknown }).photoId !== photoId) return null;
        const { image, accent } = body as { image?: ViewerPeek['image']; accent?: unknown };
        return { image: typeof image === 'object' && image !== null ? image : null, accent: accentValue(typeof accent === 'string' ? accent : null) };
    } catch {
        return null;
    }
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
 * Zoom resets on every move.
 *
 * The photograph follows the finger (9a, useSwipe and StageMotion), with its
 * neighbors peeking in beside it once a finger has gone down on it (their
 * sets come from the peek endpoint then, never on a first load, #6), and a
 * move settles in: from the lift for a swipe, and from its arrival for
 * Previous, Next, and the arrow keys, so every move looks the same. The
 * header and the reading area stay put. The counter, the accent rules and
 * the arrows' ends change once, at the lift (or the press). The words under the photograph
 * stay as they are until the photograph's page arrives, and change then with
 * a 200 ms fade, so the reading area is never empty. Once the Viewer is idle
 * it prefetches the neighbors' pages, so a move's page usually arrives
 * inside its settle, and once it learns of a publish it drops those pages
 * (dropStalePages). While a move is on its way, no swipe can start, and the
 * latest press of a control or a key is remembered and runs once the
 * photograph arrives. Under reduced motion nothing slides or fades: the next
 * photograph replaces this one in place when it arrives, and the header and
 * the region give the new position at once, as before 9a.
 */
export default function ViewerShell({ mode, children }: { mode: ViewerMode; children: ReactNode }) {
    const router = useRouter();
    const { catalogApiHref } = useSiteRoutes();
    const [chrome, setChrome] = useState<ViewerChromeState | null>(null);
    const [zoomed, setZoomed] = useState(false);
    const [message, setMessage] = useState('');
    const headingId = useId();
    const rootRef = useRef<HTMLElement | null>(null);
    const closing = useRef(false);
    const shownPhoto = useRef<string | null>(null);
    const movedWith = useRef<{ direction: ViewerStep; held: Element | null } | null>(null);
    const reduced = usePrefersReducedMotion();
    const motionRef = useRef<StageMotion | null>(null);
    /** The move decided and on its way, from the photograph it leaves, so the counter and accents show it at once. */
    const [pending, setPending] = useState<{ from: string; direction: ViewerStep } | null>(null);
    const pendingRef = useRef<typeof pending>(null);
    /** The latest press of a control or a key while a move was on its way, which runs once its photograph arrives. */
    const queued = useRef<ViewerStep | null>(null);
    /** The peeks the shell has, by peekKey (revision and photo ID): every photograph it has shown, and the neighbors it asked the endpoint for. */
    const [peeks, setPeeks] = useState<ReadonlyMap<string, ViewerPeek>>(NO_PEEKS);
    /** Set once a finger goes down on the photograph: from then on, each photograph's neighbors are asked for. */
    const engaged = useRef(false);
    const requested = useRef(new Set<string>());
    /** The revision the last photograph shown came from. */
    const shownRevision = useRef<string | null>(null);
    /** A revision the shell has learned isn't served any more, until it drops the pages it prefetched (dropStalePages). */
    const outdated = useRef<string | null>(null);
    /** The revision the shell last dropped its prefetched pages for, so it does that once per publish. */
    const refreshedFrom = useRef<string | null>(null);

    const report = useCallback((state: ViewerChromeState) => {
        setChrome((current) => (sameChrome(current, state) ? current : state));
    }, []);

    const close = useCallback(() => {
        // One close, one Back: a quick second Escape fires close as well as cancel, and two Backs would leave the site.
        if (closing.current) return;
        closing.current = true;
        router.back();
    }, [router]);

    const swipeShell = useRef<SwipeShell>({ zoomed, motion: false, previous: false, next: false, pending: () => false, step: () => undefined, engage: () => undefined });
    const { pinched, drop: dropGesture } = useSwipe(rootRef, { zoomed, shellRef: swipeShell, motionRef, photoId: chrome?.photoId ?? null });

    const step = useCallback(
        (direction: ViewerStep, settling = false) => {
            if (chrome === null) return;
            const motion = reduced ? null : motionRef.current;
            // A move already on its way is the one the visitor sees settling. A press or a key now is remembered, the
            // latest one, and runs once that photograph arrives (the arrival effect below).
            if (motion !== null && pendingRef.current !== null) {
                if (!settling) queued.current = direction;
                return;
            }
            const href = direction === 'previous' ? chrome.previousHref : chrome.nextHref;
            if (href === null) {
                setMessage(boundaryText(direction, chrome.seriesTitle));
                return;
            }
            setZoomed(false);
            movedWith.current = { direction, held: document.activeElement };
            if (motion !== null) {
                if (!settling) {
                    // A press or a key while a finger holds the photograph: the move is the press's. The gesture ends
                    // with no move, and the photograph slides back while the page comes.
                    dropGesture();
                    if (motion.heldOffset() !== 0) motion.release(null, 0);
                }
                motion.holdWords();
                const next = { from: chrome.photoId, direction };
                pendingRef.current = next;
                setPending(next);
            }
            router.replace(href, { scroll: false });
        },
        [chrome, router, reduced, dropGesture],
    );

    /**
     * After a publish: Next keeps the neighbors' prefetched pages for minutes, by URL alone, so a move could land on the
     * revision before. A refresh drops them, and renders this photograph again in the revision served. Never while a
     * move is on its way: the arrival effect runs it once that photograph is in.
     */
    const dropStalePages = useCallback(() => {
        const revision = outdated.current;
        if (revision === null || pendingRef.current !== null) return;
        outdated.current = null;
        if (refreshedFrom.current === revision) return;
        refreshedFrom.current = revision;
        router.refresh();
    }, [router]);

    /** Ask for the current photograph's neighbors, once each, if a finger has gone down on the photograph. */
    const askForPeeks = useCallback(
        (state: ViewerChromeState | null) => {
            if (state === null || !engaged.current) return;
            for (const photoId of [state.previousPhotoId, state.nextPhotoId]) {
                if (photoId === null) continue;
                // By revision too: after a publish, a neighbor's set from the revision before isn't this one's.
                const key = peekKey(state.revisionId, photoId);
                if (requested.current.has(key)) continue;
                requested.current.add(key);
                void fetchPeek(catalogApiHref, state.seriesSlug, photoId, state.revisionId).then((peek) => {
                    if (peek === REVISED) {
                        outdated.current = state.revisionId;
                        dropStalePages();
                    } else if (peek !== null) setPeeks((current) => (current.has(key) ? current : new Map(current).set(key, peek)));
                });
            }
        },
        [dropStalePages, catalogApiHref],
    );

    // A new photograph: announce its position, and if focus was inside the photograph that left, put it on the control for the direction moved.
    // Focus that was on the page itself (a swipe, or an arrow with nothing focused) stays there: a move never moves keyboard focus.
    useLayoutEffect(() => {
        if (chrome === null || chrome.photoId === shownPhoto.current) return;
        const first = shownPhoto.current === null;
        shownPhoto.current = chrome.photoId;
        // Every photograph shown can peek back in once the Viewer moves on from it.
        const { image, accent } = chrome;
        const key = peekKey(chrome.revisionId, chrome.photoId);
        requested.current.add(key);
        setPeeks((current) => (current.has(key) ? current : new Map(current).set(key, { image, accent })));
        if (first) return;
        setZoomed(false);
        setMessage(positionText(chrome.position, chrome.total));
        const root = rootRef.current;
        const moved = movedWith.current;
        movedWith.current = null;
        // Before paint: the settle goes on on the new photograph's track, or a move by a control slides in now.
        pendingRef.current = null;
        setPending(null);
        const motion = motionRef.current;
        if (motion !== null && !reduced) {
            motion.arrive(moved?.direction ?? null);
            motion.wordsIn();
        }
        const active = document.activeElement;
        const lost = moved?.held != null && !moved.held.isConnected;
        if (root && lost && (active === null || active === document.body)) {
            root.querySelector<HTMLElement>(`[data-viewer-step="${moved.direction}"]`)?.focus();
        }
    }, [chrome, reduced]);

    // Once engaged, each photograph shown asks for its neighbors, so the next swipe has them peeking in.
    useEffect(() => {
        if (!reduced) askForPeeks(chrome);
    }, [chrome, reduced, askForPeeks]);

    // Once the Viewer is idle, the neighbors' pages (their RSC payloads, no image), so a move's page is usually there
    // by the time its settle lands, and the words change with it. Next keeps one request per page however often it's asked.
    const previousHref = chrome?.previousHref ?? null;
    const nextHref = chrome?.nextHref ?? null;
    useEffect(() => {
        if (previousHref === null && nextHref === null) return;
        return whenIdle(() => {
            for (const href of [nextHref, previousHref]) if (href !== null) router.prefetch(href, FULL_PREFETCH);
        });
    }, [previousHref, nextHref, router]);

    // The stage's motion, on the root, which outlives every move. Reduced motion drops any slide in flight.
    useLayoutEffect(() => {
        const root = rootRef.current;
        if (root === null) return;
        const motion = new StageMotion(root);
        motionRef.current = motion;
        return () => {
            motion.reset();
            if (motionRef.current === motion) motionRef.current = null;
        };
    }, []);
    useEffect(() => {
        if (reduced) motionRef.current?.reset();
    }, [reduced]);

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
    const engage = useCallback(() => {
        if (reduced) return;
        engaged.current = true;
        askForPeeks(chrome);
    }, [reduced, askForPeeks, chrome]);
    useEffect(() => {
        zoomedRef.current = zoomed;
        stepRef.current = step;
        swipeShell.current = {
            zoomed,
            motion: !reduced,
            previous: chrome?.previousHref != null,
            next: chrome?.nextHref != null,
            pending: () => pendingRef.current !== null,
            step,
            engage,
        };
    }, [zoomed, step, reduced, chrome, engage]);

    // A photograph from another revision than the last one shown means a publish: drop the pages prefetched before it.
    // So does a peek's 409 that came while a move was on its way. Before the press below, which may start a move.
    useEffect(() => {
        if (chrome === null) return;
        const before = shownRevision.current;
        shownRevision.current = chrome.revisionId;
        if (before !== null && before !== chrome.revisionId) outdated.current = before;
        dropStalePages();
    }, [chrome, dropStalePages]);

    // The press remembered while the last move was on its way runs once its photograph is in, with that one's
    // neighbors. After the effect above, so it runs with this photograph's step.
    useEffect(() => {
        const direction = queued.current;
        if (direction === null || pendingRef.current !== null) return;
        queued.current = null;
        stepRef.current(direction);
    }, [chrome]);

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

    // A double-tap on the photograph is Zoom, and does nothing where Zoom does nothing (no usable set), so it can't leave
    // the shell zoomed with nothing on screen to show it, which would stop the swipe.
    const hasImage = chrome?.hasImage ?? false;
    const toggleZoom = useCallback(() => setZoomed((value) => !value), []);
    const doubleTapRef = useRef<() => void>(() => undefined);
    useEffect(() => {
        doubleTapRef.current = hasImage ? toggleZoom : () => undefined;
    }, [hasImage, toggleZoom]);
    useDoubleTap(rootRef, { toggleRef: doubleTapRef, photoId: chrome?.photoId ?? null });

    const actions = useMemo<ViewerChromeActions>(() => ({ step: (direction) => step(direction), close }), [step, close]);
    const context = useMemo<ViewerShellContext>(
        () => ({ mode, claimed: chrome !== null, zoomed, headingId, report, peeks: reduced ? NO_PEEKS : peeks }),
        [mode, chrome, zoomed, headingId, report, reduced, peeks],
    );
    // The counter, the accents and the arrows' ends show a move once it's decided, before its photograph arrives.
    const shown = useMemo<ViewerChromeState | null>(() => {
        if (chrome === null || pending === null || pending.from !== chrome.photoId) return chrome;
        const to = pending.direction === 'next' ? chrome.nextPhotoId : chrome.previousPhotoId;
        const peek = to === null ? undefined : peeks.get(peekKey(chrome.revisionId, to));
        const position = chrome.position + (pending.direction === 'next' ? 1 : -1);
        // The arrows read only whether an href is there, and a press now is remembered (step), so the arriving
        // photograph's place says which ends to show: its own neighbors' hrefs come with its page.
        const toward = pending.direction === 'next' ? chrome.nextHref : chrome.previousHref;
        return {
            ...chrome,
            position,
            accent: peek === undefined ? chrome.accent : peek.accent,
            previousHref: position > 1 ? toward : null,
            nextHref: position < chrome.total ? toward : null,
        };
    }, [chrome, pending, peeks]);
    const surface = (shown?.accent ? { '--cc-accent': shown.accent } : undefined) as CSSProperties | undefined;

    const body = (
        <ViewerContext.Provider value={context}>
            {shown !== null && (
                <ViewerChrome state={shown} mode={mode} headingId={headingId} zoomed={zoomed} onZoom={toggleZoom} actions={actions} />
            )}
            {children}
            {/* The leaving photograph's words, over the new ones for the 70 ms of their fade out (StageMotion.wordsIn). Empty otherwise. */}
            <div className={styles.leaving} data-viewer-leaving="" aria-hidden="true" />
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
