'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDocumentVisible } from '../motion/useDocumentVisible';
import { usePrefersReducedMotion } from '../motion/usePrefersReducedMotion';
import { HOME_CHROME_FADE_MS, HOME_CHROME_IDLE_MS, HOME_LOADING_TIMEOUT_MS } from './homeChromeConfig';
import { HOVER, initialChrome, KEYBOARD_FOCUS, PRESS, reduceChrome, type ChromeEvent, type ChromeState, type IntroPhase } from './homeChrome';
import { ChromeContext, useChromeContext, type ChromeContextValue, type HomeChromeApi } from './useHomeChrome';
import styles from './HomeChrome.module.css';

/** The chrome's controls, for the hover and press holds. */
const CONTROL = 'a[href], button, input, select, textarea';
/** Pressed alone, these only modify another key, so they aren't activity. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);
/** The first gesture's click guard disarms this long after the gesture ends. */
const GUARD_EXPIRY_MS = 500;

/** Keyboard focus is what draws the ring. A browser that can't tell counts it as keyboard focus. */
function isFocusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

const holdsPointer = (event: PointerEvent) => event.pointerType === 'mouse' || event.pointerType === 'pen';

const controlIn = (chrome: HTMLElement | null, node: EventTarget | null) => {
  if (!chrome || !(node instanceof Element)) return null;
  const control = node.closest(CONTROL);
  return control && chrome.contains(control) ? control : null;
};

type HomeChromeControllerProps = {
  children: React.ReactNode;
  /** Only a first visit in the tab starts loading. */
  initialLoading: boolean;
  initialIntro: IntroPhase;
  idleMs?: number;
} & { [attribute: `data-${string}`]: string | undefined };

/**
 * The one owner of Home chrome visibility. Home starts immersive, with the
 * chrome invisible and untargetable but still in the document, and any intent
 * shows it: a mouse or pen that moves, focus, a key, a wheel or scroll, or a
 * first tap, which only reveals. It recedes `idleMs` after the last activity
 * unless a hold stands. It renders Home's `<main>` with the state as data
 * attributes, and one setTimeout arms the idle, so mouse movement doesn't
 * re-render Home.
 */
