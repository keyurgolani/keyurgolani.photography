'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { DOUBLE_TAP_IDLE, reduceDoubleTap, type DoubleTapInput, type DoubleTapState } from './doubleTap';
import { isPinched } from './swipe';
import { STAGE_SELECTOR } from './useSwipe';

/**
 * A double-tap on the photograph toggles Zoom (#9c), on touch only, on the Viewer's shell root, which outlives every
 * move. The rule is reduceDoubleTap's. It reads the same pointer events the swipe does and never cancels one, so the
 * swipe, vertical scroll, pinch, and the zoomed photograph's pan all go on as before. Any scroll in the document, a
 * fling included, quiets it for a moment (SETTLE), so a tap that stops a fling never counts. A pinch-zoomed page is
 * the browser's: its stage is back at `touch-action: auto` there, and the Viewer reads no taps.
 *
 * `toggleRef` is the shell's, kept current by it; `photoId` is there for the reset.
 */
export function useDoubleTap(rootRef: RefObject<HTMLElement | null>, { toggleRef, photoId }: { toggleRef: RefObject<() => void>; photoId: string | null }): void {
    const state = useRef<DoubleTapState>(DOUBLE_TAP_IDLE);

    useEffect(() => {
        const root = rootRef.current;
        if (root === null) return;
        const apply = (input: DoubleTapInput) => {
            const result = reduceDoubleTap(state.current, input);
            state.current = result.state;
            if (result.fire) toggleRef.current();
        };
        const onDown = (event: PointerEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            const onStage = target !== null && target.closest(STAGE_SELECTOR) !== null;
            const eligible = event.pointerType === 'touch' && onStage && !isPinched(window.visualViewport?.scale);
            apply({ type: 'down', pointerId: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp, primary: event.isPrimary, eligible });
        };
        const onMove = (event: PointerEvent) => apply({ type: 'move', pointerId: event.pointerId, x: event.clientX, y: event.clientY });
        const onUp = (event: PointerEvent) => apply({ type: 'up', pointerId: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp });
        const onCancel = (event: PointerEvent) => apply({ type: 'cancel', pointerId: event.pointerId, t: event.timeStamp });
        // Scroll events don't bubble, so one capturing listener on the document hears the page, the modal, and the zoomed photograph.
        const onScroll = (event: Event) => apply({ type: 'scroll', t: event.timeStamp });
        root.addEventListener('pointerdown', onDown);
        root.addEventListener('pointermove', onMove);
        root.addEventListener('pointerup', onUp);
        root.addEventListener('pointercancel', onCancel);
        document.addEventListener('scroll', onScroll, { capture: true, passive: true });
        return () => {
            root.removeEventListener('pointerdown', onDown);
            root.removeEventListener('pointermove', onMove);
            root.removeEventListener('pointerup', onUp);
            root.removeEventListener('pointercancel', onCancel);
            document.removeEventListener('scroll', onScroll, { capture: true });
            state.current = DOUBLE_TAP_IDLE;
        };
    }, [rootRef, toggleRef]);

    // A move by any route drops a first tap, so a tap on the last photograph and one on the next never pair.
    useEffect(() => {
        state.current = reduceDoubleTap(state.current, { type: 'reset' }).state;
    }, [photoId]);
}
