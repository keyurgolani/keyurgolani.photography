import path from 'node:path';
import { applySequenceOp, applySeriesOp, sequenceContext, type SeriesOp } from '../catalog/sequence';
import type { AuthoredAlt, AuthoredPhoto, AuthoredSeries } from '../catalog/types';
import { readActivePointer, readAuthoredRecord, readAuthoredSeries } from '../catalog/working-layer';
import { AUTHORED_LEASE_MS, AUTHORED_LOCK, AUTHORED_WAIT_MS, AuthoredWriteError, writeAuthoredRecord } from '../catalog/working-layer-writer';
import { createDecision, writeDecision } from '../identity/decisions';
import { readRegistry } from '../identity/registry';
import type { Registry } from '../identity/types';
import { dataRootStatus } from '../storage/config';
import { LockTimeoutError, withLock, type LockContext } from '../storage/lock';
import type { CurationDecision, CurationEvent, CurationEventStatus, CuratorDescription, CuratorEdits, Placement } from './events';
import { photoHolders } from './holders';
import { EventMovedError, EventUnusableError, readEvent, withCurationLock, writeEvent } from './repository';

/**
 * The curator's actions on an inbox event: edit, approve, defer, dismiss,
 * retry, and reopen. Each one runs under the `curation` lock, checks that the
 * event is still at the version the curator reviewed and the active revision
 * is still the one they reviewed against, and writes nothing when either
 * moved. None of them touches `catalog/`, so none changes what visitors see.
 *
 * Approve is the only one that writes the working layer: under the
 * `authored` lock too, it writes the photo record through #13's
 * writeAuthoredRecord() and places it through #8's applySequenceOp(), each
 * with compare-and-swap, and copies no EXIF or other derived fact into them.
 * Retry writes a #10 `retry` decision for the next pass. Only the CLI and the
 * curator process load this module; the watcher can't (eslint.config.js and
 * the import-graph test).
 */

export type ActionErrorCode = 'not-found' | 'refused' | 'needs-choice' | 'stale' | 'locked' | 'not-ready' | 'damaged';

/** Exit codes for each failure, as the `photos` commands use them: 1 refused, 2 usage, 3 conflict or stop, 4 storage. */
export const ACTION_EXIT_CODES: Record<ActionErrorCode, 1 | 2 | 3 | 4> = {
    'not-found': 1,
    refused: 1,
    'needs-choice': 2,
    stale: 3,
    locked: 3,
    'not-ready': 3,
    damaged: 4,
};

export interface WrittenRecord {
    record: string;
    version: number;
}

export type ActionOutcome =
    | { ok: true; event: CurationEvent; notes: string[] }
    | { ok: false; code: ActionErrorCode; message: string; /** Working-layer writes that landed before the failure. */ writes?: WrittenRecord[] };

export interface ActionInput {
    root: string;
    eventId: string;
    /** The event version the curator reviewed. */
    expectedVersion: number;
    /** The active revision the curator reviewed against, null for none yet. Undefined takes whatever is active. */
    expectedBase?: string | null;
    /** Who acted, recorded as `reviewedBy`. */
    actor: string;
    clock?: () => number;
    /** How long to wait for each lock. */
    waitMs?: number;
}

/** What an edit or an approval sets. Undefined leaves a field as it is; a null `seriesId` is "Leave unassigned". */
export interface Choices {
    seriesId?: string | null;
    placement?: Placement;
    /** Null clears an edited description. */
    description?: CuratorDescription | null;
}

class ActionFailure extends Error {
    readonly code: ActionErrorCode;
    readonly writes?: WrittenRecord[];

    constructor(code: ActionErrorCode, message: string, writes?: WrittenRecord[]) {
        super(message);
        this.code = code;
        this.writes = writes;
    }
}

const fail = (code: ActionErrorCode, message: string, writes?: WrittenRecord[]): never => {
    throw new ActionFailure(code, message, writes);
};

interface Step {
    event: CurationEvent;
    active: string | null;
    at: string;
    hold: LockContext;
}

type Change = { event: CurationEvent; notes?: string[] };

