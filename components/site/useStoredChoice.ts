import { useLayoutEffect } from 'react';
import { THEME_CHOICES } from '@/components/themeChoices';

/** Sets an attribute on <html> only when it differs, so a page where the script already ran sees no write. */
function put(name: string, value: string): void {
    const root = document.documentElement;
    if (root.getAttribute(name) !== value) root.setAttribute(name, value);
}

/**
 * The inline script's job, for a page React renders on the client from the start, where that script never runs:
 * Next's error shell (`<html id="__next_error__">`), which app/error.tsx renders into when the server render throws, and
 * global-error.tsx, which only ever renders on the client. Before React's first paint it puts the stored choice and
 * what it paints on <html>, keeps System following the device, and applies a choice made in another tab. ThemeContext's
 * readers see the change through their observer. Where the script did run, the stored choice is already there, so it
 * changes nothing.
 *
 * It does what themeScript.ts does, step for step (useStoredChoice.test.tsx runs both over the same inputs): `read`
 * is the script's `r()`, storage to `data-theme-choice`, and `paint` its `a()`, `data-theme-choice` to `data-theme`.
 * A device change only repaints the choice on <html>, never re-reading storage: with site data blocked, the menu's
 * choice lives only there (ThemeContext's setThemeChoice), and storage would say System.
 */
export function useStoredChoice(): void {
    useLayoutEffect(() => {
        const light = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null;
        const paint = () => {
            const choice = document.documentElement.getAttribute('data-theme-choice');
            put('data-theme', choice === 'system' ? (light?.matches ? 'light' : 'dark') : String(choice));
        };
        const read = () => {
            let stored: string | null = null;
            try {
                stored = localStorage.getItem('theme');
            } catch {
                // Site data blocked: System.
            }
            // Dark's `charcoal` is Dark; anything else that isn't a choice is System.
            if (stored === 'charcoal') stored = 'dark';
            put('data-theme-choice', (THEME_CHOICES as readonly (string | null)[]).includes(stored) ? String(stored) : 'system');
            paint();
        };
        const fromAnotherTab = (event: StorageEvent) => {
            if (event.key === 'theme' || event.key === null) read();
        };
        read();
        light?.addEventListener?.('change', paint);
        window.addEventListener('storage', fromAnotherTab);
        return () => {
            light?.removeEventListener?.('change', paint);
            window.removeEventListener('storage', fromAnotherTab);
        };
    }, []);
}
