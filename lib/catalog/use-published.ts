import { readRevisionFile } from './repository';
import { hashValue } from './review';
import { readReviewContext } from './review-context';
import { ReviewRefusedError, reviewNow } from './review-write';
import type { AuthoredKind } from './schema';
import type { AuthoredRecord } from './types';
import { canUsePublished, publishedValueCheck } from './use-published-rules';
import { LockTimeoutError, withLock } from '../storage/lock';
import { readActivePointer, readAuthoredRecord, readWorkingLayer } from './working-layer';
import { AUTHORED_LEASE_MS, AUTHORED_LOCK, AUTHORED_WAIT_MS, AuthoredWriteError, writeAuthoredRecord } from './working-layer-writer';

/**
 * A9's "Use the published value" (#182): the one writer behind the Publish
 * screen's button and `photos review --use-published`. It puts the live
 * revision's value of one field back into the draft as an authored write,
 * through #13's one write path, so the field is stamped as the curator's
 * review against the live revision, and a rebase conflict on it is settled.
 *
 * One hold on the authored lock covers every check and the write. It refuses
 * when the live revision isn't the one the caller compared against, when the
 * record's version or the field's value moved since the caller read them,
 * when an Inbox item the field rests on needs a decision again, and when the
 * field's review isn't stale against the live revision nor in conflict. All
 * of that is checked before the write, so a refusal writes nothing.
 */

export interface UsePublishedInput {
    root: string;
    record: { kind: AuthoredKind; id: string };
    field: string;
    /** The record version the caller read. */
    version: number;
    /** The hashValue() of the draft's value the caller showed. */
    valueHash: string;
    /** The live revision the caller compared against, null before the first activation. */
    baseRevisionId: string | null;
    actor: string;
}

/**
 * Write the published value of `input.field`, or throw: ReviewRefusedError
 * (`active-moved`, `inbox`, `not-clearable`), or AuthoredWriteError with
 * VERSION_CONFLICT when the version or the value moved, AUTHORED_LOCKED
 * when the lock stays busy. Returns the record as written.
 */
export async function writePublishedValue(input: UsePublishedInput, options: { waitMs?: number } = {}): Promise<AuthoredRecord> {
    const { root, record: ref, field, baseRevisionId } = input;
    if (!canUsePublished(ref.kind, field)) throw new ReviewRefusedError('not-clearable', `Use the published value doesn't cover the ${field} of a ${ref.kind}.`);
    try {
        return await withLock(AUTHORED_LOCK, { root, leaseMs: AUTHORED_LEASE_MS, waitMs: options.waitMs ?? AUTHORED_WAIT_MS }, async (lock) => {
            const pointer = await readActivePointer(root);
            if ((pointer?.revisionId ?? null) !== baseRevisionId) {
                throw new ReviewRefusedError('active-moved', `The live revision is ${pointer?.revisionId ?? 'none'} now, not ${baseRevisionId ?? 'none'}.`);
            }
            if (pointer === null) throw new ReviewRefusedError('not-clearable', 'Nothing is published yet, so there is no published value.');
            const record = (await readAuthoredRecord(root, ref.kind, ref.id)) as AuthoredRecord | null;
            if (record === null || record.version !== input.version || hashValue((record as unknown as Record<string, unknown>)[field]) !== input.valueHash) {
                throw new AuthoredWriteError('VERSION_CONFLICT', ref, 'The value moved.');
            }
            const active = await readRevisionFile(root, pointer.revisionId);
            if (active === null) throw new Error('The active pointer names a revision with no file.');
            const layer = await readWorkingLayer(root);
            const [{ state, inbox }] = await reviewNow(root, ref, [field], { pointer, active, layer });
            // The same check the screen and photos diff offer by, the new-image guard included (A9 review).
            const review = await readReviewContext(root, layer, active.revisionId);
            const value = publishedValueCheck({ record, field, state, inbox, layer, active: active.content, review });
            if (!value.ok) throw new ReviewRefusedError(value.code ?? 'not-clearable', value.why);
            const next = { ...record } as Record<string, unknown>;
            if (value.value === undefined) delete next[field];
            else next[field] = value.value;
            // Settling the field settles its conflict: the writer stamps a field whose conflicts entry goes.
            const conflicts = (record.conflicts ?? []).filter((entry) => entry.field !== field && !entry.field.startsWith(`${field}[`));
            if (conflicts.length > 0) next.conflicts = conflicts;
            else delete next.conflicts;
            lock.signal.throwIfAborted();
            return writeAuthoredRecord(next as never, { expectedVersion: record.version, lock, root, review: { baseRevisionId, origin: 'curator', actor: input.actor, reviewedAt: new Date().toISOString() } });
        });
    } catch (error) {
        if (error instanceof LockTimeoutError) throw new AuthoredWriteError('AUTHORED_LOCKED', input.record, error.message, { holder: error.holder });
        throw error;
    }
}
