import { readRevisionFile } from './repository';
import { readReviewContext } from './review-context';
import { fieldReview, hashValue, inboxReviewOf, type FieldReviewState, type ReviewEnv } from './review';
import { INBOX_REASONS, inConflict, restampReason } from './review-reasons';
import type { AuthoredKind } from './schema';
import type { ActivePointer, AuthoredRecord, IssueRecord, RevisionFile, WorkingLayer } from './types';
import { LockTimeoutError, withLock } from '../storage/lock';
import { readActivePointer, readAuthoredRecord, readWorkingLayer } from './working-layer';
import { AUTHORED_LEASE_MS, AUTHORED_LOCK, AUTHORED_WAIT_MS, AuthoredWriteError, writeAuthoredRecord } from './working-layer-writer';

/**
 * #16's stamp-only review: the one writer behind the Publish screen's "Still
 * right, mark reviewed" and `photos review`. It writes a record as it is,
 * stamping the fields the curator checked against the live revision they
 * compared with, through #13's one authored write path. It refuses when the
 * live revision, the record's version, or a value moved since the caller
 * read them, and when a field waits on something a review can't clear: a
 * suggested description, which is its own fix, an Inbox item that needs a
 * decision again, a rebase conflict, or a record that's gone.
 */

export { INBOX_REASONS, isGeneratedAlt, restampReason, RESTAMP_REASONS, type RestampReason } from './review-reasons';

/**
 * Each of `fields` of one record as review reads it now, from a fresh read:
 * fieldReview()'s state, and what the inbox item its stamp names says on its
 * own, which a stale base would hide behind its own reason.
 */
export async function reviewNow(
    root: string,
    record: IssueRecord,
    fields: readonly string[],
    known: { pointer?: ActivePointer | null; active?: RevisionFile | null; layer?: WorkingLayer } = {},
): Promise<{ field: string; state: FieldReviewState; inbox: FieldReviewState | null }[]> {
    // A caller holding the lock passes what it already read (A9 review), so one check sees one pointer.
    const pointer = known.pointer !== undefined ? known.pointer : await readActivePointer(root);
    const layer = known.layer ?? (await readWorkingLayer(root));
    const active = known.active !== undefined ? known.active : pointer ? await readRevisionFile(root, pointer.revisionId) : null;
    if (pointer && active === null) throw new Error('The active pointer names a revision with no file.');
    const review = await readReviewContext(root, layer, active?.revisionId ?? null);
    const env: ReviewEnv = { layer, active: active ? { revisionId: active.revisionId, content: active.content } : null, review };
    return fields.map((field) => ({ field, state: fieldReview({ record, field }, env), inbox: inboxReviewOf({ record, field }, env) }));
}

/**
 * Why a review wrote nothing: `active-moved`, the live revision isn't the
 * one the caller compared against; `inbox`, a field's Inbox item needs a
 * decision again; `conflict`, a rebase left a field in conflict;
 * `not-clearable`, a field waits on something else.
 */
export class ReviewRefusedError extends Error {
    constructor(readonly code: 'active-moved' | 'inbox' | 'conflict' | 'not-clearable', message: string) {
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
 * Stamp `hashes`' fields of one record as reviewed, or throw: see
 * markAllReviewed().
 */
export async function markFieldsReviewed(input: MarkReviewedInput): Promise<AuthoredRecord> {
    const [record] = await markAllReviewed([input]);
    return record;
}

/**
 * Stamp each input's fields as reviewed, all or none. One hold on the
 * authored lock covers every check and every write: the live revision, then
 * for each record its version, the hash of each value, rebase conflicts, and
 * what each field waits on, all before the first write. So a refusal writes
 * nothing, and only an I/O error part way can leave earlier records stamped.
 * Throws a ReviewRefusedError, or AuthoredWriteError with VERSION_CONFLICT
 * when a version or a value moved, AUTHORED_LOCKED when the lock stays busy.
 * The writer stamps each field only while it holds the value whose hash it
 * was given.
 */
export async function markAllReviewed(inputs: readonly MarkReviewedInput[], options: { waitMs?: number } = {}): Promise<AuthoredRecord[]> {
    if (inputs.length === 0) return [];
    const { root, baseRevisionId } = inputs[0];
    if (inputs.some((input) => input.root !== root || input.baseRevisionId !== baseRevisionId)) throw new RangeError('A review stamps one data root against one live revision.');
    for (const input of inputs) if (Object.keys(input.hashes).length === 0) throw new ReviewRefusedError('not-clearable', 'A review names at least one field.');
    try {
        return await withLock(AUTHORED_LOCK, { root, leaseMs: AUTHORED_LEASE_MS, waitMs: options.waitMs ?? AUTHORED_WAIT_MS }, async (lock) => {
            const pointer = await readActivePointer(root);
            if ((pointer?.revisionId ?? null) !== baseRevisionId) {
                throw new ReviewRefusedError('active-moved', `The live revision is ${pointer?.revisionId ?? 'none'} now, not ${baseRevisionId ?? 'none'}.`);
            }
            // `reviewedAt` is taken before the fresh reads that check the fields, so an inbox replacement observed after
            // them is newer than the stamp and still reads as `newer-item` (16-3's high review N2).
            const reviewedAt = new Date().toISOString();
            const checked: AuthoredRecord[] = [];
            for (const { record: ref, version, hashes } of inputs) {
                const fields = Object.keys(hashes);
                const record = (await readAuthoredRecord(root, ref.kind, ref.id)) as AuthoredRecord | null;
                const moved = record === null || record.version !== version || fields.some((field) => hashValue((record as unknown as Record<string, unknown>)[field]) !== hashes[field]);
                if (moved) throw new AuthoredWriteError('VERSION_CONFLICT', ref, 'The value moved.');
                const conflicted = fields.find((field) => inConflict(record as { conflicts?: { field: string }[] }, field));
                if (conflicted) throw new ReviewRefusedError('conflict', `A restore's rebase left the ${conflicted} of ${ref.kind} ${ref.id} in conflict. Keep one value with photos edit, which clears the conflict.`);
                await checkReviewable(root, ref, fields, restampReason);
                checked.push(record);
            }
            const written: AuthoredRecord[] = [];
            for (const [index, { hashes, version, actor }] of inputs.entries()) {
                lock.signal.throwIfAborted();
                written.push(await writeAuthoredRecord(checked[index] as never, { expectedVersion: version, lock, root, review: { baseRevisionId, origin: 'curator', actor, reviewedAt, reviewedValues: hashes } }));
            }
            return written;
        });
    } catch (error) {
        if (error instanceof LockTimeoutError) throw new AuthoredWriteError('AUTHORED_LOCKED', inputs[0].record, error.message, { holder: error.holder });
        throw error;
    }
}
