import { createHash } from 'node:crypto';
import { canonicalJson } from '../storage/canonical';
import { authoredPhotoSchema, authoredSeriesSchema, authoredSiteSchema, type AuthoredKind } from './schema';
import type { AuthoredPhoto, AuthoredRecord, AuthoredSeries, AuthoredSite, FieldReview, IssueRecord, ReviewStamp, RevisionContent, WorkingLayer } from './types';

/**
 * #16's review state for authored fields, without I/O. The writer stamps
 * each field a write changes (stampWrite()), a rebase keeps only the stamps
 * of fields it left alone (rebaseStamps()), and fieldReview() reads a stamp
 * back as reviewed, unreviewed, or stale.
 *
 * A stamp stores what the approved rule needs: the active revision the value
 * was reviewed against, the asset revision it was reviewed with, and the
 * inbox item it settled. A reviewed value goes stale only when one of those
 * inputs changed in a way that touches it:
 *
 * - the active revision moved, and this field's published value differs
 *   between the revision it was reviewed against and the active one;
 * - a photo field that describes the image (alt, title, caption, focal
 *   point, crop, accent), or a series cover, was reviewed with another asset
 *   revision than the one the record (or the cover photo's record) pins now;
 * - the inbox item it settled is open again, or a newer replacement item for
 *   the same photo was observed after the review and still waits for the
 *   curator.
 *
 * Backfill: a record no tool has written since stamps were added carries no
 * `review`. It reads as stamped by `migration` (backfillFields()): every
 * field reviewed against the record's own base and pinned asset revision,
 * except a described alt with `reviewed: false`, which a #14 suggestion
 * leaves and which stays generated. The writer stores those stamps for the
 * fields its first write of the record leaves alone, so the backfill happens
 * once per record, and nothing writes for it otherwise.
 */

export type ReviewOrigin = FieldReview['origin'];

/** The fields a stamp can cover: every authored field but the managed ones, `kind`, and `id`. */
const NOT_STAMPED = new Set(['schemaVersion', 'version', 'baseRevisionId', 'baseSeriesOrder', 'conflicts', 'review', 'kind', 'id']);
const fieldsOf = (shape: Record<string, unknown>) => Object.keys(shape).filter((key) => !NOT_STAMPED.has(key)).sort();
export const STAMPED_FIELDS: Record<AuthoredKind, readonly string[]> = {
    site: fieldsOf(authoredSiteSchema.shape),
    series: fieldsOf(authoredSeriesSchema.shape),
    photo: fieldsOf(authoredPhotoSchema.shape),
};

/** Photo fields that describe the image, so a review of them goes stale when the record pins other bytes. */
export const ASSET_DEPENDENT_FIELDS: readonly string[] = ['alt', 'title', 'caption', 'focalPoint', 'crop', 'accent'];

/**
 * The time a backfill stamp read in memory carries. A stored one carries the
 * time of the write that stored it. Only the inbox check compares it, and a
 * backfill stamp names no inbox item.
 */
const BACKFILL_AT = '1970-01-01T00:00:00.000Z';

export function hashValue(value: unknown): string {
    return createHash('sha256').update(canonicalJson(value ?? null)).digest('hex');
}

const valueOf = (record: AuthoredRecord, field: string): unknown => (record as unknown as Record<string, unknown>)[field];

/** A described alt nobody has reviewed: #13's `alt.reviewed: false`, as a #14 suggestion leaves it. */
function generatedAlt(field: string, value: unknown): boolean {
    const alt = value as AuthoredPhoto['alt'] | undefined;
    return field === 'alt' && alt != null && alt.kind === 'described' && !alt.reviewed;
}

/** The stamps a record without `review` reads as. `coverAsset` is the cover photo's pinned revision, for a series. */
export function backfillFields(record: AuthoredRecord, coverAsset?: string | null, at: string = BACKFILL_AT): Record<string, FieldReview> {
    const fields: Record<string, FieldReview> = {};
    for (const field of STAMPED_FIELDS[record.kind]) {
        const value = valueOf(record, field);
        if (value === undefined) continue;
        fields[field] = {
            valueHash: hashValue(value),
            origin: generatedAlt(field, value) ? 'generated' : 'migration',
            baseRevisionId: record.baseRevisionId,
            ...assetFor(record, field, coverAsset),
            actor: 'migration',
            reviewedAt: at,
        };
    }
    return fields;
}

