'use client';

import { Check } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { THEME_CHOICES, type ThemeChoice, useThemeChoice } from './ThemeContext';

/** Each choice's name and the one line that says what it looks like. Provisional copy. */
export const THEME_LABELS: Record<ThemeChoice, { name: string; note: string }> = {
  system: { name: 'System', note: 'Light or Black, as your device is set' },
  light: { name: 'Light', note: 'Soft paper, matted prints' },
  bright: { name: 'Bright', note: 'White wall, framed prints' },
  dark: { name: 'Dark', note: 'Charcoal room' },
  black: { name: 'Black', note: 'Near black, the site as it was' },
};

// The popover's styles, off the first load's critical path (round 2, the CSS budget): they load once the page is idle
// after hydration, or as soon as the pointer or focus reaches the button.
const ThemeMenuPopoverStyles = dynamic(() => import('./ThemeMenuPopoverStyles'), { ssr: false });

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
  // `wanted` mounts the popover's styles, `ready` says they're in. Until then the button holds no popovertarget, so
  // the popover never opens unstyled; a press that early opens it the moment they land.
  const [wanted, setWanted] = useState(false);
  const [ready, setReady] = useState(false);
  const openWhenReady = useRef(false);
  const popover = useRef<HTMLDivElement>(null);
  const want = useCallback(() => setWanted(true), []);
  const onReady = useCallback(() => setReady(true), []);

  useEffect(() => {
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(want, { timeout: 2000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(want, 300);
    return () => window.clearTimeout(timer);
  }, [want]);

  useEffect(() => {
    if (ready && openWhenReady.current) {
      openWhenReady.current = false;
      popover.current?.showPopover();
    }
  }, [ready]);

  return (
    <>
      {wanted && <ThemeMenuPopoverStyles onReady={onReady} />}
      <button
        type="button"
        className="theme-menu-button"
        popoverTarget={ready ? popoverId : undefined}
        data-placement={placement}
        onPointerEnter={want}
        onFocus={want}
        onClick={() => {
          if (!ready) {
            openWhenReady.current = true;
            want();
          }
        }}
      >
        <span className="theme-menu-swatch" aria-hidden="true" />
        <span className="sr-only">Theme: </span>
        {THEME_CHOICES.map((value) => (
          <span key={value} className="sr-only" data-name-for={value}>
            {THEME_LABELS[value].name}
          </span>
        ))}
        <span className="sr-only" data-now="light">
          {' '}
          (Light now)
        </span>
        <span className="sr-only" data-now="black">
          {' '}
          (Black now)
        </span>
      </button>
      <div ref={popover} id={popoverId} popover="auto" className="theme-menu-popover" data-placement={placement}>
        <fieldset className="theme-menu-group">
          <legend className="theme-menu-legend">Theme</legend>
          {THEME_CHOICES.map((value) => (
            <label key={value} className="theme-menu-option">
              <input
                type="radio"
                name={`${id}-theme`}
                value={value}
                checked={choice === value}
                onChange={() => setChoice(value)}
                className="theme-menu-radio"
              />
              <span className="theme-menu-preview" data-preview={value} aria-hidden="true">
                <span className="theme-menu-preview-photo" />
              </span>
              <span className="theme-menu-text">
                <span className="theme-menu-name">{THEME_LABELS[value].name}</span>
                <span className="theme-menu-note">{THEME_LABELS[value].note}</span>
              </span>
              <Check size={16} strokeWidth={2} className="theme-menu-check" aria-hidden="true" />
            </label>
          ))}
        </fieldset>
      </div>
    </>
  );
}
