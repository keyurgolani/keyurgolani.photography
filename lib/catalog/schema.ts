import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ASSET_REVISION_RE, canonicalJson, PHOTO_ID_RE, PROFILE_ID_RE } from '../identity/ids';
import { TECHNICAL_KEYS } from '../identity/metadata';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../identity/variants';

/**
 * Catalog schema v1: the revision files visitors are served from, candidates,
 * activations, the active pointer, and the authored working layer. Every
 * object is strict, so a revision holds only allowlisted fields and nothing
 * like a source path, GPS, a serial number, or an owner name can ride along.
 * Readers upgrade every schemaVersion ever written and reject unknown ones.
 */

export const CATALOG_SCHEMA_VERSION = 1;

export const SERIES_ID_RE = /^ser_[a-z0-9][a-z0-9_-]{1,62}$/;
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SLUG_LENGTH = 64;
/** Path segments a series slug or alias can't take, since routes use them. */
export const RESERVED_SLUGS = ['api', 'curation', 'media', 'new', 'photo', 'preview', 'work'] as const;
export const REVISION_ID_RE = /^rev_[0-9a-f]{64}$/;
export const ACTIVATION_ID_RE = /^act_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_64_RE = /^[0-9a-f]{64}$/;
/** A photo's LQIP: a WebP data URI. The screens check it again (projections/ladder.ts lqipOf()), since ResponsivePhoto writes it into a CSS `url()`. */
export const LQIP_RE = /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/;

const positiveInt = z.number().int().positive();
const count = z.number().int().nonnegative();
const photoId = z.string().regex(PHOTO_ID_RE, 'must be a photo ID, ph_ plus a UUID v4');
const assetRevision = z.string().regex(ASSET_REVISION_RE, 'must be an asset revision, sha256- plus 64 hex');
const profileId = z.string().regex(PROFILE_ID_RE, 'must be a profile ID, p_ plus 16 hex');
const revisionId = z.string().regex(REVISION_ID_RE, 'must be a revision ID, rev_ plus 64 hex');
const activationId = z.string().regex(ACTIVATION_ID_RE, 'must be an activation ID, act_ plus a UUID v4');
/** A series reference. Its pattern is structure.series-id's to report, so a bad ID gets that rule's issue. */
const seriesRef = z.string().min(1);
/** Public copy: absent, or present with something in it. */
const copy = z.string().regex(/\S/, 'must not be empty');
const date = z.iso.date();
const timestamp = z.iso.datetime();

export const focalPointSchema = z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
export const cropSchema = z.enum(['cover', 'contain']);
const technicalSchema = z.partialRecord(z.enum(TECHNICAL_KEYS), z.string().min(1));
const variantFileSchema = z.strictObject({ url: z.string().min(1), width: positiveInt, height: positiveInt, bytes: positiveInt });
const variantsSchema = z.record(z.enum(VARIANT_WIDTHS), z.record(z.enum(VARIANT_FORMATS), variantFileSchema));

const decorativeAlt = z.strictObject({ kind: z.literal('decorative') });
/**
 * A photo `photos carry-over` brought over from the legacy site at the
 * launch, still with no description: the screens name it by its place, as
 * the legacy Gallery did, "Photograph N of T", never with text passed off
 * as a description, and never with an empty alt, since it isn't decorative.
 * Only a photo record with the carry-over marker and no alt compiles to it.
 */
const positionAlt = z.strictObject({ kind: z.literal('position') });
export const publicAltSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('described'), text: copy }), decorativeAlt, positionAlt]);
/**
 * A candidate mirrors the working layer before the description rules have
 * judged it: `pending` stands for an authored `alt: null`, and described text
 * may still be empty. The revision schema accepts neither.
 */
export const candidateAltSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('described'), text: z.string() }),
    decorativeAlt,
    positionAlt,
    z.strictObject({ kind: z.literal('pending') }),
]);

