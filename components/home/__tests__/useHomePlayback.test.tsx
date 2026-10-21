import { act, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mediaListenerCounts, setPrefersReducedMotion } from '@/test/matchMedia';
import { setDocumentVisibility } from '@/test/visibility';
import { rememberHomePlaybackPaused } from '@/utils/homeHeroCache';
import { HOME_AUTO_ADVANCE_MS } from '../homePlayback';
import { useHomePlayback } from '../useHomePlayback';

const INTERVAL = HOME_AUTO_ADVANCE_MS;
const ids = ['a', 'b', 'c', 'd'];

type Props = { photoIds: readonly string[]; ready: boolean };

function renderPlayback(props: Props = { photoIds: ids, ready: true }) {
    return renderHook((current: Props) => useHomePlayback(current), { initialProps: props, wrapper: StrictMode });
}

const advance = (ms: number) =>
    act(() => {
        vi.advanceTimersByTime(ms);
    });

/** Counts add and remove calls for the given event types on a target. */
function countListeners(target: EventTarget, types: string[]) {
    const counts = { added: 0, removed: 0 };
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
        if (types.includes(type)) counts.added += 1;
        add(type, listener, options);
    });
    vi.spyOn(target, 'removeEventListener').mockImplementation((type, listener, options) => {
        if (types.includes(type)) counts.removed += 1;
        remove(type, listener, options);
    });
    return counts;
}

