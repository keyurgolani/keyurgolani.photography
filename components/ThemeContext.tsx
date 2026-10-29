'use client';

import {ReactNode, useEffect, useSyncExternalStore} from 'react';
import {prefersReducedMotion} from '@/components/motion/usePrefersReducedMotion';

import {THEME_CHOICES, type Theme, type ThemeChoice} from '@/components/themeChoices';

export type {Theme, ThemeChoice};

// <html data-theme-choice> and <html data-theme> are the store. The server sends system and black; the inline script
// in app/layout.tsx puts the stored choice and its theme there before first paint, keeps System following the device
// and follows a choice made in another tab; setThemeChoice writes them here. Each reader subscribes on its own, so the
// provider's value never changes: a provider value that changed on mount is a context change above every Suspense
// boundary still streaming in, which React then renders again on the client instead of hydrating it (the curator's
// inbox, opened in the light theme on a phone, didn't land on its item). Writes here notify at once; the script's
// writes reach readers through the observer.
const listeners = new Set<() => void>();
const notify = () => {
    for (const listener of listeners) listener();
};
let observer: MutationObserver | null = null;

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    if (!observer && typeof MutationObserver === 'function') {
        observer = new MutationObserver(notify);
        observer.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme', 'data-theme-choice']});
    }
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && observer) {
            observer.disconnect();
            observer = null;
        }
    };
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

/** What a choice paints, on this device now. */
const resolveTheme = (choice: ThemeChoice): Theme =>
    choice === 'system' ? (prefersLight() ? 'light' : 'black') : choice === 'charcoal' ? 'dark' : choice;

/**
 * Applies a choice at once and stores it. With `animate`, motion allowed and view transitions available, the page's
 * colours crossfade over 180 ms (styles/themes.css); otherwise they swap in one frame. Keyboard changes don't animate:
 * arrowing from System to Black passes Light and Bright, two full-page flashes in a dark room (P3-12). Storage that
 * throws (site data blocked) only loses the choice on reload.
 */
const setThemeChoice = (choice: ThemeChoice, {animate = false}: {animate?: boolean} = {}) => {
    const apply = () => {
        const root = document.documentElement;
        root.setAttribute('data-theme-choice', choice);
        root.setAttribute('data-theme', resolveTheme(choice));
        notify();
    };
    const start = (document as Document & {startViewTransition?: (callback: () => void) => unknown}).startViewTransition;
    if (animate && !prefersReducedMotion() && typeof start === 'function') start.call(document, apply);
    else apply();
    try {
        localStorage.setItem('theme', choice);
    } catch {
        // Nothing to keep it in.
    }
};

/** Each theme's ground, for the browser's own bar when the choice is explicit. */
const BAR: Record<Theme, string> = {light: '#ebe5d9', bright: '#ffffff', dark: '#1b1f1d', black: '#080a09'};

/**
 * The browser's bar (P3-10). The layout sends System's pair, a light and a dark `theme-color` meta, each with its
 * media query. An explicit choice paints both with its own ground, so Bright and Dark get theirs whatever the device;
 * System puts the pair back. The inline script can't do it: it runs before Next writes the metas.
 */
const syncThemeColor = () => {
    const explicit = readChoice() !== 'system';
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
        if (meta.dataset.themeSystem === undefined) meta.dataset.themeSystem = meta.content;
        meta.content = explicit ? BAR[readTheme()] : meta.dataset.themeSystem;
    }
};

/**
 * The store is the DOM (above), so there's no context to provide: the provider only marks hydration and keeps the
 * browser's bar on the painting theme, and the hooks work with or without it (the curator's login tests render the
 * menu bare).
 */
export const ThemeProvider = ({children}: { children: ReactNode }) => {
    // A parent's effect runs after its children's, so this lands once the page has committed.
    // Browser tests wait on html[data-hydrated].
    useEffect(() => {
        document.documentElement.dataset.hydrated = 'true';
        syncThemeColor();
        return subscribe(syncThemeColor);
    }, []);

    return children;
};

/** The setter alone, with no subscription: a caller that never reads the theme never re-renders when it changes. */
export const useSetThemeChoice = (): typeof setThemeChoice => setThemeChoice;

/**
 * The choice and what it paints. The caller subscribes, so it renders again right after hydration when the stored
 * choice isn't the server's. Keep it to leaves: a caller must not wrap streamed content (a Suspense boundary or
 * children that stream in), since that re-render would make React render the boundary again on the client.
 */
export const useThemeChoice = (): {choice: ThemeChoice; theme: Theme; setChoice: typeof setThemeChoice} => {
    const setChoice = useSetThemeChoice();
    const choice = useSyncExternalStore(subscribe, readChoice, () => 'system' as const);
    const theme = useSyncExternalStore(subscribe, readTheme, () => 'black' as const);
    return {choice, theme, setChoice};
};
