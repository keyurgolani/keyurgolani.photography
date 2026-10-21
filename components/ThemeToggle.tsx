'use client';

import { Moon, Sun } from 'lucide-react';
import { useTheme } from './ThemeContext';
import styles from './ThemeToggle.module.css';

/**
 * A plain 44 by 44 button in `SiteNav` that flips the theme. Both icons
 * render, and CSS on `html[data-theme]` shows the one for the current theme,
 * so the icon is right at first paint, before React reads the theme.
 */
export default function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
      className={styles.toggle}
    >
      <Sun size={20} strokeWidth={1.5} className={styles.sun} aria-hidden="true" />
      <Moon size={20} strokeWidth={1.5} className={styles.moon} aria-hidden="true" />
    </button>
  );
}
