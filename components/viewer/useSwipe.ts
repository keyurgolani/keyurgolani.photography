'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { SWIPE_IDLE, claimsTouch, isPinched, reduceSwipe, type SwipeInput, type SwipeState } from './swipe';
import type { ViewerStep } from './viewerKeys';

/** The photograph's box, where a swipe can start. Controls sit outside it. */
export const STAGE_SELECTOR = '[data-viewer-stage]';

/**
 * Swipes on the Viewer's shell root (#9), which outlives every move, so a
 * gesture survives the photograph under it and its listeners go once. A
 * gesture starts on the photograph's stage while it isn't zoomed and the
 * page isn't pinch-zoomed, and the root takes the pointer's capture, so the
 * lift comes back to it wherever the finger ends. The rule is reduceSwipe's.
 * The stage's `touch-action: pan-y pinch-zoom` (StoryViewer.module.css)
 * leaves vertical scroll and pinch zoom to the browser, which cancels the
 * pointer when it takes one, and a cancel never moves. While the page is
 * pinch-zoomed, the returned flag goes on the shell root as `data-pinched`,
 * which gives the stage `touch-action: auto`, so a sideways drag pans the
 * zoomed page instead. A new photograph (any route), Zoom, a pinch, and
 * unmount drop the gesture in flight. A followed touch that settles sideways
 * has its `touchmove`s cancelled (claimsTouch), so Chromium leaves no fling
 * behind it to swallow the next tap.
 *
 * `zoomedRef` and `stepRef` are the shell's, kept current by it; `zoomed`
 * and `photoId` are there for the reset.
 */
export function useSwipe(
    rootRef: RefObject<HTMLElement | null>,
    {
        zoomed,
        zoomedRef,
        stepRef,
        photoId,
    }: { zoomed: boolean; zoomedRef: RefObject<boolean>; stepRef: RefObject<(step: ViewerStep) => void>; photoId: string | null },
): boolean {
    const state = useRef<SwipeState>(SWIPE_IDLE);
    /** Whether the touch the gesture follows is claimed from the browser: null until its axis is settled (claimsTouch). */
    const claim = useRef<boolean | null>(null);
    const [pinched, setPinched] = useState(false);

    useEffect(() => {
        const viewport = window.visualViewport;
        if (!viewport) return;
        const update = () => setPinched(isPinched(viewport.scale));
        update();
        viewport.addEventListener('resize', update);
        return () => viewport.removeEventListener('resize', update);
    }, []);

    useEffect(() => {
        const root = rootRef.current;
        if (root === null) return;
        const apply = (input: SwipeInput) => {
            const result = reduceSwipe(state.current, input);
            state.current = result.state;
            if (result.step !== null) stepRef.current(result.step);
        };
        const onDown = (event: PointerEvent) => {
            claim.current = null;
            const target = event.target instanceof Element ? event.target : null;
            const onStage = target !== null && target.closest(STAGE_SELECTOR) !== null;
            const eligible = onStage && !zoomedRef.current && !isPinched(window.visualViewport?.scale);
            apply({ type: 'down', pointerId: event.pointerId, x: event.clientX, y: event.clientY, primary: event.isPrimary, eligible });
            if (state.current.start?.pointerId !== event.pointerId) return;
            try {
                root.setPointerCapture?.(event.pointerId);
            } catch {
                // A pointer the browser no longer counts as down can't be captured; its lift or cancel still reaches the root.
            }
        };
        const onUp = (event: PointerEvent) => apply({ type: 'up', pointerId: event.pointerId, x: event.clientX, y: event.clientY });
        const onCancel = (event: PointerEvent) => apply({ type: 'cancel', pointerId: event.pointerId });
        // A sideways drag the swipe follows is the Viewer's: its moves are cancelled, so the browser starts no fling at
        // the lift that would swallow the next tap (claimsTouch). The browser fires each pointer event before its touch
        // event, so the gesture's start is already set here.
        const onTouchMove = (event: TouchEvent) => {
            const { start } = state.current;
            if (start === null || event.touches.length !== 1) return;
            const touch = event.touches[0];
            claim.current ??= claimsTouch(touch.clientX - start.x, touch.clientY - start.y);
            if (claim.current === true && event.cancelable) event.preventDefault();
        };
        root.addEventListener('pointerdown', onDown);
        root.addEventListener('pointerup', onUp);
        root.addEventListener('pointercancel', onCancel);
        root.addEventListener('lostpointercapture', onCancel);
        root.addEventListener('touchmove', onTouchMove, { passive: false });
        return () => {
            root.removeEventListener('pointerdown', onDown);
            root.removeEventListener('pointerup', onUp);
            root.removeEventListener('pointercancel', onCancel);
            root.removeEventListener('lostpointercapture', onCancel);
            root.removeEventListener('touchmove', onTouchMove);
            state.current = SWIPE_IDLE;
            claim.current = null;
        };
    }, [rootRef, zoomedRef, stepRef]);

    // A move by any route, Zoom either way, or a pinch ends the gesture in flight.
    useEffect(() => {
        state.current = reduceSwipe(state.current, { type: 'reset' }).state;
    }, [photoId, zoomed, pinched]);

    return pinched;
}