const photoFields = {
    id: photoId,
    assetRevision,
    profileId,
    /** Oriented, as the derivatives are. */
    width: positiveInt,
    height: positiveInt,
    aspectRatio: z.number().positive(),
    variants: variantsSchema,
    lqip: z.string().regex(LQIP_RE, 'must be a WebP data URI'),
    technical: technicalSchema,
    title: copy.optional(),
    caption: copy.optional(),
    focalPoint: focalPointSchema.optional(),
    crop: cropSchema.optional(),
    accent: z.string().optional(),
    credit: copy.optional(),
    /** Authored only. Never derived from GPS. */
    location: copy.optional(),
    /** `YYYY-MM-DD`, authored or #10's capture date. */
    capturedAt: date.optional(),
};
export const publicPhotoRecordSchema = z.strictObject({ ...photoFields, alt: publicAltSchema });
export const candidatePhotoRecordSchema = z.strictObject({ ...photoFields, alt: candidateAltSchema });

const chapterSchema = z.strictObject({ id: z.string().min(1), title: z.string().min(1), startPhotoId: photoId });
const coverSchema = z.strictObject({ photoId, focalPoint: focalPointSchema.optional() });

export const seriesRecordSchema = z.strictObject({
    id: seriesRef,
    slug: z.string().min(1),
    slugAliases: z.array(z.string().min(1)),
    title: z.string(),
    statement: z.string(),
    /** Plain text: the Work dek and the meta description. */
    shortStatement: z.string(),
    /** The only order authority. */
    photoIds: z.array(photoId),
    chapters: z.array(chapterSchema),
    openingPhotoId: photoId.optional(),
    cover: coverSchema,
    accent: z.string().optional(),
    /** The series `photos carry-over` made at the launch, which may go without a statement until the owner writes one. */
    carryOver: z.literal(true).optional(),
    /** Computed by compile over resolved members. The dates are absent when no member is dated. */
    derived: z.strictObject({ photoCount: count, capturedFrom: date.optional(), capturedTo: date.optional() }),
});
export const siteRecordSchema = z.strictObject({ featuredSeriesIds: z.array(seriesRef) });

/** Published series in Work order, and their photos sorted by ID. */
export const revisionContentSchema = z.strictObject({
    site: siteRecordSchema,
    series: z.array(seriesRecordSchema),
    photos: z.array(publicPhotoRecordSchema),
});
export const candidateContentSchema = z.strictObject({
    site: siteRecordSchema,
    series: z.array(seriesRecordSchema),
    photos: z.array(candidatePhotoRecordSchema),
});

const fileFields = {
    revisionId,
    schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
    baseRevisionId: revisionId.nullable(),
    compiledAt: timestamp,
};
export const revisionFileSchema = z.strictObject({ ...fileFields, content: revisionContentSchema });
/** Named by the revision ID it would get. */
export const candidateFileSchema = z.strictObject({ ...fileFields, content: candidateContentSchema });

export const activationSchema = z.strictObject({
    schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
    activationId,
    /** The `NNNNNN` prefix of the activation's file name. */
    sequence: positiveInt,
    kind: z.enum(['publish', 'rollback']),
    status: z.enum(['pending', 'committed', 'abandoned']),
    revisionId,
    revisionNumber: positiveInt,
    previousRevisionId: revisionId.nullable(),
    previousActivationId: activationId.nullable(),
    actor: z.string().min(1),
    reason: z.string().min(1),
    startedAt: timestamp,
    committedAt: timestamp.optional(),
    validation: z.strictObject({
        rulesetVersion: z.string().regex(HEX_64_RE),
        errors: count,
        warnings: count,
        diagnosticsDigest: z.string().regex(HEX_64_RE),
    }),
    /** Editorial rules a rollback accepted. */
    acceptedRules: z.array(z.string().min(1)),
    lockTakeover: z.strictObject({ previousOwner: z.string(), previousAcquiredAt: z.string() }).nullable(),
});
/** The active pointer: the newest version in `catalog/active/`, so `version` is that file's number. */
export const activePointerSchema = z.strictObject({ schemaVersion: z.literal(CATALOG_SCHEMA_VERSION), version: positiveInt, revisionId, activationId });

/**
 * A field a rebase couldn't merge. `baseUnreadable` is set when the record's
 * base revision couldn't be read, so `base` is null and the field may be one
 * only the active revision changed. Without it, both sides changed the field.
 */
const conflictSchema = z.strictObject({ field: z.string().min(1), base: z.json(), active: z.json(), baseUnreadable: z.literal(true).optional() });