function assetFor(record: AuthoredRecord, field: string, coverAsset: string | null | undefined): { assetRevision?: string } {
    if (record.kind === 'photo') return { assetRevision: record.assetRevision };
    if (record.kind === 'series' && field === 'cover' && coverAsset) return { assetRevision: coverAsset };
    return {};
}

/** A record's stamps: its own, or the backfill's when it has none, dated `at` when given. */
export function stampsOf(record: AuthoredRecord, coverAsset?: string | null, at?: string): Record<string, FieldReview> {
    return record.review?.fields ?? backfillFields(record, coverAsset, at);
}

/** What a write was reviewed with. The writer fills in what a caller leaves out. */
export interface StampInputs {
    baseRevisionId: string | null;
    /** `generated` for a write nobody reviewed, such as #14's auto-include policy. Defaults to curator. */
    origin?: 'curator' | 'generated';
    event?: { id: string; version: number };
    asset?: { from: string; to: string; profileId: string };
    actor: string;
    reviewedAt: string;
}

/**
 * The stamps a written record carries. A field the write changed is stamped
 * with `inputs`, a described alt with `reviewed: false` as generated. A field
 * it left alone keeps the stamp it had, or the backfill's for a record
 * written before stamps, so a write never reviews what it didn't touch.
 * `coverAsset` is the pinned revision of the cover photo `next` names, and
 * `existingCoverAsset` that of the one `existing` names.
 */
export function stampWrite(
    existing: AuthoredRecord | null,
    next: AuthoredRecord,
    inputs: StampInputs,
    covers: { next?: string | null; existing?: string | null } = {},
): ReviewStamp {
    const prior = existing ? stampsOf(existing, covers.existing, inputs.reviewedAt) : {};
    const fields: Record<string, FieldReview> = {};
    for (const field of STAMPED_FIELDS[next.kind]) {
        const value = valueOf(next, field);
        const hash = hashValue(value);
        const before = existing ? valueOf(existing, field) : undefined;
        if (hashValue(before) === hash) {
            if (prior[field]) fields[field] = prior[field];
            continue;
        }
        fields[field] = {
            valueHash: hash,
            origin: inputs.origin === 'generated' || generatedAlt(field, value) ? 'generated' : 'curator',
            baseRevisionId: inputs.baseRevisionId,
            ...assetFor(next, field, covers.next),
            ...(inputs.event ? { event: { id: inputs.event.id, version: inputs.event.version } } : {}),
            ...(field === 'assetRevision' && inputs.asset ? { asset: { ...inputs.asset } } : {}),
            actor: inputs.actor,
            reviewedAt: inputs.reviewedAt,
        };
    }
    return { fields };
}

/**
 * The stamps a rebased record keeps: those of the fields the rebase left as
 * they were, the backfill's for a record written before stamps. A field it
 * moved to the target's value now holds what was published, not what anyone
 * reviewed here, so its stamp goes. So a rollback that puts a field back on
 * a value a review once stamped never revives that review.
 *
 * `publishedFrom`: the target was published from this working layer, so
 * whatever it changed for visitors came from the curator's own drafts, and
 * every kept stamp moves its base to it. A rollback's target wasn't, so its
 * stamps keep the base they were reviewed against, and a field the rollback
 * publishes differently from that base reads as stale.
 */
export function rebaseStamps(existing: AuthoredRecord | null, next: AuthoredRecord, existingCover: string | null, at: string, publishedFrom?: string): ReviewStamp | undefined {
    if (!existing) return undefined;
    const fields: Record<string, FieldReview> = {};
    for (const [field, stamp] of Object.entries(stampsOf(existing, existingCover, at))) {
        if (hashValue(valueOf(existing, field)) !== hashValue(valueOf(next, field))) continue;
        fields[field] = publishedFrom === undefined ? stamp : { ...stamp, baseRevisionId: publishedFrom };
    }
    return { fields };
}

// Reading a stamp back.

