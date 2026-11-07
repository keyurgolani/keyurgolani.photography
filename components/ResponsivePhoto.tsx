'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { preload } from 'react-dom';
import { VARIANT_WIDTHS, type VariantFormat, type VariantWidth } from '@/lib/identity/variants';
import { stopFetching } from './stopFetching';

/**
 * What the markup reads: the photo's own size and each file's URL and width.
 * #10's PublicAssetProjection and the catalog screens' leaner ladders both fit.
 */
type PhotoAsset = {
  width: number;
  height: number;
  variants: Record<VariantWidth, Record<VariantFormat, { url: string; width: number }>>;
  lqip?: string;
};

export interface ResponsivePhotoProps {
  asset: PhotoAsset;
  /** Required. Empty only for a decorative photo, one inside a named link, or a preview whose alt is still pending. */
  alt: string;
  /** Required: how wide this use renders the photograph, so the browser picks the rung it needs instead of assuming the full viewport. */
  sizes: string;
  /** Lazy unless the caller says otherwise: only a screen's first viewport loads eagerly (#6). */
  loading?: 'lazy' | 'eager';
  fetchPriority?: 'high' | 'low' | 'auto';
  /**
   * In the server render, put a preload for this photograph in the document
   * head, carrying the same srcset and sizes the <picture> has, so the
   * browser fetches the rung the element would. Only for a screen's lead
   * photograph. A client render adds none: the <img> is in the same commit,
   * so a link would start nothing sooner, and it would stay in the head and
   * keep a passed photograph downloading.
   */
  preload?: boolean;
  onLoad?: React.ReactEventHandler<HTMLImageElement>;
  /**
   * The photograph can't be shown. A failed AVIF file first retries once with
   * the WebP source (#6), so this comes only after that fails too, or at once
   * for a failed WebP file. It also comes for a file that failed before
   * hydration, which fires no event: the mount check finds it, so callers
   * don't check again.
   */
  onError?: () => void;
  className?: string;
  ref?: React.Ref<HTMLImageElement>;
}

/** Each variant once per pixel width, narrowest first: a small photo makes several variants the same size. */
function srcSet(variants: PhotoAsset['variants'], format: VariantFormat): string {
  const widths = new Set<number>();
  const entries: string[] = [];
  for (const variant of VARIANT_WIDTHS) {
    const { url, width } = variants[variant][format];
    if (widths.has(width)) continue;
    widths.add(width);
    entries.push(`${url} ${width}w`);
  }
  return entries.join(', ');
}

/** A URL's path and query, which is what tells the set's files apart. */
function pathOf(url: string): string | null {
  try {
    const parsed = new URL(url, document.baseURI);
    return parsed.pathname + parsed.search;
  } catch {
    return null;
  }
}

/** Whether the file the browser picked is one of the set's AVIF files. currentSrc is absolute; the set's URLs are paths. */
function isAvif(variants: PhotoAsset['variants'], currentSrc: string): boolean {
  const picked = currentSrc === '' ? null : pathOf(currentSrc);
  return picked !== null && VARIANT_WIDTHS.some((variant) => pathOf(variants[variant].avif.url) === picked);
}

/**
 * One derivative set as a <picture>: AVIF and WebP sources the browser picks
 * from, and an <img> at w1200.webp with the photo's own dimensions, so the
 * layout never shifts, over its LQIP until the image paints. Plain markup,
 * not next/image: the set is already sized and encoded, and /media serves it.
 *
 * The preload carries the AVIF srcset only, typed, so a browser without AVIF
 * skips it and finds the WebP source in the markup, and no browser fetches
 * both. Unmounted before it finished, the image stops fetching (#6),
 * except a lead the server preloaded, which its head link keeps going.
 *
 * A failed AVIF file retries once with WebP (#6): the AVIF source leaves the
 * <picture>, which makes the same <img> pick again, from the WebP source.
 * Only a WebP failure is the photograph's failure.
 */
