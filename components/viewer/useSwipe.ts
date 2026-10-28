'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { StageMotion } from './stageMotion';
import { SWIPE_IDLE, caughtBase, claimsTouch, followOffset, followTravel, isPinched, reduceSwipe, type SwipeInput, type SwipeState } from './swipe';
import type { ViewerStep } from './viewerKeys';

/**
 * The photograph's stage, where a swipe or a double-tap can start: the photograph and, on a phone, where the stage takes
 * the spare height (#9b), the dark ground above and below it, which gives a thumb more room. Controls sit outside it.
 */
export const STAGE_SELECTOR = '[data-viewer-stage]';

/** What the swipe reads from the shell as it goes, kept current there. */
export interface SwipeShell {
    zoomed: boolean;
    /** False under reduced motion: nothing follows the finger, and a move is the cut at the lift. */
    motion: boolean;
    /** Whether there's a photograph each way, so a pull toward an end meets the rubber band. */
    previous: boolean;
    next: boolean;
    /** Whether a move (by any route: a swipe, a control, a key) is on its way, so no swipe can start until it arrives. */
    pending(): boolean;
    /** The move the swipe asks for, at the lift. `settling` when the photograph is already settling into it. */
    step(step: ViewerStep, settling: boolean): void;
    /** A finger went down on the photograph: the shell starts fetching the neighbors that peek in. */
    engage(): void;
}

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
 * With motion (9a), the photograph follows a touch claimed sideways 1:1 from
 * the claim, with the neighbors peeking in, and meets a rubber band toward an
 * end. At the lift it settles onward into the move, or back. A finger that
 * goes down on it while it slides back catches it there. Under reduced
 * motion it stays still and the move is the cut at the lift, as before.
 *
 * `shellRef` is the shell's, kept current by it; `zoomed` and `photoId` are
 * there for the reset. `motionRef` holds the shell's StageMotion. It returns
 * whether the page is pinch-zoomed, and `drop`, which ends the gesture in
 * flight with no move, for a move by a control or a key while a finger holds
 * the photograph.
 */
export function useSwipe(
    rootRef: RefObject<HTMLElement | null>,
    { zoomed, shellRef, motionRef, photoId }: { zoomed: boolean; shellRef: RefObject<SwipeShell>; motionRef: RefObject<StageMotion | null>; photoId: string | null },
): { pinched: boolean; drop: () => void } {
    const state = useRef<SwipeState>(SWIPE_IDLE);
    /** Whether the touch the gesture follows is claimed from the browser: null until its axis is settled (claimsTouch). */
    const claim = useRef<boolean | null>(null);
    /** Where a caught settle held the photograph when the finger went down, which the drag starts from. */
    const base = useRef(0);
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
            const { release } = result;
            if (release === undefined) return;
            const shell = shellRef.current;
            const motion = shell.motion ? motionRef.current : null;
            const step = release.step;
            // Toward an end there's nothing to bring in: the photograph slides back, and the step announces the end.
            const toward = step === null ? false : step === 'next' ? shell.next : shell.previous;
            const settles = motion !== null && (release.followed || motion.heldOffset() !== 0);
            if (settles) motion.release(toward ? step : null, release.velocity);
            if (step !== null) shell.step(step, settles && toward);
        };
        const onDown = (event: PointerEvent) => {
            claim.current = null;
            const target = event.target instanceof Element ? event.target : null;
            const onStage = target !== null && target.closest(STAGE_SELECTOR) !== null;
            const shell = shellRef.current;
            const motion = shell.motion ? motionRef.current : null;
            // A move already decided is on its way, by a swipe, a control, or a key, so a finger can't start another until
            // its photograph arrives.
            const eligible = onStage && !shell.zoomed && !isPinched(window.visualViewport?.scale) && !shell.pending() && motion?.pendingStep() == null;
            apply({ type: 'down', pointerId: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp, primary: event.isPrimary, eligible });
            if (state.current.start?.pointerId !== event.pointerId) return;
            // Caught past an end, the drag picks up the pull the rubber band gave, so the photograph stays where it was caught.
            base.current = motion === null ? 0 : caughtBase(motion.catch(), motion.width(), { previous: shell.previous, next: shell.next });
            shell.engage();
            try {
                root.setPointerCapture?.(event.pointerId);
            } catch {
                // A pointer the browser no longer counts as down can't be captured; its lift or cancel still reaches the root.
            }
        };
        const onMove = (event: PointerEvent) => {
            const { start } = state.current;
            if (start === null || start.pointerId !== event.pointerId) return;
            // Every sample the browser took since the last event, so a quick flick, which it coalesces into a frame or two,
            // still has its speed (releaseVelocity). WebKit has no coalesced events, and there the event is the one sample.
            const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
            for (const sample of coalesced.length > 0 ? coalesced : [event]) {
                apply({ type: 'move', pointerId: event.pointerId, x: sample.clientX, y: sample.clientY, t: sample.timeStamp });
            }
            const shell = shellRef.current;
            const motion = shell.motion ? motionRef.current : null;
            const travel = followTravel(state.current.start, event.clientX);
            if (motion === null || travel === null) return;
            motion.hold(followOffset(travel, base.current, motion.width(), { previous: shell.previous, next: shell.next }));
        };
        const onUp = (event: PointerEvent) => apply({ type: 'up', pointerId: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp });
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
        root.addEventListener('pointermove', onMove);
        root.addEventListener('pointerup', onUp);
        root.addEventListener('pointercancel', onCancel);
        root.addEventListener('lostpointercapture', onCancel);
        root.addEventListener('touchmove', onTouchMove, { passive: false });
        return () => {
            root.removeEventListener('pointerdown', onDown);
            root.removeEventListener('pointermove', onMove);
            root.removeEventListener('pointerup', onUp);
            root.removeEventListener('pointercancel', onCancel);
            root.removeEventListener('lostpointercapture', onCancel);
            root.removeEventListener('touchmove', onTouchMove);
            state.current = SWIPE_IDLE;
            claim.current = null;
        };
    }, [rootRef, shellRef, motionRef]);

    // A move by any route, Zoom either way, or a pinch ends the gesture in flight. A gesture the photograph was
    // following slides back first, unless the move is the one it asked for.
    useEffect(() => {
        const had = state.current.start !== null;
        state.current = reduceSwipe(state.current, { type: 'reset' }).state;
        const motion = motionRef.current;
        if (had && motion !== null && motion.pendingStep() === null) motion.release(null, 0);
    }, [photoId, zoomed, pinched, motionRef]);

    const drop = useCallback(() => {
        state.current = reduceSwipe(state.current, { type: 'reset' }).state;
        claim.current = null;
    }, []);

    return { pinched, drop };
}
