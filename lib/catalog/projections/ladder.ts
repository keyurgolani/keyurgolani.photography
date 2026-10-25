import { VARIANT_FORMATS, VARIANT_WIDTHS, type VariantFormat, type VariantWidth } from '../../identity/variants';
import { mediaUrl } from '../../media/url';
import type { CatalogContent } from '../reader';
import { LQIP_RE } from '../schema';
import { dimension } from './shared';

/**
 * The derivative ladder as a screen ships it. ResponsivePhoto, the one
 * thing that renders a ladder, reads each file's `url` and `width` for its
 * `srcset` and takes the box from the photo's own `width` and `height`, so
 * a file's own height and byte count stay in the revision. With per-file
 * sizes, as a real library has, they were about a quarter of Home's, Work's,
 * and a series page's compressed bytes (#6).
 */

type Photo = CatalogContent['photos'][number];

/** One variant file, as `/media` serves it and a `srcset` names it. Every screen ships this shape. */
export interface LadderVariant {
    url: string;
    width: number;
}

export type Ladder = Record<VariantWidth, Record<VariantFormat, LadderVariant>>;

/**
 * The photo's ladder, field by field, when every file is the `/media` URL
 * #10 builds for this photo's set and declares a positive size. Anything
 * else (a missing file, an original, a foreign URL, a hand-built revision's
 * bad size) gives null, so a screen never points outside the revision's
 * derivatives. The checks read the whole stored record; only `url` and
 * `width` leave.
 */
export function ladderOf(photo: Photo): Ladder | null {
    const stored = photo.variants as Partial<Record<VariantWidth, Partial<Record<VariantFormat, Partial<Photo['variants'][VariantWidth][VariantFormat]>>>>> | undefined;
    const ladder = {} as Ladder;
    for (const width of VARIANT_WIDTHS) {
        ladder[width] = {} as Record<VariantFormat, LadderVariant>;
        for (const format of VARIANT_FORMATS) {
            const file = stored?.[width]?.[format];
            if (!file || !dimension(file.width) || !dimension(file.height) || !dimension(file.bytes)) return null;
            let expected: string;
            try {
                expected = mediaUrl({ photoId: photo.id, assetRevision: photo.assetRevision, profileId: photo.profileId }, width, format);
            } catch {
                return null;
            }
            if (file.url !== expected) return null;
            ladder[width][format] = { url: file.url, width: file.width };
        }
    }
    return ladder;
}

/**
 * The photo's stored LQIP when it is in the shape the revision schema
 * checks, else undefined. Checked again here because ResponsivePhoto puts it
 * in a CSS `url()`, so nothing else may pass, and a preview's candidate
 * hasn't been through the schema.
 */
export function lqipOf(photo: Photo): string | undefined {
    return typeof photo.lqip === 'string' && LQIP_RE.test(photo.lqip) ? photo.lqip : undefined;
}

/** One photograph's #10 derivative set, as ResponsivePhoto takes it. */
export interface LadderImage {
    /** Oriented. */
    width: number;
    height: number;
    variants: Ladder;
    /** Only when the caller asks for it and lqipOf() accepts it. */
    lqip?: string;
}

/**
 * The photo's set when it has positive integer dimensions and its ladder is
 * usable (see ladderOf()), else null, with the LQIP only when `withLqip`.
 * Home, Work's cover, the series page, and the Viewer all build their image
 * here, so none of them ships a set another would refuse.
 */
export function imageOf(photo: Photo, withLqip: boolean): LadderImage | null {
    if (!dimension(photo.width) || !dimension(photo.height)) return null;
    const variants = ladderOf(photo);
    if (variants === null) return null;
    const image: LadderImage = { width: photo.width, height: photo.height, variants };
    const lqip = withLqip ? lqipOf(photo) : undefined;
    if (lqip !== undefined) image.lqip = lqip;
    return image;
}
