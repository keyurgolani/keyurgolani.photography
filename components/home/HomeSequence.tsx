'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { HomePhoto } from './homePhoto';
import type { PlaybackState } from './homePlayback';
import styles from './HomeSequence.module.css';

interface HomeSequenceProps {
  photos: readonly HomePhoto[];
  index: number;
  /** The slow zoom runs only while this is 'advancing'. */
  playbackState: PlaybackState;
  /** Called once, when the first photograph shown has its full-quality layer. */
  onFirstImageReady?: () => void;
}

const addTo = (set: ReadonlySet<string>, id: string) => (set.has(id) ? set : new Set(set).add(id));

/**
 * Home's slide stack, controlled by useHomePlayback. It shows `photos[index]`
 * and preloads what comes next. It keeps no playback timer, renders no button,
 * and never moves focus, so a slide change can't take focus anywhere.
 */
const HomeSequence: React.FC<HomeSequenceProps> = ({ photos, index, playbackState, onFirstImageReady }) => {
  const [thumbnails, setThumbnails] = useState<ReadonlySet<string>>(new Set());
  const [fullImages, setFullImages] = useState<ReadonlySet<string>>(new Set());
  const preloaded = useRef(new Set<string>());
  const hasNotifiedReady = useRef(false);
  const activeId = photos[index]?.id;

  // Each slide that left keeps its zoom, paused, until its own fade ends, so two quick moves can't snap one back.
  const [shown, setShown] = useState<{ active?: string; outgoing: readonly string[] }>({ active: activeId, outgoing: [] });
  if (shown.active !== activeId) {
    const stillFading = shown.outgoing.filter((id) => id !== activeId && id !== shown.active);
    setShown({ active: activeId, outgoing: shown.active === undefined ? stillFading : [...stillFading, shown.active] });
  }

  const notifyReady = () => {
    if (hasNotifiedReady.current) return;
    hasNotifiedReady.current = true;
    onFirstImageReady?.();
  };

  const handleLoad = (id: string, layer: 'thumbnail' | 'full') => {
    if (layer === 'thumbnail') {
      setThumbnails((current) => addTo(current, id));
      return;
    }
    setFullImages((current) => addTo(current, id));
    // The intro ends only once the photograph on screen has its full-quality layer.
    if (id === activeId) notifyReady();
  };

  // A cached image can finish before React attaches onLoad, so check the one on screen shortly after.
  useEffect(() => {
    const photo = photos[index];
    if (!photo || hasNotifiedReady.current) return;
    const probe = setTimeout(() => {
      const image = new Image();
      image.src = photo.sources.full;
      if (image.complete) notifyReady();
    }, 500);
    return () => clearTimeout(probe);
    // notifyReady only reads refs and the latest callback, so it isn't a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos, index]);

  // Warm up the next three full-quality images and the next two thumbnails.
  useEffect(() => {
    if (photos.length === 0) return;
    const upcoming = [1, 2, 3].map((offset) => photos[(index + offset) % photos.length]);
    for (const photo of upcoming) {
      if (preloaded.current.has(photo.id)) continue;
      preloaded.current.add(photo.id);
      new Image().src = photo.sources.full;
    }
    for (const photo of upcoming.slice(0, 2)) {
      if (!thumbnails.has(photo.id)) new Image().src = photo.sources.thumbnail;
    }
    const current = photos[index];
    if (current && thumbnails.has(current.id) && !fullImages.has(current.id)) new Image().src = current.sources.full;
  }, [photos, index, thumbnails, fullImages]);

  if (photos.length === 0) return null;

  return (
    <div className={styles.carousel} data-zoom={playbackState === 'advancing' ? 'running' : 'paused'}>
      {photos.map((photo, slide) => {
        const active = slide === index;
        const outgoing = shown.outgoing.includes(photo.id);
        // Render the photograph on screen, its neighbors, and anything already loaded.
        const render = Math.abs(slide - index) <= 1 || thumbnails.has(photo.id);
        const thumbnailLoaded = thumbnails.has(photo.id);
        const fullLoaded = fullImages.has(photo.id);
        const className = [styles.slide, active && styles.active, (active || outgoing) && styles.zoom, outgoing && styles.outgoing]
          .filter(Boolean)
          .join(' ');

        return (
          <div
            key={photo.id}
            className={className}
            aria-hidden={!active}
            onTransitionEnd={(event) => {
              if (outgoing && event.propertyName === 'opacity' && event.target === event.currentTarget) {
                setShown((current) =>
                  current.outgoing.includes(photo.id) ? { ...current, outgoing: current.outgoing.filter((id) => id !== photo.id) } : current,
                );
              }
            }}
          >
            {render && (
              <>
                {/* The full-quality layer carries the name, so the thumbnail layer is decorative. */}
                <img
                  src={photo.sources.thumbnail}
                  alt=""
                  data-layer="thumbnail"
                  className={`${styles.slideImage} ${styles.thumbnailLayer}`}
                  loading={slide === 0 ? 'eager' : 'lazy'}
                  fetchPriority={slide === 0 ? 'high' : 'auto'}
                  onLoad={() => handleLoad(photo.id, 'thumbnail')}
                  style={{ opacity: thumbnailLoaded && !fullLoaded ? 1 : 0 }}
                />
                <img
                  src={photo.sources.full}
                  alt={photo.accessibleName}
                  data-layer="optimized"
                  className={`${styles.slideImage} ${styles.optimizedLayer}`}
                  loading={slide === 0 ? 'eager' : 'lazy'}
                  fetchPriority={slide === 0 ? 'high' : 'auto'}
                  onLoad={() => handleLoad(photo.id, 'full')}
                  style={{ opacity: fullLoaded ? 1 : 0 }}
                />
              </>
            )}
            {!thumbnailLoaded && active && <div className={styles.slidePlaceholder} />}
          </div>
        );
      })}
    </div>
  );
};

export default HomeSequence;
