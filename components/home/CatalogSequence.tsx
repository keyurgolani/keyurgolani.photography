'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import ResponsivePhoto from '@/components/ResponsivePhoto';
import type { HomePhoto as CatalogPhoto } from '@/lib/catalog/projections/home';
import type { PlaybackState } from './homePlayback';
import styles from './HomeSequence.module.css';

/** Every slide fills the viewport. */
export const HOME_SIZES = '100vw';

interface CatalogSequenceProps {
  /** The authored order. */
  photoIds: readonly string[];
  /**
   * The records it holds, by ID. A record whose image is null renders as a
   * missing image; a photo with no record yet renders nothing and reports
   * nothing, so the photograph before it stays on screen while it loads.
   */
  photos: ReadonlyMap<string, CatalogPhoto>;
  /** The position useHomePlayback is on. */
  index: number;
  /** The photograph Home opens on, the one the document head preloads. */
  openingId?: string;
  /** The slow zoom runs only while this is 'advancing'. */
  playbackState: PlaybackState;
  /** Bumped by Retry: a new number remounts that photo's image, so it fetches again. */
  attempts: Readonly<Record<string, number>>;
  /** Called whenever the photograph at `index` has painted, once per photograph. */
  onImageReady: (photoId: string) => void;
  /** Called when a photograph's image fails to load. */
  onImageFailed: (photoId: string) => void;
}

const addTo = (set: ReadonlySet<string>, id: string) => (set.has(id) ? set : new Set(set).add(id));

/**
 * The catalog Home's slide stack, controlled by useHomePlayback. Each slide
 * is one #10 derivative set through ResponsivePhoto. The photograph on
 * screen changes only to one that has loaded: while the next one loads, or
 * if it fails, the one before stays, so a failed image never blanks Home.
 * Before anything has loaded, the opening photograph is on screen, over its
 * LQIP. It mounts the photograph at `index`, the next one once something
 * has loaded, the one on screen, and any that loaded before, so the first
 * view asks for at most two full-size files: the opening photograph, then
 * the next (#6). A slide that unmounts before it finished stops fetching
 * (ResponsivePhoto). Like #2's HomeSequence it keeps no timer, renders no
 * control, and never moves focus.
 */
export default function CatalogSequence({ photoIds, photos, index, openingId, playbackState, attempts, onImageReady, onImageFailed }: CatalogSequenceProps) {
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(new Set());
  const activeId = photoIds[index];
  const nextId = photoIds.length > 1 ? photoIds[(index + 1) % photoIds.length] : undefined;

  // What's on screen: the photograph at `index` once it has loaded, else the one there before if that one had.
  const [stage, setStage] = useState<{ shown?: string; outgoing: readonly string[] }>({ shown: activeId, outgoing: [] });
  const keep = stage.shown !== undefined && stage.shown !== activeId && loaded.has(stage.shown) && !(activeId !== undefined && loaded.has(activeId));
  const shownId = keep ? stage.shown : activeId;
  if (stage.shown !== shownId) {
    const stillFading = stage.outgoing.filter((id) => id !== shownId && id !== stage.shown);
    setStage({ shown: shownId, outgoing: stage.shown === undefined ? stillFading : [...stillFading, stage.shown] });
  }

  const markLoaded = useCallback((id: string) => setLoaded((current) => addTo(current, id)), []);

  useEffect(() => {
    if (activeId !== undefined && loaded.has(activeId)) onImageReady(activeId);
  }, [activeId, loaded, onImageReady]);

  // A photo whose record has no showable set fails as soon as it would mount. One with no record yet is still loading (#6).
  useEffect(() => {
    for (const id of [activeId, nextId]) if (id !== undefined && photos.get(id)?.image === null) onImageFailed(id);
  }, [activeId, nextId, photos, onImageFailed]);

  if (photoIds.length === 0) return null;
  const anyLoaded = loaded.size > 0;

  return (
    <div className={styles.carousel} data-zoom={playbackState === 'advancing' ? 'running' : 'paused'}>
      {photoIds.map((id) => {
        const on = id === shownId;
        const outgoing = stage.outgoing.includes(id);
        const mounted = on || outgoing || id === activeId || loaded.has(id) || (anyLoaded && id === nextId);
        if (!mounted) return null;
        const image = photos.get(id)?.image ?? null;
        const className = [styles.slide, on && styles.active, (on || outgoing) && styles.zoom, outgoing && styles.outgoing].filter(Boolean).join(' ');
        return (
          <div
            key={id}
            className={className}
            aria-hidden={!on}
            data-photo-id={id}
            onTransitionEnd={(event) => {
              if (outgoing && event.propertyName === 'opacity' && event.target === event.currentTarget) {
                setStage((current) => (current.outgoing.includes(id) ? { ...current, outgoing: current.outgoing.filter((other) => other !== id) } : current));
              }
            }}
          >
            {image && (
              <SlideImage
                key={attempts[id] ?? 0}
                id={id}
                image={image}
                alt={photos.get(id)?.alt ?? ''}
                priority={id === activeId}
                lead={id === openingId}
                onLoaded={markLoaded}
                onFailed={onImageFailed}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

interface SlideImageProps {
  id: string;
  image: NonNullable<CatalogPhoto['image']>;
  alt: string;
  priority: boolean;
  /** The opening photograph: preloaded from the head, with the srcset and sizes its <picture> has. */
  lead: boolean;
  onLoaded: (photoId: string) => void;
  onFailed: (photoId: string) => void;
}

/** One attempt at a photograph's image. Retry remounts it with a new key, since a failed image's decode() doesn't fetch again. */
function SlideImage({ id, image, alt, priority, lead, onLoaded, onFailed }: SlideImageProps) {
  const ref = useRef<HTMLImageElement>(null);
  // A server-rendered image can settle before hydration attaches onLoad and onError, so check it once at mount.
  useEffect(() => {
    const element = ref.current;
    if (!element?.complete) return;
    if (element.naturalWidth > 0) onLoaded(id);
    else onFailed(id);
    // Only the settled state at mount matters. Later loads and errors arrive as events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <ResponsivePhoto
      ref={ref}
      asset={image}
      alt={alt}
      sizes={HOME_SIZES}
      loading="eager"
      fetchPriority={priority ? 'high' : 'auto'}
      preload={lead}
      onLoad={() => onLoaded(id)}
      onError={() => onFailed(id)}
      className={styles.slideImage}
    />
  );
}
