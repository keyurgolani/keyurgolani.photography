'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { SWIPE_IDLE, isPinched, reduceSwipe, type SwipeInput, type SwipeState } from './swipe';
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
 * unmount drop the gesture in flight.
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
        root.addEventListener('pointerdown', onDown);
        root.addEventListener('pointerup', onUp);
        root.addEventListener('pointercancel', onCancel);
        root.addEventListener('lostpointercapture', onCancel);
        return () => {
            root.removeEventListener('pointerdown', onDown);
            root.removeEventListener('pointerup', onUp);
            root.removeEventListener('pointercancel', onCancel);
            root.removeEventListener('lostpointercapture', onCancel);
            state.current = SWIPE_IDLE;
        };
    }, [rootRef, zoomedRef, stepRef]);

    // A move by any route, Zoom either way, or a pinch ends the gesture in flight.
    useEffect(() => {
        state.current = reduceSwipe(state.current, { type: 'reset' }).state;
    }, [photoId, zoomed, pinched]);

    return pinched;
}
