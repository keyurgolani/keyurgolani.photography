import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ASSET_REVISION_RE, PHOTO_ID_RE } from '../identity/ids';
import type { IdentityFact, IdentityFactType } from '../identity/types';
import { SERIES_ID_RE } from '../catalog/schema';

/**
 * Curation events: the inbox items #10's facts open. One event per
 * idempotency key, so a fact delivered again, or the same evidence seen in a
 * later pass, updates the same item instead of adding one. What the watcher
 * generates (`derivedFacts`, `suggestions`) stays apart from what the curator
 * decided (`edits`, `decisions`, `status`). Nothing here reaches a public
 * route, and nothing an event holds names an absolute path: source paths are
 * library-relative, as #10's facts carry them.
 */

export const CURATION_SCHEMA_VERSION = 1;

export const EVENT_TYPES = ['new', 'replacement', 'missing', 'reappeared', 'ambiguous', 'processing-failure'] as const;
export type CurationEventType = (typeof EVENT_TYPES)[number];

export const EVENT_STATUSES = ['open', 'deferred', 'dismissed', 'approved', 'failed'] as const;
export type CurationEventStatus = (typeof EVENT_STATUSES)[number];

export const ACTIONS = ['edit', 'approve', 'defer', 'dismiss', 'retry', 'reopen'] as const;
export type CurationAction = (typeof ACTIONS)[number];

/** `evt_` plus 24 hex of the SHA-256 of the event's key. Event folders are named only by this. */
export const EVENT_ID_RE = /^evt_[0-9a-f]{24}$/;
/** `fp_` plus the 64 hex of the source bytes' digest: the source fingerprint, and the subject of an event no photo ID settles. */
export const FINGERPRINT_RE = /^fp_[0-9a-f]{64}$/;

/** How many fact IDs an event keeps, newest last. A fact delivered again is only ever a recent one. */
export const KEPT_FACT_IDS = 20;

/**
 * Which event each of #10's fact types opens. `renamed` opens none: a
 * byte-identical rename keeps its photo ID and changes nothing a visitor
 * sees, and the approved event list has no rename. `metadata-changed` is new
 * bytes for the same photo, which an authored record only takes through an
 * authored edit, so it is a replacement.
 */
export const EVENT_TYPE_FOR_FACT: Record<IdentityFactType, CurationEventType | null> = {
    new: 'new',
    replaced: 'replacement',
    'metadata-changed': 'replacement',
    reappeared: 'reappeared',
    missing: 'missing',
    ambiguous: 'ambiguous',
    'processing-failed': 'processing-failure',
    renamed: null,
};

const photoId = z.string().regex(PHOTO_ID_RE, 'must be a photo ID');
const seriesId = z.string().regex(SERIES_ID_RE, 'must be a series ID');
const timestamp = z.iso.datetime();
const libraryPath = z.string().min(1);

/** #8's `Placement`, as the inbox offers it. */
export const placementSchema = z.union([z.literal('start'), z.literal('end'), z.strictObject({ after: photoId })]);
export type Placement = z.infer<typeof placementSchema>;

const confidence = z.enum(['high', 'medium', 'low']);
const suggestionFields = {
    /** What produced it, such as `rules@<12 hex of rules.json>`. */
    producedBy: z.string().min(1),
    producedAt: timestamp,
    confidence,
    evidence: z.array(z.string()),
};

export const suggestionsSchema = z.strictObject({
    /** A null value is "Leave unassigned". */
    series: z.strictObject({ ...suggestionFields, value: seriesId.nullable() }).nullable(),
    placement: z.strictObject({ ...suggestionFields, value: placementSchema }).nullable(),
});
export type Suggestions = z.infer<typeof suggestionsSchema>;

/** Text the curator typed, or the decorative flag. Generated text never lands here. */
export const descriptionSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('described'), text: z.string().min(1) }),
    z.strictObject({ kind: z.literal('decorative') }),
]);
export type CuratorDescription = z.infer<typeof descriptionSchema>;

