import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    HOME_AUTO_ADVANCE_MS,
    initialPlayback,
    isAdvancing,
    playbackState,
    reducePlayback,
    resolveInterval,
    wantsPlay,
    type PlaybackModel,
} from '../homePlayback';

const ids = ['a', 'b', 'c'];
/** Ready, visible, and unheld, so it advances unless a case changes one of those. */
const base = (overrides: Partial<PlaybackModel> = {}): PlaybackModel => initialPlayback({ photoIds: ids, ready: true, ...overrides });

describe('wantsPlay', () => {
    it.each([
        ['nothing chosen yet', base(), true],
        ['Play chosen', base({ intent: 'playing' }), true],
        ['Pause chosen', base({ intent: 'paused' }), false],
        ['reduced motion', base({ reducedMotion: true }), false],
        ['reduced motion after Play', base({ reducedMotion: true, intent: 'playing' }), false],
        ['a hidden tab, a hold, or no readiness', base({ visible: false, ready: false, holds: new Set(['focus']) }), true],
    ])('is %s: %s', (_, model, expected) => {
        expect(wantsPlay(model)).toBe(expected);
    });
});

describe('isAdvancing', () => {
    it.each([
        ['when it wants to play, is ready and visible, has no hold, and two photos', base(), true],
        ['while paused', base({ intent: 'paused' }), false],
        ['under reduced motion', base({ reducedMotion: true }), false],
        ['before the first photograph and the intro are ready', base({ ready: false }), false],
        ['in a hidden tab', base({ visible: false }), false],
        ['while held', base({ holds: new Set(['pointer']) }), false],
        ['with one photograph', base({ photoIds: ['a'] }), false],
        ['with none', base({ photoIds: [] }), false],
    ])('is %s', (_, model, expected) => {
        expect(isAdvancing(model)).toBe(expected);
    });
});

describe('playbackState', () => {
    it.each([
        ['single', base({ photoIds: ['a'], ready: false, intent: 'paused' })],
        ['not-ready', base({ ready: false, intent: 'paused', reducedMotion: true })],
        ['paused', base({ intent: 'paused', reducedMotion: true, visible: false })],
        ['reduced-motion', base({ reducedMotion: true, visible: false, holds: new Set(['focus']) })],
        ['hidden', base({ visible: false, holds: new Set(['focus']) })],
        ['held', base({ holds: new Set(['focus']) })],
        ['advancing', base()],
    ])('reads %s first', (expected, model) => {
        expect(playbackState(model)).toBe(expected);
    });
});

