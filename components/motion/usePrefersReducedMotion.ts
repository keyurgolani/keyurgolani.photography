import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

const mediaQuery = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : undefined);

function subscribe(onChange: () => void): () => void {
    const list = mediaQuery();
    if (!list) return () => {};
    if (typeof list.addEventListener === 'function') {
        list.addEventListener('change', onChange);
        return () => list.removeEventListener('change', onChange);
    }
    // Safari before 14 only has the older listener API.
    list.addListener(onChange);
    return () => list.removeListener(onChange);
}

const getSnapshot = () => mediaQuery()?.matches ?? false;

/** The server can't know the preference, so it renders full motion and the client corrects on hydration. */
const getServerSnapshot = () => false;

/**
 * The visitor's live prefers-reduced-motion setting. This is the only
 * TypeScript module that reads it, so every motion choice follows one value.
 */
export function usePrefersReducedMotion(): boolean {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** The same setting, read once, for code that acts on an event rather than rendering (a theme change's crossfade). */
export const prefersReducedMotion = (): boolean => getSnapshot();
