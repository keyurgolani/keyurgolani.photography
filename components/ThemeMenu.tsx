'use client';

import { Check } from 'lucide-react';
import dynamic from 'next/dynamic';
import { Component, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useThemeChoice } from './ThemeContext';
import { THEME_CHOICES, type ThemeChoice } from './themeChoices';

/** Each choice's name and the one line that says what it looks like. */
const THEME_LABELS: Record<ThemeChoice, { name: string; note: string }> = {
  system: { name: 'System', note: 'Light or Black, as your device is set' },
  light: { name: 'Light', note: 'Soft paper, matted prints' },
  bright: { name: 'Bright', note: 'White wall, framed prints' },
  charcoal: { name: 'Dark', note: 'Charcoal room' },
  black: { name: 'Black', note: 'Near black, the site as it was' },
};

// The popover's styles, off every page's first-load CSS (the CSS budget): they load once the page is idle after
// hydration, or as soon as the pointer or focus reaches the button.
const ThemeMenuPopoverStyles = dynamic(() => import('./ThemeMenuPopoverStyles'), { ssr: false });

/**
 * A failed load of the styles' chunk (a page left open across a redeploy, a dropped request) renders nothing, so the
 * button stays inert, as without JavaScript, instead of the route's error page taking over.
 */
class StylesBoundary extends Component<{ children: ReactNode; onFailed: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onFailed();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * The theme control: a 44 by 44 button in `SiteNav` (and the curator's header)
 * that opens a small popover holding a native radio group of the five choices.
 *
 * The button's name is "Theme: <choice>", with "(Light now)" or "(Black now)"
 * after System. The names are all rendered, and CSS on `html[data-theme-choice]`
 * and `html[data-theme]` hides the ones that don't apply, so the name is right
 * from first paint, before React runs. Without JavaScript the button is hidden
 * (`data-theme-control`, the root layout's noscript rule), since nothing in the
 * menu could work.
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
  // A press before the styles land waits for them, marked busy (R2-P3-3).
  const [pending, setPending] = useState(false);
  const popover = useRef<HTMLDivElement>(null);
  // Set by a press in the menu, read by the change it causes, and cleared once the press is over.
  const byPointer = useRef(false);
  const want = useCallback(() => setWanted(true), []);
  const onReady = useCallback(() => setReady(true), []);
  // A press waiting on styles that will never come stops waiting, so the button isn't left busy (D5).
  const onFailed = useCallback(() => setPending(false), []);

  useEffect(() => {
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(want, { timeout: 2000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(want, 300);
    return () => window.clearTimeout(timer);
  }, [want]);

  useEffect(() => {
    if (ready && pending) {
      setPending(false);
      popover.current?.showPopover();
    }
  }, [ready, pending]);

  return (
    <>
      {wanted && (
        <StylesBoundary onFailed={onFailed}>
          <ThemeMenuPopoverStyles onReady={onReady} />
        </StylesBoundary>
      )}
      <button
        type="button"
        className="theme-menu-button"
        data-theme-control=""
        aria-busy={pending || undefined}
        popoverTarget={ready ? popoverId : undefined}
        // No CSS reads it yet; the curator PR's anchor rule will (P2-4).
        data-placement={placement}
        onPointerEnter={want}
        onFocus={want}
        onClick={() => {
          if (!ready) {
            setPending(true);
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
        {/* A pointer's choice crossfades; the arrow keys' don't, since they pass every theme on the way. */}
        <fieldset
          className="theme-menu-group"
          onPointerDown={() => {
            byPointer.current = true;
            // Cleared just after the press ends, wherever it ends: the change a click causes runs inside the click,
            // which follows pointerup in the same task, so a press that changes nothing (the checked row, the legend,
            // a drag off) can't leave the next arrow key crossfading.
            // One controller per press, so the listener that doesn't fire goes with the one that does (D6).
            const press = new AbortController();
            const clear = () => {
              press.abort();
              window.setTimeout(() => (byPointer.current = false), 0);
            };
            window.addEventListener('pointerup', clear, { signal: press.signal });
            window.addEventListener('pointercancel', clear, { signal: press.signal });
          }}
        >
          <legend className="theme-menu-legend">Theme</legend>
          {THEME_CHOICES.map((value) => (
            <label key={value} className="theme-menu-option">
              <input
                type="radio"
                name={`${id}-theme`}
                value={value}
                checked={choice === value}
                onChange={() => setChoice(value, { animate: byPointer.current })}
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
