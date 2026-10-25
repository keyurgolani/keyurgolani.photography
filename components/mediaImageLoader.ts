import type { ImageLoaderProps } from 'next/image';
import { VARIANT_PIXELS, VARIANT_WIDTHS } from '@/lib/identity/variants';

/**
 * A `next/image` loader for `/media` sets. A set is already sized and
 * encoded, so the loader picks the set's narrowest variant at least as wide
 * as the width asked for, or its widest, in the same format, and never goes
 * through `/_next/image`. That route refuses `/media` URLs, and must never
 * cache them, since it would keep serving a set after it leaves the active
 * revision.
 */

/** `/media/<photoId>/<assetRevision>/<profileId>/` and the variant file's format. */
const MEDIA_SRC_RE = /^(\/media\/[^/?#]+\/[^/?#]+\/[^/?#]+\/)w(?:400|800|1200|1920)\.(avif|webp)$/;

/** Whether `src` names one variant of a `/media` set, which mediaImageLoader serves. */
export function isMediaSrc(src: string): boolean {
    return MEDIA_SRC_RE.test(src);
}

export function mediaImageLoader({ src, width }: ImageLoaderProps): string {
    const match = MEDIA_SRC_RE.exec(src);
    if (!match) throw new Error(`mediaImageLoader only loads /media variants, not ${src}`);
    const [, set, format] = match;
    const variant = VARIANT_WIDTHS.find((name) => VARIANT_PIXELS[name] >= width) ?? VARIANT_WIDTHS[VARIANT_WIDTHS.length - 1];
    return `${set}${variant}.${format}`;
}
