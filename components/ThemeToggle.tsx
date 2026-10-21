'use client';

import { Moon, Sun } from 'lucide-react';
import { useTheme } from './ThemeContext';
import styles from './ThemeToggle.module.css';

/**
 * A plain 44 by 44 button in `SiteNav` that flips the theme. It renders both
 * icons and both names, and CSS on `html[data-theme]` hides the pair that
 * doesn't fit, so the icon and the accessible name are right from first
 * paint, before React runs.
 */
export default function ThemeToggle() {
  const { toggleTheme } = useTheme();
  return (
    <button type="button" onClick={toggleTheme} className={styles.toggle}>
      <Sun size={20} strokeWidth={1.5} className={styles.sun} aria-hidden="true" />
      <Moon size={20} strokeWidth={1.5} className={styles.moon} aria-hidden="true" />
      <span className={`${styles.name} ${styles.toLight}`}>Switch to light mode</span>
      <span className={`${styles.name} ${styles.toDark}`}>Switch to dark mode</span>
    </button>
  );
}
