import path from 'node:path';
import { applySeriesOp, applySequenceOp, sequenceContext, type Consequence } from '../catalog/sequence';
import { hashValue, stampsOf } from '../catalog/review';
import type { AuthoredPhoto } from '../catalog/types';
import { readActivePointer, readAuthoredSeries } from '../catalog/working-layer';
import { AUTHORED_LEASE_MS, AUTHORED_LOCK, AUTHORED_WAIT_MS, AuthoredWriteError, writeAuthoredRecord, type WriteAuthoredOptions } from '../catalog/working-layer-writer';
import { createDecision, isLibraryPath, writeDecision } from '../identity/decisions';
import { readRegistry } from '../identity/registry';
import { keyOf } from '../identity/scan';
import type { PhotoRecord, Registry } from '../identity/types';
import { readAssetManifest } from '../media/manifest';
import { assetDir } from '../media/path';
import type { AssetRef } from '../media/url';
import { LockTimeoutError, withLock, type LockContext } from '../storage/lock';
import { verifyDirectory } from '../storage/publish';
import { act, decided, fail, readAuthored, requireStatus, type ActionInput, type ActionOutcome, type Change, type Step, type WrittenRecord } from './actions';
import { candidateOf } from './candidates';
import type { CandidateFailure, CurationEvent } from './events';
import { pendingBindOf, pendingMergeOf } from './binds';
import { mergeBlockers, type MergeBlockers } from './holders';
import { draftPlan, latestPin } from './pins';
import { listEvents } from './repository';

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
 *
 * And #17's resolutions of a missing item, besides putting the file back,
 * for which the watcher closes the item (lib/curation/sources.ts):
 *
 * - "Bind an intentional replacement" writes #10's `bind` decision, giving
 *   the photo the file at a path: by default the other bytes found at its
 *   last path, which #10 reported as a new photo with `samePathAs`. The
 *   watcher's next pass applies it, #10 then reports `replaced`, and the
 *   photo's replacement item confirms the new bytes as any replacement's.
 *   Nothing binds on its own (#40's review: a guessed bind can merge an
 *   unrelated photo).
 * - "Archive after removing series references" takes the photo out of every
 *   series that lists it with #8's `remove`, under the `authored` lock, and
 *   writes #10's `archive` decision. That is the takedown: the active
 *   revision keeps showing the photo until a #13 publish leaves it out, and
 *   `photos publish --dry-run` lists it as removed first. Nothing is deleted.
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

/**
 * `fn` under the authored lock, once the active revision is still the one
 * reviewed. Lock and writer errors become action failures. When `fn` can
 * write more than one record, `landed` holds what it wrote so far, and a
 * failure after the first write says so and how to finish.
 */
async function underAuthoredLock(root: string, step: Step, input: ActionInput, what: string, fn: (authored: LockContext) => Promise<void>, landed?: { writes: readonly WrittenRecord[]; again: string }): Promise<void> {
    try {
        await withLock(AUTHORED_LOCK, { root, leaseMs: AUTHORED_LEASE_MS, waitMs: input.waitMs ?? AUTHORED_WAIT_MS }, async (authored) => {
            // A publish may have moved the active revision while this waited for the hold.
            if (((await readActivePointer(root))?.revisionId ?? null) !== step.active) {
                fail('stale', `The active revision moved while the ${what} waited for the authored lock. Show it again and review it. Nothing was written.`);
            }
            await fn(authored);
        });
    } catch (error) {
        const writes = landed?.writes ?? [];
        const after = writes.length > 0 ? ` ${writes.map((entry) => `${entry.record} v${entry.version}`).join(', ')} landed first. ${landed?.again}` : ' Nothing was written.';
        if (error instanceof LockTimeoutError) fail('locked', `The authored lock is busy.${after}${writes.length > 0 ? '' : ' Try again shortly.'}`, writes.length > 0 ? [...writes] : undefined);
        if (error instanceof AuthoredWriteError) {
            const code = error.code === 'VERSION_CONFLICT' || error.code === 'AUTHORED_LOCKED' || error.code === 'LOCK_NOT_HELD' ? 'stale' : error.code === 'DATA_ROOT_NOT_READY' ? 'not-ready' : 'damaged';
            fail(code, `${error.message}${after}`, writes.length > 0 ? [...writes] : undefined);
        }
        throw error;
    }
}

