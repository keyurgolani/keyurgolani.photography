'use client';

import {createContext, ReactNode, useContext, useEffect, useSyncExternalStore} from 'react';

/** What the visitor chose. System follows the device. */
export type ThemeChoice = 'system' | 'light' | 'bright' | 'dark' | 'black';
/** What paints. System resolves to light or black. */
export type Theme = 'light' | 'bright' | 'dark' | 'black';

export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'bright', 'dark', 'black'];

// <html data-theme-choice> and <html data-theme> are the store: the server sends system and black, the inline script
// in app/layout.tsx puts the stored choice and its resolved theme there before first paint (and keeps System
// following the device), and setThemeChoice writes them. Each reader subscribes on its own through a
// MutationObserver on <html>, so the provider's value never changes (see the Suspense note in git history: a
// provider value that changed on mount re-rendered streamed boundaries instead of hydrating them).
const subscribe = (listener: () => void) => {
    const observer = new MutationObserver(listener);
    observer.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme', 'data-theme-choice']});
    return () => observer.disconnect();
};

const isChoice = (value: string | null): value is ThemeChoice => value !== null && (THEME_CHOICES as readonly string[]).includes(value);

const readChoice = (): ThemeChoice => {
    const value = document.documentElement.getAttribute('data-theme-choice');
    return isChoice(value) ? value : 'system';
};

const readTheme = (): Theme => {
    const value = document.documentElement.getAttribute('data-theme');
    return value === 'light' || value === 'bright' || value === 'dark' ? value : 'black';
};

const prefersLight = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;

/**
 * Applies a choice at once and stores it. Where motion is allowed and the browser has view transitions, the page's
 * colors crossfade over 180 ms (styles/themes.css); under reduced motion, or without them, they swap in one frame.
 * Storage that throws (site data blocked) only loses the choice on reload.
 */
export const setThemeChoice = (choice: ThemeChoice) => {
    const apply = () => {
        const root = document.documentElement;
        root.setAttribute('data-theme-choice', choice);
        root.setAttribute('data-theme', choice === 'system' ? (prefersLight() ? 'light' : 'black') : choice);
    };
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const start = (document as Document & {startViewTransition?: (callback: () => void) => unknown}).startViewTransition;
    if (!reduced && typeof start === 'function') start.call(document, apply);
    else apply();
    try {
        localStorage.setItem('theme', choice);
    } catch {
        // Nothing to keep it in.
    }
};

const VALUE = {setThemeChoice};

const ThemeContext = createContext<typeof VALUE | null>(null);

export const ThemeProvider = ({children}: { children: ReactNode }) => {
    // A parent's effect runs after its children's, so this lands once the page has committed.
    // Browser tests wait on html[data-hydrated].
    useEffect(() => {
        document.documentElement.dataset.hydrated = 'true';
    }, []);

    return (
        <ThemeContext.Provider value={VALUE}>
            {children}
        </ThemeContext.Provider>
    );
};

/** The choice, what it resolves to, and the setter. Keep it to leaves, as before: it re-renders after hydration. */
export const useThemeChoice = (): { choice: ThemeChoice; theme: Theme; setChoice: (choice: ThemeChoice) => void } => {
    const context = useContext(ThemeContext);
    if (!context) {
        throw new Error('useThemeChoice must be used within a ThemeProvider');
    }
    const choice = useSyncExternalStore(subscribe, readChoice, () => 'system' as const);
    const theme = useSyncExternalStore(subscribe, readTheme, () => 'black' as const);
    return {choice, theme, setChoice: context.setThemeChoice};
};

/** The legacy two-way flip, for callers that still read light or dark. Its dark is today's, which is Black now. */
export const useTheme = (): { theme: 'light' | 'dark'; toggleTheme: () => void } => {
    const {theme, setChoice} = useThemeChoice();
    const flat = theme === 'light' || theme === 'bright' ? 'light' : 'dark';
    return {theme: flat, toggleTheme: () => setChoice(flat === 'light' ? 'black' : 'light')};
};

export const useThemeToggle = (): (() => void) => useTheme().toggleTheme;
