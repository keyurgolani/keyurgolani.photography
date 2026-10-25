'use client';

import { createContext, useContext } from 'react';
import type { ChromeVisibility, IntroPhase } from './homeChrome';

export interface HomeChromeApi {
  visibility: ChromeVisibility;
  loading: boolean;
  /** Keyboard focus is inside the chrome, which holds it up. Pointer focus never does. */
  isKeyboardHeld: boolean;
  holds: ReadonlySet<string>;
  /** Keeps the chrome up for `reason`, such as a dialog opened from it, until `release(reason)`. */
  hold: (reason: string) => void;
  release: (reason: string) => void;
  reportPhoto: (status: 'shown' | 'none') => void;
  reportIntro: (phase: IntroPhase) => void;
}

export interface ChromeContextValue {
  api: HomeChromeApi;
  registerChrome: (element: HTMLDivElement | null) => void;
}

/** HomeChromeController provides it, and HomeChrome registers its layer through it. */
export const ChromeContext = createContext<ChromeContextValue | null>(null);

export function useChromeContext(): ChromeContextValue {
  const context = useContext(ChromeContext);
  if (!context) throw new Error('Home chrome needs a HomeChromeController above it.');
  return context;
}

/** Home chrome's state and its holds. The object changes only on transitions. */
export function useHomeChrome(): HomeChromeApi {
  return useChromeContext().api;
}
