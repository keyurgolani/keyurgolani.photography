import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ASSET_REVISION_RE, PHOTO_ID_RE, PROFILE_ID_RE } from '../identity/ids';
import type { IdentityFact, IdentityFactType, Registry } from '../identity/types';
import { SERIES_ID_RE } from '../catalog/schema';
import { v1Reads } from './events-v1';

/**
 * Curation events: the inbox items #10's facts open. One event per
 * idempotency key, so a fact delivered again, or the same evidence seen in a
 * later pass, updates the same item instead of adding one. What the watcher
 * generates (`derivedFacts`, `suggestions`) stays apart from what the curator
 * decided (`edits`, `decisions`, `status`). Nothing here reaches a public
 * route, and nothing an event holds names an absolute path: source paths are
 * library-relative, as #10's facts carry them.
 */

/**
 * Version 2 (A5, v2.0.0) adds the resolutions, the `resolve` and
 * `confirm-missing` actions, the restore and resolve fields on a decision,
 * and the comparison and suggestion facts. A build reads every version up to
 * its own. Each version file is stamped with the oldest version that reads
 * it (schemaVersionFor()), so after an image rollback v1.7.x keeps reading
 * every item that holds nothing new, and reads the rest as a newer build's
 * (`unknown-schema-version`) rather than as damaged. It never writes those.
 */
export const CURATION_SCHEMA_VERSION = 2;

export const EVENT_TYPES = ['new', 'replacement', 'missing', 'reappeared', 'ambiguous', 'processing-failure'] as const;
export type CurationEventType = (typeof EVENT_TYPES)[number];

/** `resolved` is #17's: the watcher closed the item because what it reported is over, such as a missing source back again. */
export const EVENT_STATUSES = ['open', 'deferred', 'dismissed', 'approved', 'failed', 'resolved'] as const;
export type CurationEventStatus = (typeof EVENT_STATUSES)[number];

/**
 * `confirm` is #17's "Confirm new asset revision", for a replacement. `bind`
 * and `archive` are #17's "Bind an intentional replacement" and "Archive
 * after removing series references", for a missing source; `bind` also
 * answers an ambiguous item with the photograph its file is (`to`). `close`
 * is the watcher's, when it resolves an item. Version 2 adds `resolve`, the
 * curator's answer to an ambiguous item (`--as new` or `--as replacement-of`)
 * or to a replacement whose file is really another photograph (`--as new`),
 * and `confirm-missing`, the curator's word that a missing source is gone on
 * purpose, which writes the item and nothing else.
 */
export const ACTIONS = ['edit', 'approve', 'defer', 'dismiss', 'retry', 'reopen', 'confirm', 'bind', 'archive', 'close', 'resolve', 'confirm-missing'] as const;
export type CurationAction = (typeof ACTIONS)[number];

/**
 * What the watcher's close says became of an item, recorded on the close
 * from version 2 (A5). `reverted`: a replacement whose source went back to
 * older bytes. `withdrawn`: a missing photograph no revision or series lists.
 * `split`: a replacement whose file became its own photograph, after
 * `resolve --as new`. `restored`: a new photograph whose bytes brought an
 * archived one back under its old ID, after approving it. The closes before
 * version 2 say what they are in their reason only (closeCauseOf()).
 */
