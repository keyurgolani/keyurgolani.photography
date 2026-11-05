import { z } from 'zod';

/**
 * FROZEN. Never change this file: v1.7.0's curation event schema (lib/curation/events.ts at 0de8ab31), enum values
 * and patterns included, copied as it shipped, so schemaVersionFor() stamps an item 1 only when v1.7.x, after an
 * image rollback, would read it. Anything this doesn't parse is stamped 2, which v1.7.x reads as a newer build's.
 * A test pins this file's hash. To read a new value, change lib/curation/events.ts, never this copy.
 */

// lib/identity/ids.ts and lib/catalog/schema.ts at 0de8ab31.
const PHOTO_ID_RE = /^ph_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ASSET_REVISION_RE = /^sha256-[0-9a-f]{64}$/;
const PROFILE_ID_RE = /^p_[0-9a-f]{16}$/;
const SERIES_ID_RE = /^ser_[a-z0-9][a-z0-9_-]{1,62}$/;

const CURATION_SCHEMA_VERSION = 1;
const EVENT_TYPES = ['new', 'replacement', 'missing', 'reappeared', 'ambiguous', 'processing-failure'] as const;
const EVENT_STATUSES = ['open', 'deferred', 'dismissed', 'approved', 'failed', 'resolved'] as const;
const ACTIONS = ['edit', 'approve', 'defer', 'dismiss', 'retry', 'reopen', 'confirm', 'bind', 'archive', 'close'] as const;
const EVENT_ID_RE = /^evt_[0-9a-f]{24}$/;
const FINGERPRINT_RE = /^fp_[0-9a-f]{64}$/;

const photoId = z.string().regex(PHOTO_ID_RE, 'must be a photo ID');
const seriesId = z.string().regex(SERIES_ID_RE, 'must be a series ID');
const timestamp = z.iso.datetime();
const libraryPath = z.string().min(1);

/** #8's `Placement`, as the inbox offers it. */
const placementSchema = z.union([z.literal('start'), z.literal('end'), z.strictObject({ after: photoId })]);

const confidence = z.enum(['high', 'medium', 'low']);
const suggestionFields = {
    /** What produced it, such as `rules@<12 hex of rules.json>`. */
    producedBy: z.string().min(1),
    producedAt: timestamp,
    confidence,
    evidence: z.array(z.string()),
};

const suggestionsSchema = z.strictObject({
    /** A null value is "Leave unassigned". */
    series: z.strictObject({ ...suggestionFields, value: seriesId.nullable() }).nullable(),
    placement: z.strictObject({ ...suggestionFields, value: placementSchema }).nullable(),
});

/** Text the curator typed, or the decorative flag. Generated text never lands here. */
const descriptionSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('described'), text: z.string().min(1) }),
    z.strictObject({ kind: z.literal('decorative') }),
]);

/** The curator's edits to the suggestions, kept until approval uses them. A null `seriesId` is "Leave unassigned". */
const editsSchema = z.strictObject({
    seriesId: seriesId.nullable().optional(),
    placement: placementSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    editedAt: timestamp,
    editedBy: z.string().min(1),
});

const FAILURE_REASONS = ['unsupported-format', 'digest-collision', 'undecodable'] as const;

/** Facts the watcher saw. Curator-only, but never GPS or any other curator-only EXIF, and never an absolute path. */
const derivedFactsSchema = z.strictObject({
    factType: z.enum(['new', 'renamed', 'reappeared', 'replaced', 'metadata-changed', 'ambiguous', 'missing', 'processing-failed']),
    sourcePath: libraryPath,
    /** The source's library-relative folder, '' at the root. */
    folder: z.string(),
    fromPath: libraryPath.optional(),
    candidates: z.array(photoId).optional(),
    duplicateOf: photoId.optional(),
    samePathAs: photoId.optional(),
    revert: z.boolean().optional(),
    failure: z.enum(FAILURE_REASONS).optional(),
    /** The EXIF capture date, `YYYY-MM-DD`, from #10's public tier. */
    capturedDate: z.iso.date().nullable().optional(),
    width: z.number().int().positive().nullable().optional(),
    height: z.number().int().positive().nullable().optional(),
    sourceFormat: z.string().optional(),
});

/** A working-layer record an action wrote, and the version it wrote. */
const writeSchema = z.strictObject({ record: z.string().min(1), version: z.number().int().positive() });

const decisionSchema = z.strictObject({
    action: z.enum(ACTIONS),
    at: timestamp,
    by: z.string().min(1),
    /** The active revision the action was taken against, null before the first publish. */
    baseRevisionId: z.string().nullable(),
    reason: z.string().optional(),
    seriesId: seriesId.nullable().optional(),
    placement: placementSchema.optional(),
    writes: z.array(writeSchema).optional(),
    /** The #10 identity decision a retry wrote. */
    identityDecisionId: z.string().optional(),
    /** For a confirm: the asset revision the photo record pinned before it, which the event's replaces. For a defer: the one it put back. */
    fromRevision: z.string().regex(ASSET_REVISION_RE).optional(),
    /** For a bind: the library-relative path the #10 `bind` decision gives the photo. */
    path: libraryPath.optional(),
});

/** Why a replacement's derivative set wasn't built: #10's writer's failure, without its text, which may name a host path. */
const CANDIDATE_FAILURES = ['superseded', 'integrity', 'undecodable', 'build'] as const;

/**
 * #17: what became of a replacement's derivative set, once #10's registry
 * says. Absent while the set is still building. `ready` means the set is
 * committed with its manifest, under `profileId`; only then can the
 * replacement be confirmed. A `processing-failure` item for a build that
 * failed carries one too (lib/curation/sources.ts).
 */
const candidateSchema = z.strictObject({
    state: z.enum(['ready', 'failed']),
    profileId: z.string().regex(PROFILE_ID_RE),
    failure: z.enum(CANDIDATE_FAILURES).optional(),
    /** When the inbox recorded it. */
    at: timestamp,
});

const curationEventSchema = z.strictObject({
    schemaVersion: z.literal(CURATION_SCHEMA_VERSION),
    /** Compare-and-swap counter: the version file it was read from. */
    version: z.number().int().positive(),
    id: z.string().regex(EVENT_ID_RE),
    key: z.string().min(1),
    type: z.enum(EVENT_TYPES),
    photoId: photoId.nullable(),
    sourceFingerprint: z.string().regex(FINGERPRINT_RE),
    assetRevision: z.string().regex(ASSET_REVISION_RE).nullable(),
    /** When the first fact for it was observed. */
    observedAt: timestamp,
    /** When the latest fact folded into it was observed. */
    lastObservedAt: timestamp,
    factIds: z.array(z.string().min(1)),
    status: z.enum(EVENT_STATUSES),
    derivedFacts: derivedFactsSchema,
    suggestions: suggestionsSchema,
    edits: editsSchema.nullable(),
    /** A replacement's derivative set, once it is ready or failed, or a failed build's (#17). Other types never have one. */
    candidate: candidateSchema.optional(),
    /** Every curator action, oldest first. */
    decisions: z.array(decisionSchema),
    reviewedAt: timestamp.nullable(),
    reviewedBy: z.string().nullable(),
});

/** Whether v1.7.0's schema reads `value` as a version 1 event. */
export function v1Reads(value: unknown): boolean {
    return curationEventSchema.safeParse(value).success;
}
