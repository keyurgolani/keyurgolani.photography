import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_HOLD_MS, REPEAT_GAP_MS, useLiveMessage } from '../liveMessage';

// #246: a live region's text, held only while it's being announced. Home's carousel and the Viewer's status both use it.

beforeEach(() => {
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

const advance = (ms: number) =>
    act(() => {
        vi.advanceTimersByTime(ms);
    });

/** The region's text after every render, so a clear and the landing after it both show. */
function live() {
    const texts: string[] = [];
    const view = renderHook(() => {
        const result = useLiveMessage();
        texts.push(result.message);
        return result;
    });
    const say = (text: string) => act(() => view.result.current.say(text));
    const landings = (text: string) => texts.filter((value, index) => value === text && texts[index - 1] !== text).length;
    return { view, say, landings, message: () => view.result.current.message };
}

describe('useLiveMessage', () => {
    it('holds a message no less than about a second', () => {
        expect(LIVE_HOLD_MS).toBeGreaterThanOrEqual(1000);
        expect(REPEAT_GAP_MS).toBeLessThan(LIVE_HOLD_MS);
    });

    it('starts empty, says a message at once, and empties the region LIVE_HOLD_MS later', () => {
        const { say, message } = live();
        expect(message()).toBe('');
        say('Photograph 2 of 3.');
        expect(message()).toBe('Photograph 2 of 3.');
        advance(LIVE_HOLD_MS - 1);
        expect(message()).toBe('Photograph 2 of 3.');
        advance(1);
        expect(message()).toBe('');
    });

    it('puts a new message in at once over one still held, and holds it from its own landing', () => {
        const { say, message } = live();
        say('Photograph 2 of 3.');
        advance(LIVE_HOLD_MS - 10);
        say('Photograph 3 of 3.');
        expect(message()).toBe('Photograph 3 of 3.');
        advance(LIVE_HOLD_MS - 1);
        expect(message()).toBe('Photograph 3 of 3.');
        advance(1);
        expect(message()).toBe('');
    });

    it('still says a repeat that comes while the clear is pending: cleared, then set REPEAT_GAP_MS later, then held again', () => {
        const { say, message, landings } = live();
        say('Last photograph in Harbor.');
        advance(LIVE_HOLD_MS - 10);
        say('Last photograph in Harbor.');
        expect(message()).toBe('');
        advance(REPEAT_GAP_MS - 1);
        expect(message()).toBe('');
        advance(1);
        expect(message()).toBe('Last photograph in Harbor.');
        expect(landings('Last photograph in Harbor.')).toBe(2);
        advance(LIVE_HOLD_MS - 1);
        expect(message()).toBe('Last photograph in Harbor.');
        advance(1);
        expect(message()).toBe('');
    });

    it('says a repeat that comes after the clear at once', () => {
        const { say, message, landings } = live();
        say('Last photograph in Harbor.');
        advance(LIVE_HOLD_MS);
        say('Last photograph in Harbor.');
        expect(message()).toBe('Last photograph in Harbor.');
        expect(landings('Last photograph in Harbor.')).toBe(2);
    });

    it('drops a repeat still waiting to land, and a new message after it says at once', () => {
        const { view, say, message, landings } = live();
        say('Last photograph in Harbor.');
        say('Last photograph in Harbor.');
        act(() => view.result.current.drop());
        advance(LIVE_HOLD_MS);
        expect(message()).toBe('');
        expect(landings('Last photograph in Harbor.')).toBe(1);
        say('Photograph 2 of 3.');
        expect(message()).toBe('Photograph 2 of 3.');
    });

    it('leaves no timer behind when it unmounts', () => {
        const { view, say } = live();
        say('Last photograph in Harbor.');
        say('Last photograph in Harbor.');
        view.unmount();
        expect(vi.getTimerCount()).toBe(0);
    });
});
