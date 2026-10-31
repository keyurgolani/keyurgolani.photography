import { useLayoutEffect } from 'react';
import { THEME_CHOICES, type ThemeChoice } from '@/components/themeChoices';

/** The stored choice, read as the inline script reads it (themeScript.ts): Dark's `charcoal` is Dark, anything else System. */
function storedChoice(): ThemeChoice {
    let stored: string | null = null;
    try {
        stored = localStorage.getItem('theme');
    } catch {
        // Site data blocked: System.
    }
    if (stored === 'charcoal') return 'dark';
    return (THEME_CHOICES as readonly (string | null)[]).includes(stored) ? (stored as ThemeChoice) : 'system';
}

/**
 * The inline script's job, for a page React renders on the client from the start, where that script never runs:
 * Next's error shell (`<html id="__next_error__">`), which app/error.tsx renders into when the server render throws, and
 * global-error.tsx, which only ever renders on the client. Before the first paint it puts the stored choice and what it
 * paints on <html>, and it keeps System following the device. ThemeContext's readers see the change through their
 * observer. Where the script did run, the stored choice is already there, so it changes nothing.
 */
export function useStoredChoice(): void {
    useLayoutEffect(() => {
        const light = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null;
        const apply = () => {
            const choice = storedChoice();
            const theme = choice === 'system' ? (light?.matches ? 'light' : 'dark') : choice;
            const root = document.documentElement;
            if (root.getAttribute('data-theme-choice') !== choice) root.setAttribute('data-theme-choice', choice);
            if (root.getAttribute('data-theme') !== theme) root.setAttribute('data-theme', theme);
        };
        apply();
        light?.addEventListener?.('change', apply);
        return () => light?.removeEventListener?.('change', apply);
    }, []);
}