export const RESOLUTIONS = ['reverted', 'withdrawn', 'split', 'restored'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

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

/**
 * One side of a replacement's comparison (#17, A5): oriented size, aspect
 * ratio (width over height, to 4 places), orientation by that size, the
 * public tier's capture date, and the source's bytes.
 */
export const comparisonSideSchema = z.strictObject({
    assetRevision: z.string().regex(ASSET_REVISION_RE),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    aspectRatio: z.number().positive().nullable(),
    orientation: z.enum(['landscape', 'portrait', 'square']).nullable(),
    capturedAt: z.iso.date().nullable(),
    bytes: z.number().int().nonnegative(),
});
export type ComparisonSide = z.infer<typeof comparisonSideSchema>;

/** What a replacement's review should look at: the aspect ratio moving over 1%, or the orientation flipping. */
export const COMPARISON_NOTES = ['aspect-ratio', 'orientation'] as const;

/** A replacement's bytes against the revision the photo record pinned when it opened (#17, A5). */
export const comparisonSchema = z.strictObject({
    before: comparisonSideSchema,
    after: comparisonSideSchema,
    notes: z.array(z.enum(COMPARISON_NOTES)),
});
export type Comparison = z.infer<typeof comparisonSchema>;

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
    /** Version 2: a replacement's before and after (A5). */
    comparison: comparisonSchema.optional(),
    /** Version 2: the missing photograph #10 suggests a new file is, by its file name or its capture time (A5). */
    suggestedFor: photoId.optional(),
    suggestedBy: z.enum(['basename', 'capture-time']).optional(),
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
    /** For a confirm: the asset revision the photo record pinned before it, which the event's replaces. For a defer: the one it put back. */
    fromRevision: z.string().regex(ASSET_REVISION_RE).optional(),
    /** For a bind: the library-relative path the #10 `bind` decision gives the photo. */
    path: libraryPath.optional(),
    /** Version 2. For the watcher's close: what became of the item (RESOLUTIONS). */
    resolution: z.enum(RESOLUTIONS).optional(),
    /** Version 2. For a resolve: the curator's answer. */
    resolveAs: z.enum(['new', 'replacement-of']).optional(),
    /** Version 2. For a resolve `--as replacement-of`, or a bind `--to`: the photograph the file is given to. */
    to: photoId.optional(),
    /** Version 2. For an approve: the archived photograph the #10 `restore` decision brings back with these bytes. */
    restores: photoId.optional(),
});
export type CurationDecision = z.infer<typeof decisionSchema>;

/** Why a replacement's derivative set wasn't built: #10's writer's failure, without its text, which may name a host path. */
export const CANDIDATE_FAILURES = ['superseded', 'integrity', 'undecodable', 'build'] as const;
export type CandidateFailure = (typeof CANDIDATE_FAILURES)[number];

/**
 * #17: what became of a replacement's derivative set, once #10's registry
 * says. Absent while the set is still building. `ready` means the set is
 * committed with its manifest, under `profileId`; only then can the
 * replacement be confirmed. A `processing-failure` item for a build that
 * failed carries one too (lib/curation/sources.ts).
 */
export const candidateSchema = z.strictObject({
    state: z.enum(['ready', 'failed']),
    profileId: z.string().regex(PROFILE_ID_RE),
    failure: z.enum(CANDIDATE_FAILURES).optional(),
    /** When the inbox recorded it. */
    at: timestamp,
});
export type Candidate = z.infer<typeof candidateSchema>;

