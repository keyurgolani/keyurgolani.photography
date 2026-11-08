'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import ResponsivePhoto from '@/components/ResponsivePhoto';
import type { HomePhoto as CatalogPhoto } from '@/lib/catalog/projections/home';
import type { PlaybackState } from './homePlayback';
import styles from './HomeSequence.module.css';
import { heroSizes } from './heroSizes';
import { useCopyTone } from './useCopyTone';

interface CatalogSequenceProps {
  /** The authored order. */
  photoIds: readonly string[];
  /**
   * The records it holds, by ID. A record whose image is null renders as a
   * missing image; a photo with no record yet renders nothing and reports
   * nothing, so the photograph before it stays on screen while it loads.
   */
  photos: ReadonlyMap<string, CatalogPhoto>;
  /** The photos whose record failed to arrive, so the live region doesn't wait for a description that isn't coming. */
  recordsFailed: ReadonlySet<string>;
  /** The position useHomePlayback is on: the photograph Home is moving to, or has committed. */
  index: number;
  /** The photograph Home opens on, the one the document head preloads. */
  openingId?: string;
  /** The slow zoom runs only while this is 'advancing'. */
  playbackState: PlaybackState;
  /** Bumped by Retry: a new number remounts that photo's image, so it fetches again. */
  attempts: Readonly<Record<string, number>>;
  /** The carousel's name: the title of the series on screen. */
  label: string;
  /** Each slide's name, "3 of 12": its place in its own series. */
  slideLabel: (photoId: string) => string;
  /** The series a photograph is in, so the live region can name a new one when the photograph on screen crosses into it. */
  seriesOf: (photoId: string) => { id: string; title: string };
  /** The hidden live region's politeness: off while Home moves by itself, polite after the visitor moves it. */
  announce: 'off' | 'polite';
  /** Called whenever the photograph at `index` has decoded and is on screen: its commit. */
  onImageReady: (photoId: string) => void;
  /** Called when a photograph's image fails to load or decode. */
  onImageFailed: (photoId: string) => void;
  /** Called with the photograph on screen whenever that changes, which lags `index` while the next one loads. */
  onShownChange?: (photoId: string | undefined) => void;
}

const addTo = (set: ReadonlySet<string>, id: string) => (set.has(id) ? set : new Set(set).add(id));
const removeFrom = (set: ReadonlySet<string>, id: string) => {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
};

/**
 * The catalog Home's slide stack, controlled by useHomePlayback, as #4's
 * carousel: a region named for the series on screen, each slide a group
 * named "N of M". Each slide is one #10 derivative set through
 * ResponsivePhoto, framed by its record (frameOf, `data-crop`). A slide
 * commits only once its image's decode() resolves: the photograph on screen
 * changes only to one that has, so while the next
 * one loads, or if it fails, the one before stays, and a failed image never
 * blanks Home. Before anything has decoded, the photograph at `index` is on
 * screen, over its LQIP. It mounts only the photograph on screen, the one at
 * `index`, the one after that once something has decoded, and one fading
 * out, so the first view asks for at most two full-size files: the opening
 * photograph, then the next (#6). A slide that unmounts before it finished
 * stops fetching (ResponsivePhoto). It keeps no timer, renders no control,
 * and never moves focus.
 */
