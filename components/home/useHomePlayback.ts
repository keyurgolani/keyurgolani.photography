'use client';

import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { isHomePlaybackPaused, rememberHomePlaybackPaused } from '@/utils/homeHeroCache';
import { useDocumentVisible } from '../motion/useDocumentVisible';
import { usePrefersReducedMotion } from '../motion/usePrefersReducedMotion';
import {
    HOME_AUTO_ADVANCE_MS,
    initialPlayback,
    isAdvancing,
    playbackState,
    reducePlayback,
    resolveInterval,
    wantsPlay,
    type PlaybackAction,
    type PlaybackIntent,
    type PlaybackModel,
    type PlaybackState,
} from './homePlayback';

/** What made the latest move: Home's opening, the timer, or the visitor. Home's own skips past a failure name theirs. */
export type MoveSource = 'opening' | 'auto' | 'manual';

export interface HomePlayback {
    index: number;
    count: number;
    intent: PlaybackIntent;
    wantsPlay: boolean;
    advancing: boolean;
    playbackState: PlaybackState;
    /** What made the latest move. 'opening' until the first one. */
    source: MoveSource;
    /** How many moves have been made, so a caller can tell one visit to a photograph from the next. */
    moves: number;
    togglePlayback: () => void;
    /** The visitor's Next and Previous. */
    next: () => void;
    prev: () => void;
    /** Moves on past a photograph that failed, on Home's own account: the timer's move ('auto') or the opening walk's. */
    skipFailed: (source: Exclude<MoveSource, 'manual'>) => void;
    /** Holds automatic advance for `key` while active, without touching the Pause/Play state. */
    setHold: (key: string, active: boolean) => void;
}

interface Options {
    photoIds: readonly string[];
    ready: boolean;
    intervalMs?: number;
    /** The photograph to open on, read once at mount, such as #4's authored opening. Anything that isn't one of `photoIds`' positions opens on the first. */
    initialIndex?: number;
    /**
     * #4's commit model: the photograph whose attempt last ended, by loading or failing, or null before any has. While
     * the photograph at `index` isn't it, the move is still on its way and no timer runs; its commit arms a fresh full
     * interval. Left out, the timer doesn't wait on photographs.
     */
    settledPhotoId?: string | null;
}

type HookAction = PlaybackAction | { type: 'skip'; source: Exclude<MoveSource, 'manual'> };
type HookModel = PlaybackModel & { source: MoveSource; moves: number };

/** The source a move action names, or null for one that isn't a move. */
function sourceOf(action: HookAction): MoveSource | null {
    if (action.type === 'next' || action.type === 'prev') return 'manual';
    if (action.type === 'advance') return 'auto';
    if (action.type === 'skip') return action.source;
    return null;
}

const openingIndex = (index: number | undefined, count: number) =>
    typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < count ? index : 0;

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Home's one playback owner. It subscribes to the motion preference and page
 * visibility, and keeps the only slideshow timer: a single setTimeout armed
 * while the sequence is advancing.
 */
export function useHomePlayback({ photoIds, ready, intervalMs = HOME_AUTO_ADVANCE_MS, initialIndex, settledPhotoId }: Options): HomePlayback {
    const reducedMotion = usePrefersReducedMotion();
    const visible = useDocumentVisible();
    const interval = useMemo(() => resolveInterval(intervalMs), [intervalMs]);

    // The reducer reads this render's preference, visibility, and readiness, so a queued tick never acts on stale ones.
    // An action that changes nothing hands back the same state, so React skips the render. The pure model passes the
    // move's source and count through untouched; a move stamps them here.
    const [state, dispatch] = useReducer(
        (current: HookModel, action: HookAction) => {
            const model = { ...current, reducedMotion, visible, ready };
            const result = reducePlayback(model, action.type === 'skip' ? { type: 'next' } : action) as HookModel;
            if (result === model) return current;
            const source = sourceOf(action);
            return source === null ? result : { ...result, source, moves: current.moves + 1 };
        },
        photoIds,
        (ids): HookModel => ({
            ...initialPlayback({ photoIds: ids, index: openingIndex(initialIndex, ids.length), intent: isHomePlaybackPaused() ? 'paused' : 'none' }),
            source: 'opening',
            moves: 0,
        }),
    );

    // A new list keeps the current photograph by id. Deciding it during render means no frame shows the wrong one.
    if (!sameIds(state.photoIds, photoIds)) dispatch({ type: 'photos', photoIds });

    const model: PlaybackModel = { ...state, reducedMotion, visible, ready };
    const advancing = isAdvancing(model);
    const idsKey = state.photoIds.join('\n');
    // A move still waiting on its photograph runs no timer (#4). It's not a hold: the slideshow is still running.
    const waiting = settledPhotoId !== undefined && state.photoIds[state.index] !== settledPhotoId;
    const ticking = advancing && !waiting;

    // Any index change, commit, Play, hold release, return to a visible tab, or new list arms a fresh full interval.
    useEffect(() => {
        if (!ticking) return;
        const timer = setTimeout(() => dispatch({ type: 'advance' }), interval);
        return () => clearTimeout(timer);
    }, [ticking, state.index, state.restart, interval, idsKey]);

    useEffect(() => {
        rememberHomePlaybackPaused(state.intent === 'paused');
    }, [state.intent]);

    const togglePlayback = useCallback(() => dispatch({ type: 'toggle' }), []);
    const next = useCallback(() => dispatch({ type: 'next' }), []);
    const prev = useCallback(() => dispatch({ type: 'prev' }), []);
    const skipFailed = useCallback((source: Exclude<MoveSource, 'manual'>) => dispatch({ type: 'skip', source }), []);
    const setHold = useCallback((key: string, active: boolean) => dispatch({ type: 'hold', key, active }), []);

    return {
        index: state.index,
        count: state.photoIds.length,
        intent: state.intent,
        wantsPlay: wantsPlay(model),
        advancing,
        playbackState: playbackState(model),
        source: state.source,
        moves: state.moves,
        togglePlayback,
        next,
        prev,
        skipFailed,
        setHold,
    };
}
