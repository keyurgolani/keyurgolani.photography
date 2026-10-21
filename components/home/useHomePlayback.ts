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

export interface HomePlayback {
    index: number;
    count: number;
    intent: PlaybackIntent;
    wantsPlay: boolean;
    advancing: boolean;
    playbackState: PlaybackState;
    togglePlayback: () => void;
    next: () => void;
    prev: () => void;
    /** Holds automatic advance for `key` while active, without touching the Pause/Play state. */
    setHold: (key: string, active: boolean) => void;
}

interface Options {
    photoIds: readonly string[];
    ready: boolean;
    intervalMs?: number;
}

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Home's one playback owner. It subscribes to the motion preference and page
 * visibility, and keeps the only slideshow timer: a single setTimeout armed
 * while the sequence is advancing.
 */
export function useHomePlayback({ photoIds, ready, intervalMs = HOME_AUTO_ADVANCE_MS }: Options): HomePlayback {
    const reducedMotion = usePrefersReducedMotion();
    const visible = useDocumentVisible();
    const interval = useMemo(() => resolveInterval(intervalMs), [intervalMs]);

    // The reducer reads this render's preference, visibility, and readiness, so a queued tick never acts on stale ones.
    const [state, dispatch] = useReducer(
        (current: PlaybackModel, action: PlaybackAction) => reducePlayback({ ...current, reducedMotion, visible, ready }, action),
        photoIds,
        (ids) => initialPlayback({ photoIds: ids, intent: isHomePlaybackPaused() ? 'paused' : 'none' }),
    );

    // A new list keeps the current photograph by id. Deciding it during render means no frame shows the wrong one.
    if (!sameIds(state.photoIds, photoIds)) dispatch({ type: 'photos', photoIds });

    const model: PlaybackModel = { ...state, reducedMotion, visible, ready };
    const advancing = isAdvancing(model);
    const idsKey = state.photoIds.join('\n');

    // Any index change, Play, hold release, return to a visible tab, or new list arms a fresh full interval.
    useEffect(() => {
        if (!advancing) return;
        const timer = setTimeout(() => dispatch({ type: 'advance' }), interval);
        return () => clearTimeout(timer);
    }, [advancing, state.index, state.restart, interval, idsKey]);

    useEffect(() => {
        rememberHomePlaybackPaused(state.intent === 'paused');
    }, [state.intent]);

    const togglePlayback = useCallback(() => dispatch({ type: 'toggle' }), []);
    const next = useCallback(() => dispatch({ type: 'next' }), []);
    const prev = useCallback(() => dispatch({ type: 'prev' }), []);
    const setHold = useCallback((key: string, active: boolean) => dispatch({ type: 'hold', key, active }), []);

    return {
        index: state.index,
        count: state.photoIds.length,
        intent: state.intent,
        wantsPlay: wantsPlay(model),
        advancing,
        playbackState: playbackState(model),
        togglePlayback,
        next,
        prev,
        setHold,
    };
}