/** The checks every action shares, then `change`, then the event write, all under the curation lock. */
async function act(input: ActionInput, change: (step: Step) => Promise<Change>): Promise<ActionOutcome> {
    const root = path.resolve(/*turbopackIgnore: true*/ input.root);
    const status = dataRootStatus({ versioned: true, root });
    if (status.state !== 'ready') return { ok: false, code: 'not-ready', message: `The data root is ${status.state}. Nothing was written.` };
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) return { ok: false, code: 'needs-choice', message: '--version takes the event version list or show printed.' };
    try {
        return await withCurationLock(root, { waitMs: input.waitMs }, async (hold) => {
            let event: CurationEvent | null;
            try {
                event = await readEvent(root, input.eventId);
            } catch (error) {
                if (error instanceof EventUnusableError) return fail('damaged', `${error.message}. Nothing was written.`);
                throw error;
            }
            if (event === null) return fail('not-found', `There is no event ${input.eventId}.`);
            if (event.version !== input.expectedVersion) {
                return fail('stale', `The event ${event.id} is at version ${event.version}, not ${input.expectedVersion}: it changed since it was shown. Show it again and review it. Nothing was written.`);
            }
            let active: string | null;
            try {
                active = (await readActivePointer(root))?.revisionId ?? null;
            } catch (error) {
                return fail('damaged', `The active pointer can't be read: ${(error as Error).message}. Nothing was written.`);
            }
            if (input.expectedBase !== undefined && input.expectedBase !== active) {
                return fail('stale', `The active revision is ${active ?? 'none yet'}, not ${input.expectedBase ?? 'none yet'}: a publish or rollback happened since it was shown. Show it again and review it. Nothing was written.`);
            }
            const at = new Date((input.clock ?? Date.now)()).toISOString();
            const { event: next, notes = [] } = await change({ event, active, at, hold });
            hold.signal.throwIfAborted();
            const written = await writeEvent(root, next, event.version, hold);
            return { ok: true as const, event: written, notes };
        });
    } catch (error) {
        if (error instanceof ActionFailure) return { ok: false, code: error.code, message: error.message, ...(error.writes ? { writes: error.writes } : {}) };
        if (error instanceof EventMovedError) return { ok: false, code: 'stale', message: `${error.message} Nothing more was written.` };
        if (error instanceof LockTimeoutError) return { ok: false, code: 'locked', message: `The ${error.lockName} lock is busy. Nothing was written. Try again shortly.` };
        throw error;
    }
}

function requireStatus(event: CurationEvent, allowed: readonly CurationEventStatus[], action: string): void {
    if (allowed.includes(event.status)) return;
    const hint = event.status === 'approved' || event.status === 'dismissed' ? ' Reopen it first.' : '';
    fail('refused', `The event ${event.id} is ${event.status}, so it can't be ${action}.${hint}`);
}

function decided(step: Step, input: ActionInput, decision: Omit<CurationDecision, 'at' | 'by' | 'baseRevisionId'>, status: CurationEventStatus, extra: Partial<CurationEvent> = {}): CurationEvent {
    return {
        ...step.event,
        ...extra,
        status,
        decisions: [...step.event.decisions, { ...decision, at: step.at, by: input.actor, baseRevisionId: step.active }],
        reviewedAt: step.at,
        reviewedBy: input.actor,
    };
}

const OPEN_STATES: readonly CurationEventStatus[] = ['open', 'deferred', 'failed'];