describe('useHomePlayback', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        rememberHomePlaybackPaused(false);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('advances one full interval after it becomes ready, and not before', () => {
        const { result, rerender } = renderPlayback({ photoIds: ids, ready: false });
        advance(INTERVAL * 3);
        expect(result.current.index).toBe(0);
        expect(result.current.playbackState).toBe('not-ready');
        expect(vi.getTimerCount()).toBe(0);
        rerender({ photoIds: ids, ready: true });
        advance(INTERVAL - 1);
        expect(result.current.index).toBe(0);
        advance(1);
        expect(result.current.index).toBe(1);
    });

    it('Pause in the last millisecond stops every advance, and Play moves once a full interval later', () => {
        const { result } = renderPlayback();
        advance(INTERVAL - 1);
        act(() => result.current.togglePlayback());
        expect(result.current.intent).toBe('paused');
        expect(result.current.wantsPlay).toBe(false);
        expect(result.current.playbackState).toBe('paused');
        advance(INTERVAL * 10);
        expect(result.current.index).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        act(() => result.current.togglePlayback());
        expect(result.current.intent).toBe('playing');
        advance(INTERVAL - 1);
        expect(result.current.index).toBe(0);
        advance(1);
        expect(result.current.index).toBe(1);
    });

    it('a tick that fires after a Pause in the same task does nothing', () => {
        const { result } = renderPlayback();
        advance(INTERVAL - 1);
        // The Pause and the tick land before React commits, as when a click races the timer.
        act(() => {
            result.current.togglePlayback();
            vi.advanceTimersByTime(1);
        });
        expect(result.current.index).toBe(0);
    });

    it('Next at 11.9 s brings the automatic move a full interval later, not 0.1 s later', () => {
        const { result } = renderPlayback();
        advance(11_900);
        act(() => result.current.next());
        expect(result.current.index).toBe(1);
        advance(INTERVAL - 1);
        expect(result.current.index).toBe(1);
        advance(1);
        expect(result.current.index).toBe(2);
    });

    it('Previous wraps to the last photograph and restarts the countdown', () => {
        const { result } = renderPlayback();
        advance(6000);
        act(() => result.current.prev());
        expect(result.current.index).toBe(3);
        advance(INTERVAL - 1);
        expect(result.current.index).toBe(3);
        advance(1);
        expect(result.current.index).toBe(0);
    });

    it('a hold stops advance without touching intent, and its release starts a fresh interval', () => {
        const { result } = renderPlayback();
        advance(INTERVAL - 1);
        act(() => result.current.setHold('focus', true));
        expect(result.current.playbackState).toBe('held');
        expect(result.current.wantsPlay).toBe(true);
        expect(result.current.intent).toBe('none');
        advance(INTERVAL * 5);
        expect(result.current.index).toBe(0);
        act(() => result.current.setHold('focus', false));
        advance(INTERVAL - 1);
        expect(result.current.index).toBe(0);
        advance(1);
        expect(result.current.index).toBe(1);
    });

    it('a hidden tab never catches up: back after 60 s, it waits a full interval', () => {
        const { result } = renderPlayback();
        advance(INTERVAL - 1000);
        act(() => setDocumentVisibility('hidden'));
        expect(result.current.playbackState).toBe('hidden');
        advance(60_000);
        expect(result.current.index).toBe(0);
        act(() => setDocumentVisibility('visible'));
        advance(INTERVAL - 1);
        expect(result.current.index).toBe(0);
        advance(1);
        expect(result.current.index).toBe(1);
    });

    it('mounted in a hidden tab, it arms no timer until visible, then moves a full interval later', () => {
        setDocumentVisibility('hidden');
        const { result } = renderPlayback();
        expect(vi.getTimerCount()).toBe(0);
        advance(INTERVAL * 4);
        expect(result.current.index).toBe(0);
        act(() => setDocumentVisibility('visible'));
        expect(vi.getTimerCount()).toBe(1);
        advance(INTERVAL);
        expect(result.current.index).toBe(1);
    });

    it('a new list keeps the photograph on screen, and one photograph arms nothing', () => {
        const { result, rerender } = renderPlayback();
        act(() => result.current.next());
        act(() => result.current.next());
        expect(result.current.index).toBe(2);
        rerender({ photoIds: ['x', 'c', 'a'], ready: true });
        expect(result.current.index).toBe(1);
        expect(result.current.count).toBe(3);
        rerender({ photoIds: ['solo'], ready: true });
        expect(result.current.index).toBe(0);
        expect(result.current.playbackState).toBe('single');
        expect(vi.getTimerCount()).toBe(0);
        advance(INTERVAL * 3);
        expect(result.current.index).toBe(0);
    });

    it('reduced motion stops moves and timers at once, and turning it off honors the earlier choice', () => {
        const { result } = renderPlayback();
        advance(6000);
        act(() => setPrefersReducedMotion(true));
        expect(result.current.playbackState).toBe('reduced-motion');
        expect(result.current.wantsPlay).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        advance(INTERVAL * 3);
        expect(result.current.index).toBe(0);
        act(() => result.current.togglePlayback());
        expect(result.current.intent).toBe('none');
        act(() => setPrefersReducedMotion(false));
        expect(result.current.playbackState).toBe('advancing');
        advance(INTERVAL - 1);
        expect(result.current.index).toBe(0);
        advance(1);
        expect(result.current.index).toBe(1);
    });

    it('a Pause made before reduced motion stays put after it turns off', () => {
        const { result } = renderPlayback();
        act(() => result.current.togglePlayback());
        act(() => setPrefersReducedMotion(true));
        act(() => setPrefersReducedMotion(false));
        expect(result.current.intent).toBe('paused');
        expect(result.current.playbackState).toBe('paused');
        advance(INTERVAL * 3);
        expect(result.current.index).toBe(0);
    });

    it('remembers a Pause across a remount, but never a Play', () => {
        const first = renderPlayback();
        act(() => first.result.current.togglePlayback());
        first.unmount();
        const second = renderPlayback();
        expect(second.result.current.intent).toBe('paused');
        act(() => second.result.current.togglePlayback());
        second.unmount();
        expect(renderPlayback().result.current.intent).toBe('none');
    });

    it('falls back to the default interval for one that is too short', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { result } = renderHook(() => useHomePlayback({ photoIds: ids, ready: true, intervalMs: 50 }), { wrapper: StrictMode });
        advance(INTERVAL - 1);
        expect(result.current.index).toBe(0);
        advance(1);
        expect(result.current.index).toBe(1);
    });

    it('in Strict Mode, unmounting leaves no timers and balanced listeners', () => {
        const documentListeners = countListeners(document, ['visibilitychange']);
        const windowListeners = countListeners(window, ['pageshow']);
        const { result, unmount } = renderPlayback();
        expect(vi.getTimerCount()).toBe(1);
        act(() => result.current.next());
        act(() => setPrefersReducedMotion(true));
        act(() => setPrefersReducedMotion(false));
        unmount();
        expect(vi.getTimerCount()).toBe(0);
        expect(documentListeners.added).toBeGreaterThan(0);
        expect(documentListeners.removed).toBe(documentListeners.added);
        expect(windowListeners.removed).toBe(windowListeners.added);
        expect(mediaListenerCounts.added).toBeGreaterThan(0);
        expect(mediaListenerCounts.removed).toBe(mediaListenerCounts.added);
    });
});
