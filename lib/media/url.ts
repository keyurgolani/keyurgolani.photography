import { ASSET_REVISION_RE, PHOTO_ID_RE, PROFILE_ID_RE } from '../identity/ids';
import type { VariantFormat, VariantWidth } from '../identity/variants';

/** Names one derivative set: the photo, its source revision, and the profile that built it. */
export interface AssetRef {
    photoId: string;
    assetRevision: string;
    profileId: string;
}

/**
 * `/media/<photoId>/<assetRevision>/<profileId>/<variant>.<format>`. Every
 * segment is validated, and a changed source or profile changes the URL, so
 * these URLs can be cached forever. Manifests store no URLs; build them here.
 */
export function mediaUrl(ref: AssetRef, variant: VariantWidth, format: VariantFormat): string {
    if (!PHOTO_ID_RE.test(ref.photoId)) throw new Error(`Invalid photoId: ${ref.photoId}`);
    if (!ASSET_REVISION_RE.test(ref.assetRevision)) throw new Error(`Invalid assetRevision: ${ref.assetRevision}`);
    if (!PROFILE_ID_RE.test(ref.profileId)) throw new Error(`Invalid profileId: ${ref.profileId}`);
    return `/media/${ref.photoId}/${ref.assetRevision}/${ref.profileId}/${variant}.${format}`;
}