/** Save the curator's edits to the suggestions. Writes only the event. */
export function editEvent(input: ActionInput & { choices: Choices }): Promise<ActionOutcome> {
    return act(input, async (step) => {
        const { event } = step;
        requireStatus(event, OPEN_STATES, 'edited');
        const { choices } = input;
        if (choices.seriesId === undefined && choices.placement === undefined && choices.description === undefined) {
            fail('needs-choice', 'edit needs a series, a position, or a description to save.');
        }
        if ((choices.seriesId !== undefined || choices.placement !== undefined) && event.type !== 'new') {
            fail('refused', `A ${event.type} event keeps its series and position. Only a new photograph's can be edited.`);
        }
        if (choices.placement !== undefined) {
            const series = choices.seriesId !== undefined ? choices.seriesId : event.edits?.seriesId !== undefined ? event.edits.seriesId : event.suggestions.series?.value ?? null;
            if (series === null) fail('needs-choice', 'A position needs a series: pass --series <id> with it.');
        }
        const before = event.edits;
        const edits: CuratorEdits = {
            ...(before?.seriesId === undefined ? {} : { seriesId: before.seriesId }),
            ...(before?.placement === undefined ? {} : { placement: before.placement }),
            ...(before?.description === undefined ? {} : { description: before.description }),
            ...(choices.seriesId === undefined ? {} : { seriesId: choices.seriesId }),
            ...(choices.placement === undefined ? {} : { placement: choices.placement }),
            ...(choices.description === undefined ? {} : { description: choices.description }),
            editedAt: step.at,
            editedBy: input.actor,
        };
        // A series picked without a position keeps no position chosen for another series.
        if (choices.seriesId !== undefined && choices.placement === undefined && before?.seriesId !== choices.seriesId) delete edits.placement;
        if (edits.seriesId === null) delete edits.placement;
        const next = decided(step, input, {
            action: 'edit',
            ...(choices.seriesId === undefined ? {} : { seriesId: choices.seriesId }),
            ...(choices.placement === undefined ? {} : { placement: choices.placement }),
        }, event.status, { edits });
        return { event: next, notes: ['Saved the edits. Nothing in the working layer changed.'] };
    });
}

/** Leave in draft. */
export function deferEvent(input: ActionInput & { reason?: string }): Promise<ActionOutcome> {
    return act(input, async (step) => {
        requireStatus(step.event, ['open', 'failed'], 'deferred');
        return { event: decided(step, input, { action: 'defer', ...(input.reason ? { reason: input.reason } : {}) }, 'deferred'), notes: ['Left in draft.'] };
    });
}

/** The series and published revision that still show the photo. Fails closed when the data root can't tell. */
async function publishedReferences(root: string, photoId: string): Promise<string[]> {
    const found = await photoHolders(root, photoId);
    if ('unknown' in found) return fail('damaged', `${found.unknown.message.replace(' Nothing was deleted.', '')} So nothing shows whether the photograph is still referenced. Nothing was written.`);
    return found.holders;
}

/** Dismiss with a reason. A missing photograph that is still published or in a series can't be dismissed. */
export function dismissEvent(input: ActionInput & { reason: string }): Promise<ActionOutcome> {
    return act(input, async (step) => {
        const { event } = step;
        requireStatus(event, OPEN_STATES, 'dismissed');
        if (!input.reason) fail('needs-choice', 'dismiss needs a reason.');
        if (event.type === 'missing' && event.photoId !== null) {
            const holders = await publishedReferences(path.resolve(/*turbopackIgnore: true*/ input.root), event.photoId);
            if (holders.length > 0) {
                fail('refused', `${event.photoId}'s source is missing, and ${holders.join(' and ')} still ${holders.length === 1 ? 'references' : 'reference'} it, so it can't be dismissed. Restore the source, or remove it from the series and publish first. Nothing was written.`);
            }
        }
        return { event: decided(step, input, { action: 'dismiss', reason: input.reason }, 'dismissed'), notes: ['Dismissed.'] };
    });
}

/** Put a deferred, dismissed, or approved event back in the inbox. An approval's working-layer writes stay. */
export function reopenEvent(input: ActionInput & { reason?: string }): Promise<ActionOutcome> {
    return act(input, async (step) => {
        const { event } = step;
        requireStatus(event, ['deferred', 'dismissed', 'approved'], 'reopened');
        const status: CurationEventStatus = event.type === 'processing-failure' ? 'failed' : 'open';
        const notes = event.status === 'approved' ? ['Reopened. The draft placement stays in the working layer; approve with a position flag to move it.'] : ['Reopened.'];
        return { event: decided(step, input, { action: 'reopen', ...(input.reason ? { reason: input.reason } : {}) }, status), notes };
    });
}