export default function CatalogSequence({ photoIds, photos, recordsFailed, index, openingId, playbackState, attempts, label, slideLabel, seriesOf, announce, onImageReady, onImageFailed, onShownChange }: CatalogSequenceProps) {
  // The mounted slides whose image has decoded. A slide leaves it when it unmounts, so a remount decodes again.
  const [decoded, setDecoded] = useState<ReadonlySet<string>>(new Set());
  const [anyDecoded, setAnyDecoded] = useState(false);
  const activeId = photoIds[index];
  const nextId = photoIds.length > 1 ? photoIds[(index + 1) % photoIds.length] : undefined;

  // What's on screen: the photograph at `index` once it has decoded, else the one there before if that one had.
  // `crossed`: it's in another series than the one before it, so the live region names that series. The opening
  // photograph isn't a crossing: the page's heading names its series.
  const [stage, setStage] = useState<{ shown?: string; outgoing: readonly string[]; crossed: boolean }>({ shown: activeId, outgoing: [], crossed: false });
  const keep = stage.shown !== undefined && stage.shown !== activeId && decoded.has(stage.shown) && !(activeId !== undefined && decoded.has(activeId));
  const shownId = keep ? stage.shown : activeId;
  if (stage.shown !== shownId) {
    // The photograph that was on screen fades out, and a newer commit ends any older fade at once. One that never
    // decoded has nothing on screen to fade. Decided in this render, so the crossing and the slide are one message.
    setStage({
      shown: shownId,
      outgoing: stage.shown !== undefined && decoded.has(stage.shown) ? [stage.shown] : [],
      crossed: stage.shown !== undefined && shownId !== undefined && seriesOf(shownId).id !== seriesOf(stage.shown).id,
    });
  }

  const markDecoded = useCallback((id: string) => {
    setDecoded((current) => addTo(current, id));
    setAnyDecoded(true);
  }, []);
  const markGone = useCallback((id: string) => setDecoded((current) => removeFrom(current, id)), []);

  // The tone of the photograph on screen under the copy, for Light's and Bright's scrim.
  const carouselRef = useRef<HTMLDivElement>(null);
  const shownDecoded = shownId !== undefined && decoded.has(shownId);
  useCopyTone(carouselRef, shownId, shownDecoded);

  // The commit, once per photograph Home moves to. The latest callback, so a new one doesn't report it again.
  const ready = useRef(onImageReady);
  useEffect(() => {
    ready.current = onImageReady;
  }, [onImageReady]);
  const activeDecoded = activeId !== undefined && decoded.has(activeId);
  useEffect(() => {
    if (activeId !== undefined && activeDecoded) ready.current(activeId);
  }, [activeId, activeDecoded]);

  useEffect(() => {
    onShownChange?.(shownId);
  }, [shownId, onShownChange]);

  // A photo whose record has no showable set fails as soon as it would mount. One with no record yet is still loading (#6).
  useEffect(() => {
    for (const id of [activeId, nextId]) if (id !== undefined && photos.get(id)?.image === null) onImageFailed(id);
  }, [activeId, nextId, photos, onImageFailed]);

  if (photoIds.length === 0) return null;
  const shownRecord = shownId === undefined ? undefined : photos.get(shownId);
  // Before anything has decoded, the slide on screen is the one Home moved to, and its record may still be on its way:
  // the line waits for it, so the slide and its description are one message, not the slide said twice. A record that
  // failed has no description to wait for.
  const waiting = shownId !== undefined && shownRecord === undefined && !recordsFailed.has(shownId);

  return (
    // A div with the region role, not a <section>: the same semantics, and the element Dark's parity gate walks.
    <div
      ref={carouselRef}
      className={styles.carousel}
      role="region"
      aria-roledescription="carousel"
      aria-label={label}
      data-home-carousel=""
      data-zoom={playbackState === 'advancing' ? 'running' : 'paused'}
    >
      {photoIds.map((id) => {
        const on = id === shownId;
        const outgoing = stage.outgoing.includes(id);
        const mounted = on || outgoing || id === activeId || (anyDecoded && id === nextId);
        if (!mounted) return null;
        const record = photos.get(id);
        const image = record?.image ?? null;
        const crop = record?.crop === 'contain' ? 'contain' : 'cover';
        const className = [styles.slide, on && styles.active, (on || outgoing) && styles.zoom, outgoing && styles.outgoing].filter(Boolean).join(' ');
        return (
          <div
            key={id}
            className={className}
            role="group"
            aria-roledescription="slide"
            aria-label={slideLabel(id)}
            aria-hidden={!on}
            data-photo-id={id}
            data-crop={crop}
            data-decoded={decoded.has(id) ? '' : undefined}
            style={frameOf(record?.focalPoint)}
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
                crop={crop}
                alt={record?.alt ?? ''}
                priority={id === activeId}
                lead={id === openingId}
                onDecoded={markDecoded}
                onGone={markGone}
                onFailed={onImageFailed}
              />
            )}
          </div>
        );
      })}
      {/*
        The slide on screen and its photograph, after the series' name when it crossed into another, for a screen
        reader: read out after the visitor's own move, never Home's. Home's only announcement, so a crossing is one
        message (#4).
      */}
      <p className="sr-only" aria-live={announce} aria-atomic="true">
        {shownId === undefined || waiting ? '' : `${stage.crossed ? `Now showing ${seriesOf(shownId).title}. ` : ''}${slideLabel(shownId)}${shownRecord?.alt ? `, ${shownRecord.alt}` : ''}`}
      </p>
    </div>
  );
}