describe('reducePlayback', () => {
    it.each([
        ['next moves on', base({ index: 0 }), { type: 'next' } as const, 1],
        ['next wraps from the last photograph to the first', base({ index: 2 }), { type: 'next' } as const, 0],
        ['prev moves back', base({ index: 2 }), { type: 'prev' } as const, 1],
        ['prev wraps from the first photograph to the last', base({ index: 0 }), { type: 'prev' } as const, 2],
        ['an automatic advance moves on and wraps', base({ index: 2 }), { type: 'advance' } as const, 0],
        ['an automatic advance does nothing once paused', base({ index: 1, intent: 'paused' }), { type: 'advance' } as const, 1],
        ['an automatic advance does nothing while held', base({ index: 1, holds: new Set(['focus']) }), { type: 'advance' } as const, 1],
        ['an automatic advance does nothing in a hidden tab', base({ index: 1, visible: false }), { type: 'advance' } as const, 1],
        ['an automatic advance does nothing under reduced motion', base({ index: 1, reducedMotion: true }), { type: 'advance' } as const, 1],
    ])('%s', (_, model, action, index) => {
        expect(reducePlayback(model, action).index).toBe(index);
    });

    it.each(['none', 'paused', 'playing'] as const)('manual moves leave the %s intent alone', (intent) => {
        const model = base({ intent });
        expect(reducePlayback(model, { type: 'next' }).intent).toBe(intent);
        expect(reducePlayback(model, { type: 'prev' }).intent).toBe(intent);
    });

    it('a manual move with one photograph does nothing', () => {
        const model = base({ photoIds: ['a'] });
        expect(reducePlayback(model, { type: 'next' })).toBe(model);
    });

    it.each([
        ['pauses while it wants to play', base(), 'paused'],
        ['pauses after Play', base({ intent: 'playing' }), 'paused'],
        ['plays after a Pause', base({ intent: 'paused' }), 'playing'],
    ])('the button %s', (_, model, intent) => {
        expect(reducePlayback(model, { type: 'toggle' }).intent).toBe(intent);
    });

    it.each(['none', 'paused'] as const)('the button does nothing under reduced motion, from %s', (intent) => {
        const model = base({ reducedMotion: true, intent });
        expect(reducePlayback(model, { type: 'toggle' })).toBe(model);
    });

    it('Play starts a fresh interval, and Pause needs none', () => {
        const paused = base({ intent: 'paused' });
        expect(reducePlayback(paused, { type: 'toggle' }).restart).toBe(paused.restart + 1);
        expect(reducePlayback(base(), { type: 'toggle' }).restart).toBe(0);
    });

    it('manual moves start a fresh interval', () => {
        expect(reducePlayback(base(), { type: 'next' }).restart).toBe(1);
        expect(reducePlayback(base(), { type: 'prev' }).restart).toBe(1);
    });

    it.each(['none', 'paused', 'playing'] as const)('holds never touch the %s intent', (intent) => {
        const held = reducePlayback(base({ intent }), { type: 'hold', key: 'focus', active: true });
        expect(held.intent).toBe(intent);
        expect([...held.holds]).toEqual(['focus']);
        const released = reducePlayback(held, { type: 'hold', key: 'focus', active: false });
        expect(released.intent).toBe(intent);
        expect(released.holds.size).toBe(0);
    });

    it('keeps each hold separate, and a repeated one changes nothing', () => {
        const both = [{ key: 'focus', active: true }, { key: 'pointer', active: true }].reduce(
            (model, hold) => reducePlayback(model, { type: 'hold', ...hold }),
            base(),
        );
        expect(isAdvancing(reducePlayback(both, { type: 'hold', key: 'focus', active: false }))).toBe(false);
        expect(reducePlayback(both, { type: 'hold', key: 'focus', active: true })).toBe(both);
    });

    it('a new list keeps the current photograph by id', () => {
        const model = base({ index: 1 });
        const next = reducePlayback(model, { type: 'photos', photoIds: ['z', 'c', 'b', 'a'] });
        expect(next.index).toBe(2);
        expect(next.photoIds).toEqual(['z', 'c', 'b', 'a']);
        expect(next.restart).toBe(model.restart + 1);
    });

    it('a new list without the current photograph starts at the first', () => {
        expect(reducePlayback(base({ index: 2 }), { type: 'photos', photoIds: ['x', 'y'] }).index).toBe(0);
    });

    it('the same list by content changes nothing', () => {
        const model = base({ index: 1 });
        expect(reducePlayback(model, { type: 'photos', photoIds: [...ids] })).toBe(model);
    });

    it.each([
        ['reducedMotion', { type: 'reducedMotion', value: true } as const],
        ['visible', { type: 'visible', value: false } as const],
        ['ready', { type: 'ready', value: false } as const],
    ])('tracks %s without touching intent', (field, action) => {
        const next = reducePlayback(base({ intent: 'playing' }), action);
        expect(next[field as 'reducedMotion' | 'visible' | 'ready']).toBe(action.value);
        expect(next.intent).toBe('playing');
    });
});

describe('resolveInterval', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('keeps a whole interval of at least 5000 ms', () => {
        expect(resolveInterval(5000)).toBe(5000);
        expect(resolveInterval(HOME_AUTO_ADVANCE_MS)).toBe(12000);
    });

    it.each([4999, 0, -1, 7500.5, Number.NaN, Number.POSITIVE_INFINITY])('falls back from %s with a warning', (value) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(resolveInterval(value)).toBe(HOME_AUTO_ADVANCE_MS);
        expect(warn).toHaveBeenCalledTimes(1);
    });
});
