'use client';

import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { BUILT_IN_HOLDS } from './homeChrome';
import { useHomeChrome } from './useHomeChrome';
import type { HomePlayback } from './useHomePlayback';

const holdsPointer = (event: React.PointerEvent) => event.pointerType === 'mouse' || event.pointerType === 'pen';

/**
 * The chrome's holds on the slideshow, for any Home under a
 * HomeChromeController: keyboard focus in the chrome holds it and pointer
 * focus doesn't, a consumer's hold on the chrome (an open dialog) holds it
 * too, and a mouse or pen resting on the controls holds it while the chrome
 * shows them. Spread the handlers on the sequence controls.
 */
export function usePlaybackHolds(setHold: HomePlayback['setHold']) {
  const { isKeyboardHeld, holds, visibility } = useHomeChrome();
  const [pointerOver, setPointerOver] = useState(false);

  useEffect(() => {
    setHold('focus', isKeyboardHeld);
  }, [setHold, isKeyboardHeld]);

  const consumerHeld = useMemo(() => [...holds].some((reason) => !BUILT_IN_HOLDS.has(reason)), [holds]);
  useEffect(() => {
    setHold('chrome', consumerHeld);
  }, [setHold, consumerHeld]);

  const chromeVisible = visibility !== 'immersive';
  useEffect(() => {
    setHold('pointer', pointerOver && chromeVisible);
  }, [setHold, pointerOver, chromeVisible]);

  return {
    onPointerEnter: (event: React.PointerEvent) => {
      if (holdsPointer(event)) setPointerOver(true);
    },
    onPointerLeave: () => setPointerOver(false),
  };
}