export const curationEventSchema = z.strictObject({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
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

/**
 * The oldest schema version that reads `event` as it is: 1 only when a
 * frozen copy of v1.7.0's schema (lib/curation/events-v1.ts), enum values
 * included, parses it as version 1, else 2. The repository stamps each
 * version file with it, so v1.7.x, after an image rollback, reads what it
 * can, and reads the rest as a newer build's. A new type, status, action,
 * field, or enum value is stamped 2 by itself.
 */
export function schemaVersionFor(event: CurationEvent): 1 | 2 {
    return v1Reads({ ...event, schemaVersion: 1 }) ? 1 : 2;
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

/**
 * Why an open item can't be acted on yet, or null when it can: a
 * replacement whose new bytes have no ready derivative set at `profileId`,
 * which a confirm refuses until the watcher finishes it. A failed build isn't
 * waiting, since retry is the next step.
 */
export function waitingReason(event: Pick<CurationEvent, 'type' | 'status' | 'photoId' | 'assetRevision'>, registry: Registry | null, profileId: string): string | null {
    if (event.type !== 'replacement' || event.status !== 'open' || event.photoId === null || event.assetRevision === null) return null;
    const revision = registry?.photos[event.photoId]?.revisions[event.assetRevision];
    if (!revision) return null;
    const state = revision.profiles[profileId]?.state;
    return state === 'ready' || state === 'failed' ? null : 'its new derivatives are still building';
}

/** Whether placement can settle this item: a new photograph's item, open or deferred, with a photo ID. */
export function settlesByPlacement(event: Pick<CurationEvent, 'type' | 'status' | 'photoId'>): boolean {
    return event.type === 'new' && event.photoId !== null && (event.status === 'open' || event.status === 'deferred');
}

/**
 * Whether the item moved to other bytes after it opened: the sink's
 * foldIntoNew() moves an open new item when its photo has no photo record.
 * Its key, from eventKey(), still names the asset revision it opened at.
 */
export function movedSinceOpened(event: Pick<CurationEvent, 'key' | 'assetRevision'>): boolean {
    return event.key.split('|')[2] !== event.assetRevision;
}

/**
 * Whether a new photograph's item is settled because its photo is already
 * placed: `placement` is its entry in lib/curation/placement.ts's index,
 * the active revision or a working-layer series. `sequence set` and `insert`
 * place photos without the inbox, and a published photo needs no judgment.
 * The item counts as settled only while something holds the photo, and
 * nothing writes that to it, so removing the photo from its series, or a
 * rollback that takes it out, puts the item back as it was, and the sink's
 * and approve's rules see the item they always did. A holder settles it only
 * when it pins the item's bytes, or when the item never moved: new bytes for
 * a photo placed without a photo record move the item, and those need
 * judgment. A missing, replacement, or other item stays open whatever holds
 * the photo.
 */
export function settledByPlacement(event: Pick<CurationEvent, 'type' | 'status' | 'photoId' | 'key' | 'assetRevision'>, placement: { holders: readonly string[]; assetRevisions: ReadonlySet<string> }): boolean {
    if (!settlesByPlacement(event) || placement.holders.length === 0) return false;
    return (event.assetRevision !== null && placement.assetRevisions.has(event.assetRevision)) || !movedSinceOpened(event);
}

/**
 * The series an approved new photograph's item placed it in, when nothing
 * holds the photo now (`holders`, from lib/curation/placement.ts's index),
 * or null. A rollback rebases the working layer onto its target, so a
 * series' photo list goes back to the target's, a placement the rolled-away
 * revision published goes with it, and the item still reads `approved`. The
 * photo record stays in the draft, unassigned. Nothing writes that to the
 * item, so the rollback stays a pointer move and a rebase: list and show
 * say it, and reopening the item and approving it with `--series` places
 * the photo again. A `sequence remove` reads the same way. A series only
 * the rolled-away revision published goes hidden and keeps its photos, so
 * its approvals still have a holder and aren't flagged. Only the last
 * approval counts: one that left the photo unassigned flags nothing.
 */
export function unplacedApproval(event: Pick<CurationEvent, 'type' | 'status' | 'photoId' | 'decisions'>, holders: readonly string[]): string | null {
    if (event.type !== 'new' || event.status !== 'approved' || event.photoId === null || holders.length > 0) return null;
    const approvals = event.decisions.filter((decision) => decision.action === 'approve');
    return approvals[approvals.length - 1]?.seriesId ?? null;
}

/**
 * Whether an event still needs the curator's judgment. An item that is
 * waiting (waitingReason()) doesn't, yet, and neither does one settled by
 * placement (settledByPlacement(), through placedItems() in
 * lib/curation/placement.ts). Both are required, so every view of the inbox
 * counts the same way.
 */
export function needsJudgment(event: Pick<CurationEvent, 'status'>, waiting: string | null, settled: boolean): boolean {
    return (event.status === 'open' || event.status === 'failed') && waiting === null && !settled;
}

/** The short photo ID the inbox shows, such as `ph_1a2b3c4d`. */
export function shortPhotoId(id: string | null): string {
    return id === null ? 'no photo ID' : id.slice(0, 11);
}

/** What a failure reason means, without a stack trace or a host path. */
export const FAILURE_TEXT: Record<(typeof FAILURE_REASONS)[number], string> = {
    'unsupported-format': 'The file is not a format the watcher reads.',
    'digest-collision': "Another file in the library looks like the same photograph but isn't the same size, so the watcher set this one aside.",
    undecodable: 'The file could not be decoded.',
};

/**
 * #17: the reasons the watcher's `close` writes on an item (lib/curation/sources.ts), kept here with closeCauseOf(),
 * which reads them back for the inbox page, so the two can't drift apart.
 */
export const CLOSE_REASONS = {
    back: (where: string, same: boolean) =>
        same ? `The source is back ${where} with the same bytes, so nothing changed.` : `The source is back ${where} with other bytes, which its replacement item reviews.`,
    merged: (into: string) => `A bind gave these bytes to ${into}, whose replacement item reviews them.`,
    archived: 'The photograph is archived.',
    built: (profileId: string) => `Its derivative set built under ${profileId}.`,
    gone: 'The registry no longer holds the photograph.',
    moved: "The source holds other bytes now, which the photograph's newer items cover.",
    /** #14: an ambiguous item whose bytes #10 holds in doubt no more, because a present photograph has them. */
    identified: (photoId: string) => `These bytes are ${photoId}'s now, so nothing is in doubt.`,
    /** #14: an ambiguous item whose hold ended with no photograph present on its bytes: the file changed or left. */
    unheld: 'The file changed or left the library, so nothing is in doubt.',
    /** #17: a replacement whose derivative set the writer refused because the source moved on to newer bytes. */
    superseded: 'The source changed again before this derivative set was built, so the newer replacement item is the one to review.',
    /** A5 (#14): a replacement whose source went back to older bytes, so these are no longer the file's. */
    reverted: 'The source went back to an earlier version, so these bytes are no longer the file.',
    /** A5 (#17): a missing photograph that no catalog revision and no draft series lists. */
    withdrawn: 'No catalog revision or draft series lists the photograph, so its file going missing takes nothing down.',
    /** A5 (#17): a replacement whose file `curation resolve --as new` made its own photograph. */
    split: (photoId: string) => `The file is its own photograph now, ${photoId}, whose new item reviews it.`,
    /** A5 (#17): a new photograph whose bytes brought back an archived one under its old ID, after approving it. */
    restored: (photoId: string) => `These bytes brought back the archived photograph ${photoId} under its old ID.`,
} as const;

/**
 * The watcher's reopen reasons for the items CLOSE_REASONS' `identified`, `unheld`, `superseded` and a replacement's
 * `moved` and `reverted` closed (lib/curation/sink.ts), and for a new photograph's item `archived` closed, once a
 * restore brings the photograph back (lib/curation/sources.ts).
 */
export const REOPEN_REASONS = {
    held: '#10 holds this file in doubt again.',
    back: 'The source holds these bytes again.',
    restored: 'The photograph is restored under its old ID, so it can be placed again.',
} as const;

/** The watcher's close that settled a resolved item, with its cause, or null. */
export function watcherCloseOf(event: Pick<CurationEvent, 'status' | 'decisions'>): { decision: CurationDecision; cause: CloseCause | null } | null {
    if (event.status !== 'resolved') return null;
    const decision = event.decisions.at(-1);
    if (decision?.action !== 'close' || decision.by !== 'watcher' || decision.reason === undefined) return null;
    return { decision, cause: decision.resolution ?? closeCauseOf(decision.reason) };
}

export type CloseCause = 'same-file' | 'other-bytes' | 'merged' | 'archived' | 'built' | 'gone' | 'moved' | 'identified' | 'unheld' | 'superseded' | Resolution;

/** Which of CLOSE_REASONS a watcher's close reason is, or null for any other text. */
export function closeCauseOf(reason: string): CloseCause | null {
    if (reason === CLOSE_REASONS.reverted) return 'reverted';
    if (reason === CLOSE_REASONS.withdrawn) return 'withdrawn';
    if (/^The file is its own photograph now, .+, whose new item reviews it\.$/.test(reason)) return 'split';
    if (/^These bytes brought back the archived photograph .+ under its old ID\.$/.test(reason)) return 'restored';
    if (reason === CLOSE_REASONS.archived) return 'archived';
    if (reason === CLOSE_REASONS.gone) return 'gone';
    if (reason === CLOSE_REASONS.moved) return 'moved';
    if (reason === CLOSE_REASONS.unheld) return 'unheld';
    if (reason === CLOSE_REASONS.superseded) return 'superseded';
    if (/^These bytes are .+'s now, so nothing is in doubt\.$/.test(reason)) return 'identified';
    const back = /^The source is back .+ with (the same|other) bytes, /.exec(reason);
    if (back) return back[1] === 'the same' ? 'same-file' : 'other-bytes';
    if (reason.startsWith('A bind gave these bytes to ')) return 'merged';
    if (reason.startsWith('Its derivative set built under ')) return 'built';
    return null;
}

/**
 * #17: the reason 14-1's sink writes when it dismisses a missing item because the same bytes came back at the
 * photograph's own path (lib/curation/sink.ts closeMissing()), kept here with backAtItsPath(), which reads it back.
 */
export const SAME_BYTES_BACK = (where: string) => `The same bytes came back at ${where}, so nothing is missing.`;

/**
 * #17: a missing item the watcher dismissed because its source came back at its own path with the same bytes. Like a
 * resolved missing item, it would read as missing and unresolved if the page reopened it.
 */
export function backAtItsPath(event: Pick<CurationEvent, 'type' | 'status' | 'decisions'>): boolean {
    if (event.type !== 'missing' || event.status !== 'dismissed') return false;
    const dismiss = event.decisions.findLast((decision) => decision.action === 'dismiss');
    return dismiss?.by === 'watcher' && dismiss.reason !== undefined && /^The same bytes came back at .+, so nothing is missing\.$/.test(dismiss.reason);
}
