'use client';

import Link from 'next/link';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { V110_LANE } from '@/components/badgePlace';
import HeroReveal from '@/components/HeroReveal';
import { usePrefersReducedMotion } from '@/components/motion/usePrefersReducedMotion';
import LoadingState from '@/components/site/LoadingState';
import SiteNav from '@/components/site/SiteNav';
import type { HomeLoopSeries, HomeSeries, PublishedHome } from '@/lib/catalog/projections/home';
import type { AboutPortraitView } from '@/lib/siteConfig/portraitVariants';
import { hasCompletedHomeHeroIntro, markHomeHeroIntroCompleted } from '@/utils/homeHeroCache';
import CatalogSequence from './CatalogSequence';
import HomeChromeController, { HomeChrome, HomeVignette } from './HomeChromeController';
import { homeLoopOf } from './homeLoop';
import HomeSequenceControls from './HomeSequenceControls';
import { HOME_LOADING_TIMEOUT_MS } from './homeChromeConfig';
import { useHomeChrome } from './useHomeChrome';
import { useHomePlayback, type HomePlayback } from './useHomePlayback';
import { useHomeRecords } from './useHomeRecords';
import { usePlaybackHolds } from './usePlaybackHolds';
import styles from './CatalogHome.module.css';

/**
 * Home, from one revision's PublishedHome and the later records
 * useHomeRecords() asks that same revision for (#6), and nothing else: no
 * photo list, no library scan, no shuffle. The featured series play as one
 * loop (v1.5.0), starting on the one the server picked: each in its authored
 * order from its opening photograph, then the next, inside #18's chrome,
 * which names the series on screen, with #2's playback as the only timer.
 * Nothing featured is the empty state, with no intro and the chrome held up
 * by #18's no-photo hold. Every prop ships to visitors, so it takes only the projection and
 * About's portrait view, whose URLs and alt About already shows.
 */
export default function CatalogHome({ home, portrait = null }: { home: PublishedHome; portrait?: AboutPortraitView | null }) {
  const series = home.featuredSeries;
  if (series === null) {
    return (
      <HomeChromeController initialLoading={false} initialIntro="settled" data-catalog-revision={home.catalogRevision}>
        <EmptyHome />
      </HomeChromeController>
    );
  }
  const introCompleted = hasCompletedHomeHeroIntro();
  return (
    <HomeChromeController initialLoading={!introCompleted} initialIntro={introCompleted ? 'settled' : 'loading'} data-catalog-revision={home.catalogRevision}>
      {/* A new revision, or a new pick on the same one, starts over on its own opening photograph, so no screen mixes
          two revisions and the preload, the timer and the records all start from the photograph the server picked. */}
      <FeaturedHome key={`${home.catalogRevision} ${series.id}`} revisionId={home.catalogRevision} opening={series} following={home.followingSeries} portrait={portrait} />
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
    <div className="contents" data-home-state="empty">
      <HomeChrome
        nav={<SiteNav />}
        story={
          <div className={styles.story}>
            <h1 className={styles.title}>Nothing is featured right now.</h1>
          </div>
        }
      />
    </div>
  );
}

/** At least two digits, as HomeSequenceControls shows the position. */
const pad = (value: number) => String(value).padStart(2, '0');

/** One featured series: nothing follows it. */
const NONE: readonly HomeLoopSeries[] = [];

/**
 * How many photographs the opening walk tries before Home says they can't be
 * shown: the opening and the next, #6's first-load cap, so a dead media route
 * costs two requests rather than the whole loop. Retry tries two more.
 */
const OPENING_ATTEMPTS = 2;

/** Automatic failures in a row that suspend playback until the visitor moves it, or presses Play. */
const SUSPEND_AFTER = 2;

const withoutId = (set: ReadonlySet<string>, id: string) => {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
};

interface FeaturedHomeProps {
  revisionId: string;
  /** The series Home opens on, with the server's records. */
  opening: HomeSeries;
  /** The rest of the loop, in the order they play after it. */
  following?: readonly HomeLoopSeries[];
  portrait: AboutPortraitView | null;
}

/**
 * The featured loop, with #4's failure policy. A slide commits once its image
 * decodes. Each move waits on its photograph, and each commit gets a full
 * interval. When a photograph fails:
 * - before anything is on screen, the opening walk tries the next one, inside
 *   loading, and after OPENING_ATTEMPTS Home is `image-unavailable`, with the
 *   story and Retry;
 * - on Home's own move, it skips to the next at once, and SUSPEND_AFTER in a
 *   row suspend playback with a polite note, until the visitor's own move
 *   lands or they press Play;
 * - on the visitor's move, or while Home is paused or held, it says which
 *   photograph, with Retry and Skip, which stay until a move lands.
 * When a focused Retry or Skip leaves because its move landed, focus goes to
 * the Previous or Next that started the move, else to "Enter the series".
 */