/** An inbox item, as much of it as staleness reads. */
export interface InboxItem {
    id: string;
    type: string;
    photoId: string | null;
    status: string;
    lastObservedAt: string;
}

/** What review state needs beyond the working layer and the active revision. publish and validate read it with readReviewContext(). */
export interface ReviewContext {
    /** The revisions stamps were reviewed against, by ID, besides the active one. A missing one reads as unreadable. */
    bases: ReadonlyMap<string, RevisionContent>;
    /** Every readable inbox item, by ID. */
    inbox: ReadonlyMap<string, InboxItem>;
    /** Inbox items whose files can't be read. */
    unreadable: ReadonlySet<string>;
}

export type FieldReviewReason =
    | 'no-record'
    | 'no-stamp'
    | 'edited'
    | 'generated'
    | 'active-moved'
    | 'base-unreadable'
    | 'asset-replaced'
    | 'cover-replaced'
    | 'item-reopened'
    | 'newer-item'
    | 'item-unreadable'
    | 'inbox-unread';

/** One authored field a change depends on. `field` is '' for the record itself. */
export interface FieldRef {
    record: IssueRecord;
    field: string;
}

export interface FieldReviewState extends FieldRef {
    state: 'reviewed' | 'unreviewed' | 'stale';
    reason?: FieldReviewReason;
    /** What the reason says, for the CLI and the Publish screen. */
    detail?: string;
    origin?: ReviewOrigin;
    by?: string;
    at?: string;
    /** For `newer-item` and `item-reopened`: the inbox item. */
    eventId?: string;
}

export interface ReviewEnv {
    layer: WorkingLayer;
    active: { revisionId: string; content: RevisionContent } | null;
    /** Absent: the inbox wasn't read, so a stamp that settled an inbox item can't be checked and reads as stale. */
    review?: ReviewContext;
}

const EMPTY: RevisionContent = { site: { featuredSeriesIds: [] }, series: [], photos: [] };
const NEEDS_JUDGMENT = new Set(['open', 'failed']);

/** A field's published value in a revision, null when it doesn't publish it. */
export function publishedValue(content: RevisionContent, ref: FieldRef): unknown {
    const { record, field } = ref;
    if (record.kind === 'site') return field === 'seriesOrder' ? content.series.map((series) => series.id) : (content.site as Record<string, unknown>)[field] ?? null;
    if (record.kind === 'series') {
        const series = content.series.find((entry) => entry.id === record.id);
        if (field === 'visibility') return series ? 'published' : null;
        return series ? (series as unknown as Record<string, unknown>)[field] ?? null : null;
    }
    const photo = content.photos.find((entry) => entry.id === record.id);
    return photo ? (photo as unknown as Record<string, unknown>)[field] ?? null : null;
}

export function recordOf(layer: WorkingLayer, ref: IssueRecord): AuthoredRecord | null {
    if (ref.kind === 'site') return layer.site;
    if (ref.kind === 'series') return layer.series.find((series) => series.id === ref.id) ?? null;
    return layer.photos.find((photo) => photo.id === ref.id) ?? null;
}

/** The revision a series' cover photo record pins, or null. */
export function coverAssetOf(layer: WorkingLayer, series: AuthoredSeries | AuthoredSite | AuthoredPhoto): string | null {
    if (series.kind !== 'series' || series.cover === null) return null;
    const photoId = series.cover.photoId;
    return layer.photos.find((photo) => photo.id === photoId)?.assetRevision ?? null;
}

const short = (id: string | null) => (id === null ? 'none' : id.slice(0, 12));