export default function ResponsivePhoto({
  asset,
  alt,
  sizes,
  loading = 'lazy',
  fetchPriority,
  preload: preloadIt = false,
  onLoad,
  onError,
  className,
  ref,
}: ResponsivePhotoProps) {
  const element = useRef<HTMLImageElement | null>(null);
  /** The photograph's own file, which names it: a retry belongs to one photograph, and another in this element starts afresh. */
  const photo = asset.variants.w1200.webp.url;
  /** The photograph whose AVIF file failed: while it's this one, the <picture> offers WebP alone. */
  const [webpFor, setWebpFor] = useState<string | null>(null);
  const webpOnly = webpFor === photo;
  /** The retry this element took: for which photograph, and the AVIF file that failed, whose error may arrive twice. */
  const retried = useRef<{ photo: string; from: string } | null>(null);
  const setRef = useCallback(
    (node: HTMLImageElement | null) => {
      element.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  // A Strict Mode rehearsal keeps the image in the document, so only a real removal stops it.
  useEffect(() => {
    const image = element.current;
    return () => {
      if (image && !image.isConnected && !image.complete) stopFetching(image);
    };
  }, []);

  // The latest props, for the mount check, which runs once.
  const latest = useRef({ asset, onError, loading });
  latest.current = { asset, onError, loading };
  // Idempotent: the mount check and the error event can both see one AVIF failure, in either order. Only a file other
  // than the one the retry answered (the WebP the browser picked next) is the photograph's failure.
  const failed = useCallback((image: HTMLImageElement) => {
    const { asset: current, onError: report } = latest.current;
    const own = current.variants.w1200.webp.url;
    const retry = retried.current?.photo === own ? retried.current : null;
    const picked = image.currentSrc === '' ? null : pathOf(image.currentSrc);
    if (retry !== null && picked === retry.from) return;
    if (retry === null && picked !== null && isAvif(current.variants, image.currentSrc)) {
      retried.current = { photo: own, from: picked };
      setWebpFor(own);
      return;
    }
    report?.();
  }, []);

  // A server-rendered image can fail before hydration attaches onError. Complete with no pixels is a failed load,
  // unless it's a lazy image that hasn't started (an empty currentSrc).
  // Once per element: a Strict Mode rehearsal runs this twice, and the second run would take a retry for a failure.
  const checked = useRef(false);
  useEffect(() => {
    const image = element.current;
    if (checked.current) return;
    checked.current = true;
    // An error event that came first already took the retry.
    if (retried.current !== null) return;
    if (image && image.complete && image.naturalWidth === 0 && (image.currentSrc !== '' || latest.current.loading === 'eager')) failed(image);
  }, [failed]);

  const avif = srcSet(asset.variants, 'avif');
  if (preloadIt && typeof window === 'undefined') {
    preload(asset.variants.w1200.avif.url, { as: 'image', type: 'image/avif', imageSrcSet: avif, imageSizes: sizes, fetchPriority: fetchPriority ?? 'high' });
  }

  // A cropped photo sets --photo-lqip-position to its object-position, so the LQIP crops where the image will.
  const placeholder: React.CSSProperties | undefined = asset.lqip
    ? { backgroundImage: `url("${asset.lqip}")`, backgroundSize: 'cover', backgroundPosition: 'var(--photo-lqip-position, center)' }
    : undefined;
  return (
    <picture>
      {/* Left out after an AVIF failure, in its slot, so the <img> stays the same element and picks again (#6). */}
      {!webpOnly && <source type="image/avif" srcSet={avif} sizes={sizes} />}
      <source type="image/webp" srcSet={srcSet(asset.variants, 'webp')} sizes={sizes} />
      <img
        ref={setRef}
        src={asset.variants.w1200.webp.url}
        width={asset.width}
        height={asset.height}
        alt={alt}
        loading={loading}
        fetchPriority={fetchPriority}
        onLoad={onLoad}
        onError={(event) => failed(event.currentTarget)}
        className={className}
        style={placeholder}
      />
    </picture>
  );
}
