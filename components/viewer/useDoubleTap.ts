'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { DOUBLE_TAP_IDLE, placeOnPhoto, reduceDoubleTap, zoomScrollBy, type DoubleTapInput, type DoubleTapState } from './doubleTap';
import { isPinched } from './swipe';
import { STAGE_SELECTOR } from './useSwipe';

/** The photograph's own box on the stage, beside any neighbors peeking in (9a). */
const CURRENT_SELECTOR = '[data-viewer-current]';

/**
 * A double-tap on the photograph's stage toggles Zoom (#9c), on touch only, on the Viewer's shell root, which outlives
 * every move. The stage is the photograph and, on a phone, the dark ground above and below it that the stage takes up
 * (as it does for a swipe). The rule is reduceDoubleTap's. It reads the same pointer events the swipe does, so the
 * swipe, vertical scroll, pinch, and the zoomed photograph's pan all go on as before. Any scroll in the document, a
 * fling included, quiets it for a moment (SETTLE), so a tap that stops a fling never counts. A pinch-zoomed page is the
 * browser's: its stage is back at `touch-action: auto` there, and the Viewer reads no taps.
 *
 * Zooming in, the zoomed photograph scrolls so the place under the finger stays under it, as a phone's own photo
 * viewer does. Zooming out needs no place. The toggle renders at once (flushSync), so the place is read from the
 * fitted photograph before and the zoomed one after, and no frame shows the zoomed photograph unscrolled.
 *
 * The one event it cancels is the `touchend` of the tap that fired. The layout has changed under the finger by then
 * (zoomed out, the stage shrinks and Previous and Next can sit where the zoomed photograph was), and a cancelled
 * `touchend` makes no click, so the second tap can't press what the new layout put under it. The browser fires each
 * pointer event before its touch event, so the lift that fires comes first.
 *
 * `toggleRef` is the shell's, kept current by it; `photoId` is there for the reset.
 */
export function useDoubleTap(rootRef: RefObject<HTMLElement | null>, { toggleRef, photoId }: { toggleRef: RefObject<() => void>; photoId: string | null }): void {
    const state = useRef<DoubleTapState>(DOUBLE_TAP_IDLE);

    useEffect(() => {
        const root = rootRef.current;
        if (root === null) return;
        /** The touch whose lift fired, so its `touchend` is cancelled. A new touch going down clears it. */
        let fired = false;
        /**
         * The zoomed region's own scroll to the tapped place, and where it left the region. That scroll's event comes at
         * the next frame, and it's no fling, so it doesn't quiet the taps. A scroll anywhere else is the visitor's.
         */
        let ownScroll: { target: Element; left: number; top: number } | null = null;

        const toggleAt = (at: { x: number; y: number }) => {
            const stage = root.querySelector<HTMLElement>(STAGE_SELECTOR);
            const zoomingIn = stage !== null && !stage.hasAttribute('data-zoomed');
            const fitted = zoomingIn ? stage.querySelector(CURRENT_SELECTOR)?.getBoundingClientRect() : undefined;
            flushSync(() => toggleRef.current());
            const place = fitted ? placeOnPhoto(fitted, at) : null;
            if (stage === null || place === null || !stage.hasAttribute('data-zoomed')) return;
            const zoomed = stage.querySelector(CURRENT_SELECTOR)?.getBoundingClientRect();
            if (!zoomed) return;
            const by = zoomScrollBy(zoomed, place, at);
            stage.scrollLeft += by.left;
            stage.scrollTop += by.top;
            ownScroll = { target: stage, left: stage.scrollLeft, top: stage.scrollTop };
        };
        const apply = (input: DoubleTapInput) => {
            const result = reduceDoubleTap(state.current, input);
            state.current = result.state;
            if (!result.fire || input.type !== 'up') return;
            fired = true;
            ownScroll = null;
            toggleAt({ x: input.x, y: input.y });
        };
        const onDown = (event: PointerEvent) => {
            fired = false;
            const target = event.target instanceof Element ? event.target : null;
            const onStage = target !== null && target.closest(STAGE_SELECTOR) !== null;
            const eligible = event.pointerType === 'touch' && onStage && !isPinched(window.visualViewport?.scale);
            apply({ type: 'down', pointerId: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp, primary: event.isPrimary, eligible });
        };
        const onMove = (event: PointerEvent) => apply({ type: 'move', pointerId: event.pointerId, x: event.clientX, y: event.clientY });
        const onUp = (event: PointerEvent) => apply({ type: 'up', pointerId: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp });
        const onCancel = (event: PointerEvent) => apply({ type: 'cancel', pointerId: event.pointerId, t: event.timeStamp });
        const onTouchEnd = (event: TouchEvent) => {
            if (!fired) return;
            fired = false;
            if (event.cancelable) event.preventDefault();
        };
        // Scroll events don't bubble, so one capturing listener on the document hears the page, the modal, and the zoomed photograph.
        const onScroll = (event: Event) => {
            const own = ownScroll;
            if (own !== null && event.target === own.target && own.target.scrollLeft === own.left && own.target.scrollTop === own.top) return;
            ownScroll = null;
            apply({ type: 'scroll', t: event.timeStamp });
        };
        root.addEventListener('pointerdown', onDown);
        root.addEventListener('pointermove', onMove);
        root.addEventListener('pointerup', onUp);
        root.addEventListener('pointercancel', onCancel);
        root.addEventListener('touchend', onTouchEnd, { passive: false });
        document.addEventListener('scroll', onScroll, { capture: true, passive: true });
        return () => {
            root.removeEventListener('pointerdown', onDown);
            root.removeEventListener('pointermove', onMove);
            root.removeEventListener('pointerup', onUp);
            root.removeEventListener('pointercancel', onCancel);
            root.removeEventListener('touchend', onTouchEnd);
            document.removeEventListener('scroll', onScroll, { capture: true });
            state.current = DOUBLE_TAP_IDLE;
        };
    }, [rootRef, toggleRef]);

    // A move by any route drops a first tap, so a tap on the last photograph and one on the next never pair.
    useEffect(() => {
        state.current = reduceDoubleTap(state.current, { type: 'reset' }).state;
    }, [photoId]);
}
