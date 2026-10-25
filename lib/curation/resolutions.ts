import path from 'node:path';
import type { AuthoredPhoto } from '../catalog/types';
import { readActivePointer } from '../catalog/working-layer';
import { AUTHORED_LEASE_MS, AUTHORED_LOCK, AUTHORED_WAIT_MS, AuthoredWriteError, writeAuthoredRecord, type WriteAuthoredOptions } from '../catalog/working-layer-writer';
import { readRegistry } from '../identity/registry';
import { readAssetManifest } from '../media/manifest';
import { assetDir } from '../media/path';
import type { AssetRef } from '../media/url';
import { LockTimeoutError, withLock, type LockContext } from '../storage/lock';
import { verifyDirectory } from '../storage/publish';
import { act, decided, fail, readAuthored, requireStatus, type ActionInput, type ActionOutcome, type Change, type Step, type WrittenRecord } from './actions';
import { candidateOf } from './candidates';
import type { CandidateFailure } from './events';
import { draftPlan, latestPin } from './pins';

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
 * "Leave in draft" (leaveInDraft(), the CLI's defer) keeps the revision the
 * photo record pinned before the item. On an item whose confirm landed,
 * reopened since, it writes the record back to the revision that confirm
 * replaced, the same way confirm writes it, so the next publish ships that
 * one, while that confirm is still the inbox's latest pin of the photo. Once
 * a later pin moved the record, even back onto the item's bytes, it puts
 * nothing back, and reopen and `curation show` say so. A record on the item's bytes with no confirm of the item to say so
 * (a hand edit or `photos edit`, a #15 rollback, or a confirm whose event a
 * crash lost) is left where it is: nothing on record tells those apart, so
 * nothing is guessed. Confirm guesses nothing there either: it records no
 * `fromRevision`, so a later Leave in draft keeps the record where it is.
 */

const FAILURE_TEXT: Record<CandidateFailure, string> = {
    superseded: 'the source changed again before it was built, so review the newer replacement instead',
    integrity: "a set already in place for these bytes doesn't match its manifest",
    undecodable: "the new file can't be decoded",
    build: 'building it failed',
};

export interface ConfirmFaults {
    /** After the event and its base are checked, before the authored lock is taken. A test can publish here. */
    beforeAuthoredLock?(): void | Promise<void>;
    /** Under the authored lock, after the photo record is read and before it is written. A test can move it here. */
    beforeWrite?(): void | Promise<void>;
    /** After the photo record is written, before the event is. A test can crash here. */
    afterWrite?(): void | Promise<void>;
}

/** #13 accepts only a set #10's writer committed with its manifest, every file checking out, so neither does a resolution. */
async function requireSet(root: string, ref: AssetRef, what: string): Promise<void> {
    const problems = (await readAssetManifest(ref, { root })) === null ? ['no valid manifest'] : await verifyDirectory(assetDir(ref, root), ref);
    if (problems.length > 0) {
        fail('damaged', `${ref.assetRevision}'s derivative set for ${ref.profileId} doesn't check out (${problems.slice(0, 3).join('; ')}), so it can't be ${what}. Nothing was written.`);
    }
}

/** `fn` under the authored lock, once the active revision is still the one reviewed. Lock and writer errors become action failures. */
async function underAuthoredLock(root: string, step: Step, input: ActionInput, what: string, fn: (authored: LockContext) => Promise<void>): Promise<void> {
    try {
        await withLock(AUTHORED_LOCK, { root, leaseMs: AUTHORED_LEASE_MS, waitMs: input.waitMs ?? AUTHORED_WAIT_MS }, async (authored) => {
            // A publish may have moved the active revision while this waited for the hold.
            if (((await readActivePointer(root))?.revisionId ?? null) !== step.active) {
                fail('stale', `The active revision moved while the ${what} waited for the authored lock. Show it again and review it. Nothing was written.`);
            }
            await fn(authored);
        });
    } catch (error) {
        if (error instanceof LockTimeoutError) fail('locked', 'The authored lock is busy. Nothing was written. Try again shortly.');
        if (error instanceof AuthoredWriteError) {
            const code = error.code === 'VERSION_CONFLICT' || error.code === 'AUTHORED_LOCKED' || error.code === 'LOCK_NOT_HELD' ? 'stale' : error.code === 'DATA_ROOT_NOT_READY' ? 'not-ready' : 'damaged';
            fail(code, `${error.message} Nothing was written.`);
        }
        throw error;
    }
}

/** Point the photo record at `to`, in place of `from`, through #13's writer with compare-and-swap, passing what was reviewed for #16. */
async function pinRecord(record: AuthoredPhoto, to: string, profileId: string, step: Step, input: ActionInput, authored: LockContext, root: string): Promise<WrittenRecord> {
    const review: WriteAuthoredOptions['review'] = {
        baseRevisionId: step.active,
        event: { id: step.event.id, version: step.event.version },
        asset: { from: record.assetRevision, to, profileId },
        actor: input.actor,
        reviewedAt: step.at,
    };
    const written = await writeAuthoredRecord({ ...record, assetRevision: to }, { expectedVersion: record.version, lock: authored, root, review });
    return { record: `photo:${record.id}`, version: written.version };
}

const readRegistryOrFail = (root: string) => readRegistry(root).catch((error: unknown) => fail('damaged', `The identity registry can't be read: ${(error as Error).message}. Nothing was written.`));

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

        const registry = await readRegistryOrFail(root);
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
        await requireSet(root, { photoId, assetRevision, profileId }, 'confirmed');

        const writes: WrittenRecord[] = [];
        let fromRevision = assetRevision;
        // When the record already pins these bytes though the inbox last pinned another revision, that one.
        let unexplained: string | null = null;
        let again = false;
        await input.faults?.beforeAuthoredLock?.();
        await underAuthoredLock(root, step, input, 'confirm', async (authored) => {
            const existing = await readAuthored<AuthoredPhoto>(root, 'photo', photoId);
            if (existing === null) {
                fail('refused', `${photoId} has no photo record in the working layer, so no revision of it is pinned to replace. Approve its new item first. Nothing was written.`);
            }
            const record = existing as AuthoredPhoto;
            fromRevision = record.assetRevision;
            if (record.assetRevision === assetRevision) {
                const pin = await latestPin(root, registry, photoId);
                if (pin && pin.revision === assetRevision && pin.action === 'confirm' && pin.fromRevision) {
                    // Confirmed again, as after a reopen: keep what the earlier confirm replaced, so leaving it in draft still puts that back.
                    fromRevision = pin.fromRevision;
                    again = true;
                } else if (pin && pin.revision !== assetRevision) {
                    // Pinned already, though the inbox last pinned another. A confirm whose event a crash lost leaves this, and so
                    // do a #15 rollback's rebase and a photos edit. Until 16-1 stamps the reviewed event on the record, nothing on
                    // record tells them apart: the writer stores no review inputs, and the record keeps only its two newest
                    // versions, in which a photos edit of assetRevision alone reads the same as confirm's write. So record no
                    // fromRevision, and leaving it in draft later puts nothing back.
                    unexplained = pin.revision;
                }
                return;
            }
            await input.faults?.beforeWrite?.();
            writes.push(await pinRecord(record, assetRevision, profileId, step, input, authored, root));
            await input.faults?.afterWrite?.();
        });

        const notes = writes.length > 0
            ? [`Confirmed ${assetRevision} for ${photoId} in the draft, in place of ${fromRevision}. Its series, position, title, description, and story stay as they were. Visitors keep the current image until photos publish runs.`]
            : unexplained !== null
                ? [
                    `${photoId}'s photo record already pins ${assetRevision}, though the inbox last pinned ${unexplained}, so nothing in the working layer changed. Nothing on record shows a confirm of this item put it there: a rollback, a photos edit, and a confirm whose event a crash lost all leave it this way.`,
                    `So it is recorded as confirmed with nothing to put back, and leaving it in draft later keeps ${assetRevision}. To use ${unexplained} again, set assetRevision back with photos edit ${photoId}.`,
                ]
                : again
                    ? [`${photoId}'s photo record already pins ${assetRevision}, as the last confirm left it, so nothing in the working layer changed. It is recorded as confirmed in place of ${fromRevision}, which that confirm replaced and leaving it in draft puts back.`]
                    : [`${photoId}'s photo record already pins ${assetRevision}, so nothing in the working layer changed, and leaving it in draft later puts nothing back.`];
        const next = decided(step, input, { action: 'confirm', writes, ...(fromRevision !== assetRevision ? { fromRevision } : {}) }, 'approved');
        return { event: next, notes };
    });
}

