import type { CatalogChange } from './diff';
import { ASSET_DEPENDENT_FIELDS, coverAssetOf, hashValue, inboxReviewOf, publishedValue, recordOf, stampsOf, type FieldReviewState, type PublishedIndex, type ReviewBackfill, type ReviewContext } from './review';
import { INBOX_REASONS, inConflict } from './review-reasons';
import type { AuthoredKind } from './schema';
import type { AuthoredRecord, IssueRecord, RevisionContent, WorkingLayer } from './types';

/**
 * A9's "Use the published value" (#182), the rules: which rows offer it and
 * what it writes. Pure, so the Publish screen's view (publish-view.ts) and
 * `photos review --use-published` (ledger-cli.ts) offer exactly what the one
 * writer, use-published.ts, accepts, and the view never reaches the writer
 * or its locks.
 *
 * It's offered where the refined spec puts it: a field whose review went
 * stale because the live revision publishes it differently from the one it
 * was reviewed against (the first staleness rule, `active-moved`, or
 * `base-unreadable` when that revision can't be read), and a field a
 * restore's rebase left in conflict. Never while an Inbox item the field
 * rests on needs a decision, which the Inbox settles first.
 */

/**
 * The fields it can put back, by record kind: those whose published value
 * is the authored one, or maps to it without a guess. Left out on purpose:
 * a series' address and former addresses (#5's alias rules decide those),
 * its visibility and the Work order (the draft may hold drafts and hidden
 * series there), a photograph's bytes (only #17's confirm moves them) and
 * its capture date (published from #10's read when not overridden).
 */
export const USE_PUBLISHED_FIELDS: Record<AuthoredKind, readonly string[]> = {
    photo: ['alt', 'title', 'caption', 'credit', 'location', 'focalPoint', 'crop', 'accent'],
    series: ['title', 'statement', 'shortStatement', 'cover', 'chapters', 'openingPhotoId', 'accent', 'photoIds'],
    site: ['featuredSeriesIds'],
};

/** The staleness reasons it clears: the live revision moved past the review. */
export const USE_PUBLISHED_REASONS: ReadonlySet<string> = new Set(['active-moved', 'base-unreadable']);

export const canUsePublished = (kind: AuthoredKind, field: string): boolean => USE_PUBLISHED_FIELDS[kind].includes(field);

/** What the writer writes: `value` undefined takes the field away, as the published record doesn't carry it. */
export type FromPublished = { ok: true; value: unknown } | { ok: false; why: string };

const sameMembers = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/**
 * The authored value for `field` of `record` from its published value (null
 * when the live revision doesn't carry it). A published description is the
 * one the owner reviewed, so it comes back reviewed; a photograph named by
 * its place has no description to put back. An order comes back only when
 * the draft holds the same photographs, since a published list without a
 * newly placed one would take it off the series.
 */
export function authoredFromPublished(record: AuthoredRecord, field: string, published: unknown): FromPublished {
    if (!canUsePublished(record.kind, field)) return { ok: false, why: `Use the published value doesn't cover the ${field} of a ${record.kind}. Change it with photos edit.` };
    if (record.kind === 'photo' && field === 'alt') {
        const alt = published as { kind?: string; text?: string } | null;
        if (alt?.kind === 'described' && typeof alt.text === 'string') return { ok: true, value: { kind: 'described', text: alt.text, reviewed: true } };
        if (alt?.kind === 'decorative') return { ok: true, value: { kind: 'decorative' } };
        return { ok: false, why: 'The live revision names this photograph by its place, so there is no published description to put back.' };
    }
    // A9 review: what the series points at must be one of its own photographs in the draft.
    if (record.kind === 'series' && published !== null && published !== undefined) {
        const missing = referencedPhotos(field, published).find((photoId) => !record.photoIds.includes(photoId));
        if (missing !== undefined) {
            return { ok: false, why: `The published ${field === 'openingPhotoId' ? 'opening photograph' : field} ${field === 'chapters' ? 'start at' : 'is'} ${missing}, which this series doesn't hold in the draft, so putting it back would point at a photograph that isn't there. Put the photograph back first, or change it with photos sequence.` };
        }
    }
    if (record.kind === 'series' && field === 'photoIds') {
        if (!Array.isArray(published) || !sameMembers(published as string[], record.photoIds)) {
            return { ok: false, why: 'The draft holds other photographs in this series than the live revision does, so putting back the published order would add or take some away. Order it with photos sequence.' };
        }
        return { ok: true, value: [...(published as string[])] };
    }
    if (published === null || published === undefined) {
        // A series always carries its text fields; an optional field the live revision doesn't publish goes.
        return record.kind === 'series' && ['title', 'statement', 'shortStatement', 'chapters', 'cover'].includes(field) ? { ok: false, why: 'The live revision has no value here to put back.' } : { ok: true, value: undefined };
    }
    return { ok: true, value: structuredClone(published) };
}

