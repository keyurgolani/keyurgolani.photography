'use client';

import {createContext, ReactNode, useContext, useEffect, useSyncExternalStore} from 'react';

type Theme = 'dark' | 'light';

interface ThemeContextType {
    theme: Theme;
    toggleTheme: () => void;
}

// <html data-theme> is the store: the server sends dark, the inline script in app/layout.tsx may already have put a
// stored light theme there, and the toggle writes it. Each reader subscribes to it on its own, so the provider's
// value never changes. A provider value that changed on mount (it used to, for a stored light theme) is a context
// change above every Suspense boundary still streaming in, and React then renders such a boundary again on the
// client instead of hydrating it. The curator's inbox, behind its loading state, did, so a phone opening an item in
// the light theme didn't land on it, and in the dark theme it did.
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

const readTheme = (): Theme => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

/** Dark, as the server HTML is, so the first client render matches it. */
const serverTheme = (): Theme => 'dark';

// The page's own attribute decides the next theme, and storage that throws (site data blocked) only loses the
// choice on reload, so the toggle still flips both ways.
const toggleTheme = () => {
    const newTheme = readTheme() === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', newTheme);
    try {
        localStorage.setItem('theme', newTheme);
    } catch {
        // Nothing to keep it in.
    }
    for (const listener of listeners) listener();
};

const VALUE = {toggleTheme};

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

/**
 * The toggle alone, from the context, with no subscription: a caller that never reads the theme never re-renders
 * when it changes, or after hydration.
 */
export const useThemeToggle = (): (() => void) => {
    const context = useContext(ThemeContext);
    if (!context) {
        throw new Error('useThemeToggle must be used within a ThemeProvider');
    }
    return context.toggleTheme;
};

/**
 * The theme and the toggle. The caller subscribes to the theme, so in the light theme it renders again right after
 * hydration. Keep it to leaves: a caller must not wrap streamed content (a Suspense boundary or children that stream
 * in), since that re-render would make React render the boundary again on the client instead of hydrating it.
 */
export const useTheme = (): ThemeContextType => {
    const toggle = useThemeToggle();
    const theme = useSyncExternalStore(subscribe, readTheme, serverTheme);
    return {theme, toggleTheme: toggle};
};
