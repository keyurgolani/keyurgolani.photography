'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import HeroReveal from '@/components/HeroReveal';
import { usePrefersReducedMotion } from '@/components/motion/usePrefersReducedMotion';
import LoadingState from '@/components/site/LoadingState';
import SiteNav from '@/components/site/SiteNav';
import type { AboutPortraitView } from '@/lib/siteConfig/portraitVariants';
import { hasCompletedHomeHeroIntro, markHomeHeroIntroCompleted } from '@/utils/homeHeroCache';
import HomeChromeController, { HomeChrome, HomeVignette } from './HomeChromeController';
import type { HomePhoto } from './homePhoto';
import HomeSequence from './HomeSequence';
import HomeSequenceControls from './HomeSequenceControls';
import { useHomeChrome } from './useHomeChrome';
import { useHomePlayback } from './useHomePlayback';
import { usePlaybackHolds } from './usePlaybackHolds';
import type { HomePhotosStatus } from './useLegacyHomePhotos';

interface HomeViewProps {
  photos: HomePhoto[];
  photosStatus?: HomePhotosStatus;
  /** About's portrait, for the intro and the badge, or null for none. */
  portrait?: AboutPortraitView | null;
}

/**
 * Home: the intro, the slideshow, and the chrome over it. HomeChromeController
 * owns whether the chrome shows, useHomePlayback owns the only slideshow
 * timer, and a photograph on screen with the intro settled starts it.
 */
export default function HomeView({ photos, photosStatus = 'ready', portrait = null }: HomeViewProps) {
  const introCompleted = hasCompletedHomeHeroIntro();
  return (
    <HomeChromeController initialLoading={!introCompleted} initialIntro={introCompleted ? 'settled' : 'loading'}>
      <HomeViewContent photos={photos} photosStatus={photosStatus} portrait={portrait} />
    </HomeChromeController>
  );
}

function HomeViewContent({ photos, photosStatus, portrait }: Required<HomeViewProps>) {
  const chrome = useHomeChrome();
  const { reportPhoto, reportIntro, loading } = chrome;
  const reducedMotion = usePrefersReducedMotion();
  const [isSettled, setIsSettled] = useState(hasCompletedHomeHeroIntro);
  const [firstImageReady, setFirstImageReady] = useState(false);
  const shownRef = useRef(false);

  const photoIds = useMemo(() => photos.map((photo) => photo.id), [photos]);
  const playback = useHomePlayback({ photoIds, ready: firstImageReady && isSettled });
  const pointerHandlers = usePlaybackHolds(playback.setHold);

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

  return (
    <div className="contents" data-playback={playback.playbackState}>
      {/* The intro is Home's loading state on a first visit with motion, and leaves About's portrait as the badge. */}
      <HeroReveal isLoading={loading} onSettled={handleSettled} onPhaseChange={reportIntro} portrait={portrait} />

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
            {...pointerHandlers}
          />
        }
      />
    </div>
  );
}