/**
 * #16's review stamp on one authored field: what the curator reviewed, as
 * the writer recorded it when the value was written. Managed, like
 * `baseRevisionId`: only the writer sets it (lib/catalog/review.ts).
 */
export const fieldReviewSchema = z.strictObject({
    /** SHA-256 hex of the canonical JSON of the value reviewed, null for an absent one. A value changed since, by hand, no longer matches. */
    valueHash: z.string().regex(HEX_64_RE),
    /** `curator`: typed or chosen through a tool. `generated`: a suggestion or a policy write nobody accepted yet. `migration`: the backfill of a record written before stamps. */
    origin: z.enum(['curator', 'generated', 'migration']),
    /** The active revision the value was reviewed against, null before the first activation. */
    baseRevisionId: revisionId.nullable(),
    /** A photo field: the asset revision the record pinned. A series cover: the cover photo's. */
    assetRevision: assetRevision.optional(),
    /** The inbox item, and the version of it, the curator reviewed, when the write settled one. */
    event: z.strictObject({ id: z.string().min(1), version: positiveInt }).optional(),
    /** `assetRevision` set by #17's confirm or Leave in draft: the revision it replaced, the one it set, and that set's profile. */
    asset: z.strictObject({ from: assetRevision, to: assetRevision, profileId }).optional(),
    actor: z.string().min(1),
    reviewedAt: timestamp,
});
export const reviewStampSchema = z.strictObject({ fields: z.record(z.string().min(1), fieldReviewSchema) });

/**
 * `photos carry-over`'s marker on the records it wrote at the launch: when,
 * and the owner's direction it followed, quoted. A marked photo with no alt
 * is named by its place (`position`), and the marked series may go without
 * a statement, until the owner writes them.
 */
export const carryOverSchema = z.strictObject({ reason: copy, at: timestamp });

const authoredFields = {
    schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
    /** Bumped on every tool write. The compare-and-swap key. */
    version: positiveInt,
    /** The active revision at the record's creation or last rebase. */
    baseRevisionId: revisionId.nullable(),
    conflicts: z.array(conflictSchema).optional(),
    /** #16's review stamps, by field. Absent on a record no tool has written since they were added, which reads as backfilled. */
    review: reviewStampSchema.optional(),
};

export const authoredSiteSchema = z.strictObject({
    ...authoredFields,
    kind: z.literal('site'),
    featuredSeriesIds: z.array(seriesRef),
    /** Work order. Draft and hidden series may hold slots. */
    seriesOrder: z.array(seriesRef),
    /**
     * Managed, like `baseRevisionId`: the Work order as the last rebase left
     * it, without any change the owner made since, so a rebase can tell an
     * owner's move from the target's. Null when that isn't known: a record no
     * rebase has written, or one written before this field.
     */
    baseSeriesOrder: z.array(seriesRef).nullable().default(null),
});

/** A SeriesRecord minus `derived`. Draft and hidden series may lack copy, photos, and a cover. */
export const authoredSeriesSchema = z.strictObject({
    ...authoredFields,
    kind: z.literal('series'),
    id: z.string().min(1),
    slug: z.string().min(1),
    slugAliases: z.array(z.string().min(1)).default([]),
    title: z.string().default(''),
    statement: z.string().default(''),
    shortStatement: z.string().default(''),
    photoIds: z.array(photoId).default([]),
    chapters: z.array(chapterSchema).default([]),
    openingPhotoId: photoId.optional(),
    cover: coverSchema.nullable().default(null),
    accent: z.string().optional(),
    visibility: z.enum(['draft', 'published', 'hidden']),
    /** Only #14 acts on it. */
    publicationPolicy: z.enum(['review-required', 'auto-include-as-draft']).default('review-required'),
    carryOver: carryOverSchema.optional(),
});

/** Owner-written or imported alt is reviewed. A #14 suggestion isn't until the owner accepts it. */
export const authoredAltSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('described'), text: z.string(), reviewed: z.boolean() }),
    decorativeAlt,
]).nullable();

