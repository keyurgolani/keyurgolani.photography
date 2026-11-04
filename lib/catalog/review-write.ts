import { readRevisionFile } from './repository';
import { readReviewContext } from './review-context';
import { fieldReview, hashValue, inboxReviewOf, type FieldReviewState, type ReviewEnv } from './review';
import type { AuthoredKind } from './schema';
import type { AuthoredRecord, IssueRecord } from './types';
import { readActivePointer, readAuthoredRecord, readWorkingLayer } from './working-layer';
import { AuthoredWriteError, writeAuthoredRecord } from './working-layer-writer';

/**
 * #16's stamp-only review: the one writer behind the Publish screen's "Still
 * right, mark reviewed" and `photos review`. It writes a record as it is,
 * stamping the fields the curator checked against the live revision they
 * compared with, through #13's one authored write path. It refuses when the
 * live revision, the record's version, or a value moved since the caller
 * read them, and when a field waits on something a review can't clear: a
 * suggested description, which is its own fix, an Inbox item that needs a
 * decision again, or a record that's gone.
 */

type Reason = NonNullable<FieldReviewState['reason']>;

const RESTAMP_LIST = ['active-moved', 'base-unreadable', 'asset-replaced', 'cover-replaced', 'edited', 'no-stamp', 'generated'] as const satisfies readonly Reason[];
export type RestampReason = (typeof RESTAMP_LIST)[number];
/** The reasons a stamp-only review may clear (16-3's decision 2). */
export const RESTAMP_REASONS: ReadonlySet<string> = new Set<string>(RESTAMP_LIST);

/** The reasons only the Inbox settles. */
export const INBOX_REASONS: ReadonlySet<string> = new Set(['item-reopened', 'newer-item', 'item-unreadable', 'inbox-unread']);

/** A described alt nobody has reviewed: marking it ready is its own fix, never a stamp-only review. */
export const isGeneratedAlt = (entry: Pick<FieldReviewState, 'reason' | 'record' | 'field'>) => entry.reason === 'generated' && entry.record.kind === 'photo' && entry.field === 'alt';

/** Whether a stamp-only review may clear this field's state: its reason is one it restamps, and it isn't a generated description. */
export function restampReason(state: FieldReviewState): boolean {
    return state.state !== 'reviewed' && state.reason !== undefined && RESTAMP_REASONS.has(state.reason) && !isGeneratedAlt(state);
}

/**
 * Each of `fields` of one record as review reads it now, from a fresh read:
 * fieldReview()'s state, and what the inbox item its stamp names says on its
 * own, which a stale base would hide behind its own reason.
 */
export async function reviewNow(root: string, record: IssueRecord, fields: readonly string[]): Promise<{ field: string; state: FieldReviewState; inbox: FieldReviewState | null }[]> {
    const pointer = await readActivePointer(root);
    const layer = await readWorkingLayer(root);
    const active = pointer ? await readRevisionFile(root, pointer.revisionId) : null;
    if (pointer && active === null) throw new Error('The active pointer names a revision with no file.');
    const review = await readReviewContext(root, layer, active?.revisionId ?? null);
    const env: ReviewEnv = { layer, active: active ? { revisionId: active.revisionId, content: active.content } : null, review };
    return fields.map((field) => ({ field, state: fieldReview({ record, field }, env), inbox: inboxReviewOf({ record, field }, env) }));
}

/**
 * Why a review wrote nothing: `active-moved`, the live revision isn't the
 * one the caller compared against; `inbox`, a field's Inbox item needs a
 * decision again; `not-clearable`, a field waits on something else.
 */
export class ReviewRefusedError extends Error {
    constructor(readonly code: 'active-moved' | 'inbox' | 'not-clearable', message: string) {
        super(message);
        this.name = 'ReviewRefusedError';
    }
}

/**
 * Check each of `fields` from a fresh read: no inbox item its stamp names
 * may need a decision, whatever reason reads first, and each must wait for a
 * reason `allowed` accepts. Throws ReviewRefusedError.
 */
export async function checkReviewable(root: string, record: IssueRecord, fields: readonly string[], allowed: (state: FieldReviewState) => boolean): Promise<void> {
    for (const { field, state, inbox } of await reviewNow(root, record, fields)) {
        if (inbox !== null || (state.reason !== undefined && INBOX_REASONS.has(state.reason))) {
            throw new ReviewRefusedError('inbox', `The ${field} of ${record.kind} ${record.id} waits on its Inbox item, which needs a decision again.`);
        }
        if (!allowed(state)) throw new ReviewRefusedError('not-clearable', `The ${field} of ${record.kind} ${record.id} is ${state.state}${state.reason ? ` (${state.reason})` : ''}, which a review here can't clear.`);
    }
}

export interface MarkReviewedInput {
    root: string;
    record: { kind: AuthoredKind; id: string };
    /** The record version the caller read. */
    version: number;
    /** Each field to stamp, with the hashValue() of the value the caller showed. */
    hashes: Readonly<Record<string, string>>;
    /** The live revision the caller compared against, null before the first activation. */
    baseRevisionId: string | null;
    actor: string;
}

/**
 * Stamp `hashes`' fields of one record as reviewed, or throw: a
 * ReviewRefusedError, or AuthoredWriteError with VERSION_CONFLICT when the
 * version or a value moved, AUTHORED_LOCKED when the lock stays busy. The
 * writer checks the version under the authored lock and stamps each field
 * only while it still holds the value whose hash it was given.
 */
export async function markFieldsReviewed(input: MarkReviewedInput): Promise<AuthoredRecord> {
    const { root, record: ref, version, hashes, baseRevisionId, actor } = input;
    const fields = Object.keys(hashes);
    if (fields.length === 0) throw new ReviewRefusedError('not-clearable', 'A review names at least one field.');
    const pointer = await readActivePointer(root);
    if ((pointer?.revisionId ?? null) !== baseRevisionId) {
        throw new ReviewRefusedError('active-moved', `The live revision is ${pointer?.revisionId ?? 'none'} now, not ${baseRevisionId ?? 'none'}.`);
    }
    const record = (await readAuthoredRecord(root, ref.kind, ref.id)) as AuthoredRecord | null;
    const moved = record === null || record.version !== version || fields.some((field) => hashValue((record as unknown as Record<string, unknown>)[field]) !== hashes[field]);
    if (moved) throw new AuthoredWriteError('VERSION_CONFLICT', ref, 'The value moved.');
    // `reviewedAt` is taken before the fresh read that checks the fields, so an inbox replacement observed after that
    // read is newer than the stamp and still reads as `newer-item` (16-3's high review N2).
    const reviewedAt = new Date().toISOString();
    await checkReviewable(root, ref, fields, restampReason);
    return writeAuthoredRecord(record as never, { expectedVersion: version, root, review: { baseRevisionId, origin: 'curator', actor, reviewedAt, reviewedValues: hashes } });
}
