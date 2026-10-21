'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import BottomBar from '@/components/BottomBar';
import HeroReveal from '@/components/HeroReveal';
import RevealingContents from '@/components/RevealingContents';
import { hasCompletedHomeHeroIntro, markHomeHeroIntroCompleted } from '@/utils/homeHeroCache';
import type { HomePhoto } from './homePhoto';
import HomeSequence from './HomeSequence';
import HomeSequenceControls from './HomeSequenceControls';
import { useHomePlayback } from './useHomePlayback';

interface HomeViewProps {
  photos: HomePhoto[];
}

/** Keyboard focus holds the slideshow and a mouse click doesn't. A browser that can't tell counts it as keyboard focus. */
function isKeyboardFocus(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

const holdsPointer = (event: React.PointerEvent) => event.pointerType === 'mouse' || event.pointerType === 'pen';

/**
 * Home: the intro, the slideshow, and the chrome over it. useHomePlayback owns
 * the only slideshow timer, and the intro gates it.
 */
export default function HomeView({ photos }: HomeViewProps) {
  const hasCompletedIntro = hasCompletedHomeHeroIntro();
  const [isLoading, setIsLoading] = useState(!hasCompletedIntro);
  const [isSettled, setIsSettled] = useState(hasCompletedIntro);
  const hasLoadedRef = useRef(hasCompletedIntro);
  const [chromeVisible, setChromeVisible] = useState(false);
  const [pointerOver, setPointerOver] = useState(false);

  const photoIds = useMemo(() => photos.map((photo) => photo.id), [photos]);
  const playback = useHomePlayback({ photoIds, ready: !isLoading && isSettled });
  const { setHold } = playback;

  const handleFirstImageReady = useCallback(() => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;
    markHomeHeroIntroCompleted();
    setIsLoading(false);
  }, []);

  const handleSettled = useCallback(() => {
    setIsSettled(true);
  }, []);

  // Once the intro settles, a synthetic click shows the chrome through RevealingContents' activity handler, until #18 replaces it.
  useEffect(() => {
    if (!isSettled) return;
    window.dispatchEvent(new MouseEvent('click'));
  }, [isSettled]);

  // A mouse or pen resting on the controls holds the slideshow, but only while the chrome shows them.
  useEffect(() => {
    setHold('pointer', pointerOver && chromeVisible);
  }, [setHold, pointerOver, chromeVisible]);

  const handleFocus = (event: React.FocusEvent<HTMLDivElement>) => {
    setHold('focus', isKeyboardFocus(event.target));
  };

  const handleBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHold('focus', false);
  };

  return (
    <main className="relative w-full h-screen bg-black overflow-hidden" data-playback={playback.playbackState}>
      {/* HeroReveal: grain overlay, ripples, and the portrait's travel */}
      <HeroReveal isLoading={isLoading} onSettled={handleSettled} />

      <div className="absolute inset-0 z-0">
        <HomeSequence
          photos={photos}
          index={playback.index}
          playbackState={playback.playbackState}
          onFirstImageReady={handleFirstImageReady}
        />
      </div>

      <RevealingContents onVisibleChange={setChromeVisible}>
        {/* Keyboard focus anywhere in here holds the slideshow. */}
        <div className="relative flex flex-col items-center justify-end h-full pb-8" onFocus={handleFocus} onBlur={handleBlur}>
          <HomeSequenceControls
            index={playback.index}
            count={playback.count}
            wantsPlay={playback.wantsPlay}
            onPrev={playback.prev}
            onNext={playback.next}
            onTogglePlayback={playback.togglePlayback}
            onPointerEnter={(event) => {
              if (holdsPointer(event)) setPointerOver(true);
            }}
            onPointerLeave={() => setPointerOver(false)}
          />
          <BottomBar visible={isSettled} />
        </div>
      </RevealingContents>
    </main>
  );
}
