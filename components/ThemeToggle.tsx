'use client';

import { Moon, Sun } from 'lucide-react';
import { useId } from 'react';
import { useTheme } from './ThemeContext';
import styles from './ThemeToggle.module.css';

/**
 * What the theme reaches while the shell looks the same in both themes (#21):
 * the legacy variables, which paint Home's opening and the legacy Gallery's
 * photo grid. The shell, Work, the series pages, the Viewer, About, and the
 * 404 don't change. Rewrite it when #13 removes the legacy Gallery, or when
 * the owner answers #21's light-theme question.
 */
export const THEME_TOGGLE_DESCRIPTION = "Changes only Home's opening screen and the photo grid; other pages keep their colors.";

/**
 * A plain 44 by 44 button in `SiteNav` that flips the theme. It renders both
 * icons and both names, and CSS on `html[data-theme]` hides the pair that
 * doesn't fit, so the icon and the accessible name are right from first
 * paint, before React runs. The description says what the theme changes, from
 * a `hidden` node, so it's read with the button and never shows.
 */
export default function ThemeToggle() {
  const { toggleTheme } = useTheme();
  const descriptionId = useId();
  return (
    <>
      <button type="button" onClick={toggleTheme} className={styles.toggle} aria-describedby={descriptionId}>
        <Sun size={20} strokeWidth={1.5} className={styles.sun} aria-hidden="true" />
        <Moon size={20} strokeWidth={1.5} className={styles.moon} aria-hidden="true" />
        <span className={`${styles.name} ${styles.toLight}`}>Switch to light mode</span>
        <span className={`${styles.name} ${styles.toDark}`}>Switch to dark mode</span>
      </button>
      <span id={descriptionId} hidden>
        {THEME_TOGGLE_DESCRIPTION}
      </span>
    </>
  );
}
