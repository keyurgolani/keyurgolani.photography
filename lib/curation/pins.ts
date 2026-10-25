import { hashValue } from '../catalog/review';
import type { AuthoredPhoto } from '../catalog/types';
import { readRegistry } from '../identity/registry';
import type { Registry } from '../identity/types';
import { readUsableEvent, replacementEventIds } from './candidates';
import { eventIdOf, eventKey, type CurationEvent } from './events';

/**
 * #17: the revisions the inbox set on a photo record, and what Leave in
 * draft does with a replacement item because of them. leaveInDraft() acts on
 * draftPlan(), and reopen's note and `curation show` describe the same plan
 * with draftPlanText(), so what they promise is what defer does. Only the CLI
 * and the curator process load this module.
 */

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
export async function latestPin(root: string, registry: Registry, photoId: string): Promise<Pin | null> {
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

/**
 * What Leave in draft does with an item. Only `put-back` writes: when this
 * item's confirm is the inbox's latest pin of the photo, carries what it
 * replaced, and the record still pins the item's bytes. Any later pin, a
 * later item's Leave in draft included, means this confirm no longer
 * explains the record, so nothing is put back and nothing is guessed.
 */
export type DraftPlan =
    /** Not a replacement of a known photo and revision: #14's defer. */
    | { kind: 'plain' }
    | { kind: 'no-record'; photoId: string }
    /** The record pins `pinned`, which is neither the item's bytes nor what its confirm replaced. Defer refuses. */
    | { kind: 'moved'; photoId: string; revision: string; pinned: string }
    /** The record is back on what this item's confirm replaced already. */
    | { kind: 'back-already'; photoId: string; putBack: string }
    /** The record pins another revision, which defer keeps. */
    | { kind: 'keeps-other'; photoId: string; pinned: string }
    /**
     * The record pins the item's bytes, and no pin of the inbox's says so: a hand edit, a #15 rollback, or a confirm
     * whose event a crash lost. `stampedFrom` is what that lost confirm replaced, when #16's stamp shows it.
     */
    | { kind: 'unexplained'; photoId: string; revision: string; pin: Pin | null; stampedFrom?: string }
    /** The record pins the item's bytes as the latest pin set them, and that pin records nothing to put back. `own` when it is this item's confirm. */
    | { kind: 'keeps'; photoId: string; revision: string; pin: Pin; own: boolean }
    | { kind: 'put-back'; photoId: string; revision: string; putBack: string };

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

/**
 * The plan for `event`, given the revision its photo record pins (null for no
 * record) and the inbox's latest pin of the photo. `stampedFrom` is what a
 * confirm of this item replaced, by the record's stamp (confirmStampOf()),
 * which only an `unexplained` plan carries, so its note can say so. Leave in
 * draft still puts nothing back there: confirm again records it first.
 */
export function draftPlan(event: CurationEvent, pinned: string | null, pin: Pin | null, stampedFrom?: string | null): DraftPlan {
    if (event.type !== 'replacement' || event.photoId === null || event.assetRevision === null) return { kind: 'plain' };
    const photoId = event.photoId;
    const revision = event.assetRevision;
    if (pinned === null) return { kind: 'no-record', photoId };
    const own = pin && pin.eventId === event.id && pin.action === 'confirm' ? pin : null;
    if (pinned !== revision) {
        if (own?.fromRevision && pinned !== own.fromRevision) return { kind: 'moved', photoId, revision, pinned };
        if (own?.fromRevision) return { kind: 'back-already', photoId, putBack: own.fromRevision };
        return { kind: 'keeps-other', photoId, pinned };
    }
    if (!own && pin?.revision !== revision) return { kind: 'unexplained', photoId, revision, pin, ...(stampedFrom ? { stampedFrom } : {}) };
    if (!own?.fromRevision) return { kind: 'keeps', photoId, revision, pin: pin as Pin, own: own !== null };
    return { kind: 'put-back', photoId, revision, putBack: own.fromRevision };
}

/** draftPlan() read from the data root: the photo record through `readRecord`, the latest pin through the registry. */
export async function readDraftPlan(root: string, event: CurationEvent, readRecord: (photoId: string) => Promise<AuthoredPhoto | null>, registry?: Registry): Promise<DraftPlan> {
    if (event.type !== 'replacement' || event.photoId === null || event.assetRevision === null) return { kind: 'plain' };
    const record = await readRecord(event.photoId);
    if (record === null) return draftPlan(event, null, null);
    return draftPlan(event, record.assetRevision, await latestPin(root, registry ?? (await readRegistry(root)), event.photoId), confirmStampOf(record, event.id, event.assetRevision));
}

/**
 * What Leave in draft (defer) would do, in one sentence, for reopen's note
 * and `curation show`. `replaced` is what this item's last confirm replaced,
 * named as the way back when defer no longer puts it back. Null for `plain`.
 */
export function draftPlanText(plan: DraftPlan, replaced?: string): string | null {
    switch (plan.kind) {
        case 'plain':
            return null;
        case 'no-record':
            return `Leaving it in draft (defer) writes nothing: ${plan.photoId} has no photo record yet.`;
        case 'moved':
            return `Leaving it in draft (defer) refuses for now: ${plan.photoId}'s photo record pins ${plan.pinned}, not ${plan.revision} as this item's confirm left it, so it can't tell what to put back.`;
        case 'back-already':
            return `Leaving it in draft (defer) keeps ${plan.putBack}: ${plan.photoId}'s photo record is back on it already.`;
        case 'keeps-other':
            return `Leaving it in draft (defer) keeps ${plan.pinned}, the revision ${plan.photoId}'s photo record pins.`;
        case 'unexplained':
            return plan.stampedFrom
                ? `Leaving it in draft (defer) keeps ${plan.revision}: the inbox records no confirm of this item, though its review stamp shows one put ${plan.photoId}'s photo record there in place of ${plan.stampedFrom}. Run curation confirm again to record what it replaced, and then defer puts that back.`
                : `Leaving it in draft (defer) keeps ${plan.revision}: neither the inbox nor its review stamp shows a confirm of this item put ${plan.photoId}'s photo record there, so it puts nothing back.`;
        case 'keeps': {
            if (plan.own) return 'Its last confirm found the record on these bytes already and recorded nothing to put back, so leaving it in draft (defer) keeps them too.';
            const back = replaced && replaced !== plan.revision ? ` To use ${replaced} again, which this item's confirm replaced, set assetRevision with photos edit ${plan.photoId}.` : '';
            return `Leaving it in draft (defer) keeps ${plan.revision}: ${plan.pin.eventId}'s ${plan.pin.action} set ${plan.photoId}'s photo record on it last, not a confirm of this item, so it puts nothing back.${back}`;
        }
        case 'put-back':
            return `Leaving it in draft (defer) puts back ${plan.putBack}, the revision this item's confirm replaced.`;
    }
}

/** What this item's last confirm replaced, if it recorded one. */
export function replacedBy(event: CurationEvent): string | undefined {
    return event.decisions.findLast((decision) => decision.action === 'confirm')?.fromRevision;
}
