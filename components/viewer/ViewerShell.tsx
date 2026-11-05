'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useDocumentVisible } from '@/components/motion/useDocumentVisible';
import { usePrefersReducedMotion } from '@/components/motion/usePrefersReducedMotion';
import { useOnline } from '@/components/site/onlineStatus';
import { useSiteRoutes } from '@/components/site/siteRoutesContext';
import { StageMotion } from './stageMotion';
import ViewerChrome, { type ViewerChromeActions } from './ViewerChrome';
import { ViewerContext, peekKey, type ViewerChromeState, type ViewerMode, type ViewerPeek, type ViewerShellContext } from './viewerContext';
import { stepForKey, type ViewerStep } from './viewerKeys';
import { useDoubleTap } from './useDoubleTap';
import { STAGE_SELECTOR, useSwipe, type SwipeShell } from './useSwipe';
import { whenIdle } from './whenIdle';
import { UNAVAILABLE_ANNOUNCEMENT, accentValue, boundaryText, moveText, offlineText } from './viewerLabels';
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

/** The endpoint's answer when the revision asked for isn't the one it serves any more. */
const REVISED = 'revised';

/**
 * How often an open Viewer asks whether the revision it shows is still the one served (bug 5, #178), while its tab is
 * visible. Not 0: in Next 16.4.2 `staleTimes` is site-wide with a 30 s floor, and a non-full prefetch is the same as
 * none, so the bound is this check's (coordinator bug review, 11-04). One conditional GET per visible Viewer, mostly a 304.
 */
export const REVISION_CHECK_MS = 30_000;
/** A move's announcement waits this long after its photograph arrives, so rapid presses give one message (#178). */
export const ANNOUNCE_SETTLE_MS = 250;
/** A repeated message clears the region and lands again this long after, so a screen reader hears it again (bug 3). */
export const REPEAT_GAP_MS = 100;

/** Whether the visitor asked the browser to save data (`navigator.connection.saveData`, #174): then nothing is fetched ahead. */
function savesData(): boolean {
    if (typeof navigator === 'undefined') return false;
    return (navigator as Navigator & { connection?: { saveData?: unknown } }).connection?.saveData === true;
}