/** Whether the registry shows a failed derivative build for this revision. */
function hasFailedBuild(registry: Registry, photoId: string, assetRevision: string): boolean {
    const revision = registry.photos[photoId]?.revisions[assetRevision];
    return revision !== undefined && Object.values(revision.profiles).some((profile) => profile.state === 'failed');
}

/** Ask #10 to process the photograph again: one `retry` decision, which the watcher's next pass applies. */
export function retryEvent(input: ActionInput & { reason?: string }): Promise<ActionOutcome> {
    return act(input, async (step) => {
        const { event } = step;
        requireStatus(event, OPEN_STATES, 'retried');
        const root = path.resolve(/*turbopackIgnore: true*/ input.root);
        if (event.photoId === null || event.assetRevision === null) fail('refused', `The event ${event.id} has no photo ID, so there is nothing to retry. Retry needs a photograph #10 has identified.`);
        const failure = event.derivedFacts.failure;
        if (failure === 'unsupported-format' || failure === 'digest-collision') {
            fail('refused', `Retrying won't help: ${failure === 'unsupported-format' ? 'the format is not one the watcher reads' : 'the file collides with another one by digest'}. Dismiss it, or replace the file.`);
        }
        const registry = await readRegistry(root).catch((error: unknown) => fail('damaged', `The identity registry can't be read: ${(error as Error).message}. Nothing was written.`));
        const photoId = event.photoId as string;
        const assetRevision = event.assetRevision as string;
        if (!Object.hasOwn(registry.photos, photoId)) fail('refused', `The registry has no photo ${photoId}. Nothing was written.`);
        if (failure !== 'undecodable' && !hasFailedBuild(registry, photoId, assetRevision)) {
            fail('refused', `Nothing failed for ${photoId} at ${assetRevision}, so there is nothing to retry.`);
        }
        const decision = createDecision({ type: 'retry', photoId, assetRevision, actor: input.actor, reason: input.reason ?? `curation ${event.id}` }, { clock: input.clock });
        await writeDecision(root, decision);
        const next = decided(step, input, { action: 'retry', identityDecisionId: decision.decisionId, ...(input.reason ? { reason: input.reason } : {}) }, event.status);
        return { event: next, notes: [`Wrote the retry decision ${decision.decisionId}. The watcher applies it on its next pass, and the derivatives build after that.`] };
    });
}

function altOf(description: CuratorDescription): AuthoredAlt {
    // Only text the curator typed, or the decorative flag, is stored as reviewed. Nothing generated reaches here.
    return description.kind === 'decorative' ? { kind: 'decorative' } : { kind: 'described', text: description.text, reviewed: true };
}

/** The series and position an approval uses: the command's, then the saved edits, then the suggestion for that same series. */
function resolveChoices(event: CurationEvent, choices: Choices): { seriesId: string | null; placement: Placement | null; picked: boolean; description: CuratorDescription | null | undefined } {
    const edits = event.edits;
    let seriesId = choices.seriesId;
    let fromSuggestion = false;
    if (seriesId === undefined) seriesId = edits?.seriesId;
    if (seriesId === undefined && event.suggestions.series?.value) {
        seriesId = event.suggestions.series.value;
        fromSuggestion = true;
    }
    if (seriesId === undefined) {
        return fail('needs-choice', 'Nothing chooses a series: no series is suggested and none was edited. Pass --series <id> or --unassigned.');
    }
    if (seriesId === null) {
        if (choices.placement !== undefined) fail('needs-choice', 'A photograph left unassigned has no position.');
        return { seriesId: null, placement: null, picked: false, description: choices.description !== undefined ? choices.description : edits?.description };
    }
    let placement = choices.placement;
    // Edits made without picking a series apply to the suggested one.
    if (placement === undefined && edits?.placement !== undefined && (edits.seriesId ?? event.suggestions.series?.value) === seriesId) placement = edits.placement;
    // Only the command or a saved edit picks a position. A generated one is a suggestion, never an authored move.
    const picked = placement !== undefined;
    if (placement === undefined && (fromSuggestion || event.suggestions.series?.value === seriesId)) placement = event.suggestions.placement?.value;
    return { seriesId, placement: placement ?? 'end', picked, description: choices.description !== undefined ? choices.description : edits?.description };
}

