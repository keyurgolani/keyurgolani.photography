'use client';

import {createContext, ReactNode, useContext, useEffect, useState} from 'react';

type Theme = 'dark' | 'light';

interface ThemeContextType {
    theme: Theme;
    toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | null>(null);

export const ThemeProvider = ({children}: { children: ReactNode }) => {
    // Dark matches the server HTML, so the first client render does too. The inline
    // script in app/layout.tsx may already have put a stored light theme on <html>.
    const [theme, setTheme] = useState<Theme>('dark');

    // A parent's effect runs after its children's, so this lands once the page has committed.
    // Browser tests wait on html[data-hydrated].
    useEffect(() => {
        const root = document.documentElement;
        const current = root.getAttribute('data-theme');
        if (current === 'light' || current === 'dark') setTheme(current);
        root.dataset.hydrated = 'true';
    }, []);

    // The page's own attribute decides the next theme, and storage that throws (site data blocked) only loses the
    // choice on reload, so the toggle still flips both ways.
    const toggleTheme = () => {
        const newTheme = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', newTheme);
        setTheme(newTheme);
        try {
            localStorage.setItem('theme', newTheme);
        } catch {
            // Nothing to keep it in.
        }
    };

    return (
        <ThemeContext.Provider value={{theme, toggleTheme}}>
            {children}
        </ThemeContext.Provider>
    );
};

export const useTheme = () => {
    const context = useContext(ThemeContext);
    if (!context) {
        throw new Error('useTheme must be used within a ThemeProvider');
    }
    return context;
};
