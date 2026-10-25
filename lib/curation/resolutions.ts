import path from 'node:path';
import type { AuthoredPhoto } from '../catalog/types';
import { readActivePointer } from '../catalog/working-layer';
import { AUTHORED_LEASE_MS, AUTHORED_LOCK, AUTHORED_WAIT_MS, AuthoredWriteError, writeAuthoredRecord, type WriteAuthoredOptions } from '../catalog/working-layer-writer';
import { readRegistry } from '../identity/registry';
import { readAssetManifest } from '../media/manifest';
import { assetDir } from '../media/path';
import { LockTimeoutError, withLock } from '../storage/lock';
import { verifyDirectory } from '../storage/publish';
import { act, decided, fail, readAuthored, requireStatus, type ActionInput, type ActionOutcome, type WrittenRecord } from './actions';
import { candidateOf } from './candidates';
import type { CandidateFailure } from './events';

/**
 * #17's resolutions of a replacement item. Only the CLI and the curator
 * process load this module; the watcher can't (eslint.config.js and the
 * import-graph test).
 *
 * "Confirm new asset revision" sets the photo record's `assetRevision` to the
 * replacement's, through #13's writeAuthoredRecord() with the version it
 * read under the `authored` lock, passing what the curator reviewed for #16.
 * It changes no other field and no series, so the photograph keeps its photo
 * ID, its series membership and position, and its title, description, and
 * story. It needs the set #10's writer committed for those bytes, checked
 * against its manifest, and it never publishes: the active revision keeps
 * serving the old bytes until a #13 publish activates the new ones.
 *
 * "Leave in draft" is #14's defer, which keeps the photo record on its
 * current revision.
 */

const FAILURE_TEXT: Record<CandidateFailure, string> = {
    superseded: 'the source changed again before it was built, so review the newer replacement instead',
    integrity: "a set already in place for these bytes doesn't match its manifest",
    undecodable: "the new file can't be decoded",
    build: 'building it failed',
};

export interface ConfirmFaults {
    /** Under the authored lock, after the photo record is read and before it is written. A test can move it here. */
    beforeWrite?(): void | Promise<void>;
}

/** Confirm new asset revision. Writes the photo record only, and leaves `catalog/` byte-identical. */
export function confirmReplacement(input: ActionInput & { faults?: ConfirmFaults }): Promise<ActionOutcome> {
    return act(input, async (step) => {
        const { event } = step;
        if (event.type !== 'replacement') fail('refused', `Only a replacement is confirmed. A ${event.type} event is settled another way.`);
        requireStatus(event, ['open', 'deferred', 'failed'], 'confirmed');
        if (input.expectedBase === undefined && step.active !== null) {
            fail('needs-choice', `confirm needs --base ${step.active}, the active revision it was reviewed against. Show it again if that isn't the one. Nothing was written.`);
        }
        if (event.photoId === null || event.assetRevision === null) fail('refused', `The event ${event.id} names no photo and revision. Nothing was written.`);
        const photoId = event.photoId as string;
        const assetRevision = event.assetRevision as string;
        const root = path.resolve(input.root);

        const registry = await readRegistry(root).catch((error: unknown) => fail('damaged', `The identity registry can't be read: ${(error as Error).message}. Nothing was written.`));
        const photo = Object.hasOwn(registry.photos, photoId) ? registry.photos[photoId] : undefined;
        if (!photo || photo.mergedInto || photo.sourceHealth !== 'present' || photo.source.observedRevision !== assetRevision) {
            const now = !photo ? 'is not in the registry' : photo.mergedInto ? `was merged into ${photo.mergedInto}` : photo.sourceHealth !== 'present' ? `is ${photo.sourceHealth}` : `now holds ${photo.source.observedRevision}`;
            fail('stale', `The source changed since this event: ${photoId} ${now}. Review the newer event instead. Nothing was written.`);
        }
        const candidate = candidateOf(registry, photoId, assetRevision);
        if (candidate.state === 'pending') {
            fail('not-ready', `${assetRevision}'s derivatives are still building. Use the new bytes only after all derivatives succeed. Nothing was written.`);
        }
        if (candidate.state === 'failed') {
            fail('refused', `${assetRevision}'s derivative set failed: ${FAILURE_TEXT[candidate.failure]}. Retry it, or leave the current revision in draft. Nothing was written.`);
        }
        if (candidate.state !== 'ready') fail('stale', `The registry no longer holds ${assetRevision} for ${photoId}. Nothing was written.`);
        const profileId = (candidate as { profileId: string }).profileId;
        // #13 accepts only a set #10's writer committed with its manifest, so neither does confirm.
        const ref = { photoId, assetRevision, profileId };
        const problems = (await readAssetManifest(ref, { root })) === null ? ['no valid manifest'] : await verifyDirectory(assetDir(ref, root), ref);
        if (problems.length > 0) {
            fail('damaged', `${assetRevision}'s derivative set for ${profileId} doesn't check out (${problems.slice(0, 3).join('; ')}), so it can't be confirmed. Nothing was written.`);
        }

        const writes: WrittenRecord[] = [];
        let fromRevision = assetRevision;
        try {
            await withLock(AUTHORED_LOCK, { root, leaseMs: AUTHORED_LEASE_MS, waitMs: input.waitMs ?? AUTHORED_WAIT_MS }, async (authored) => {
                // A publish may have moved the active revision while this waited for the hold.
                if (((await readActivePointer(root))?.revisionId ?? null) !== step.active) {
                    fail('stale', 'The active revision moved while the confirm waited for the authored lock. Show it again and review it. Nothing was written.');
                }
                const existing = await readAuthored<AuthoredPhoto>(root, 'photo', photoId);
                if (existing === null) {
                    fail('refused', `${photoId} has no photo record in the working layer, so no revision of it is pinned to replace. Approve its new item first. Nothing was written.`);
                }
                const record = existing as AuthoredPhoto;
                fromRevision = record.assetRevision;
                if (record.assetRevision === assetRevision) return;
                await input.faults?.beforeWrite?.();
                const review: WriteAuthoredOptions['review'] = {
                    baseRevisionId: step.active,
                    event: { id: event.id, version: event.version },
                    asset: { from: record.assetRevision, to: assetRevision, profileId },
                    actor: input.actor,
                    reviewedAt: step.at,
                };
                const written = await writeAuthoredRecord({ ...record, assetRevision }, { expectedVersion: record.version, lock: authored, root, review });
                writes.push({ record: `photo:${photoId}`, version: written.version });
            });
        } catch (error) {
            if (error instanceof LockTimeoutError) fail('locked', 'The authored lock is busy. Nothing was written. Try again shortly.');
            if (error instanceof AuthoredWriteError) {
                const code = error.code === 'VERSION_CONFLICT' || error.code === 'AUTHORED_LOCKED' || error.code === 'LOCK_NOT_HELD' ? 'stale' : error.code === 'DATA_ROOT_NOT_READY' ? 'not-ready' : 'damaged';
                fail(code, `${error.message} Nothing was written.`);
            }
            throw error;
        }

        const notes = writes.length > 0
            ? [`Confirmed ${assetRevision} for ${photoId} in the draft, in place of ${fromRevision}. Its series, position, title, description, and story stay as they were. Visitors keep the current image until photos publish runs.`]
            : [`${photoId}'s photo record already pins ${assetRevision}, so nothing in the working layer changed.`];
        const next = decided(step, input, { action: 'confirm', writes, ...(fromRevision !== assetRevision ? { fromRevision } : {}) }, 'approved');
        return { event: next, notes };
    });
}