function FeaturedHome({ revisionId, opening, following = NONE, portrait }: FeaturedHomeProps) {
  const { reportPhoto, reportIntro, loading } = useHomeChrome();
  const reducedMotion = usePrefersReducedMotion();
  const [isSettled, setIsSettled] = useState(hasCompletedHomeHeroIntro);
  /** Something has committed: the opening walk is over. */
  const [shown, setShown] = useState(false);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const [attempts, setAttempts] = useState<Readonly<Record<string, number>>>({});
  /** The photograph whose attempt last ended, by committing or failing: the timer waits on anything else. */
  const [settledId, setSettledId] = useState<string | null>(null);
  /** The visitor's failure note, held until a move lands, so Retry and Skip stay while theirs loads. */
  const [noticeId, setNoticeId] = useState<string | null>(null);
  const [suspended, setSuspended] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  // Every featured series in play order, from the opening photograph, so the sequence starts at its first position.
  const loop = useMemo(() => homeLoopOf([opening, ...following]), [opening, following]);
  const photoIds = loop.photoIds;
  const seriesIds = useMemo(() => new Map([...loop.seriesOf].map(([photoId, entry]) => [photoId, entry.id] as const)), [loop]);
  const playback = useHomePlayback({ photoIds, ready: shown && isSettled, initialIndex: 0, settledPhotoId: settledId });
  const pointerHandlers = usePlaybackHolds(playback.setHold);
  // The opening walk asks for no window past the photograph it tries, so a dead media route costs one request (#6).
  const walking = !shown && playback.moves > 0;
  // The server sent three records; the rest arrive as Home moves, from the revision it rendered (#6).
  const { records: photos, failed: recordFailed, retry: retryRecord } = useHomeRecords({ revisionId, photoIds, seriesOf: seriesIds, initial: opening.records, index: playback.index, ahead: !walking });

  const currentId = photoIds[playback.index];
  // The title, statement, link and position name the photograph on screen, which stays up until the next decodes.
  const [shownId, setShownId] = useState<string | undefined>(opening.openingPhotoId);
  const series = (shownId !== undefined && loop.seriesOf.get(shownId)) || opening;
  const placeOf = useCallback((photoId: string) => {
    const entry = loop.seriesOf.get(photoId) ?? opening;
    return { entry, position: Math.max(0, entry.photoIds.indexOf(photoId)), count: entry.photoIds.length };
  }, [loop, opening]);
  const onScreen = placeOf(shownId ?? currentId ?? opening.openingPhotoId);
  const slideLabel = useCallback((photoId: string) => {
    const { position, count } = placeOf(photoId);
    return `${position + 1} of ${count}`;
  }, [placeOf]);

  // Crossing into another series says its name once in the live region. The one Home opens on isn't announced: the
  // page's own heading names it.
  const [announcedId, setAnnouncedId] = useState(series.id);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  if (announcedId !== series.id) {
    setAnnouncedId(series.id);
    setAnnouncement(`Now showing ${series.title}`);
  }

  const current = currentId === undefined ? undefined : photos.get(currentId);
  // A record still on its way isn't a failure: the photograph before it stays on screen meanwhile.
  const currentRecordFailed = currentId !== undefined && recordFailed.has(currentId);
  const currentFailed = currentId !== undefined && (failed.has(currentId) || currentRecordFailed || current?.image === null);

  const handleImageFailed = useCallback((photoId: string) => {
    setFailed((set) => (set.has(photoId) ? set : new Set(set).add(photoId)));
  }, []);

  /** The move whose failure was last decided, so each visit to a photograph decides once, and again after a Retry. */
  const handled = useRef<number | null>(null);
  const autoFailures = useRef(0);
  const walkFailures = useRef(0);

  const note = unavailable
    ? 'These photographs can’t be shown right now.'
    : suspended
      ? 'Some photographs couldn’t load.'
      : noticeId !== null
        ? noticeText(placeOf(noticeId), series.id)
        : null;
  // The status region is atomic, so a failure note replaces the announcement rather than being read after it.
  if (note !== null && announcement !== null) setAnnouncement(null);

  // A failure decides once per visit to a photograph, and again after a Retry.
  useEffect(() => {
    if (!currentFailed || currentId === undefined || handled.current === playback.moves) return;
    handled.current = playback.moves;
    setSettledId(currentId);
    if (!shown) {
      // The opening walk: nothing is on screen, so try the next photograph, inside loading, up to OPENING_ATTEMPTS.
      walkFailures.current += 1;
      if (walkFailures.current >= OPENING_ATTEMPTS || photoIds.length < 2) {
        setUnavailable(true);
        reportPhoto('none');
      } else {
        playback.skipFailed('opening');
      }
      return;
    }
    if (skipsOnItsOwn(playback)) {
      autoFailures.current += 1;
      if (autoFailures.current >= SUSPEND_AFTER) setSuspended(true);
      else playback.skipFailed('auto');
      return;
    }
    setNoticeId(currentId);
  }, [currentFailed, currentId, shown, photoIds.length, playback, reportPhoto]);

  // #18's loading bound, once something is on screen: a move whose photograph is still loading at HOME_LOADING_TIMEOUT_MS
  // counts as failed, so a stalled media route never stops Home now that each move waits on its commit. The image keeps
  // loading, and lands if it arrives while it's still the one Home is on. The opening has no such bound: #18 ends
  // loading at it, and the photograph still shows when it comes.
  const waitingOn = shown && currentId !== undefined && currentId !== settledId && !currentFailed ? currentId : null;
  useEffect(() => {
    if (waitingOn === null) return;
    const timer = setTimeout(() => handleImageFailed(waitingOn), HOME_LOADING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [waitingOn, playback.moves, handleImageFailed]);

  // Suspension holds the timer, without touching the visitor's Pause or Play.
  const { setHold } = playback;
  useEffect(() => {
    setHold('auto-suspended', suspended);
  }, [setHold, suspended]);

  // Focus: the Previous or Next that started the visitor's move, and the actions it should come back from.
  const origin = useRef<'prev' | 'next' | null>(null);
  const previousRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const enterRef = useRef<HTMLAnchorElement>(null);
  /** Retry or Skip had focus as they left: a move landed under them. */
  const focusLeft = useRef(false);
  const handleActionsLeft = useCallback(() => {
    focusLeft.current = true;
  }, []);

  const commit = useLatest((photoId: string) => {
    setFailed((set) => withoutId(set, photoId));
    setSettledId(photoId);
    autoFailures.current = 0;
    walkFailures.current = 0;
    if (playback.source === 'manual' || !shown) setSuspended(false);
    setNoticeId(null);
    setUnavailable(false);
    if (shown) return;
    // The first photograph on screen ends loading, marks the intro done for the tab, and releases any no-photo hold.
    setShown(true);
    markHomeHeroIntroCompleted();
    reportPhoto('shown');
  });
  const handleImageReady = useCallback((photoId: string) => commit.current(photoId), [commit]);

  const retry = useCallback(() => {
    if (currentId === undefined) return;
    // The attempt starts over, so the timer waits on it and its result decides again.
    handled.current = null;
    walkFailures.current = 0;
    setSettledId(null);
    if (currentRecordFailed) {
      retryRecord(currentId);
      return;
    }
    setAttempts((attempt) => ({ ...attempt, [currentId]: (attempt[currentId] ?? 0) + 1 }));
    setFailed((set) => withoutId(set, currentId));
  }, [currentId, currentRecordFailed, retryRecord]);

  const prev = useCallback(() => {
    origin.current = 'prev';
    playback.prev();
  }, [playback]);
  const next = useCallback(() => {
    origin.current = 'next';
    playback.next();
  }, [playback]);
  // Home's own moves start nothing the visitor would come back to.
  useEffect(() => {
    if (playback.source !== 'manual') origin.current = null;
  }, [playback.source, playback.moves]);

  // Suspended, the playback button offers Play, which takes the slideshow up again a full interval later.
  const togglePlayback = useCallback(() => {
    if (!suspended) {
      playback.togglePlayback();
      return;
    }
    autoFailures.current = 0;
    setSuspended(false);
    if (!playback.wantsPlay) playback.togglePlayback();
  }, [suspended, playback]);

  // Retry and Skip stay from the failure until a move lands, so a focused one never leaves while its own move loads.
  const showActions = !unavailable && (suspended || noticeId !== null);
  // A photograph with no derivative set has nothing to fetch again.
  const showRetry = unavailable || (showActions && current?.image !== null);
  // When Retry or Skip held focus and left because a move landed, focus goes back where the move started, in the same
  // commit, so #18's keyboard-focus hold never drops.
  useLayoutEffect(() => {
    if (!focusLeft.current) return;
    focusLeft.current = false;
    const back = origin.current === 'prev' ? previousRef.current : origin.current === 'next' ? nextRef.current : null;
    (back ?? enterRef.current)?.focus();
  });

  const handleSettled = useCallback(() => setIsSettled(true), []);
  const announce = playback.source === 'manual' ? 'polite' : 'off';

  return (
    <div className="contents" data-playback={playback.playbackState} data-home-state={unavailable ? 'image-unavailable' : 'ready'}>
      {/* The intro is Home's loading state on a first visit with motion, and leaves About's portrait as the badge. */}
      <HeroReveal isLoading={loading} onSettled={handleSettled} onPhaseChange={reportIntro} portrait={portrait} copyKey={series.id} />

      {/* This layer takes the pointer instead of the photograph, so a drag or a long press never picks up the image. */}
      <div className="absolute inset-0 z-0 [&>*]:pointer-events-none">
        <CatalogSequence
          photoIds={photoIds}
          photos={photos}
          index={playback.index}
          openingId={opening.openingPhotoId}
          playbackState={playback.playbackState}
          attempts={attempts}
          label={series.title}
          slideLabel={slideLabel}
          announce={announce}
          onImageReady={handleImageReady}
          onImageFailed={handleImageFailed}
          onShownChange={setShownId}
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
            <div
              className={styles.copy}
              data-badge-lane={portrait ? '' : undefined}
              style={portrait ? ({ '--badge-lane': `${V110_LANE}px` } as React.CSSProperties) : undefined}
            >
              <span className={styles.panel} aria-hidden="true" data-chrome-panel="" />
              <h1 className={styles.title}>{series.title}</h1>
              {series.shortStatement !== null && <p className={styles.statement}>{series.shortStatement}</p>}
            </div>
            <Link ref={enterRef} href={series.href} className={styles.enter}>
              Enter the series
            </Link>
          </div>
        }
        sequence={
          <div className={styles.sequence}>
            <div role="status" className={styles.failure} data-failed={note !== null ? '' : undefined}>
              {announcement !== null && <p className="sr-only">{announcement}</p>}
              {note !== null && <p>{note}</p>}
            </div>
            {(showActions || unavailable) && (
              <FailureActions onLeftWithFocus={handleActionsLeft}>
                {showRetry && (
                  <button type="button" className={styles.action} onClick={retry}>
                    Retry
                  </button>
                )}
                {showActions && photoIds.length > 1 && (
                  <button type="button" className={styles.action} onClick={playback.next}>
                    Skip
                  </button>
                )}
              </FailureActions>
            )}
            {!unavailable && (
              <HomeSequenceControls
                index={onScreen.position}
                count={onScreen.count}
                steps={photoIds.length}
                wantsPlay={playback.wantsPlay && !suspended}
                onPrev={prev}
                onNext={next}
                onTogglePlayback={togglePlayback}
                previousRef={previousRef}
                nextRef={nextRef}
                {...pointerHandlers}
              />
            )}
          </div>
        }
      />
    </div>
  );
}

/**
 * Retry and Skip. As they leave the document, which a landed move does, they
 * say whether one of them had focus: React runs this cleanup before it removes
 * them, so focus is still inside.
 */
function FailureActions({ children, onLeftWithFocus }: { children: React.ReactNode; onLeftWithFocus: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    return () => {
      if (element?.contains(document.activeElement)) onLeftWithFocus();
    };
  }, [onLeftWithFocus]);
  return (
    <div ref={ref} className={styles.failureActions}>
      {children}
    </div>
  );
}

/** Home moves past a failure on its own only on its own move, while it's playing. */
function skipsOnItsOwn(playback: Pick<HomePlayback, 'source' | 'advancing'>): boolean {
  return playback.source === 'auto' && playback.advancing;
}

/** "Couldn't load photograph 05 of 12", naming the series when it isn't the one on screen. */
function noticeText({ entry, position, count }: { entry: HomeLoopSeries; position: number; count: number }, seriesOnScreen: string): string {
  return `Couldn’t load photograph ${pad(position + 1)} of ${pad(count)}${entry.id !== seriesOnScreen ? ` in ${entry.title}` : ''}`;
}

/** A ref that always holds this render's `value`, for a callback that must stay the same across renders. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