export const authoredPhotoSchema = z.strictObject({
    ...authoredFields,
    kind: z.literal('photo'),
    id: photoId,
    /** Changes only through an authored edit, never from the newest registry revision. */
    assetRevision,
    alt: authoredAltSchema,
    title: z.string().optional(),
    caption: z.string().optional(),
    focalPoint: focalPointSchema.optional(),
    crop: cropSchema.optional(),
    accent: z.string().optional(),
    credit: z.string().optional(),
    location: z.string().optional(),
    capturedAt: date.optional(),
    carryOver: carryOverSchema.optional(),
});

export interface SchemaIssue {
    /** Where in the record, such as `content.photos[0].alt.text`. Empty for the record itself. */
    path: string;
    message: string;
}

export interface SchemaError {
    reason: 'unknown-schema-version' | 'invalid';
    /** The version found, for `unknown-schema-version`. */
    schemaVersion?: unknown;
    issues: SchemaIssue[];
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: SchemaError };

/** Turns a record written under one schemaVersion into the next one's shape. */
type Upgrade = (value: Record<string, unknown>) => Record<string, unknown>;

function pathOf(path: readonly PropertyKey[]): string {
    return path.reduce<string>((text, key) => (typeof key === 'number' ? `${text}[${key}]` : text ? `${text}.${String(key)}` : String(key)), '');
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A parser that upgrades a record from any version in `upgrades` to the
 * current one, then parses it strictly. Schema v1 has nothing to upgrade
 * from yet, so the table starts empty.
 */
function versioned<T>(schema: z.ZodType<T>, upgrades: Record<number, Upgrade> = {}): (value: unknown) => ParseResult<T> {
    return (value) => {
        if (!isObject(value)) return { ok: false, error: { reason: 'invalid', issues: [{ path: '', message: 'expected a JSON object' }] } };
        let current = value;
        while (current.schemaVersion !== CATALOG_SCHEMA_VERSION) {
            const version = current.schemaVersion;
            const upgrade = typeof version === 'number' ? upgrades[version] : undefined;
            if (upgrade) {
                current = upgrade(current);
                continue;
            }
            // Only a newer build writes a higher version. Anything else, such as a missing, 0, or "1", is just wrong.
            if (typeof version === 'number' && Number.isInteger(version) && version > CATALOG_SCHEMA_VERSION) {
                return {
                    ok: false,
                    error: {
                        reason: 'unknown-schema-version',
                        schemaVersion: version,
                        issues: [{ path: 'schemaVersion', message: `schemaVersion ${version} is newer than this build reads` }],
                    },
                };
            }
            const message = version === undefined ? 'schemaVersion is missing' : `schemaVersion must be ${CATALOG_SCHEMA_VERSION}, not ${JSON.stringify(version)}`;
            return { ok: false, error: { reason: 'invalid', issues: [{ path: 'schemaVersion', message }] } };
        }
        const parsed = schema.safeParse(current);
        if (parsed.success) return { ok: true, value: parsed.data };
        return {
            ok: false,
            error: { reason: 'invalid', issues: parsed.error.issues.map((issue) => ({ path: pathOf(issue.path), message: issue.message })) },
        };
    };
}

export const parseRevisionFile = versioned(revisionFileSchema);
export const parseCandidateFile = versioned(candidateFileSchema);
export const parseActivation = versioned(activationSchema);
export const parseActivePointer = versioned(activePointerSchema);

const authoredParsers = {
    site: versioned(authoredSiteSchema),
    series: versioned(authoredSeriesSchema),
    photo: versioned(authoredPhotoSchema),
};

export type AuthoredKind = keyof typeof authoredParsers;

export function parseAuthoredRecord<K extends AuthoredKind>(kind: K, value: unknown): ReturnType<(typeof authoredParsers)[K]> {
    return authoredParsers[kind](value) as ReturnType<(typeof authoredParsers)[K]>;
}

/** `rev_` plus the SHA-256 of the canonical JSON of the schema version and content, so the same content always gets the same ID. */
export function revisionIdOf(content: { site: unknown; series: unknown; photos: unknown }): string {
    const { site, series, photos } = content;
    return `rev_${createHash('sha256').update(canonicalJson({ schemaVersion: CATALOG_SCHEMA_VERSION, site, series, photos })).digest('hex')}`;
}
