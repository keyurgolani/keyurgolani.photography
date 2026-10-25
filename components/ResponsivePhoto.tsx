import React from 'react';
import { VARIANT_WIDTHS, type VariantFormat, type VariantWidth } from '@/lib/identity/variants';

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
  sizes?: string;
  loading?: 'lazy' | 'eager';
  fetchPriority?: 'high' | 'low' | 'auto';
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
 */
export default function ResponsivePhoto({ asset, alt, sizes, loading, fetchPriority, onLoad, onError, className, ref }: ResponsivePhotoProps) {
  const placeholder: React.CSSProperties | undefined = asset.lqip
    ? { backgroundImage: `url("${asset.lqip}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : undefined;
  return (
    <picture>
      <source type="image/avif" srcSet={srcSet(asset.variants, 'avif')} sizes={sizes} />
      <source type="image/webp" srcSet={srcSet(asset.variants, 'webp')} sizes={sizes} />
      <img
        ref={ref}
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
