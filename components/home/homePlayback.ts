/**
 * The Home slideshow's playback rules, as a pure model the hook drives. One
 * owner decides when Home moves on its own, and nothing else keeps a timer.
 */

/** How long each photograph stays before Home moves on by itself. */
export const HOME_AUTO_ADVANCE_MS = 12000;

/** The shortest interval accepted. Anything faster falls back to HOME_AUTO_ADVANCE_MS. */
const MIN_AUTO_ADVANCE_MS = 5000;

/** What the visitor asked for. Only the playback button changes it. */
export type PlaybackIntent = 'none' | 'paused' | 'playing';

/** The Home root's data-playback value, the first rule that matches. */
export type PlaybackState = 'single' | 'not-ready' | 'paused' | 'reduced-motion' | 'hidden' | 'held' | 'advancing';

export interface PlaybackModel {
    index: number;
    photoIds: readonly string[];
    intent: PlaybackIntent;
    reducedMotion: boolean;
    visible: boolean;
    /** The first full-quality photograph has loaded and the intro has settled. */
    ready: boolean;
    /** Reasons to wait, such as keyboard focus in the chrome. They never change intent. */
    holds: ReadonlySet<string>;
    /** Bumped whenever a fresh full interval should start. */
    restart: number;
}

export type PlaybackAction =
    | { type: 'next' }
    | { type: 'prev' }
    | { type: 'advance' }
    | { type: 'toggle' }
    | { type: 'hold'; key: string; active: boolean }
    | { type: 'photos'; photoIds: readonly string[] }
    | { type: 'reducedMotion'; value: boolean }
    | { type: 'visible'; value: boolean }
    | { type: 'ready'; value: boolean };

export const countOf = (model: Pick<PlaybackModel, 'photoIds'>) => model.photoIds.length;

/** The visitor wants the slideshow running. The button's name comes from this alone. */
export function wantsPlay(model: PlaybackModel): boolean {
    return !model.reducedMotion && model.intent !== 'paused';
}

/** Home moves on by itself only now. */
export function isAdvancing(model: PlaybackModel): boolean {
    return wantsPlay(model) && model.ready && model.visible && model.holds.size === 0 && countOf(model) >= 2;
}

export function playbackState(model: PlaybackModel): PlaybackState {
    if (countOf(model) < 2) return 'single';
    if (!model.ready) return 'not-ready';
    if (model.intent === 'paused') return 'paused';
    if (model.reducedMotion && !wantsPlay(model)) return 'reduced-motion';
    if (!model.visible) return 'hidden';
    if (model.holds.size > 0) return 'held';
    return 'advancing';
}

/** Moves by `step`, wrapping at both ends, and starts a fresh interval. */
function move(model: PlaybackModel, step: number): PlaybackModel {
    const count = countOf(model);
    if (count < 2) return model;
    return { ...model, index: (((model.index + step) % count) + count) % count, restart: model.restart + 1 };
}

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

export function reducePlayback(model: PlaybackModel, action: PlaybackAction): PlaybackModel {
    switch (action.type) {
        case 'next':
            return move(model, 1);
        case 'prev':
            return move(model, -1);
        case 'advance':
            // A tick that raced a Pause, a hold, or a hidden tab does nothing.
            return isAdvancing(model) ? move(model, 1) : model;
        case 'toggle':
            if (wantsPlay(model)) return { ...model, intent: 'paused' };
            // Under reduced motion Play does nothing, so a paused visitor stays paused.
            if (model.reducedMotion) return model;
            return { ...model, intent: 'playing', restart: model.restart + 1 };
        case 'hold': {
            if (model.holds.has(action.key) === action.active) return model;
            const holds = new Set(model.holds);
            if (action.active) holds.add(action.key);
            else holds.delete(action.key);
            return { ...model, holds };
        }
        case 'photos': {
            if (sameIds(model.photoIds, action.photoIds)) return model;
            // Stay on the same photograph if it's still there, otherwise start over.
            const current = model.photoIds[model.index];
            const kept = current === undefined ? -1 : action.photoIds.indexOf(current);
            return { ...model, photoIds: [...action.photoIds], index: Math.max(0, kept), restart: model.restart + 1 };
        }
        case 'reducedMotion':
            return model.reducedMotion === action.value ? model : { ...model, reducedMotion: action.value };
        case 'visible':
            return model.visible === action.value ? model : { ...model, visible: action.value };
        case 'ready':
            return model.ready === action.value ? model : { ...model, ready: action.value };
    }
}

export function initialPlayback(init: Partial<PlaybackModel> & Pick<PlaybackModel, 'photoIds'>): PlaybackModel {
    return {
        index: 0,
        intent: 'none',
        reducedMotion: false,
        visible: true,
        ready: false,
        holds: new Set(),
        restart: 0,
        ...init,
        photoIds: [...init.photoIds],
    };
}

/** The interval to use. One that isn't a whole number of at least 5000 ms falls back, with a warning outside production. */
export function resolveInterval(intervalMs: number): number {
    if (Number.isInteger(intervalMs) && intervalMs >= MIN_AUTO_ADVANCE_MS) return intervalMs;
    if (process.env.NODE_ENV !== 'production') {
        console.warn(`Home playback ignores an interval of ${intervalMs} ms and uses ${HOME_AUTO_ADVANCE_MS} ms.`);
    }
    return HOME_AUTO_ADVANCE_MS;
}