/**
 * Leave in draft. Any event but a replacement is #14's defer. A replacement
 * keeps the revision the photo record pinned before it: when this item's
 * confirm is the inbox's latest pin and the record still pins the item's
 * bytes, the record goes back to the revision the confirm replaced. That
 * write goes through writeAuthoredRecord() under the authored lock, with
 * compare-and-swap, once that revision's set checks out. A record that has
 * moved since the confirm is refused. A record on the item's bytes that no
 * confirm of the item explains is deferred with no write, and says so, and
 * so is one a later pin set there, such as another item's Leave in draft
 * putting back these bytes. draftPlan() in pins.ts decides, and reopen and
 * `curation show` describe the same plan.
 */
export function leaveInDraft(input: ActionInput & { reason?: string; faults?: ConfirmFaults }): Promise<ActionOutcome> {
    return act(input, async (step) => {
        const { event } = step;
        requireStatus(event, ['open', 'failed'], 'deferred');
        const defer = (notes: string[], extra: { writes?: WrittenRecord[]; fromRevision?: string } = {}): Change => ({
            event: decided(step, input, { action: 'defer', ...(input.reason ? { reason: input.reason } : {}), ...extra }, 'deferred'),
            notes,
        });
        if (event.type !== 'replacement' || event.photoId === null || event.assetRevision === null) return defer(['Left in draft.']);
        const photoId = event.photoId;
        const revision = event.assetRevision;
        const root = path.resolve(input.root);
        const registry = await readRegistryOrFail(root);
        const record = await readAuthored<AuthoredPhoto>(root, 'photo', photoId);
        // Reopen's note and curation show describe this same plan (pins.ts), so they promise what this does.
        const plan = draftPlan(event, record?.assetRevision ?? null, record === null ? null : await latestPin(root, registry, photoId));
        switch (plan.kind) {
            case 'plain':
                return defer(['Left in draft.']);
            case 'no-record':
                return defer([`Left in draft. ${photoId} has no photo record yet, so no revision of it is pinned.`]);
            case 'moved':
                return fail('stale', `${photoId}'s photo record pins ${plan.pinned} now, not ${revision} as this item's confirm left it, so leaving it in draft can't tell what to put back. Show it again and review it. Nothing was written.`);
            case 'back-already':
                return defer([`Left in draft. ${photoId}'s photo record is back on ${plan.putBack} already.`], { fromRevision: plan.putBack });
            case 'keeps-other':
                return defer([`Left in draft. ${photoId}'s photo record keeps ${plan.pinned}.`]);
            case 'unexplained':
                // The record pins these bytes with no pin of the inbox's to say so: a hand edit, a #15 rollback, or a confirm whose event a crash lost.
                // Nothing on record tells those apart, so nothing is guessed and nothing is written.
                return defer([
                    `Left in draft. ${photoId}'s photo record already pins ${revision}, by an edit or rollback this item didn't make, or a confirm of it that was never recorded, so nothing was put back.${plan.pin ? ` The inbox last pinned ${plan.pin.revision}.` : ''} The draft keeps ${revision}, and the next photos publish ships it.`,
                ]);
            case 'keeps': {
                // This item's last confirm recorded nothing to put back, or a later pin, such as another item's Leave in draft, set the record on these bytes.
                const why = plan.own ? 'as it did before this item\'s last confirm, which recorded nothing to put back' : `as ${plan.pin.eventId}'s ${plan.pin.action} set it`;
                return defer([`Left in draft. ${photoId}'s photo record pins ${revision}, ${why}, so the draft keeps it.`]);
            }
            case 'put-back':
                break;
        }
        const putBack = plan.putBack;
        const candidate = candidateOf(registry, photoId, putBack);
        if (candidate.state !== 'ready') {
            fail('refused', `${putBack}, the revision to put back, has no ready derivative set, so leaving it in draft can't pin it again. The photo record keeps ${revision}. Nothing was written.`);
        }
        const profileId = (candidate as { profileId: string }).profileId;
        await requireSet(root, { photoId, assetRevision: putBack, profileId }, 'put back');

        const writes: WrittenRecord[] = [];
        await input.faults?.beforeAuthoredLock?.();
        await underAuthoredLock(root, step, input, 'leave in draft', async (authored) => {
            const current = await readAuthored<AuthoredPhoto>(root, 'photo', photoId);
            if (current === null || current.assetRevision !== revision) {
                fail('stale', `${photoId}'s photo record moved while leaving it in draft waited for the authored lock. Show it again and review it. Nothing was written.`);
            }
            await input.faults?.beforeWrite?.();
            writes.push(await pinRecord(current as AuthoredPhoto, putBack, profileId, step, input, authored, root));
            await input.faults?.afterWrite?.();
        });
        return defer([
            `Left in draft: ${photoId}'s photo record is back on ${putBack}, in place of ${revision}. Its series, position, title, description, and story stay as they were. The next photos publish ships ${putBack}, not ${revision}.`,
        ], { writes, fromRevision: putBack });
    });
}