/**
 * A slide's frame (#4): its photograph's focal point as `--focal-x` and
 * `--focal-y`, which HomeSequence.module.css cuts a cover crop on, its LQIP
 * included. On the slide, so the server HTML frames the opening photograph as
 * the client does. A contain crop is shown whole and centred instead.
 */
function frameOf(focalPoint: CatalogPhoto['focalPoint'] | undefined): React.CSSProperties {
  const { x, y } = focalPoint ?? { x: 0.5, y: 0.5 };
  // To two places, so floating point never writes 7.000000000000001%.
  const percent = (value: number) => `${Math.round(value * 10000) / 100}%`;
  return { '--focal-x': percent(x), '--focal-y': percent(y) } as React.CSSProperties;
}

interface SlideImageProps {
  id: string;
  image: NonNullable<CatalogPhoto['image']>;
  /** How the slide draws it, which picks the rung #6's size rule gives it. */
  crop: CatalogPhoto['crop'];
  alt: string;
  priority: boolean;
  /** The opening photograph: preloaded from the head, with the srcset and sizes its <picture> has. */
  lead: boolean;
  onDecoded: (photoId: string) => void;
  /** It unmounted, so its decode no longer counts. */
  onGone: (photoId: string) => void;
  onFailed: (photoId: string) => void;
}

/**
 * Decodes a loaded image, then reports it. A decode that rejects for an image
 * that did load (its source changed under it, as a wider window picks a larger
 * candidate) still counts: the next load decodes again. Without decode(), as
 * in jsdom, the load is the commit.
 */
function decodeThen(element: HTMLImageElement, live: () => boolean, onDecoded: () => void, onFailed: () => void) {
  if (typeof element.decode !== 'function') {
    onDecoded();
    return;
  }
  element.decode().then(
    () => {
      if (live()) onDecoded();
    },
    () => {
      if (!live()) return;
      if (element.complete && element.naturalWidth > 0) onDecoded();
      else onFailed();
    },
  );
}

/** One attempt at a photograph's image. Retry remounts it with a new key, since a failed image's decode() doesn't fetch again. */
function SlideImage({ id, image, crop, alt, priority, lead, onDecoded, onGone, onFailed }: SlideImageProps) {
  const ref = useRef<HTMLImageElement>(null);
  const mounted = useRef(false);
  const settle = useCallback(() => {
    const element = ref.current;
    if (element) decodeThen(element, () => mounted.current && ref.current === element, () => onDecoded(id), () => onFailed(id));
  }, [id, onDecoded, onFailed]);
  // A server-rendered image can load before hydration attaches onLoad, so check it once at mount. A failure from then
  // is ResponsivePhoto's to report, once a failed AVIF file's WebP retry fails too (#6).
  useEffect(() => {
    mounted.current = true;
    const element = ref.current;
    if (element?.complete && element.naturalWidth > 0) settle();
    return () => {
      mounted.current = false;
      onGone(id);
    };
    // Only the settled state at mount matters. Later loads and errors arrive as events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <ResponsivePhoto
      ref={ref}
      asset={image}
      alt={alt}
      // #6's size rule for the slide's crop, so a contain one asks for the smaller rung it needs. The preload takes it too.
      sizes={heroSizes(image, crop)}
      loading="eager"
      fetchPriority={priority ? 'high' : 'auto'}
      preload={lead}
      onLoad={settle}
      onError={() => onFailed(id)}
      className={styles.slideImage}
    />
  );
}
