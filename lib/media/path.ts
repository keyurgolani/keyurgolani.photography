import path from 'node:path';
import { ASSET_REVISION_RE, PHOTO_ID_RE, PROFILE_ID_RE } from '../identity/ids';
import { VARIANT_FORMATS, VARIANT_WIDTHS, type VariantFormat, type VariantWidth } from '../identity/variants';
import { dataRoot } from '../storage/config';
import { isInside } from '../storage/fsx';
import type { AssetRef } from './url';

/**
 * Where derivative sets live: `<dataRoot>/assets/<photoId>/<assetRevision>/<profileId>/`,
 * holding `<variant>.<format>` files and `manifest.json`. Every segment is
 * checked against its ID pattern, so no path built here can leave the store.
 */

/** The last segment of a media URL: `w400.avif` and so on. */
export const VARIANT_FILE_RE = /^w(400|800|1200|1920)\.(avif|webp)$/;

export class MediaPathError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MediaPathError';
    }
}

/** `<dataRoot>/assets`. Throws when no data root is configured. */
export function assetsRoot(root: string | null = dataRoot()): string {
    if (root === null) throw new MediaPathError('No data root is configured: PHOTOGRAPHY_DATA_DIR is not set.');
    return path.join(path.resolve(root), 'assets');
}

export function isValidRef(ref: AssetRef): boolean {
    return PHOTO_ID_RE.test(ref.photoId) && ASSET_REVISION_RE.test(ref.assetRevision) && PROFILE_ID_RE.test(ref.profileId);
}

/** The folder of one derivative set. Throws for a segment that fails its pattern. */
export function assetDir(ref: AssetRef, root: string | null = dataRoot()): string {
    if (!PHOTO_ID_RE.test(ref.photoId)) throw new MediaPathError(`Invalid photoId: ${JSON.stringify(ref.photoId)}`);
    if (!ASSET_REVISION_RE.test(ref.assetRevision)) throw new MediaPathError(`Invalid assetRevision: ${JSON.stringify(ref.assetRevision)}`);
    if (!PROFILE_ID_RE.test(ref.profileId)) throw new MediaPathError(`Invalid profileId: ${JSON.stringify(ref.profileId)}`);
    const store = assetsRoot(root);
    const dir = path.join(store, ref.photoId, ref.assetRevision, ref.profileId);
    if (!isInside(dir, store)) throw new MediaPathError(`${dir} is outside ${store}`);
    return dir;
}

/** One variant file of a set, inside `<dataRoot>/assets`. Throws for anything that isn't a variant or would leave the store. */
export function mediaFilePath(ref: AssetRef, variant: VariantWidth, format: VariantFormat, root: string | null = dataRoot()): string {
    if (!(VARIANT_WIDTHS as readonly string[]).includes(variant)) throw new MediaPathError(`Invalid variant: ${JSON.stringify(variant)}`);
    if (!(VARIANT_FORMATS as readonly string[]).includes(format)) throw new MediaPathError(`Invalid format: ${JSON.stringify(format)}`);
    return path.join(assetDir(ref, root), `${variant}.${format}`);
}

/** The variant and format a media URL's last segment names, or null. */
export function parseVariantFile(segment: string): { variant: VariantWidth; format: VariantFormat } | null {
    const match = VARIANT_FILE_RE.exec(segment);
    if (!match) return null;
    return { variant: `w${match[1]}` as VariantWidth, format: match[2] as VariantFormat };
}
