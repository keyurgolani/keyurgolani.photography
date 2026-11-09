import type { CandidatePhotoRecord, PublicPhotoRecord, SeriesRecord, SiteRecord } from './types';

/**
 * #16's field registry: how the publish ledger (diff.ts) treats every field
 * of a published record. Each table is a mapped type over its record's keys,
 * so a field added to the schema without a class here fails `tsc`, and with
 * it `npm run build`. A field the registry doesn't know at run time, which
 * the strict schemas shouldn't let through, gets an authored row that needs
 * a review, never a derived one that slips past the gate.
 *
 * - `id`: the record's identity, never a change of its own.
 * - `authored`: its own row, reviewed.
 * - `route`: a series' slug or aliases, its own row in the route category, reviewed.
 * - `members`: a series' photo order, a moved row per photo it moves.
 * - `asset`: the bytes a photo pins, an asset row.
 * - `capture`: a photo's capture date, authored while the record overrides
 *   the one #10 read, derived otherwise.
 * - `derived`: what compile or #10 works out, in the record's one derived row.
 */

export type FieldClass = 'id' | 'authored' | 'route' | 'members' | 'asset' | 'capture' | 'derived';

/** A class for every key of `T`, optional ones included, and nothing else. */
export type FieldRegistry<T, C extends FieldClass = FieldClass> = { readonly [K in keyof T]-?: C };

/** Photo fields, both the candidate's and the revision's. The authored ones are in the order the ledger reads them. */
export const PHOTO_FIELDS: FieldRegistry<PublicPhotoRecord & CandidatePhotoRecord, 'id' | 'authored' | 'asset' | 'capture' | 'derived'> = {
    id: 'id',
    assetRevision: 'asset',
    alt: 'authored',
    title: 'authored',
    caption: 'authored',
    focalPoint: 'authored',
    crop: 'authored',
    accent: 'authored',
    credit: 'authored',
    location: 'authored',
    capturedAt: 'capture',
    profileId: 'derived',
    width: 'derived',
    height: 'derived',
    aspectRatio: 'derived',
    variants: 'derived',
    lqip: 'derived',
    technical: 'derived',
};

export const SERIES_FIELDS: FieldRegistry<SeriesRecord, 'id' | 'authored' | 'route' | 'members' | 'derived'> = {
    id: 'id',
    slug: 'route',
    slugAliases: 'route',
    title: 'authored',
    statement: 'authored',
    shortStatement: 'authored',
    chapters: 'authored',
    openingPhotoId: 'authored',
    cover: 'authored',
    accent: 'authored',
    carryOver: 'authored',
    photoIds: 'members',
    derived: 'derived',
};

export const SITE_FIELDS: FieldRegistry<SiteRecord, 'authored'> = {
    featuredSeriesIds: 'authored',
};

const TABLES: Record<'site' | 'series' | 'photo', Readonly<Record<string, FieldClass>>> = { site: SITE_FIELDS, series: SERIES_FIELDS, photo: PHOTO_FIELDS };

/** A field's class, or `authored` for one the registry doesn't list, so it needs a review. */
export function fieldClass(kind: 'site' | 'series' | 'photo', field: string): FieldClass {
    return Object.hasOwn(TABLES[kind], field) ? TABLES[kind][field] : 'authored';
}

/** The photo fields compile copies from the photo record, in registry order. */
export const AUTHORED_PHOTO_FIELDS: readonly string[] = Object.keys(PHOTO_FIELDS).filter((field) => fieldClass('photo', field) === 'authored');
