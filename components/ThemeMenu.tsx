'use client';

import { Check } from 'lucide-react';
import { useId } from 'react';
import { THEME_CHOICES, type ThemeChoice, useThemeChoice } from './ThemeContext';
import styles from './ThemeMenu.module.css';

/** Each choice's name and the one line that says what it looks like. Provisional copy. */
export const THEME_LABELS: Record<ThemeChoice, { name: string; note: string }> = {
  system: { name: 'System', note: 'Light or Black, as your device is set' },
  light: { name: 'Light', note: 'Soft paper, matted prints' },
  bright: { name: 'Bright', note: 'White wall, framed prints' },
  dark: { name: 'Dark', note: 'Charcoal room' },
  black: { name: 'Black', note: 'Near black, the site as it was' },
};

/**
 * The theme control: a 44 by 44 button in `SiteNav` (and the curator's header)
 * that opens a small popover holding a native radio group of the five choices.
 *
 * The button's name is "Theme: <choice>", with "(Light now)" or "(Black now)"
 * after System. The names are all rendered, and CSS on `html[data-theme-choice]`
 * and `html[data-theme]` hides the ones that don't apply, so the name is right
 * from first paint, before React runs, as the old toggle's was.
 *
 * The popover is the native `popover` API: Escape and a click outside close it,
 * it sits in the top layer (so no nav or chrome clips it), and focus returns
 * to the button. Inside, the radios behave natively: Tab enters the group on the
 * checked choice, the arrow keys move and choose, and a screen reader announces
 * "<name>, radio button, checked, 3 of 5". A choice applies at once.
 */
export default function ThemeMenu({ placement = 'nav' }: { placement?: 'nav' | 'curator' }) {
  const { choice, setChoice } = useThemeChoice();
  const id = useId();
  const popoverId = `${id}-themes`;
  return (
    <>
      <button type="button" className={styles.button} popoverTarget={popoverId} data-placement={placement}>
        <span className={styles.swatch} aria-hidden="true" />
        <span className={styles.hidden}>Theme: </span>
        {THEME_CHOICES.map((value) => (
          <span key={value} className={styles.hidden} data-name-for={value}>
            {THEME_LABELS[value].name}
          </span>
        ))}
        <span className={styles.hidden} data-now="light">
          {' '}
          (Light now)
        </span>
        <span className={styles.hidden} data-now="black">
          {' '}
          (Black now)
        </span>
      </button>
      <div id={popoverId} popover="auto" className={styles.popover} data-placement={placement}>
        <fieldset className={styles.group}>
          <legend className={styles.legend}>Theme</legend>
          {THEME_CHOICES.map((value) => (
            <label key={value} className={styles.option}>
              <input
                type="radio"
                name={`${id}-theme`}
                value={value}
                checked={choice === value}
                onChange={() => setChoice(value)}
                className={styles.radio}
              />
              <span className={styles.preview} data-preview={value} aria-hidden="true">
                <span className={styles.previewPhoto} />
              </span>
              <span className={styles.text}>
                <span className={styles.name}>{THEME_LABELS[value].name}</span>
                <span className={styles.note}>{THEME_LABELS[value].note}</span>
              </span>
              <Check size={16} strokeWidth={2} className={styles.check} aria-hidden="true" />
            </label>
          ))}
        </fieldset>
      </div>
    </>
  );
}
