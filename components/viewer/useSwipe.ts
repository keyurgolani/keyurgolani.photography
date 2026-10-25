'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { SWIPE_IDLE, reduceSwipe, type SwipeInput, type SwipeState } from './swipe';
import type { ViewerStep } from './viewerKeys';

/** The photograph's box, where a swipe can start. Controls sit outside it. */
export const STAGE_SELECTOR = '[data-viewer-stage]';

/**
 * Swipes on the Viewer's shell root (#9), which outlives every move, so a
 * gesture survives the photograph under it and its listeners go once. A
 * gesture starts on the photograph's stage while it isn't zoomed, and the
 * root takes the pointer's capture, so the lift comes back to it wherever
 * the finger ends. The rule is reduceSwipe's. The stage's `touch-action:
 * pan-y pinch-zoom` (StoryViewer.module.css) leaves vertical scroll and
 * pinch zoom to the browser, which cancels the pointer when it takes one,
 * and a cancel never moves. A new photograph (any route), Zoom, and unmount
 * drop the gesture in flight.
 */
export function useSwipe(
    rootRef: RefObject<HTMLElement | null>,
    { zoomed, photoId, onStep }: { zoomed: boolean; photoId: string | null; onStep: (step: ViewerStep) => void },
): void {
    const state = useRef<SwipeState>(SWIPE_IDLE);
    const zoomedRef = useRef(zoomed);
    const stepRef = useRef(onStep);
    useEffect(() => {
        zoomedRef.current = zoomed;
        stepRef.current = onStep;
    }, [zoomed, onStep]);

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
            const eligible = !zoomedRef.current && target !== null && target.closest(STAGE_SELECTOR) !== null;
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
    }, [rootRef]);

    // A move by any route, or Zoom either way, ends the gesture in flight.
    useEffect(() => {
        state.current = reduceSwipe(state.current, { type: 'reset' }).state;
    }, [photoId, zoomed]);
}
