'use client';

import React, { useCallback, useEffect, useRef } from 'react';
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
   * Put a preload for this photograph in the document head, carrying the
   * same srcset and sizes the <picture> has, so the browser fetches the rung
   * the element would. Only for a screen's lead photograph.
   */
  preload?: boolean;
  onLoad?: React.ReactEventHandler<HTMLImageElement>;
  onError?: React.ReactEventHandler<HTMLImageElement>;
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

/**
 * One derivative set as a <picture>: AVIF and WebP sources the browser picks
 * from, and an <img> at w1200.webp with the photo's own dimensions, so the
 * layout never shifts, over its LQIP until the image paints. Plain markup,
 * not next/image: the set is already sized and encoded, and /media serves it.
 *
 * The preload carries the AVIF srcset only, typed, so a browser without AVIF
 * skips it and finds the WebP source in the markup, and no browser fetches
 * both. Unmounted before it finished, the image stops fetching (#6).
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

  const avif = srcSet(asset.variants, 'avif');
  if (preloadIt) {
    preload(asset.variants.w1200.avif.url, { as: 'image', type: 'image/avif', imageSrcSet: avif, imageSizes: sizes, fetchPriority: fetchPriority ?? 'high' });
  }

  const placeholder: React.CSSProperties | undefined = asset.lqip
    ? { backgroundImage: `url("${asset.lqip}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : undefined;
  return (
    <picture>
      <source type="image/avif" srcSet={avif} sizes={sizes} />
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
        onError={onError}
        className={className}
        style={placeholder}
      />
    </picture>
  );
}
