import { VARIANT_FORMATS, VARIANT_WIDTHS, type VariantFormat, type VariantWidth } from '../../identity/variants';
import { mediaUrl } from '../../media/url';
import type { CatalogContent } from '../reader';

/**
 * The derivative ladder as a screen ships it. ResponsivePhoto, the one
 * thing that renders a ladder, reads each file's `url` and `width` for its
 * `srcset` and takes the box from the photo's own `width` and `height`, so
 * a file's own height and byte count stay in the revision. With per-file
 * sizes, as a real library has, they were about a quarter of Home's, Work's,
 * and a series page's compressed bytes (#6).
 */

type Photo = CatalogContent['photos'][number];

/** One variant file, as `/media` serves it and a `srcset` names it. */
export interface LadderVariant {
    url: string;
    width: number;
}

export type Ladder = Record<VariantWidth, Record<VariantFormat, LadderVariant>>;

const dimension = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

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
