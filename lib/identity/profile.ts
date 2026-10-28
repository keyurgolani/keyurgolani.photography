import sharp from 'sharp';
import { profileIdOf } from './ids';
import type { VariantFormat, VariantWidth } from './variants';

/**
 * Derivative profile 1: processImage()'s encoder settings plus autoOrient()
 * and a 1200 px size. WebP is quality 80 at 400 px and 85 above, AVIF is
 * quality 60 at effort 4, nothing is enlarged, the LQIP is a 20 px WebP, and
 * no metadata is kept. No variant is taller than `maxHeight`, since WebP
 * can't encode a side over 16383 px, so a tall panorama gets a narrower
 * variant instead of failing, as the legacy derivatives do. Changing anything here, or upgrading Sharp or libvips,
 * makes a new profileId, which applies to revisions first seen after it.
 */
export const PROFILE_1 = {
    profile: 1,
    autoOrient: true,
    metadata: 'none',
    resize: { fit: 'inside', withoutEnlargement: true },
    maxHeight: 16383,
    variants: {
        w400: { width: 400, webp: { quality: 80 }, avif: { quality: 60, effort: 4 } },
        w800: { width: 800, webp: { quality: 85 }, avif: { quality: 60, effort: 4 } },
        w1200: { width: 1200, webp: { quality: 85 }, avif: { quality: 60, effort: 4 } },
        w1920: { width: 1920, webp: { quality: 85 }, avif: { quality: 60, effort: 4 } },
    },
    lqip: { size: 20, fit: 'inside', webp: { quality: 20 } },
} as const;

/** The profile new revisions get, for the installed Sharp and libvips. */
export function currentProfileId(versions: { sharp: string; vips: string } = { sharp: sharp.versions.sharp, vips: sharp.versions.vips }): string {
    return profileIdOf(PROFILE_1, versions);
}

/**
 * Encode one variant the way profile 1 says: upright, inside the width and
 * the height cap, never enlarged, and with no metadata, since Sharp writes
 * none unless asked. The watcher's sets and About's portrait both use it.
 */
export async function encodeVariant(source: Buffer, width: VariantWidth, format: VariantFormat, options: { limitInputPixels?: number } = {}): Promise<Buffer> {
    const recipe = PROFILE_1.variants[width];
    const resized = sharp(source, options).autoOrient().resize(recipe.width, PROFILE_1.maxHeight, PROFILE_1.resize);
    return (format === 'avif' ? resized.avif(recipe.avif) : resized.webp(recipe.webp)).toBuffer();
}

/**
 * Encode profile 1's LQIP: upright, inside 20 px, a WebP at quality 20, with
 * no metadata, as encodeVariant. The watcher's sets and About's portrait both use it.
 */
export async function encodeLqip(source: Buffer, options: { limitInputPixels?: number } = {}): Promise<Buffer> {
    const { size, fit, webp } = PROFILE_1.lqip;
    return sharp(source, options).autoOrient().resize(size, size, { fit }).webp(webp).toBuffer();
}

/** An encoded LQIP as the data URI the pages paint behind a photo. */
export const lqipDataUri = (data: Buffer) => `data:image/webp;base64,${data.toString('base64')}`;

/** The width a variant comes out at from an upright `width` x `height` source: inside its target width and the height cap, never enlarged. */
export function variantWidthFor(width: number, height: number, target: number): number {
    return Math.max(1, Math.round(width * Math.min(target / width, PROFILE_1.maxHeight / height, 1)));
}