/**
 * Approve a new photograph into the draft: its photo record at the event's
 * asset revision, and, unless it's left unassigned, its place in the chosen
 * series. Never publishes, and leaves `catalog/` byte-identical.
 */
export interface ApproveFaults {
    /** After the photo record is written, before the placement. A test can commit the series here as a writer past its lease would. */
    beforePlacement?(): void | Promise<void>;
}

export function approveEvent(input: ActionInput & { choices: Choices; faults?: ApproveFaults }): Promise<ActionOutcome> {
    return act(input, async (step) => {
        const { event } = step;
        if (event.type !== 'new') {
            const owner = event.type === 'ambiguous' ? 'photos identity bind or photos identity new' : event.type === 'replacement' || event.type === 'missing' ? "#17's confirm and archive steps" : 'dismiss';
            fail('refused', `Only a new photograph is approved into the draft. A ${event.type} event is settled with ${owner}.`);
        }
        requireStatus(event, ['open', 'deferred'], 'approved');
        if (input.expectedBase === undefined && step.active !== null) {
            fail('needs-choice', `approve needs --base ${step.active}, the active revision it was reviewed against. Show it again if that isn't the one. Nothing was written.`);
        }
        const photoId = event.photoId as string;
        const assetRevision = event.assetRevision as string;
        const root = path.resolve(/*turbopackIgnore: true*/ input.root);
        const { seriesId, placement, picked, description } = resolveChoices(event, input.choices);
        let kept = false;

        const registry = await readRegistry(root).catch((error: unknown) => fail('damaged', `The identity registry can't be read: ${(error as Error).message}. Nothing was written.`));
        const photo = registry.photos[photoId];
        if (!photo || photo.sourceHealth !== 'present' || photo.source.observedRevision !== assetRevision) {
            const now = !photo ? 'is not in the registry' : photo.sourceHealth !== 'present' ? `is ${photo.sourceHealth}` : `is now ${photo.source.observedRevision}`;
            fail('stale', `The source changed since this event: ${photoId} ${now}. Review the newer event instead. Nothing was written.`);
        }

        const writes: WrittenRecord[] = [];
        const notes: string[] = [];
        try {
            await withLock(AUTHORED_LOCK, { root, leaseMs: AUTHORED_LEASE_MS, waitMs: input.waitMs ?? AUTHORED_WAIT_MS }, async (authored) => {
                // A publish may have moved the active revision while this waited for the hold.
                if (((await readActivePointer(root))?.revisionId ?? null) !== step.active) {
                    fail('stale', 'The active revision moved while the approval waited for the authored lock. Show it again and review it. Nothing was written.');
                }
                const existing = await readAuthored<AuthoredPhoto>(root, 'photo', photoId);
                // Check the placement before writing anything, so a refused one leaves the working layer as it was.
                let op: SeriesOp | null = null;
                let series: AuthoredSeries | null = null;
                if (seriesId !== null && placement !== null) {
                    series = await readAuthored<AuthoredSeries>(root, 'series', seriesId);
                    if (series === null) fail('refused', `There is no series ${seriesId}. Nothing was written.`);
                    const target = series as AuthoredSeries;
                    const member = target.photoIds.includes(photoId);
                    if (member && !picked) {
                        // Already placed, and nobody picked a position: it keeps its place.
                        kept = true;
                    } else {
                        op = member ? { kind: 'move', seriesId, photoId, at: placement } : { kind: 'insert', seriesId, photoId, at: placement };
                        const all = await readAuthoredSeries(root);
                        const context = sequenceContext({ registry, series: all.series, unreadable: all.problems.filter((problem) => problem.kind === 'series').map((problem) => problem.id) });
                        const checked = applySeriesOp(target, op, context);
                        if (!checked.ok) fail('refused', `${checked.error.message} (${checked.error.code}). Nothing was written.`);
                        if (checked.ok && !checked.changed) op = null;
                    }
                }

                if (existing && existing.assetRevision !== assetRevision) {
                    fail('refused', `${photoId}'s photo record pins ${existing.assetRevision}, not this event's ${assetRevision}. Confirming new bytes for a photograph is #17's. Nothing was written.`);
                }
                const alt: AuthoredAlt = description ? altOf(description) : existing?.alt ?? null;
                const unchanged = existing !== null && JSON.stringify(existing.alt) === JSON.stringify(alt);
                if (!unchanged) {
                    const record = existing ? { ...existing, alt } : { kind: 'photo' as const, id: photoId, assetRevision, alt };
                    const written = await writeAuthoredRecord(record, { expectedVersion: existing?.version ?? 0, lock: authored, root });
                    writes.push({ record: `photo:${photoId}`, version: written.version });
                }
                if (alt === null) notes.push('It has no description yet, so publishing it waits until one is added and reviewed.');
                else if (alt.kind === 'described' && !alt.reviewed) notes.push('Its description is not reviewed yet, so publishing it waits until it is.');

                if (op !== null && series !== null) {
                    await input.faults?.beforePlacement?.();
                    const result = await applySequenceOp({ dataRoot: root }, op, { expectedVersion: series.version, actor: { kind: 'inbox-approval', ref: event.id }, lock: authored });
                    if (!result.ok) {
                        const code = result.error.code === 'version-conflict' || result.error.code === 'authored-locked' ? 'stale' : 'refused';
                        // The placement was checked before anything was written, so only a writer past its lease or a hand edit gets here.
                        const landed = writes.length > 0
                            ? `${writes.map((entry) => `${entry.record} v${entry.version}`).join(', ')} landed, but ${op.seriesId} did not change: ${result.error.message} (${result.error.code}). The event is unchanged. Approve again to finish it.`
                            : `${result.error.message} (${result.error.code}). Nothing was written.`;
                        fail(code, landed, writes);
                    }
                    if (result.ok && result.changed) writes.push({ record: `series:${op.seriesId}`, version: result.version });
                }
            });
        } catch (error) {
            if (error instanceof LockTimeoutError) fail('locked', `The authored lock is busy. Nothing was written. Try again shortly.`);
            if (error instanceof AuthoredWriteError) {
                const code = error.code === 'VERSION_CONFLICT' || error.code === 'AUTHORED_LOCKED' || error.code === 'LOCK_NOT_HELD' ? 'stale' : error.code === 'DATA_ROOT_NOT_READY' ? 'not-ready' : 'damaged';
                fail(code, `${error.message} Nothing was written.`);
            }
            throw error;
        }

        if (seriesId === null) notes.unshift('Approved and left unassigned: the photo record is in the draft, in no series.');
        else if (kept) notes.unshift(`Approved into ${seriesId}, where it kept its place, in the draft. Nothing is published until photos publish runs.`);
        else notes.unshift(`Approved into ${seriesId} at ${placementText(placement as Placement)}, in the draft. Nothing is published until photos publish runs.`);
        // A saved position is used up by the approval that applied it, so a later reopen and approve keeps any hand reorder.
        let edits = event.edits;
        if (edits?.placement !== undefined) {
            const { placement: _used, ...rest } = edits;
            void _used;
            edits = rest;
        }
        const next = decided(step, input, { action: 'approve', seriesId, ...(placement && !kept ? { placement } : {}), writes }, 'approved', { edits });
        return { event: next, notes };
    });
}

/** A working-layer record, or a damaged-data failure naming it. */
async function readAuthored<T>(root: string, kind: 'photo' | 'series', id: string): Promise<T | null> {
    try {
        return (await readAuthoredRecord(root, kind, id)) as T | null;
    } catch (error) {
        return fail('damaged', `${(error as Error).message}. Nothing was written.`);
    }
}

export function placementText(placement: Placement): string {
    if (placement === 'start') return 'the start';
    if (placement === 'end') return 'the end';
    return `the position after ${placement.after}`;
}
