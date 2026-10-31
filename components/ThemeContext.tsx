'use client';

import {ReactNode, useEffect, useSyncExternalStore} from 'react';
import {prefersReducedMotion} from '@/components/motion/usePrefersReducedMotion';

import {THEME_CHOICES, type Theme, type ThemeChoice} from '@/components/themeChoices';

export type {Theme, ThemeChoice};

// <html data-theme-choice> and <html data-theme> are the store. The server sends system and dark; the inline script
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
    return value === 'light' || value === 'bright' || value === 'black' ? value : 'dark';
};

const prefersLight = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;

/** What a choice paints, on this device now. */
const resolveTheme = (choice: ThemeChoice): Theme => (choice === 'system' ? (prefersLight() ? 'light' : 'dark') : choice);

/**
 * Applies a choice at once and stores it. With `animate`, motion allowed and view transitions available, the page's
 * colours crossfade over 180 ms (styles/themes.css); otherwise they swap in one frame. Keyboard changes don't animate:
 * arrowing from System to Black passes Light, Bright and Dark, two full-page flashes in a dark room (P3-12). Storage that
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
const BAR: Record<Theme, string> = {light: '#ebe5d9', bright: '#ffffff', dark: '#080a09', black: '#000000'};

/**
 * The browser's bar (P3-10). The layout sends System's pair, a light and a dark `theme-color` meta, each with its
 * media query. An explicit choice paints both with its own ground, so Bright and Black get theirs whatever the device;
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
 * A theme change swaps in one frame (P2-7). Under reduced motion the motion baseline (app/globals.css) gives every
 * element a 0.01 ms transition of `all`, so a change of what paints, which changes colours on every element, would start
 * one transition per element and property: about 45,000 on a 5,000-photo series, each with its events, seconds of a
 * slow phone's main thread, and its scroll stays slower after (the v1.3.0 phone scroll regression). So while the new
 * theme lands, <html data-theme-swap> turns transitions off (globals.css, under reduced motion only, where 0.01 ms is
 * invisible anyway), and it goes two frames later, once that theme's frame has drawn. The observer's callback runs
 * before the next frame's style, whoever wrote the attribute: setThemeChoice, the inline script, or a test.
 */
const guardThemeSwaps = (): (() => void) => {
    const root = document.documentElement;
    let frame = 0;
    const observer = new MutationObserver((records) => {
        if (records.every((record) => record.oldValue === root.getAttribute('data-theme'))) return;
        root.setAttribute('data-theme-swap', '');
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => (frame = requestAnimationFrame(() => root.removeAttribute('data-theme-swap'))));
    });
    observer.observe(root, {attributes: true, attributeFilter: ['data-theme'], attributeOldValue: true});
    return () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
        root.removeAttribute('data-theme-swap');
    };
};

/**
 * The store is the DOM (above), so there's no context to provide: the provider only marks hydration, keeps the
 * browser's bar on the painting theme and guards each theme swap (above), and the hooks work with or without it (the
 * curator's login tests render the menu bare).
 */
export const ThemeProvider = ({children}: { children: ReactNode }) => {
    // A parent's effect runs after its children's, so this lands once the page has committed.
    // Browser tests wait on html[data-hydrated].
    useEffect(() => {
        document.documentElement.dataset.hydrated = 'true';
        syncThemeColor();
        const unguard = guardThemeSwaps();
        const unsubscribe = subscribe(syncThemeColor);
        return () => {
            unsubscribe();
            unguard();
        };
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
    const theme = useSyncExternalStore(subscribe, readTheme, () => 'dark' as const);
    return {choice, theme, setChoice};
};