/** The photographs a series' chapters, cover or opening photograph names. */
function referencedPhotos(field: string, published: unknown): string[] {
    if (field === 'chapters' && Array.isArray(published)) return (published as { startPhotoId?: unknown }[]).map((chapter) => String(chapter.startPhotoId));
    if (field === 'cover' && published && typeof published === 'object') return [String((published as { photoId?: unknown }).photoId)];
    if (field === 'openingPhotoId' && typeof published === 'string') return [published];
    return [];
}

const NEW_IMAGE = 'The photograph has a new image since this was reviewed, so the published value was written for the old one. Review it against the new image first: check it, then mark it reviewed, or change it with photos edit.';

/**
 * A9 review: no published value for a field that describes the image once
 * the photograph has new bytes, since that value describes the old ones and
 * would clear the asset-replaced gate. For a photo's alt, title, caption,
 * focal point, crop and accent: the live photo pins other bytes than the
 * draft, or the field's review was of other bytes than the draft pins. For a
 * series cover: the same, of its cover photograph.
 */
export function assetGuard(record: AuthoredRecord, field: string, layer: WorkingLayer, active: RevisionContent | null, backfill?: ReviewBackfill | null): { ok: true } | { ok: false; why: string } {
    const livePhoto = (photoId: string) => active?.photos.find((photo) => photo.id === photoId)?.assetRevision;
    if (record.kind === 'photo' && ASSET_DEPENDENT_FIELDS.includes(field)) {
        const live = livePhoto(record.id);
        const stamp = stampsOf(record, null, undefined, backfill)[field];
        if ((live !== undefined && live !== record.assetRevision) || (stamp?.assetRevision !== undefined && stamp.assetRevision !== record.assetRevision)) return { ok: false, why: NEW_IMAGE };
    }
    if (record.kind === 'series' && field === 'cover' && record.cover) {
        const draft = coverAssetOf(layer, record);
        const live = livePhoto(record.cover.photoId);
        const stamp = stampsOf(record, draft, undefined, backfill)[field];
        if (draft !== null && ((live !== undefined && live !== draft) || (stamp?.assetRevision !== undefined && stamp.assetRevision !== draft))) return { ok: false, why: NEW_IMAGE };
    }
    return { ok: true };
}

/**
 * Everything but the version and value check, for the view, the CLI and
 * the writer alike: the field's state (stale against the live revision or
 * in conflict, no Inbox item first), the new-image guard, and the authored
 * value from the published one.
 */
export function publishedValueCheck(input: { record: AuthoredRecord; field: string; state: FieldReviewState; inbox: FieldReviewState | null; layer: WorkingLayer; active: RevisionContent; review?: ReviewContext; published?: PublishedIndex }): FromPublished & { code?: 'inbox' | 'not-clearable' } {
    const { record, field } = input;
    const allowed = publishedValueState(record, field, input.state, input.inbox);
    if (!allowed.ok) return allowed;
    const image = assetGuard(record, field, input.layer, input.active, input.review?.backfill);
    if (!image.ok) return { ...image, code: 'not-clearable' };
    const value = authoredFromPublished(record, field, publishedValue(input.active, { record: { kind: record.kind, id: record.kind === 'site' ? 'site' : record.id }, field }, input.published));
    return value.ok ? value : { ...value, code: 'not-clearable' };
}

