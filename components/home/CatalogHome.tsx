'use client';

import Link from 'next/link';
import React, { useCallback, useEffect, useState } from 'react';
import HeroReveal from '@/components/HeroReveal';
import { usePrefersReducedMotion } from '@/components/motion/usePrefersReducedMotion';
import LoadingState from '@/components/site/LoadingState';
import SiteNav from '@/components/site/SiteNav';
import type { HomeSeries, PublishedHome } from '@/lib/catalog/projections/home';
import type { AboutPortraitView } from '@/lib/siteConfig/portraitVariants';
import { hasCompletedHomeHeroIntro, markHomeHeroIntroCompleted } from '@/utils/homeHeroCache';
import CatalogSequence from './CatalogSequence';
import HomeChromeController, { HomeChrome, HomeVignette } from './HomeChromeController';
import HomeSequenceControls from './HomeSequenceControls';
import { useHomeChrome } from './useHomeChrome';
import { useHomePlayback } from './useHomePlayback';
import { useHomeRecords } from './useHomeRecords';
import { usePlaybackHolds } from './usePlaybackHolds';
import styles from './CatalogHome.module.css';

/**
 * Home after the cutover, from one revision's PublishedHome and the later
 * records useHomeRecords() asks that same revision for (#6), and nothing
 * else: no /api/photos, no legacy photo list, no shuffle. The featured
 * series plays in its authored order from its opening photograph inside
 * #18's chrome, with #2's playback as the only timer. Nothing featured is
 * the empty state, with no intro and the chrome held up by #18's no-photo
 * hold. Every prop ships to visitors, so it takes only the projection and
 * About's portrait view, whose URLs and alt About already shows.
 */
export default function CatalogHome({ home, portrait = null }: { home: PublishedHome; portrait?: AboutPortraitView | null }) {
  const series = home.featuredSeries;
  if (series === null) {
    return (
      <HomeChromeController initialLoading={false} initialIntro="settled">
        <EmptyHome />
      </HomeChromeController>
    );
  }
  const introCompleted = hasCompletedHomeHeroIntro();
  return (
    <HomeChromeController initialLoading={!introCompleted} initialIntro={introCompleted ? 'settled' : 'loading'}>
      {/* A new revision starts over on its own opening photograph, so no screen mixes two revisions. */}
      <FeaturedHome key={home.catalogRevision} revisionId={home.catalogRevision} series={series} portrait={portrait} />
    </HomeChromeController>
  );
}

function EmptyHome() {
  const { reportPhoto } = useHomeChrome();
  // No photograph will come, so loading ends now and the no-photo hold keeps the navigation up.
  useEffect(() => {
    reportPhoto('none');
  }, [reportPhoto]);
  return (
    <HomeChrome
      nav={<SiteNav />}
      story={
        <div className={styles.story}>
          <h1 className={styles.title}>Nothing is featured right now.</h1>
        </div>
      }
    />
  );
}

/** At least two digits, as HomeSequenceControls shows the position. */
const pad = (value: number) => String(value).padStart(2, '0');

const withoutId = (set: ReadonlySet<string>, id: string) => {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
};

