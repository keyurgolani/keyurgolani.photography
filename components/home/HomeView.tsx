'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import HeroReveal from '@/components/HeroReveal';
import { usePrefersReducedMotion } from '@/components/motion/usePrefersReducedMotion';
import LoadingState from '@/components/site/LoadingState';
import SiteNav from '@/components/site/SiteNav';
import { hasCompletedHomeHeroIntro, markHomeHeroIntroCompleted } from '@/utils/homeHeroCache';
import { BUILT_IN_HOLDS } from './homeChrome';
import HomeChromeController, { HomeChrome, HomeVignette } from './HomeChromeController';
import type { HomePhoto } from './homePhoto';
import HomeSequence from './HomeSequence';
import HomeSequenceControls from './HomeSequenceControls';
import { useHomeChrome } from './useHomeChrome';
import { useHomePlayback } from './useHomePlayback';
import type { HomePhotosStatus } from './useLegacyHomePhotos';

interface HomeViewProps {
  photos: HomePhoto[];
  photosStatus?: HomePhotosStatus;
}

const holdsPointer = (event: React.PointerEvent) => event.pointerType === 'mouse' || event.pointerType === 'pen';

/**
 * Home: the intro, the slideshow, and the chrome over it. HomeChromeController
 * owns whether the chrome shows, useHomePlayback owns the only slideshow
 * timer, and a photograph on screen with the intro settled starts it.
 */
export default function HomeView({ photos, photosStatus = 'ready' }: HomeViewProps) {
  const introCompleted = hasCompletedHomeHeroIntro();
  return (
    <HomeChromeController initialLoading={!introCompleted} initialIntro={introCompleted ? 'settled' : 'loading'}>
      <HomeViewContent photos={photos} photosStatus={photosStatus} />
    </HomeChromeController>
  );
}

function HomeViewContent({ photos, photosStatus }: Required<HomeViewProps>) {
  const chrome = useHomeChrome();
  const { reportPhoto, reportIntro, isKeyboardHeld, holds, visibility, loading } = chrome;
  const reducedMotion = usePrefersReducedMotion();
  const [isSettled, setIsSettled] = useState(hasCompletedHomeHeroIntro);
  const [firstImageReady, setFirstImageReady] = useState(false);
  const shownRef = useRef(false);
  const [pointerOver, setPointerOver] = useState(false);

  const photoIds = useMemo(() => photos.map((photo) => photo.id), [photos]);
  const playback = useHomePlayback({ photoIds, ready: firstImageReady && isSettled });
  const { setHold } = playback;

  // The first photograph on screen ends loading and releases any no-photo hold.
  const handleImageReady = useCallback(() => {
    if (shownRef.current) return;
    shownRef.current = true;
    markHomeHeroIntroCompleted();
    setFirstImageReady(true);
    reportPhoto('shown');
  }, [reportPhoto]);

  const handleFirstImageError = useCallback(() => {
    if (!shownRef.current) reportPhoto('none');
  }, [reportPhoto]);

  useEffect(() => {
    if (photosStatus === 'empty' || photosStatus === 'error') reportPhoto('none');
  }, [photosStatus, reportPhoto]);

  const handleSettled = useCallback(() => setIsSettled(true), []);

  // Keyboard focus in the chrome holds the slideshow, and pointer focus doesn't.
  useEffect(() => {
    setHold('focus', isKeyboardHeld);
  }, [setHold, isKeyboardHeld]);

  // A consumer's hold on the chrome, such as an open dialog, holds the slideshow too.
  const consumerHeld = useMemo(() => [...holds].some((reason) => !BUILT_IN_HOLDS.has(reason)), [holds]);
  useEffect(() => {
    setHold('chrome', consumerHeld);
  }, [setHold, consumerHeld]);

  // A mouse or pen resting on the controls holds the slideshow, but only while the chrome shows them.
  const chromeVisible = visibility !== 'immersive';
  useEffect(() => {
    setHold('pointer', pointerOver && chromeVisible);
  }, [setHold, pointerOver, chromeVisible]);

  return (
    <div className="contents" data-playback={playback.playbackState}>
      {/* The intro is Home's loading state on a first visit with motion, and renders nothing once settled. */}
      <HeroReveal isLoading={loading} onSettled={handleSettled} onPhaseChange={reportIntro} />

      {/* This layer takes the pointer instead of the photograph, so a drag or a long press never picks up the image. */}
      <div className="absolute inset-0 z-0 [&>*]:pointer-events-none">
        <HomeSequence
          photos={photos}
          index={playback.index}
          playbackState={playback.playbackState}
          onImageReady={handleImageReady}
          onFirstImageError={handleFirstImageError}
        />
      </div>

      {reducedMotion && loading && (
        <div className="absolute inset-0 z-[1]">
          <LoadingState />
        </div>
      )}

      <HomeVignette />
      <HomeChrome
        nav={<SiteNav />}
        sequence={
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
        }
      />
    </div>
  );
}