/** Whether a reviewed field is still reviewed, and why not. Pure. */
export function fieldReview(ref: FieldRef, env: ReviewEnv): FieldReviewState {
    const record = recordOf(env.layer, ref.record);
    if (record === null) {
        return { ...ref, state: 'unreviewed', reason: 'no-record', detail: `The ${ref.record.kind} record ${ref.record.id} is gone from the working layer, which no tool does, so nothing on record reviewed the change.` };
    }
    const value = valueOf(record, ref.field);
    const stamp = stampsOf(record, coverAssetOf(env.layer, record))[ref.field];
    if (!stamp) return { ...ref, state: 'unreviewed', reason: 'no-stamp', detail: `${ref.field} was written outside the tools, so nothing on record reviewed it.` };
    const seen = { origin: stamp.origin, by: stamp.actor, at: stamp.reviewedAt };
    if (stamp.valueHash !== hashValue(value)) {
        return { ...ref, ...seen, state: 'unreviewed', reason: 'edited', detail: `${ref.field} changed outside the tools since it was last reviewed.` };
    }
    if (stamp.origin === 'generated') return { ...ref, ...seen, state: 'unreviewed', reason: 'generated', detail: `${ref.field} is a suggestion nobody has reviewed yet.` };

    // The active revision moved: stale when this field's published value differs between what it was reviewed against and what's active.
    const activeId = env.active?.revisionId ?? null;
    if (stamp.baseRevisionId !== activeId) {
        const base = stamp.baseRevisionId === null ? EMPTY : env.review?.bases.get(stamp.baseRevisionId);
        if (base === undefined) {
            return { ...ref, ...seen, state: 'stale', reason: 'base-unreadable', detail: `It was reviewed against ${short(stamp.baseRevisionId)}, whose revision file can't be read, so nothing shows whether the active revision changed it since.` };
        }
        if (hashValue(publishedValue(base, ref)) !== hashValue(publishedValue(env.active?.content ?? EMPTY, ref))) {
            return { ...ref, ...seen, state: 'stale', reason: 'active-moved', detail: `It was reviewed against ${short(stamp.baseRevisionId)}, and the active revision ${short(activeId)} publishes ${ref.field} differently.` };
        }
    }

    // The bytes it describes changed.
    if (record.kind === 'photo' && ASSET_DEPENDENT_FIELDS.includes(ref.field) && stamp.assetRevision !== undefined && stamp.assetRevision !== record.assetRevision) {
        return { ...ref, ...seen, state: 'stale', reason: 'asset-replaced', detail: `It was reviewed with ${stamp.assetRevision}, and the photo record pins ${record.assetRevision} now.` };
    }
    if (record.kind === 'series' && ref.field === 'cover' && stamp.assetRevision !== undefined) {
        const now = coverAssetOf(env.layer, record);
        if (now !== null && now !== stamp.assetRevision) {
            return { ...ref, ...seen, state: 'stale', reason: 'cover-replaced', detail: `The cover was reviewed with ${stamp.assetRevision}, and its photo record pins ${now} now.` };
        }
    }

    // The inbox item it settled.
    if (stamp.event) {
        const { id } = stamp.event;
        if (!env.review) return { ...ref, ...seen, state: 'stale', reason: 'inbox-unread', detail: `It settled the inbox item ${id}, and the inbox wasn't read, so nothing shows whether that item changed since.` };
        if (env.review.unreadable.has(id)) return { ...ref, ...seen, state: 'stale', reason: 'item-unreadable', eventId: id, detail: `It settled the inbox item ${id}, which can't be read now.` };
        const item = env.review.inbox.get(id);
        if (!item) return { ...ref, ...seen, state: 'stale', reason: 'item-unreadable', eventId: id, detail: `It settled the inbox item ${id}, which is gone.` };
        if (NEEDS_JUDGMENT.has(item.status)) return { ...ref, ...seen, state: 'stale', reason: 'item-reopened', eventId: id, detail: `It settled the inbox item ${id}, which is ${item.status} again.` };
        if (item.photoId !== null) {
            const newer = [...env.review.inbox.values()]
                .filter((other) => other.id !== id && other.type === 'replacement' && other.photoId === item.photoId && NEEDS_JUDGMENT.has(other.status) && other.lastObservedAt > stamp.reviewedAt)
                .sort((a, b) => (a.lastObservedAt < b.lastObservedAt ? -1 : a.lastObservedAt > b.lastObservedAt ? 1 : a.id < b.id ? -1 : 1));
            if (newer.length > 0) {
                const latest = newer[newer.length - 1];
                return { ...ref, ...seen, state: 'stale', reason: 'newer-item', eventId: latest.id, detail: `It settled ${id}, and ${item.photoId}'s source changed again after that review: the replacement item ${latest.id} still waits for the curator.` };
            }
        }
    }
    return { ...ref, ...seen, state: 'reviewed' };
}