export default function HomeChromeController({
  children,
  initialLoading,
  initialIntro,
  idleMs = HOME_CHROME_IDLE_MS,
  ...dataAttributes
}: HomeChromeControllerProps) {
  const reducedMotion = usePrefersReducedMotion();
  const documentVisible = useDocumentVisible();
  const [state, setState] = useState<ChromeState>(() => initialChrome({ loading: initialLoading, intro: initialIntro }));
  const stateRef = useRef(state);
  const rootRef = useRef<HTMLElement>(null);
  const chromeRef = useRef<HTMLDivElement | null>(null);
  const [chromeElement, setChromeElement] = useState<HTMLDivElement | null>(null);
  const reducedMotionRef = useRef(reducedMotion);
  const lastActivityAt = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
  }, [reducedMotion]);

  const clearFade = useCallback(() => {
    if (fadeTimer.current === null) return;
    clearTimeout(fadeTimer.current);
    fadeTimer.current = null;
  }, []);

  // The reducer runs here, against the latest state, so a handler that runs right after another sees its
  // result. The fade's timer starts with the fade, so its end never waits on a render.
  const send = useCallback(
    function send(event: ChromeEvent) {
      const previous = stateRef.current;
      const next = reduceChrome(previous, event);
      if (next === previous) return;
      // Any release, the no-photo one included, starts a fresh full timeout.
      if ([...previous.holds].some((reason) => !next.holds.has(reason))) lastActivityAt.current = Date.now();
      stateRef.current = next;
      if (next.visibility !== previous.visibility) {
        clearFade();
        if (next.visibility === 'receding') {
          fadeTimer.current = setTimeout(() => {
            fadeTimer.current = null;
            send({ type: 'fadeEnded' });
          }, HOME_CHROME_FADE_MS);
        }
      }
      setState(next);
    },
    [clearFade],
  );

  const activity = useCallback(() => {
    lastActivityAt.current = Date.now();
    send({ type: 'activity' });
  }, [send]);

  const setHeld = useCallback(
    (reason: string, held: boolean) => {
      const has = stateRef.current.holds.has(reason);
      if (held && !has) send({ type: 'hold', reason });
      else if (!held && has) send({ type: 'release', reason });
    },
    [send],
  );

  const recheckKeyboardFocus = useCallback(() => {
    const chrome = chromeRef.current;
    const active = document.activeElement;
    setHeld(KEYBOARD_FOCUS, !!chrome && active instanceof Element && chrome.contains(active) && isFocusVisible(active));
  }, [setHeld]);

  const clearIdle = useCallback(() => {
    if (idleTimer.current === null) return;
    clearTimeout(idleTimer.current);
    idleTimer.current = null;
  }, []);

  // One timer. When activity moved the deadline, it fires early and waits out the rest.
  const armIdle = useCallback(() => {
    clearIdle();
    const tick = () => {
      idleTimer.current = null;
      if (stateRef.current.visibility !== 'interactive' || stateRef.current.holds.size > 0) return;
      recheckKeyboardFocus();
      if (stateRef.current.holds.size > 0) return;
      const remaining = lastActivityAt.current + idleMs - Date.now();
      if (remaining > 0) {
        idleTimer.current = setTimeout(tick, remaining);
        return;
      }
      send({ type: 'idleElapsed', skipFade: reducedMotionRef.current });
    };
    idleTimer.current = setTimeout(tick, Math.max(0, lastActivityAt.current + idleMs - Date.now()));
  }, [clearIdle, idleMs, recheckKeyboardFocus, send]);

  const holdsKey = [...state.holds].sort().join(' ');

  // The idle runs only while the chrome is up with no hold, in a visible document.
  useEffect(() => {
    if (state.visibility === 'interactive' && state.holds.size === 0 && documentVisible) {
      if (idleTimer.current === null) armIdle();
    } else {
      clearIdle();
    }
  }, [state.visibility, holdsKey, state.holds.size, documentVisible, armIdle, clearIdle]);

  useEffect(
    () => () => {
      clearIdle();
      clearFade();
    },
    [clearIdle, clearFade],
  );

  // Reduced motion skips the fade, one already running included.
  useEffect(() => {
    if (reducedMotion && state.visibility === 'receding') send({ type: 'fadeEnded' });
  }, [reducedMotion, state.visibility, send]);

  // A hidden document drops the hover and press holds and returns Home to immersive, unless something still holds it.
  const pressPointer = useRef<number | null>(null);
  useEffect(() => {
    if (documentVisible) return;
    pressPointer.current = null;
    send({ type: 'documentHidden' });
  }, [documentVisible, send]);

  // Loading ends on the first photograph report, or here. A return visit runs it too, for the photograph alone.
  const awaitingPhoto = state.photo === 'unknown';
  useEffect(() => {
    if (!awaitingPhoto) return;
    const timer = setTimeout(() => send({ type: 'loadingTimedOut' }), HOME_LOADING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [awaitingPhoto, send]);

  // The first gesture on immersive Home, and the guards that keep it from activating anything.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let gesturePointer: number | null = null;
    let clickGuard: { pointerId: number; expiry: ReturnType<typeof setTimeout> | null } | null = null;
    let keyGuard: string | null = null;
    let lastPoint: { x: number; y: number } | null = null;
    const frames = new Set<number>();

    const nextFrame = (callback: () => void) => {
      const frame = requestAnimationFrame(() => {
        frames.delete(frame);
        callback();
      });
      frames.add(frame);
    };

    const disarmClickGuard = () => {
      if (clickGuard?.expiry) clearTimeout(clickGuard.expiry);
      clickGuard = null;
    };

    // A mouse or pen that actually moved. Chromium reports no movement on a document's first pointer event.
    const onPointerMove = (event: PointerEvent) => {
      if (!holdsPointer(event)) return;
      const moved =
        event.movementX !== 0 || event.movementY !== 0 || (lastPoint !== null && (lastPoint.x !== event.clientX || lastPoint.y !== event.clientY));
      lastPoint = { x: event.clientX, y: event.clientY };
      if (moved) activity();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!event.isPrimary) return;
      disarmClickGuard();
      const chrome = chromeRef.current;
      const inChrome = !!chrome && event.target instanceof Node && chrome.contains(event.target);
      if (stateRef.current.visibility === 'immersive') {
        // The receded chrome takes no real pointer, so a press inside it came from a script or assistive technology.
        if (inChrome) {
          activity();
          return;
        }
        // The reveal gesture. Its click can't reach a control, now visible, under it.
        gesturePointer = event.pointerId;
        root.setAttribute('data-reveal-gesture', '');
        clickGuard = { pointerId: event.pointerId, expiry: null };
        activity();
        return;
      }
      activity();
      if (controlIn(chrome, event.target)) {
        pressPointer.current = event.pointerId;
        setHeld(PRESS, true);
      }
    };

    const onPointerEnd = (event: PointerEvent) => {
      if (gesturePointer !== null && event.pointerId === gesturePointer) {
        gesturePointer = null;
        nextFrame(() => root.removeAttribute('data-reveal-gesture'));
        if (clickGuard) clickGuard.expiry = setTimeout(disarmClickGuard, GUARD_EXPIRY_MS);
      }
      if (pressPointer.current === event.pointerId) {
        pressPointer.current = null;
        setHeld(PRESS, false);
      }
    };

    const onLostCapture = (event: PointerEvent) => {
      if (pressPointer.current !== event.pointerId) return;
      pressPointer.current = null;
      setHeld(PRESS, false);
    };

    const onClick = (event: MouseEvent) => {
      // The click that ends the reveal gesture never activates anything.
      if (clickGuard && event.detail > 0) {
        const pointerId = (event as PointerEvent).pointerId;
        if (pointerId === undefined || pointerId === clickGuard.pointerId || pointerId < 0) {
          event.preventDefault();
          event.stopPropagation();
          disarmClickGuard();
          return;
        }
      }
      // Enter or Space that revealed the chrome doesn't activate the control focus was left on.
      if (keyGuard !== null && event.detail === 0) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // Assistive technology activating a receded control goes through and reveals the chrome.
      const chrome = chromeRef.current;
      if (stateRef.current.visibility === 'immersive' && chrome && event.target instanceof Node && chrome.contains(event.target)) activity();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // A lone modifier isn't activity, but the browser may now draw focus as keyboard focus.
      if (MODIFIERS.has(event.key)) {
        recheckKeyboardFocus();
        return;
      }
      const chrome = chromeRef.current;
      const active = document.activeElement;
      if (
        stateRef.current.visibility === 'immersive' &&
        (event.key === 'Enter' || event.key === ' ') &&
        chrome &&
        active &&
        chrome.contains(active)
      ) {
        event.preventDefault();
        keyGuard = event.key;
      }
      activity();
      recheckKeyboardFocus();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (keyGuard === null || event.key !== keyGuard) return;
      nextFrame(() => {
        keyGuard = null;
      });
    };

    const onWheel = () => activity();

    root.addEventListener('pointermove', onPointerMove);
    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('click', onClick, true);
    root.addEventListener('wheel', onWheel, { passive: true });
    root.addEventListener('lostpointercapture', onLostCapture);
    document.addEventListener('pointerup', onPointerEnd);
    document.addEventListener('pointercancel', onPointerEnd);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    return () => {
      root.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('click', onClick, true);
      root.removeEventListener('wheel', onWheel);
      root.removeEventListener('lostpointercapture', onLostCapture);
      document.removeEventListener('pointerup', onPointerEnd);
      document.removeEventListener('pointercancel', onPointerEnd);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('keyup', onKeyUp, true);
      frames.forEach((frame) => cancelAnimationFrame(frame));
      disarmClickGuard();
      root.removeAttribute('data-reveal-gesture');
    };
  }, [activity, recheckKeyboardFocus, setHeld]);

  // Focus, hover, and scroll inside the chrome.
  useEffect(() => {
    const chrome = chromeElement;
    if (!chrome) return;

    const onFocusIn = () => {
      activity();
      recheckKeyboardFocus();
    };
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && chrome.contains(event.relatedTarget)) return;
      setHeld(KEYBOARD_FOCUS, false);
    };
    const onPointerOver = (event: PointerEvent) => {
      if (holdsPointer(event) && controlIn(chrome, event.target)) setHeld(HOVER, true);
    };
    const onPointerOut = (event: PointerEvent) => {
      if (holdsPointer(event) && !controlIn(chrome, event.relatedTarget)) setHeld(HOVER, false);
    };
    const onScroll = () => activity();

    chrome.addEventListener('focusin', onFocusIn);
    chrome.addEventListener('focusout', onFocusOut);
    chrome.addEventListener('pointerover', onPointerOver);
    chrome.addEventListener('pointerout', onPointerOut);
    chrome.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      chrome.removeEventListener('focusin', onFocusIn);
      chrome.removeEventListener('focusout', onFocusOut);
      chrome.removeEventListener('pointerover', onPointerOver);
      chrome.removeEventListener('pointerout', onPointerOut);
      chrome.removeEventListener('scroll', onScroll);
    };
  }, [chromeElement, activity, recheckKeyboardFocus, setHeld]);

  const registerChrome = useCallback((element: HTMLDivElement | null) => {
    chromeRef.current = element;
    setChromeElement(element);
  }, []);

  const hold = useCallback((reason: string) => setHeld(reason, true), [setHeld]);
  const release = useCallback((reason: string) => setHeld(reason, false), [setHeld]);
  const reportPhoto = useCallback((status: 'shown' | 'none') => send({ type: 'photoReported', status }), [send]);
  const reportIntro = useCallback((phase: IntroPhase) => send({ type: 'introReported', phase }), [send]);

  const api = useMemo<HomeChromeApi>(
    () => ({
      visibility: state.visibility,
      loading: state.loading,
      isKeyboardHeld: state.holds.has(KEYBOARD_FOCUS),
      holds: state.holds,
      hold,
      release,
      reportPhoto,
      reportIntro,
    }),
    [state.visibility, state.loading, state.holds, hold, release, reportPhoto, reportIntro],
  );
  const context = useMemo<ChromeContextValue>(() => ({ api, registerChrome }), [api, registerChrome]);

  return (
    <ChromeContext.Provider value={context}>
      <main
        ref={rootRef}
        className={styles.root}
        data-interface-state={state.visibility}
        data-chrome-holds={holdsKey}
        data-home-loading={String(state.loading)}
        data-home-intro={state.intro}
        {...dataAttributes}
      >
        {children}
      </main>
    </ChromeContext.Provider>
  );
}

interface HomeChromeProps {
  nav?: React.ReactNode;
  /** #4's series identity and entry actions. */
  story?: React.ReactNode;
  sequence?: React.ReactNode;
}

/**
 * The chrome layer over the photograph: navigation at the top, the story,
 * then the sequence controls at the bottom, in DOM, visual, and tab order. It
 * scrolls when large text needs more room. HomeChrome.module.css alone
 * decides whether it shows, so nothing inside sets its own visibility.
 */
export function HomeChrome({ nav, story, sequence }: HomeChromeProps) {
  const { registerChrome } = useChromeContext();
  return (
    <div ref={registerChrome} className={styles.chrome} data-home-chrome="">
      <div data-chrome-region="nav" className={styles.nav}>
        {nav}
      </div>
      <div data-chrome-region="story" className={styles.story}>
        {story}
      </div>
      <div data-chrome-region="sequence" className={styles.sequence}>
        {sequence}
      </div>
    </div>
  );
}

/** The scrim under the chrome, which shows and hides with it. */
export function HomeVignette() {
  return <div className={styles.vignette} aria-hidden="true" data-home-vignette="" />;
}