/** The curator's edits to the suggestions, kept until approval uses them. A null `seriesId` is "Leave unassigned". */
export const editsSchema = z.strictObject({
    seriesId: seriesId.nullable().optional(),
    placement: placementSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    editedAt: timestamp,
    editedBy: z.string().min(1),
});
export type CuratorEdits = z.infer<typeof editsSchema>;

export const FAILURE_REASONS = ['unsupported-format', 'digest-collision', 'undecodable'] as const;

/** Facts the watcher saw. Curator-only, but never GPS or any other curator-only EXIF, and never an absolute path. */
export const derivedFactsSchema = z.strictObject({
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
export type DerivedFacts = z.infer<typeof derivedFactsSchema>;

/** A working-layer record an action wrote, and the version it wrote. */
const writeSchema = z.strictObject({ record: z.string().min(1), version: z.number().int().positive() });

export const decisionSchema = z.strictObject({
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
});
export type CurationDecision = z.infer<typeof decisionSchema>;

export const curationEventSchema = z.strictObject({
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
    /** Every curator action, oldest first. */
    decisions: z.array(decisionSchema),
    reviewedAt: timestamp.nullable(),
    reviewedBy: z.string().nullable(),
});
export type CurationEvent = z.infer<typeof curationEventSchema>;

export type ParsedEvent = { ok: true; event: CurationEvent } | { ok: false; reason: 'unknown-schema-version' | 'invalid'; issues: string[] };

export function parseEvent(value: unknown): ParsedEvent {
    const schemaVersion = (value as { schemaVersion?: unknown } | null)?.schemaVersion;
    if (typeof schemaVersion === 'number' && Number.isInteger(schemaVersion) && schemaVersion > CURATION_SCHEMA_VERSION) {
        return { ok: false, reason: 'unknown-schema-version', issues: [`schemaVersion ${schemaVersion} is newer than this build reads`] };
    }
    const parsed = curationEventSchema.safeParse(value);
    if (parsed.success) return { ok: true, event: parsed.data };
    return { ok: false, reason: 'invalid', issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.') || '(record)'}: ${issue.message}`) };
}

/** The source fingerprint for an asset revision: `fp_` plus its 64 hex. */
export function fingerprintOf(assetRevision: string): string {
    if (!ASSET_REVISION_RE.test(assetRevision)) throw new TypeError(`${assetRevision} is not an asset revision.`);
    return `fp_${assetRevision.slice('sha256-'.length)}`;
}

/**
 * The idempotency key: the event type, the stable identity (or, without
 * one, the source fingerprint), the candidate asset revision, and the
 * watcher input, which is #10's fact key, stable across passes for the same
 * evidence. An ambiguous event's subject is always the fingerprint, since its
 * identity is the open question.
 */
export function eventKey(type: CurationEventType, fact: Pick<IdentityFact, 'photoId' | 'assetRevision' | 'key'>): string {
    const fingerprint = fingerprintOf(fact.assetRevision);
    const subject = type === 'ambiguous' ? fingerprint : fact.photoId ?? fingerprint;
    return [type, subject, fact.assetRevision, fact.key].join('|');
}

export function eventIdOf(key: string): string {
    return `evt_${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 24)}`;
}

/** Whether an event still needs the curator's judgment. */
export function needsJudgment(event: Pick<CurationEvent, 'status'>): boolean {
    return event.status === 'open' || event.status === 'failed';
}

/** The short photo ID the inbox shows, such as `ph_1a2b3c4d`. */
export function shortPhotoId(id: string | null): string {
    return id === null ? 'no photo ID' : id.slice(0, 11);
}

/** What a failure reason means, without a stack trace or a host path. */
export const FAILURE_TEXT: Record<(typeof FAILURE_REASONS)[number], string> = {
    'unsupported-format': 'The file is not a format the watcher reads.',
    'digest-collision': 'Its bytes digest matches another file of another size, so it was set aside.',
    undecodable: 'The file could not be decoded.',
};
