import type { AuthoredPhoto } from '../catalog/types';

/**
 * What the owner set on a photo record, which a merge would drop. Kept apart
 * from lib/curation/resolutions.ts, which the watcher can't load, so the
 * watcher's withdrawn rule (lib/curation/sources.ts) and the curator's bind
 * and restore read it the same way.
 */

/**
 * The owner-set fields of a photo record, by the names the bind note uses.
 * With MANAGED_PHOTO_FIELDS they cover authoredPhotoSchema, which a test
 * checks, so a new schema field has to be sorted into one or the other.
 */
export const OWNER_FIELDS = {
    alt: 'description',
    title: 'title',
    caption: 'caption',
    focalPoint: 'focal point',
    crop: 'crop',
    accent: 'accent',
    credit: 'credit',
    location: 'location',
    capturedAt: 'capture date',
} as const satisfies Partial<Record<keyof AuthoredPhoto, string>>;

/**
 * The photo record fields the tools set: the record's identity, the asset
 * revision draft:init pins, the version and rebase fields, #16's review
 * stamps, and `photos carry-over`'s marker, which are the tools' metadata and
 * never the owner's copy.
 */
export const MANAGED_PHOTO_FIELDS = ['schemaVersion', 'version', 'baseRevisionId', 'conflicts', 'review', 'kind', 'id', 'assetRevision', 'carryOver'] as const satisfies readonly (keyof AuthoredPhoto)[];

/** What the owner set on a photo record, which a merge would lose. Empty for the bare record draft:init writes. */
export function ownerCopyOf(record: AuthoredPhoto): string[] {
    return (Object.entries(OWNER_FIELDS) as [keyof typeof OWNER_FIELDS, string][])
        .filter(([field]) => record[field] !== undefined && record[field] !== null)
        .map(([field, name]) => (field === 'alt' && record.alt?.kind === 'decorative' ? 'decorative flag' : name));
}