/** Whether the browser says it's offline at the press. Unknown counts as online. */
function offlineNow(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
}

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
 * swipe on the photograph's stage (see useSwipe), which on a phone takes the
 * ground above and below the photograph too. A double-tap there toggles
 * Zoom, as the Zoom button does (see useDoubleTap). Previous and
 * Next replace the history entry without scrolling, an end announces itself
 * and doesn't move, and each move is announced in a polite live region
 * that's empty at mount (#178): 250 ms after its photograph arrives, so rapid
 * presses give one message, with the position, the title and the
 * description. An end is announced at once, and a repeat of the same
 * message clears the region first, so every press at an end is heard (bug 3).
 * Keys ignore auto-repeat, composition and a key already taken; Escape while
 * zoomed only resets the zoom, and focus that was in the zoomed region goes
 * to Zoom. Offline, a move says so by the controls and doesn't navigate. One
 * move runs at a time in every mode, the stage `aria-busy` until it lands.
 * Zoom resets on every move. The technical details stay as the visitor left
 * them, open or closed, for the whole visit.
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
 * (dropStalePages). Every visitor's Viewer asks every 30 s while its tab is
 * visible, and at once when it's visible again, whether its revision is
 * still served (bug 5), never at load. The idle prefetch skips when the
 * visitor saves data (#174). While a move is on its way, no swipe can start, and the
 * latest press of a control or a key is remembered and runs once the
 * photograph arrives, under reduced motion too. Under reduced motion nothing
 * slides or fades: the next photograph replaces this one in place when it
 * arrives, and the counter changes then, as before 9a.
 *
 * A photograph unpublished or moved mid-visit renders ViewerUnavailable (the
 * intercepted route's not-found), which takes the controls' place: the shell
 * announces it and puts focus on its heading.
 */
export default function ViewerShell({ mode, children }: { mode: ViewerMode; children: ReactNode }) {
    const router = useRouter();
    const { catalogApiHref } = useSiteRoutes();
    const [chrome, setChrome] = useState<ViewerChromeState | null>(null);
    const [zoomed, setZoomed] = useState(false);
    /** The technical details, open or not, for the whole visit: a move keeps them as they are (#7, decided). */
    const [technicalOpen, setTechnicalOpen] = useState(false);
    const [message, setMessage] = useState('');
    /** The direction a move was asked for offline, which the notice by the controls names, or null (#178). */
    const [offline, setOffline] = useState<ViewerStep | null>(null);
    /** Whether ViewerUnavailable is the child: the photograph isn't there, so neither are its controls (#178). */
    const [unavailable, setUnavailable] = useState(false);
    const unavailableRef = useRef(false);
    /** The last message asked for, so a repeat clears the region before it lands again (bug 3). */
    const lastMessage = useRef('');
    const announceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** Whether any move has navigated, so a page still shows the route it loaded with (see revised). */
    const movedOnce = useRef(false);
    /** The revision a page asked to be shown again for, once per publish. */
    const revisitedFrom = useRef<string | null>(null);
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

    const clearAnnouncement = useCallback(() => {
        if (announceTimer.current !== null) clearTimeout(announceTimer.current);
        announceTimer.current = null;
    }, []);
    /** The region's text, now: a new message at once, a repeat cleared first and set REPEAT_GAP_MS later (bug 3). */
    const land = useCallback((text: string) => {
        if (text !== lastMessage.current) {
            lastMessage.current = text;
            setMessage(text);
            return;
        }
        setMessage('');
        announceTimer.current = setTimeout(() => {
            announceTimer.current = null;
            setMessage(text);
        }, REPEAT_GAP_MS);
    }, []);
    /**
     * The one way the live region speaks. Whatever was waiting to land is dropped, so the latest message is the one
     * heard. `settle` waits ANNOUNCE_SETTLE_MS first, for a move's arrival.
     */
    const announce = useCallback(
        (text: string, { settle = false }: { settle?: boolean } = {}) => {
            clearAnnouncement();
            if (!settle) return land(text);
            announceTimer.current = setTimeout(() => {
                announceTimer.current = null;
                land(text);
            }, ANNOUNCE_SETTLE_MS);
        },
        [clearAnnouncement, land],
    );
    useEffect(() => clearAnnouncement, [clearAnnouncement]);

    const close = useCallback(() => {
        // One close, one Back: a quick second Escape fires close as well as cancel, and two Backs would leave the site.
        if (closing.current) return;
        closing.current = true;
        router.back();
    }, [router]);

    const swipeShell = useRef<SwipeShell>({ zoomed, motion: false, previous: false, next: false, online: () => true, pending: () => false, step: () => undefined, engage: () => undefined });
    const { pinched, drop: dropGesture } = useSwipe(rootRef, { zoomed, shellRef: swipeShell, motionRef, photoId: chrome?.photoId ?? null });

    const step = useCallback(
        (direction: ViewerStep, settling = false) => {
            if (chrome === null || unavailableRef.current) return;
            const motion = reduced ? null : motionRef.current;
            // A move already on its way is the one the visitor sees settling, or, under reduced motion, the one whose
            // photograph is coming. A press or a key now is remembered, the latest one, and runs once that photograph
            // arrives (the arrival effect below), so one move runs at a time in every mode (#178).
            if (pendingRef.current !== null) {
                if (!settling) queued.current = direction;
                return;
            }
            const href = direction === 'previous' ? chrome.previousHref : chrome.nextHref;
            if (href === null) {
                announce(boundaryText(direction, chrome.seriesTitle));
                return;
            }
            // Offline, the next page can't come (#178): say so by the controls and in the region, and stay.
            if (offlineNow()) {
                setOffline(direction);
                announce(offlineText(direction));
                return;
            }
            clearAnnouncement();
            setOffline(null);
            setZoomed(false);
            movedOnce.current = true;
            movedWith.current = { direction, held: document.activeElement };
            if (motion !== null) {
                if (!settling) {
                    // A press or a key while a finger holds the photograph: the move is the press's. The gesture ends
                    // with no move, and the photograph slides back while the page comes.
                    dropGesture();
                    if (motion.heldOffset() !== 0) motion.release(null, 0);
                }
                motion.holdWords();
            }
            const next = { from: chrome.photoId, direction };
            pendingRef.current = next;
            setPending(next);
            router.replace(href, { scroll: false });
        },
        [chrome, router, reduced, dropGesture, announce, clearAnnouncement],
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
        setOffline(null);
        announce(moveText(chrome.position, chrome.total, chrome.title, chrome.description), { settle: true });
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
    }, [chrome, reduced, announce]);

    // Once engaged, each photograph shown asks for its neighbors, so the next swipe has them peeking in.
    useEffect(() => {
        if (!reduced) askForPeeks(chrome);
    }, [chrome, reduced, askForPeeks]);

    // Once the Viewer is idle, the neighbors' pages (their RSC payloads, no image), so a move's page is usually there
    // by the time its settle lands, and the words change with it. Next keeps one request per page however often it's asked.
    // Keyed on the revision too, so after a publish's refresh lands the neighbors are prefetched again from the revision
    // served (bug 5). Nothing ahead when the visitor saves data (#174), or while the photograph isn't there.
    const previousHref = chrome?.previousHref ?? null;
    const nextHref = chrome?.nextHref ?? null;
    const revisionId = chrome?.revisionId ?? null;
    useEffect(() => {
        if (unavailable || (previousHref === null && nextHref === null) || savesData()) return;
        return whenIdle(() => {
            for (const href of [nextHref, previousHref]) if (href !== null) router.prefetch(href, FULL_PREFETCH);
        });
    }, [previousHref, nextHref, revisionId, unavailable, router]);

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

    // Escape while zoomed only resets the zoom (#178). The key comes before the dialog's cancel, which it then swallows.
    const zoomedRef = useRef(zoomed);
    const escapeTook = useRef(false);
    const unzoom = useCallback(() => {
        zoomedRef.current = false;
        setZoomed(false);
    }, []);

    // The modal: open it once the shell holds the controls (or the unavailable state), so showModal() moves focus inside.
    const ready = chrome !== null || unavailable;
    useLayoutEffect(() => {
        const dialog = rootRef.current;
        if (mode !== 'modal' || !ready || !(dialog instanceof HTMLDialogElement)) return;
        const onCancel = (event: Event) => {
            event.preventDefault();
            if (escapeTook.current || zoomedRef.current) {
                escapeTook.current = false;
                if (zoomedRef.current) unzoom();
                return;
            }
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
    }, [mode, ready, close, unzoom]);

    // When the zoomed region resets with focus in it, its tabIndex goes and focus would drop to the body: put it on Zoom.
    const wasZoomed = useRef(false);
    useLayoutEffect(() => {
        const was = wasZoomed.current;
        wasZoomed.current = zoomed;
        const root = rootRef.current;
        if (!was || zoomed || root === null) return;
        const stage = root.querySelector(STAGE_SELECTOR);
        const active = document.activeElement;
        if (stage !== null && active !== null && stage.contains(active)) root.querySelector<HTMLElement>('[data-viewer-zoom]')?.focus({ preventScroll: true });
    }, [zoomed]);

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
            online: () => !offlineNow(),
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

    /**
     * The 30 s check said another revision is served (bug 5). Once no move is on its way, the pages prefetched before it
     * go (dropStalePages), and this photograph renders again in the revision served: through a refresh, or, on a page
     * no move has left yet, through a replace to the same URL. A refresh there would re-render the directly loaded
     * route, where a photograph the publish dropped lands on the site's not-found page outside the Viewer; the replace
     * comes back through the intercepted route, as a move does, where it lands on ViewerUnavailable. The arrival in
     * the new revision then drops the prefetched pages as any move into a new revision does.
     */
    const revised = useCallback(
        (revision: string) => {
            if (mode === 'page' && !movedOnce.current && pendingRef.current === null) {
                if (revisitedFrom.current === revision) return;
                revisitedFrom.current = revision;
                movedOnce.current = true;
                router.replace(`${window.location.pathname}${window.location.search}`, { scroll: false });
                return;
            }
            outdated.current = revision;
            dropStalePages();
        },
        [mode, router, dropStalePages],
    );

    // Every visitor's Viewer asks whether its revision is still served (bug 5): every REVISION_CHECK_MS while the tab is
    // visible, and at once when it's visible again, but never at load (#6). No gates: a keyboard or mouse visitor, who
    // never touches the photograph, fetches no peeks, so this is the only way they learn of a publish. The interval
    // outlives moves and reads the photograph shown when it fires. A 200 says only yes, and is never kept as a peek.
    const visible = useDocumentVisible();
    const chromeRef = useRef(chrome);
    const revisedRef = useRef(revised);
    useEffect(() => {
        chromeRef.current = chrome;
        revisedRef.current = revised;
    }, [chrome, revised]);
    const wasHidden = useRef(false);
    useEffect(() => {
        if (!visible) {
            wasHidden.current = true;
            return;
        }
        if (unavailable) return;
        let live = true;
        const check = () => {
            const state = chromeRef.current;
            if (state === null || unavailableRef.current) return;
            void fetchPeek(catalogApiHref, state.seriesSlug, state.photoId, state.revisionId).then((answer) => {
                if (live && answer === REVISED) revisedRef.current(state.revisionId);
            });
        };
        if (wasHidden.current) check();
        wasHidden.current = false;
        const timer = setInterval(check, REVISION_CHECK_MS);
        return () => {
            live = false;
            clearInterval(timer);
        };
    }, [visible, unavailable, catalogApiHref]);

    // Offline notices go once the browser is back online: the next press moves.
    const online = useOnline();
    useEffect(() => {
        if (online) setOffline(null);
    }, [online]);

    // ViewerUnavailable in place of a photograph (#178): nothing is on its way any more, the controls for a photograph
    // that isn't there go, focus moves to its heading (after showModal() in the modal), and the region says what happened.
    const reportUnavailable = useCallback((showing: boolean) => {
        unavailableRef.current = showing;
        setUnavailable(showing);
    }, []);
    useEffect(() => {
        if (!unavailable) return;
        pendingRef.current = null;
        setPending(null);
        queued.current = null;
        movedWith.current = null;
        motionRef.current?.reset();
        unzoom();
        setOffline(null);
        rootRef.current?.querySelector<HTMLElement>('[data-viewer-unavailable-heading]')?.focus({ preventScroll: true });
        announce(UNAVAILABLE_ANNOUNCEMENT, { settle: true });
    }, [unavailable, announce, unzoom]);

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
            if (event.key === 'Escape') {
                // A fresh Escape: whatever the last one took, this one decides afresh.
                escapeTook.current = false;
                if (!zoomedRef.current || event.isComposing || event.defaultPrevented) return;
                event.preventDefault();
                escapeTook.current = true;
                unzoom();
                return;
            }
            const direction = stepForKey(event, zoomedRef.current);
            if (direction === null) return;
            event.preventDefault();
            stepRef.current(direction);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [mode, unzoom]);

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
    const busy = pending !== null;
    const context = useMemo<ViewerShellContext>(
        () => ({
            mode,
            claimed: chrome !== null,
            zoomed,
            headingId,
            report,
            technicalOpen,
            setTechnicalOpen,
            peeks: reduced ? NO_PEEKS : peeks,
            busy,
            reportUnavailable,
            close,
        }),
        [mode, chrome, zoomed, headingId, report, technicalOpen, reduced, peeks, busy, reportUnavailable, close],
    );
    // The counter, the accents and the arrows' ends show a move once it's decided, before its photograph arrives. Under
    // reduced motion nothing slides, so they change when it arrives, as before 9a.
    const shown = useMemo<ViewerChromeState | null>(() => {
        if (chrome === null || pending === null || reduced || pending.from !== chrome.photoId) return chrome;
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
    }, [chrome, pending, peeks, reduced]);
    const surface = (shown?.accent ? { '--cc-accent': shown.accent } : undefined) as CSSProperties | undefined;

    const body = (
        <ViewerContext.Provider value={context}>
            {shown !== null && !unavailable && (
                <ViewerChrome state={shown} mode={mode} headingId={headingId} zoomed={zoomed} onZoom={toggleZoom} actions={actions} />
            )}
            {children}
            {/* By the controls (#178): the stage's foot, between Previous and Next. Named in the region too. */}
            {offline !== null && !unavailable && (
                <p className={styles.offline} data-viewer-offline="">
                    {offlineText(offline)}
                </p>
            )}
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
