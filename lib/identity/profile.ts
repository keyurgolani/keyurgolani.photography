import sharp from 'sharp';
import { profileIdOf } from './ids';

/**
 * Derivative profile 1: processImage()'s encoder settings plus autoOrient()
 * and a 1200 px size. WebP is quality 80 at 400 px and 85 above, AVIF is
 * quality 60 at effort 4, nothing is enlarged, the LQIP is a 20 px WebP, and
 * no metadata is kept. Changing anything here, or upgrading Sharp or libvips,
 * makes a new profileId, which applies to revisions first seen after it.
 */
export const PROFILE_1 = {
    profile: 1,
    autoOrient: true,
    metadata: 'none',
    resize: { fit: 'inside', withoutEnlargement: true },
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
