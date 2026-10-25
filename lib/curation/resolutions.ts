import path from 'node:path';
import type { AuthoredPhoto } from '../catalog/types';
import { readActivePointer } from '../catalog/working-layer';
import { AUTHORED_LEASE_MS, AUTHORED_LOCK, AUTHORED_WAIT_MS, AuthoredWriteError, writeAuthoredRecord, type WriteAuthoredOptions } from '../catalog/working-layer-writer';
import { readRegistry } from '../identity/registry';
import type { Registry } from '../identity/types';
import { readAssetManifest } from '../media/manifest';
import { assetDir } from '../media/path';
import type { AssetRef } from '../media/url';
import { LockTimeoutError, withLock, type LockContext } from '../storage/lock';
import { verifyDirectory } from '../storage/publish';
import { act, decided, fail, readAuthored, requireStatus, type ActionInput, type ActionOutcome, type Change, type Step, type WrittenRecord } from './actions';
import { candidateOf, readUsableEvent, replacementEventIds } from './candidates';
import { eventIdOf, eventKey, type CandidateFailure, type CurationEvent } from './events';

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
 * one. A confirm whose record write landed before a crash lost its event is
 * put back the same way, from what the inbox last pinned.
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

/**
 * A revision the inbox set on a photo record: an approval of its new item,
 * a confirm of a replacement, or a Leave in draft that put a confirm's
 * revision back.
 */
export interface Pin {
    revision: string;
    at: string;
    eventId: string;
    action: 'approve' | 'confirm' | 'defer';
    /** For a confirm: the revision the record pinned before it. */
    fromRevision?: string;
}

/** Every pin `events` record for `photoId`, oldest first. */
export function pinsOf(events: readonly CurationEvent[], photoId: string): Pin[] {
    const pins: Pin[] = [];
    for (const event of events) {
        if (event.photoId !== photoId || event.assetRevision === null) continue;
        for (const decision of event.decisions) {
            const base = { at: decision.at, eventId: event.id };
            if (event.type === 'new' && decision.action === 'approve') pins.push({ ...base, action: 'approve', revision: event.assetRevision });
            else if (event.type === 'replacement' && decision.action === 'confirm') {
                pins.push({ ...base, action: 'confirm', revision: event.assetRevision, ...(decision.fromRevision ? { fromRevision: decision.fromRevision } : {}) });
            } else if (event.type === 'replacement' && decision.action === 'defer' && decision.fromRevision) {
                pins.push({ ...base, action: 'defer', revision: decision.fromRevision });
            }
        }
    }
    return pins.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** The newest pin the inbox records for `photoId`, or null for none. It reads only the items that can pin it: each revision's new and replacement items. */
async function latestPin(root: string, registry: Registry, photoId: string): Promise<Pin | null> {
    const photo = Object.hasOwn(registry.photos, photoId) ? registry.photos[photoId] : undefined;
    const events: CurationEvent[] = [];
    for (const assetRevision of Object.keys(photo?.revisions ?? {})) {
        for (const id of [eventIdOf(eventKey('new', { photoId, assetRevision, key: `new:${photoId}:${assetRevision}` })), ...replacementEventIds(photoId, assetRevision)]) {
            const event = await readUsableEvent(root, id);
            if (event) events.push(event);
        }
    }
    return pinsOf(events, photoId).at(-1) ?? null;
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
        let recovered = false;
        await input.faults?.beforeAuthoredLock?.();
        await underAuthoredLock(root, step, input, 'confirm', async (authored) => {
            const existing = await readAuthored<AuthoredPhoto>(root, 'photo', photoId);
            if (existing === null) {
                fail('refused', `${photoId} has no photo record in the working layer, so no revision of it is pinned to replace. Approve its new item first. Nothing was written.`);
            }
            const record = existing as AuthoredPhoto;
            fromRevision = record.assetRevision;
            if (record.assetRevision === assetRevision) {
                // Pinned already, though the inbox last pinned another: a confirm whose event a crash lost. Keep what it replaced.
                const pin = await latestPin(root, registry, photoId);
                if (pin && pin.revision !== assetRevision) {
                    fromRevision = pin.revision;
                    recovered = true;
                }
                return;
            }
            await input.faults?.beforeWrite?.();
            writes.push(await pinRecord(record, assetRevision, profileId, step, input, authored, root));
            await input.faults?.afterWrite?.();
        });

        const notes = writes.length > 0
            ? [`Confirmed ${assetRevision} for ${photoId} in the draft, in place of ${fromRevision}. Its series, position, title, description, and story stay as they were. Visitors keep the current image until photos publish runs.`]
            : recovered
                ? [`${photoId}'s photo record already pins ${assetRevision}, though the inbox last pinned ${fromRevision}, so nothing in the working layer changed. It is recorded as confirmed in place of ${fromRevision}, which leaving it in draft puts back.`]
                : [`${photoId}'s photo record already pins ${assetRevision}, so nothing in the working layer changed.`];
        const next = decided(step, input, { action: 'confirm', writes, ...(fromRevision !== assetRevision ? { fromRevision } : {}) }, 'approved');
        return { event: next, notes };
    });
}

/**
 * Leave in draft. Any event but a replacement is #14's defer. A replacement
 * keeps the revision the photo record pinned before it: when this item's
 * confirm is the inbox's latest pin and the record still pins the item's
 * bytes, or the record pins them with no confirm recorded, as a crash
 * between confirm's two writes leaves it, the record goes back to the
 * revision the confirm replaced. That write goes through writeAuthoredRecord()
 * under the authored lock, with compare-and-swap, once that revision's set
 * checks out. A record that has moved since the confirm is refused.
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
        if (record === null) return defer([`Left in draft. ${photoId} has no photo record yet, so no revision of it is pinned.`]);
        const pin = await latestPin(root, registry, photoId);
        const own = pin && pin.eventId === event.id && pin.action === 'confirm' ? pin : null;

        if (record.assetRevision !== revision) {
            if (own?.fromRevision && record.assetRevision !== own.fromRevision) {
                fail('stale', `${photoId}'s photo record pins ${record.assetRevision} now, not ${revision} as this item's confirm left it, so leaving it in draft can't tell what to put back. Show it again and review it. Nothing was written.`);
            }
            if (own?.fromRevision) return defer([`Left in draft. ${photoId}'s photo record is back on ${own.fromRevision} already.`], { fromRevision: own.fromRevision });
            return defer([`Left in draft. ${photoId}'s photo record keeps ${record.assetRevision}.`]);
        }

        const putBack = own ? own.fromRevision ?? null : pin && pin.revision !== revision ? pin.revision : null;
        if (putBack === null) {
            const why = own
                ? 'as it did before this item was confirmed'
                : pin
                    ? `as ${pin.eventId}'s ${pin.action} set it`
                    : 'and the inbox holds no earlier revision of it to put back';
            return defer([`Left in draft. ${photoId}'s photo record pins ${revision}, ${why}, so the draft keeps it.`]);
        }
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
            `Left in draft: ${photoId}'s photo record is back on ${putBack}, in place of ${revision}${own ? '' : ', which a confirm wrote without recording it'}. Its series, position, title, description, and story stay as they were. The next photos publish ships ${putBack}, not ${revision}.`,
        ], { writes, fromRevision: putBack });
    });
}