function FeaturedHome({ revisionId, series, portrait }: { revisionId: string; series: HomeSeries; portrait: AboutPortraitView | null }) {
  const { reportPhoto, reportIntro, loading } = useHomeChrome();
  const reducedMotion = usePrefersReducedMotion();
  const [isSettled, setIsSettled] = useState(hasCompletedHomeHeroIntro);
  const [shown, setShown] = useState(false);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const [attempts, setAttempts] = useState<Readonly<Record<string, number>>>({});

  const photoIds = series.photoIds;
  const opening = Math.max(0, photoIds.indexOf(series.openingPhotoId));
  const playback = useHomePlayback({ photoIds, ready: shown && isSettled, initialIndex: opening });
  const pointerHandlers = usePlaybackHolds(playback.setHold);
  // The server sent three records; the rest arrive as Home moves, from the revision it rendered (#6).
  const { records: photos, failed: recordFailed, retry: retryRecord } = useHomeRecords({ revisionId, photoIds, initial: series.records, index: playback.index });

  const currentId = photoIds[playback.index];
  const current = currentId === undefined ? undefined : photos.get(currentId);
  // A record still on its way isn't a failure: the photograph before it stays on screen meanwhile.
  const currentRecordFailed = currentId !== undefined && recordFailed.has(currentId);
  const currentFailed = currentId !== undefined && (failed.has(currentId) || currentRecordFailed || current?.image === null);

  // The first photograph on screen ends loading, marks the intro done for the tab, and releases any no-photo hold.
  const handleImageReady = useCallback(
    (photoId: string) => {
      setFailed((set) => withoutId(set, photoId));
      if (shown) return;
      setShown(true);
      markHomeHeroIntroCompleted();
      reportPhoto('shown');
    },
    [shown, reportPhoto],
  );

  const handleImageFailed = useCallback((photoId: string) => {
    setFailed((set) => (set.has(photoId) ? set : new Set(set).add(photoId)));
  }, []);

  // A failure with nothing on screen yet ends loading, and the no-photo hold keeps Retry and Skip in view.
  useEffect(() => {
    if (currentFailed && !shown) reportPhoto('none');
  }, [currentFailed, shown, reportPhoto]);

  const retry = useCallback(() => {
    if (currentId === undefined) return;
    if (currentRecordFailed) {
      retryRecord(currentId);
      return;
    }
    setAttempts((current) => ({ ...current, [currentId]: (current[currentId] ?? 0) + 1 }));
    setFailed((set) => withoutId(set, currentId));
  }, [currentId, currentRecordFailed, retryRecord]);

  const handleSettled = useCallback(() => setIsSettled(true), []);
  const count = photoIds.length;

  return (
    <div className="contents" data-playback={playback.playbackState}>
      {/* The intro is Home's loading state on a first visit with motion, and leaves About's portrait as the badge. */}
      <HeroReveal isLoading={loading} onSettled={handleSettled} onPhaseChange={reportIntro} portrait={portrait} />

      {/* This layer takes the pointer instead of the photograph, so a drag or a long press never picks up the image. */}
      <div className="absolute inset-0 z-0 [&>*]:pointer-events-none">
        <CatalogSequence
          photoIds={photoIds}
          photos={photos}
          index={playback.index}
          openingId={series.openingPhotoId}
          playbackState={playback.playbackState}
          attempts={attempts}
          onImageReady={handleImageReady}
          onImageFailed={handleImageFailed}
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
        story={
          <div className={styles.story}>
            <div className={styles.copy}>
              <span className={styles.panel} aria-hidden="true" data-chrome-panel="" />
              <h1 className={styles.title}>{series.title}</h1>
              {series.shortStatement !== null && <p className={styles.statement}>{series.shortStatement}</p>}
            </div>
            <Link href={series.href} className={styles.enter}>
              Enter the series
            </Link>
          </div>
        }
        sequence={
          <div className={styles.sequence}>
            <div role="status" className={styles.failure}>
              {currentFailed && (
                <p>
                  Photograph {pad(playback.index + 1)} of {pad(count)} couldn&rsquo;t load.
                </p>
              )}
            </div>
            {currentFailed && (
              <div className={styles.failureActions}>
                {(current?.image || currentRecordFailed) && (
                  <button type="button" className={styles.action} onClick={retry}>
                    Retry
                  </button>
                )}
                {count > 1 && (
                  <button type="button" className={styles.action} onClick={playback.next}>
                    Skip
                  </button>
                )}
              </div>
            )}
            <HomeSequenceControls
              index={playback.index}
              count={count}
              wantsPlay={playback.wantsPlay}
              onPrev={playback.prev}
              onNext={playback.next}
              onTogglePlayback={playback.togglePlayback}
              {...pointerHandlers}
            />
          </div>
        }
      />
    </div>
  );
}