/** The base field a ledger row is about: `photoIds` for `photoIds[<id>]`, `chapters` for `chapters[<id>]`, null for a row about the record or a derived row. */
export function fieldOfChange(change: Pick<CatalogChange, 'field' | 'category'>): string | null {
    if (change.category === 'derived' || change.category === 'missing' || change.field === '') return null;
    return change.field.replace(/\[.*\]$/, '');
}

/** What a row's "Use the published value" writes against: the record, the field, and what the caller saw of it. */
export interface UsePublishedTarget {
    record: IssueRecord & { kind: AuthoredKind };
    field: string;
    /** The record version the caller read. */
    version: number;
    /** The hashValue() of the draft's value the caller showed. */
    valueHash: string;
}

export type UsePublishedOffer = { ok: true; target: UsePublishedTarget } | { ok: false; why: string };

export interface UsePublishedEnv {
    layer: WorkingLayer;
    /** The live revision's content, null before the first activation. */
    active: RevisionContent | null;
    review: ReviewContext;
    /** The live revision's index, so a ledger of many rows never searches its lists. */
    published?: PublishedIndex;
}

/** Whether one field of a record is a first-rule stale review, or a rebase conflict, that the Inbox doesn't settle first. */
export function publishedValueState(record: AuthoredRecord, field: string, state: FieldReviewState, inbox: FieldReviewState | null): { ok: true } | { ok: false; code: 'inbox' | 'not-clearable'; why: string } {
    if (inbox !== null || (state.reason !== undefined && INBOX_REASONS.has(state.reason))) return { ok: false, code: 'inbox', why: 'Its Inbox item needs a decision again. Decide it in the Inbox first.' };
    if (inConflict(record as { conflicts?: { field: string }[] }, field)) return { ok: true };
    if (state.state === 'stale' && state.reason !== undefined && USE_PUBLISHED_REASONS.has(state.reason)) return { ok: true };
    return { ok: false, code: 'not-clearable', why: 'Use the published value is for a field the live revision changed after its review. This one waits on something else.' };
}

/**
 * Whether a ledger row offers "Use the published value", and what it would
 * write against. The row must be about one field of its own record, that
 * field must be one the writer covers, and its review must be stale against
 * the live revision, or in conflict, with no Inbox item to decide first.
 */
export function publishedValueOffer(change: CatalogChange, env: UsePublishedEnv): UsePublishedOffer {
    const field = fieldOfChange(change);
    if (field === null) return { ok: false, why: 'This row is about a whole record, so there is no one published value to put back.' };
    if (env.active === null) return { ok: false, why: 'Nothing is published yet, so there is no published value.' };
    const record = recordOf(env.layer, change.record);
    if (record === null) return { ok: false, why: 'Its record is gone from the working layer.' };
    if (!canUsePublished(record.kind, field)) return { ok: false, why: `Use the published value doesn't cover the ${field} of a ${record.kind}. Change it with photos edit.` };
    const state = change.review.fields.find((entry) => entry.record.kind === change.record.kind && entry.record.id === change.record.id && entry.field === field);
    if (!state) return { ok: false, why: 'This row rests on another record, so its own value is not what changed.' };
    const inbox = inboxReviewOf(state, { layer: env.layer, active: null, review: env.review });
    const checked = publishedValueCheck({ record, field, state, inbox, layer: env.layer, active: env.active, review: env.review, published: env.published });
    if (!checked.ok) return { ok: false, why: checked.why };
    const own = (record as unknown as Record<string, unknown>)[field];
    return { ok: true, target: { record: { kind: record.kind, id: change.record.id }, field, version: record.version, valueHash: hashValue(own) } };
}