/**
 * The revision a confirm of `eventId` replaced, when the record's #16 stamp
 * on `assetRevision` shows that confirm wrote the bytes it pins, or null.
 * Leave in draft's put back writes a stamp naming the item too, but with the
 * revision it put back as `to`, so it never reads as the confirm.
 */
export function confirmStampOf(record: AuthoredPhoto, eventId: string, assetRevision: string): string | null {
    const stamp = record.review?.fields.assetRevision;
    if (!stamp || stamp.event?.id !== eventId || !stamp.asset || stamp.asset.to !== assetRevision || stamp.asset.from === assetRevision) return null;
    return record.assetRevision === assetRevision && stamp.valueHash === hashValue(assetRevision) ? stamp.asset.from : null;
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
        // This item's confirm wrote the record, by its #16 stamp, though no decision of the item records it: a crash between the two writes.
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
                const pin = await latestPin(root, registry, photoId);
                const own = pin !== null && pin.eventId === event.id && pin.action === 'confirm' && pin.revision === assetRevision;
                const stamped = confirmStampOf(record, event.id, assetRevision);
                if (stamped !== null) {
                    // #16's stamp shows a confirm of this item wrote the record, so keep what that confirm replaced, and leaving
                    // it in draft still puts that back. Confirmed again, as after a reopen, or once more after a crash between
                    // confirm's two writes. A #15 rollback's rebase or a hand edit that moved the record drops or breaks the
                    // stamp, so a record they put back on these bytes is never taken for this item's.
                    fromRevision = stamped;
                    again = own;
                    recovered = !own;
                } else if (own && pin.fromRevision && stampsOf(record).assetRevision?.origin === 'migration') {
                    // A record no tool has written since the stamps were added, so no stamp tells: the pins decide, as before.
                    fromRevision = pin.fromRevision;
                    again = true;
                } else if (pin && pin.revision !== assetRevision) {
                    // Pinned already, though the inbox last pinned another, and no stamp of this item's confirm: a #15 rollback's
                    // rebase, a photos edit, or a hand edit. Record no fromRevision, and leaving it in draft later puts nothing back.
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
                    : recovered
                        ? [`${photoId}'s photo record already pins ${assetRevision}: its review stamp shows a confirm of this item wrote it, in place of ${fromRevision}, and the item was never marked confirmed. So nothing in the working layer changed. It is recorded as confirmed in place of ${fromRevision}, which leaving it in draft puts back.`]
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

const MISSING_STATES = ['open', 'deferred', 'failed'] as const;

/** The missing item's photo in the registry, or a failure saying why it can't be settled this way. */
function missingPhoto(event: CurationEvent, registry: Registry, action: string): PhotoRecord {
    if (event.type !== 'missing') fail('refused', `Only a missing source is settled with ${action}. A ${event.type} event is settled another way.`);
    if (event.photoId === null) fail('refused', `The event ${event.id} names no photo. Nothing was written.`);
    const photoId = event.photoId as string;
    const photo = Object.hasOwn(registry.photos, photoId) ? registry.photos[photoId] : undefined;
    if (!photo) return fail('stale', `The registry no longer holds ${photoId}. Nothing was written.`);
    if (photo.mergedInto) fail('refused', `${photoId} was merged into ${photo.mergedInto}. Nothing was written.`);
    if (photo.sourceHealth === 'present' && photo.source.present) {
        fail('stale', `${photoId}'s source is back at ${photo.source.path}, so it isn't missing, and the watcher closes this item on its next pass. Nothing was written.`);
    }
    return photo;
}

/**
 * The open `new` items for other bytes at this photo's last path, which #10
 * marked with `samePathAs`, whose photo is still present there: a file gone
 * since links nothing.
 */
export async function linkedNewItems(root: string, photoId: string, registry: Registry): Promise<CurationEvent[]> {
    const { events } = await listEvents(root);
    return events.filter((event) => {
        if (event.type !== 'new' || !(MISSING_STATES as readonly string[]).includes(event.status) || event.derivedFacts.samePathAs !== photoId || event.photoId === null) return false;
        const photo = Object.hasOwn(registry.photos, event.photoId) ? registry.photos[event.photoId] : undefined;
        return photo !== undefined && photo.sourceHealth !== 'archived' && photo.mergedInto === undefined && photo.source.present && photo.source.path === event.derivedFacts.sourcePath;
    });
}

/** Why bind refuses a path #10 holds without listing the photo, worded for how many photos the hold names. */
export function holdRefusal(at: string, candidates: readonly string[], photoId: string): string {
    const doubt = candidates.length === 0
        ? `#10 holds ${at} without naming a photograph it might be, as it does when another file's name differs from it only by case or Unicode form, so it can't tell which file a bind would give ${photoId}.`
        : candidates.length === 1
            ? `#10 holds ${at} in doubt: it may still be ${candidates[0]}'s file, and a bind would merge ${candidates[0]} into ${photoId}.`
            : `#10 holds ${at} in doubt between ${candidates.join(' and ')}, so it can't tell whose file it is, and a bind would merge one of them into ${photoId}.`;
    return `${doubt} Settle that path's ambiguous item first, with photos identity bind or photos identity new, then bind again. Nothing was written.`;
}

/**
 * The owner-set fields of a photo record, by the names the bind note uses.
 * With MANAGED_PHOTO_FIELDS they cover authoredPhotoSchema, which a test
 * checks, so a new schema field has to be sorted into one or the other.
 */
export const OWNER_FIELDS = {
    alt: 'description',
    title: 'title',
    caption: 'caption',
    focalPoint: 'focal point',
    crop: 'crop',
    accent: 'accent',
    credit: 'credit',
    location: 'location',
    capturedAt: 'capture date',
} as const satisfies Partial<Record<keyof AuthoredPhoto, string>>;

/** The photo record fields the tools set: the record's identity, the asset revision draft:init pins, and the version and rebase fields. */
export const MANAGED_PHOTO_FIELDS = ['schemaVersion', 'version', 'baseRevisionId', 'conflicts', 'kind', 'id', 'assetRevision'] as const satisfies readonly (keyof AuthoredPhoto)[];

/** What the owner set on a photo record, which a merge would lose. Empty for the bare record draft:init writes. */
export function ownerCopyOf(record: AuthoredPhoto): string[] {
    return (Object.entries(OWNER_FIELDS) as [keyof typeof OWNER_FIELDS, string][])
        .filter(([field]) => record[field] !== undefined && record[field] !== null)
        .map(([field, name]) => (field === 'alt' && record.alt?.kind === 'decorative' ? 'decorative flag' : name));
}

interface BindPlan {
    /** The photo the decision names to merge, when #10 needs it named. */
    merge?: string;
    /** The photo #10 unbinds from the path instead, when its hold already lists both. */
    unbinds?: string;
    /** Whether the bytes at the path are a revision the missing photo has. */
    ownBytes: boolean;
    /** The merged photo's bare record, which the merge leaves unused. */
    bareRecord?: boolean;
}

/**
 * The bind decision #10's reconcile would accept for `photo` at `at`, or a
 * failure saying why it wouldn't, before anything is written. It follows
 * #10's rules (lib/identity/reconcile.ts, bind()):
 *
 * - A path #10's hold lists both the holder and the photo for is given up
 *   by the holder, which keeps its identity. The decision names no merge,
 *   since naming one there would retire the holder instead. A hold that
 *   doesn't list the photo is refused: #10 is unsure which other photo the
 *   file is, so the curator settles that first.
 * - Any other present holder must be named to merge, and #10 merges only a
 *   photo with one revision of its own, first seen at that path. This also
 *   refuses one a series or the active revision shows, which a merge would
 *   leave pointing at a retired photo, one a retained revision lists, which
 *   rollback could then never bring back, one whose photo record holds
 *   owner-set copy, which a merge would drop, and one a pending bind
 *   already merges. A bare record, as draft:init writes it, is left unused.
 * - Bytes the photo gave to another photo come back only with that photo merged.
 */
async function bindPlan(root: string, registry: Registry, photo: PhotoRecord, at: string): Promise<BindPlan> {
    const key = keyOf(at);
    const held = registry.holds.find((entry) => keyOf(entry.path) === key);
    const holder = Object.values(registry.photos).find((other) => other.photoId !== photo.photoId && other.source.present
        && other.sourceHealth !== 'archived' && other.mergedInto === undefined && other.source.key === key);
    // #10 binds only a file its last pass saw, so a path it hasn't seen would only be rejected later, out of sight.
    if (!holder && !held) {
        fail('refused', `The watcher hasn't seen a photograph at ${at}. Check the path, or wait for its next pass after copying the file. Nothing was written.`);
    }
    const bytes = held?.assetRevision ?? (holder as PhotoRecord).source.observedRevision;
    const own = photo.revisions[bytes];
    const plan: BindPlan = { ownBytes: own !== undefined && !own.reassignedTo };
    const givenAway = () => fail('refused', `${at} holds ${bytes}, which ${photo.photoId} gave to ${own?.reassignedTo}, so the watcher would refuse the bind. Nothing was written.`);
    // Said first when no merge could bring them back: only merging a holder whose one revision is these bytes does.
    const holderOwn = holder ? Object.values(holder.revisions).filter((revision) => !revision.reassignedTo) : [];
    if (own?.reassignedTo !== undefined && !(holderOwn.length === 1 && holderOwn[0].assetRevision === bytes)) givenAway();
    // A hold that doesn't list the photo is #10 unsure which other photo the file is, and a bind would merge one of them.
    if (held && !held.candidates.includes(photo.photoId)) {
        fail('refused', holdRefusal(at, held.candidates, photo.photoId));
    }
    let merged: string | null = null;
    if (holder) {
        if (held?.candidates.includes(holder.photoId) && held.candidates.includes(photo.photoId)) {
            plan.unbinds = holder.photoId;
        } else {
            const revisions = Object.values(holder.revisions).filter((revision) => !revision.reassignedTo);
            if (revisions.length !== 1 || keyOf(revisions[0].firstSeenPath) !== key) {
                fail('refused', `${at} is ${holder.photoId}, which has more than the one revision first seen there, so the watcher would refuse to merge it into ${photo.photoId}. Keep it as its own photograph, or bind another file. Nothing was written.`);
            }
            merged = revisions[0].assetRevision;
            const pending = await pendingMergeOf(root, holder.photoId).catch((error: unknown) => fail('damaged', `${(error as Error).message}. Nothing was written.`));
            if (pending) {
                fail('refused', `${holder.photoId} is already merged into ${pending.into} by the pending bind decision ${pending.decisionId}. Wait for the watcher's next pass. Nothing was written.`);
            }
            // A merged photo is retired: one that a series or the active revision shows would break them, a retained
            // revision that lists it could no longer be rolled back to, and its photo record's copy would be dropped.
            const found = await mergeBlockers(root, holder.photoId);
            if ('unknown' in found) fail('damaged', `${found.unknown.message.replace(' Nothing was deleted.', '')} So nothing shows whether ${holder.photoId} is in use. Nothing was written.`);
            const { shown, active, series, retained, record } = found as MergeBlockers;
            if (active !== null) {
                fail('refused', `${at} is ${holder.photoId}, which ${shown.join(' and ')} already ${shown.length === 1 ? 'shows' : 'show'}. A photograph visitors see can't be merged, even once it's taken out: the revision that shows it stays one photos rollback can go back to, which a merge would break. Keep it as its own photograph, or bind another file. Nothing was written.`);
            }
            if (series.length > 0) {
                fail('refused', `${at} is ${holder.photoId}, which ${shown.join(' and ')} already ${shown.length === 1 ? 'lists' : 'list'} in the draft. Take it out of ${series.join(' and ')} first, or keep it as its own photograph. Even then a bind is refused if a revision photos rollback can go back to lists it. Nothing was written.`);
            }
            if (retained.length > 0) {
                const named = retained.length === 1 ? `the retained catalog revision ${retained[0]} lists` : `the retained catalog revisions ${retained.join(', ')} list`;
                fail('refused', `${at} is ${holder.photoId}, which ${named}. A merge retires it and moves its asset revision to ${photo.photoId}, so photos rollback could never bring ${retained.length === 1 ? 'that revision' : 'those revisions'} back. Keep it as its own photograph, or bind another file. Nothing was written.`);
            }
            if (record) {
                const authored = await readAuthored<AuthoredPhoto>(root, 'photo', holder.photoId);
                const copy = authored ? ownerCopyOf(authored) : [];
                if (copy.length > 0) {
                    fail('refused', `${at} is ${holder.photoId}, which has a photo record in the draft with the owner's ${copy.join(', ')}. A merge retires it and drops that copy. Keep it as its own photograph, or bind another file. Nothing was written.`);
                }
                plan.bareRecord = true;
            }
            plan.merge = holder.photoId;
        }
    }
    if (own?.reassignedTo !== undefined && merged !== bytes) givenAway();
    return plan;
}

/**
 * Bind an intentional replacement: write #10's `bind` decision giving the
 * missing photo the file at `path`, or at the one linked item's path, in the
 * form #10 accepts (bindPlan()). Writes only the decision and the event.
 * Approving a photo the decision merges is refused until the watcher has
 * applied or rejected it (lib/curation/actions.ts, approveEvent()).
 */
export function bindReplacement(input: ActionInput & { path?: string; reason?: string }): Promise<ActionOutcome> {
    return act(input, async (step) => {
        const { event } = step;
        requireStatus(event, MISSING_STATES, 'bound');
        const root = path.resolve(input.root);
        const registry = await readRegistryOrFail(root);
        const photo = missingPhoto(event, registry, 'bind');
        if (photo.sourceHealth === 'archived') fail('refused', `${photo.photoId} is archived, so nothing can be bound to it. Nothing was written.`);

        let target = input.path;
        if (target === undefined) {
            const linked = await linkedNewItems(root, photo.photoId, registry);
            if (linked.length === 0) {
                fail('needs-choice', `No file is linked to ${photo.photoId}. Other bytes at its last path link here by themselves; for a file anywhere else, pass --path <library path>. Nothing was written.`);
            }
            if (linked.length > 1) {
                fail('needs-choice', `${linked.length} files are linked to ${photo.photoId}: ${linked.map((item) => item.derivedFacts.sourcePath).join(', ')}. Pass --path with the one that replaces it. Nothing was written.`);
            }
            target = linked[0].derivedFacts.sourcePath;
        }
        const at = target as string;
        if (!isLibraryPath(at)) fail('needs-choice', `${at} is not a path inside the library. Nothing was written.`);
        const plan = await bindPlan(root, registry, photo, at);
        const decision = createDecision({
            type: 'bind',
            path: at,
            photoId: photo.photoId,
            ...(plan.merge === undefined ? {} : { merge: plan.merge }),
            actor: input.actor,
            reason: input.reason ?? `curation ${event.id}`,
        }, { clock: input.clock });
        await writeDecision(root, decision);
        const next = decided(step, input, { action: 'bind', path: at, identityDecisionId: decision.decisionId, ...(input.reason ? { reason: input.reason } : {}) }, event.status);
        const holder = plan.merge !== undefined
            ? `, merging ${plan.merge}, the photo #10 made of that file, into it`
            : plan.unbinds !== undefined ? `, and ${plan.unbinds}, which #10 holds that path in doubt for, gives it up and keeps its own identity` : '';
        return {
            event: next,
            notes: [
                `Wrote the bind decision ${decision.decisionId}. If the watcher accepts it, on its next pass unless the file is still changing, ${at} becomes ${photo.photoId}'s source${holder}, and this item closes. If it refuses it, curation show ${event.id} says why.`,
                plan.ownBytes
                    ? `${at} holds ${photo.photoId}'s own bytes, so nothing new needs confirming. Visitors keep the current image until photos publish runs.`
                    : 'A replacement item opens for the new bytes. Confirm the new asset revision there once all its derivatives succeed. Visitors keep the current image until photos publish runs.',
                ...(plan.bareRecord && plan.merge
                    ? [`${plan.merge}'s photo record holds nothing the owner set, as draft:init writes it, so the merge leaves it unused in authored/photos/. Nothing is deleted.`]
                    : []),
            ],
        };
    });
}

function consequenceText(consequence: Consequence): string {
    switch (consequence.kind) {
        case 'cover-cleared':
            return `${consequence.seriesId} has no cover now. A published series needs one, so set another before publishing.`;
        case 'focal-point-dropped':
            return `${consequence.seriesId}'s cover focal point went with it.`;
        case 'opening-cleared':
            return `${consequence.seriesId} has no opening photograph now.`;
        case 'chapter-anchor-moved':
            return `${consequence.seriesId}'s chapter ${consequence.chapterId} starts at ${consequence.toPhotoId} now.`;
    }
}

/**
 * Archive after removing series references: take the missing photo out of
 * every series that lists it, any visibility, with #8's `remove`, then write
 * #10's `archive` decision. Every removal is checked before any is written,
 * so a refused one leaves the working layer as it was. Leaves `catalog/`
 * byte-identical and deletes nothing.
 */
export function archiveMissing(input: ActionInput & { reason?: string; faults?: ConfirmFaults }): Promise<ActionOutcome> {
    return act(input, async (step) => {
        const { event } = step;
        requireStatus(event, MISSING_STATES, 'archived');
        if (input.expectedBase === undefined && step.active !== null) {
            fail('needs-choice', `archive needs --base ${step.active}, the active revision it was reviewed against. Show it again if that isn't the one. Nothing was written.`);
        }
        const root = path.resolve(input.root);
        // The bind writes under the curation lock this holds, and the watcher commits the registry before it files
        // the decision as applied, so this looks first: a bind still waiting shows here, and one applied since shows
        // in the registry read below as the photo present again.
        if (event.type === 'missing' && event.photoId !== null) {
            const bind = await pendingBindOf(root, event.photoId).catch((error: unknown) => fail('damaged', `${(error as Error).message}. Nothing was written.`));
            if (bind) {
                fail('refused', `A bind for ${event.photoId} waits for the watcher's next pass: the decision ${bind.decisionId} gives it ${bind.path}. Archive after the watcher applies it, or once it refuses it; curation show ${event.id} says which. Nothing was written.`);
            }
        }
        const registry = await readRegistryOrFail(root);
        const photo = missingPhoto(event, registry, 'archive');
        const photoId = photo.photoId;

        const writes: WrittenRecord[] = [];
        const removedFrom: string[] = [];
        const consequences: string[] = [];
        const landed = () => writes.map((entry) => `${entry.record} v${entry.version}`).join(', ');
        await input.faults?.beforeAuthoredLock?.();
        await underAuthoredLock(root, step, input, 'archive', async (authored) => {
            const all = await readAuthoredSeries(root).catch((error: unknown) => fail('damaged', `The series can't be read: ${(error as Error).message}. Nothing was written.`));
            const unreadable = all.problems.filter((problem) => problem.kind === 'series');
            if (unreadable.length > 0) {
                fail('damaged', `These series records can't be read, so nothing shows whether they list ${photoId}: ${unreadable.map((problem) => problem.id).join(', ')}. Fix them first. Nothing was written.`);
            }
            const listing = all.series.filter((series) => series.photoIds.includes(photoId)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
            const context = sequenceContext({ registry, series: all.series });
            for (const series of listing) {
                const checked = applySeriesOp(series, { kind: 'remove', seriesId: series.id, photoId }, context);
                if (!checked.ok) fail('refused', `${checked.error.message} (${checked.error.code}). Nothing was written.`);
            }
            await input.faults?.beforeWrite?.();
            for (const series of listing) {
                const review = { baseRevisionId: step.active, event: { id: event.id, version: event.version }, actor: input.actor, reviewedAt: step.at };
                const result = await applySequenceOp({ dataRoot: root }, { kind: 'remove', seriesId: series.id, photoId }, { expectedVersion: series.version, actor: { kind: 'inbox-approval', ref: event.id }, lock: authored, review });
                if (!result.ok) {
                    const code = result.error.code === 'version-conflict' || result.error.code === 'authored-locked' ? 'stale' : 'refused';
                    // Every removal was checked first, so only a writer past its lease or a hand edit gets here.
                    fail(code, writes.length > 0
                        ? `${landed()} landed, but ${series.id} did not change: ${result.error.message} (${result.error.code}). The event is unchanged. Archive again to finish it.`
                        : `${result.error.message} (${result.error.code}). Nothing was written.`, writes);
                }
                if (result.ok && result.changed) {
                    writes.push({ record: `series:${series.id}`, version: result.version });
                    removedFrom.push(series.id);
                    consequences.push(...result.consequences.map(consequenceText));
                }
            }
            await input.faults?.afterWrite?.();
        }, { writes, again: 'Archive again to finish it.' });

        let decisionId: string | undefined;
        if (photo.sourceHealth !== 'archived') {
            const decision = createDecision({ type: 'archive', photoId, actor: input.actor, reason: input.reason ?? `curation ${event.id}` }, { clock: input.clock });
            await writeDecision(root, decision);
            decisionId = decision.decisionId;
        }
        const archived = decisionId ? `wrote the archive decision ${decisionId}, which the watcher applies on its next pass` : `${photoId} was already archived`;
        const notes = [
            removedFrom.length > 0 ? `Took ${photoId} out of ${removedFrom.join(', ')} in the draft, and ${archived}.` : `No series lists ${photoId}, so the draft didn't change, and ${archived}.`,
            ...consequences,
            'This is the takedown: visitors keep seeing it until photos publish runs, and photos publish --dry-run lists it as removed first. Copies already served as immutable can stay in browsers and caches. Nothing was deleted.',
        ];
        const next = decided(step, input, { action: 'archive', writes, ...(decisionId ? { identityDecisionId: decisionId } : {}), ...(input.reason ? { reason: input.reason } : {}) }, 'approved');
        return { event: next, notes };
    });
}
