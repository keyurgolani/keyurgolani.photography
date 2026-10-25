import type { AuthoredPhoto } from '../catalog/types';
import { readActivePointer, readAuthoredRecord } from '../catalog/working-layer';
import type { BuildOptions, BuildOutcome } from '../identity/derivatives';
import { ASSET_REVISION_RE, PHOTO_ID_RE } from '../identity/ids';
import type { FactSink } from '../identity/pass';
import { currentProfileId } from '../identity/profile';
import { readRegistry } from '../identity/registry';
import type { DerivativeJob, IdentityFact, ProfileEntry, Registry } from '../identity/types';
import { dataRootStatus } from '../storage/config';
import { eventIdOf, eventKey, type Candidate, type CandidateFailure, type CurationEvent } from './events';
import { EventMovedError, EventUnusableError, InvalidEventError, listEvents, readEvent, withCurationLock, writeEvent } from './repository';
import { SINK_WAIT_MS } from './sink';

/**
 * #17's replacement candidates, on the watcher's side. #14's sink opens a
 * `replacement` item when #10 reports `replaced` or `metadata-changed`, and
 * #10's worker builds the new revision's derivative set after the pass. This
 * records on that item, as `candidate`, what became of the set once #10's
 * registry says: `ready` once the writer has committed it with its manifest,
 * which is what makes the item a replacement-ready one the curator can
 * confirm, or `failed` (an open item turns `failed`, and #14's retry
 * applies; a deferred one stays deferred).
 * An older revision's bytes coming back reuse the set already committed for
 * them, so that item is ready without a build, and an item already confirmed
 * for them opens again when the photo record has moved on (settleOne()).
 *
 * It runs after each build, and on each pass for the revisions that pass's
 * facts name and those whose settle after a build failed. A sink's first
 * delivery, at the watcher's start, looks at every item once, so a crash
 * between the registry's `ready` and the item's write is settled when the
 * watcher comes back, without reading the whole inbox on every pass inside
 * the registry hold. It reads the registry without its
 * lock and takes only the curation lock, so the lock order stays `registry`
 * then `curation`. It reads the working layer's photo records and writes
 * only under `curation/`: confirming the new bytes is the curator's
 * (lib/curation/resolutions.ts), and only a #13 publish makes them public.
 */

type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

export type CandidateView =
    | { state: 'ready'; profileId: string }
    | { state: 'failed'; profileId: string; failure: CandidateFailure }
    | { state: 'pending' }
    /** The registry has no such revision for the photo, or the revision moved to another photo. */
    | { state: 'gone' };

/** #10's writer's error text, as a failure class. The text itself may name a host path, so it is never kept. */
export function failureOf(error: string | undefined): CandidateFailure {
    if (error === 'source-superseded') return 'superseded';
    if (error === 'undecodable') return 'undecodable';
    if (error?.startsWith('integrity:')) return 'integrity';
    return 'build';
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * What #10's registry says of a revision's derivative set: `ready` on the
 * current profile if that one is, else on the newest ready one, as #13's
 * compile picks a profile; `pending` while any entry is; otherwise `failed`,
 * the current profile's failure first.
 */
export function candidateOf(registry: Registry, photoId: string, assetRevision: string, profileId: string = currentProfileId()): CandidateView {
    const photo = Object.hasOwn(registry.photos, photoId) ? registry.photos[photoId] : undefined;
    const revision = photo && Object.hasOwn(photo.revisions, assetRevision) ? photo.revisions[assetRevision] : undefined;
    if (!revision || revision.reassignedTo) return { state: 'gone' };
    const entries = Object.entries(revision.profiles) as [string, ProfileEntry][];
    const ready = entries.filter(([, entry]) => entry.state === 'ready');
    if (ready.length > 0) {
        const pick = ready.find(([id]) => id === profileId)
            ?? ready.sort(([idA, a], [idB, b]) => compare(b.readyAt ?? '', a.readyAt ?? '') || compare(idA, idB))[0];
        return { state: 'ready', profileId: pick[0] };
    }
    if (entries.length === 0 || entries.some(([, entry]) => entry.state === 'pending')) return { state: 'pending' };
    const [failedId, failed] = entries.find(([id]) => id === profileId) ?? entries.sort(([a], [b]) => compare(a, b))[0];
    return { state: 'failed', profileId: failedId, failure: failureOf(failed.error) };
}

const STILL_OPEN = new Set(['open', 'deferred', 'failed']);

/** Whether the candidate an item holds already says what `view` says. */
function sameCandidate(candidate: Candidate | undefined, view: Extract<CandidateView, { state: 'ready' | 'failed' }>): boolean {
    if (!candidate || candidate.state !== view.state || candidate.profileId !== view.profileId) return false;
    return view.state === 'ready' || candidate.failure === view.failure;
}

/**
 * The item with `view` recorded, or null when nothing changes. Its status
 * moves only when the candidate's state does: a set that fails turns an open
 * item `failed`, and one that becomes ready after a failure turns it `open`
 * again. A deferred item stays deferred either way: Leave in draft is the
 * curator's, so a failure only lands in its `candidate`, which `show`
 * reports. Approved and dismissed items are never touched.
 */
export function withCandidate(event: CurationEvent, view: CandidateView, at: string): CurationEvent | null {
    if (event.type !== 'replacement' || !STILL_OPEN.has(event.status)) return null;
    if (view.state !== 'ready' && view.state !== 'failed') return null;
    if (sameCandidate(event.candidate, view)) return null;
    const candidate: Candidate = { state: view.state, profileId: view.profileId, ...(view.state === 'failed' ? { failure: view.failure } : {}), at };
    let status = event.status;
    if (view.state === 'failed' && status === 'open') status = 'failed';
    if (view.state === 'ready' && status === 'failed' && event.candidate?.state !== 'ready') status = 'open';
    return { ...event, candidate, status };
}

/** The replacement items #14's sink opens for a photo's revision: one per fact type, since #10's fact key names it. */
export function replacementEventIds(photoId: string, assetRevision: string): string[] {
    return (['replaced', 'metadata-changed'] as const).map((type) => eventIdOf(eventKey('replacement', { photoId, assetRevision, key: `${type}:${photoId}:${assetRevision}` })));
}

export type RevisionRef = Pick<DerivativeJob, 'photoId' | 'assetRevision'>;

export interface SettleOptions {
    /** Settle only these revisions' items, as after a build or for a pass's facts. Otherwise every replacement item. */
    only?: RevisionRef | readonly RevisionRef[];
    clock?: () => number;
    logger?: Logger;
    /** How long to wait for the curation lock. A busy lock throws LockTimeoutError, and nothing is written. */
    waitMs?: number;
    /** #10's current profile. Defaults to currentProfileId(). */
    profileId?: string;
}

export interface SettleResult {
    /** Item IDs given a ready candidate. */
    ready: string[];
    /** Item IDs given a failed one. */
    failed: string[];
    /** Approved item IDs opened again, because their bytes came back while the photo record pins others. */
    reopened: string[];
}

/** One event, or null when it is absent or damaged, as #14's sink leaves a damaged one. An I/O error is thrown. */
export async function readUsableEvent(root: string, id: string): Promise<CurationEvent | null> {
    return readEvent(root, id).catch((error: unknown) => {
        if (error instanceof EventUnusableError && error.problem.reason !== 'unreadable') return null;
        throw error;
    });
}

/** The photo record, null for none, or undefined when it can't be read, which settles nothing on it. */
function photoRecordOf(root: string, photoId: string): Promise<AuthoredPhoto | null | undefined> {
    return readAuthoredRecord(root, 'photo', photoId).catch(() => undefined);
}

const activeRevision = (root: string) => readActivePointer(root).then((pointer) => pointer?.revisionId ?? null, () => null);

type Settled = { next: CurationEvent; kind: keyof SettleResult };

/**
 * What a settle does to one replacement item, or null for nothing.
 *
 * An approved item opens again, as a new version with a fresh candidate,
 * when its bytes came back after it was confirmed (the source observes its
 * revision and a fact folded into it since) while the photo record pins
 * another revision: B confirmed, then A, then B copied back. Its decision is
 * the watcher's `reopen`, as #14's sink records one for a missing source.
 * Otherwise an open, deferred, or failed item takes its candidate, as
 * withCandidate() says. The working layer is only read.
 */
async function settleOne(root: string, event: CurationEvent, registry: Registry, profileId: string, at: string): Promise<Settled | null> {
    if (event.type !== 'replacement' || event.photoId === null || event.assetRevision === null) return null;
    const photoId = event.photoId;
    const revision = event.assetRevision;
    const view = candidateOf(registry, photoId, revision, profileId);
    if (event.status === 'approved') {
        const photo = Object.hasOwn(registry.photos, photoId) ? registry.photos[photoId] : undefined;
        if (!photo || photo.mergedInto || photo.sourceHealth !== 'present' || photo.source.observedRevision !== revision) return null;
        const confirmed = event.decisions.findLast((decision) => decision.action === 'confirm');
        if (!confirmed || event.lastObservedAt <= confirmed.at) return null;
        const record = await photoRecordOf(root, photoId);
        if (!record || record.assetRevision === revision) return null;
        const { candidate: _earlier, ...rest } = event;
        void _earlier;
        const reopened: CurationEvent = {
            ...rest,
            status: 'open',
            decisions: [...event.decisions, {
                action: 'reopen',
                at,
                by: 'watcher',
                baseRevisionId: await activeRevision(root),
                reason: `The source holds ${revision} again, while the photo record pins ${record.assetRevision}.`,
            }],
        };
        return { next: withCandidate(reopened, view, at) ?? reopened, kind: 'reopened' };
    }
    const next = withCandidate(event, view, at);
    return next === null ? null : { next, kind: next.candidate?.state === 'ready' ? 'ready' : 'failed' };
}

/** The items to look at: `only`'s, or every one, damaged ones aside. */
async function eventsFor(root: string, only: SettleOptions['only']): Promise<CurationEvent[]> {
    if (!only) return (await listEvents(root)).events;
    const refs = Array.isArray(only) ? only : [only as RevisionRef];
    const ids = new Set(refs.flatMap((ref) => replacementEventIds(ref.photoId, ref.assetRevision)));
    const found: CurationEvent[] = [];
    for (const id of ids) {
        const event = await readUsableEvent(root, id);
        if (event) found.push(event);
    }
    return found;
}

/**
 * Settle each replacement item settleOne() changes: record what #10's
 * registry says of its set, or open one whose bytes came back. It looks
 * first without the curation lock, and takes
 * the lock only when an item needs a write, so an unchanged run writes
 * nothing at all. Under the lock it reads the registry and each item again
 * and writes with compare-and-swap. A damaged item is skipped, as the sink
 * skips one. I/O errors and a busy lock are thrown.
 */
export async function settleCandidates(root: string, options: SettleOptions = {}): Promise<SettleResult> {
    const { clock = Date.now, logger = console, waitMs = SINK_WAIT_MS } = options;
    const profileId = options.profileId ?? currentProfileId();
    const result: SettleResult = { ready: [], failed: [], reopened: [] };
    const at = () => new Date(clock()).toISOString();

    const looked = await readRegistry(root);
    const due: CurationEvent[] = [];
    for (const event of await eventsFor(root, options.only)) {
        if (await settleOne(root, event, looked, profileId, at()) !== null) due.push(event);
    }
    if (due.length === 0) return result;

    await withCurationLock(root, { waitMs }, async (hold) => {
        const registry = await readRegistry(root);
        for (const { id } of due) {
            const event = await readUsableEvent(root, id);
            if (event === null) continue;
            const settled = await settleOne(root, event, registry, profileId, at());
            if (settled === null) continue;
            const { next, kind } = settled;
            hold.signal.throwIfAborted();
            try {
                await writeEvent(root, next, event.version, hold);
            } catch (error) {
                // Only a writer past its lease gets between the read and the write. The next run looks again.
                if (error instanceof EventMovedError) continue;
                if (error instanceof InvalidEventError || (error instanceof EventUnusableError && error.problem.reason !== 'unreadable')) {
                    logger.error(`[curation] Could not record the candidate on ${id}: ${error.message}`);
                    continue;
                }
                throw error;
            }
            result[kind].push(id);
        }
    });
    if (result.ready.length > 0 || result.failed.length > 0 || result.reopened.length > 0) {
        logger.log(`[curation] Replacements: ${result.ready.length} ready to confirm, ${result.failed.length} failed, ${result.reopened.length} reopened.`);
    }
    return result;
}

/**
 * The revisions whose settle after a build failed, owed to the candidate
 * sink's next delivery. The watcher makes one and hands it to both the sink
 * and settlingAfterBuild(), since no later pass names a revision whose fact
 * it already delivered.
 */
export interface OwedSettles {
    add(ref: RevisionRef): void;
    /** What is owed now, and `settled()` to clear those once a settle covered them. One owed again since stays owed. */
    take(): { refs: RevisionRef[]; settled(): void };
}

export function owedSettles(): OwedSettles {
    const owed = new Map<string, { ref: RevisionRef; seq: number }>();
    let seq = 0;
    return {
        add(ref) {
            owed.set(`${ref.photoId}/${ref.assetRevision}`, { ref: { photoId: ref.photoId, assetRevision: ref.assetRevision }, seq: ++seq });
        },
        take() {
            const taken = [...owed.entries()];
            return {
                refs: taken.map(([, entry]) => entry.ref),
                settled() {
                    for (const [key, entry] of taken) if (owed.get(key)?.seq === entry.seq) owed.delete(key);
                },
            };
        },
    };
}

export interface CandidateSinkOptions {
    /** Defaults to the data root at each delivery. */
    root?: string;
    clock?: () => number;
    logger?: Logger;
    waitMs?: number;
    profileId?: string;
    /** Shared with settlingAfterBuild(), so a build whose settle failed is settled on the sink's next delivery. */
    owed?: OwedSettles;
}

function readyRoot(root: string | undefined): string {
    const status = dataRootStatus({ versioned: true, ...(root === undefined ? {} : { root }) });
    if (status.state !== 'ready' || status.root === null) throw new Error(`The data root is ${status.state}, so the curation inbox can't be written.`);
    return status.root;
}

/** The revisions a pass's replacement facts name, each once. A fact #14's sink would skip is left out. */
export function namedRevisions(facts: readonly IdentityFact[]): RevisionRef[] {
    const refs = new Map<string, RevisionRef>();
    for (const fact of facts) {
        if (fact.type !== 'replaced' && fact.type !== 'metadata-changed') continue;
        if (typeof fact.photoId !== 'string' || !PHOTO_ID_RE.test(fact.photoId) || typeof fact.assetRevision !== 'string' || !ASSET_REVISION_RE.test(fact.assetRevision)) continue;
        refs.set(`${fact.photoId}/${fact.assetRevision}`, { photoId: fact.photoId, assetRevision: fact.assetRevision });
    }
    return [...refs.values()];
}

/**
 * A fact sink that runs after #14's sink has opened the pass's items. Its
 * first delivery settles every replacement item, which recovers what a crash
 * left unrecorded; each later one settles only the revisions its facts name,
 * and those `owed` holds, whose settle after a build failed. The pass
 * delivers its pending facts until every sink has them, so a fact whose
 * delivery failed is named again on the next pass, and an owed revision
 * stays owed until a delivery settles it. Like #14's sink, an I/O or lock
 * error fails the delivery, and a first delivery that fails looks at every
 * item again on the next.
 */
export function createCandidateSink(options: CandidateSinkOptions = {}): FactSink {
    let swept = false;
    return async (facts) => {
        const settle = (only?: RevisionRef[]) => settleCandidates(readyRoot(options.root), { clock: options.clock, logger: options.logger, waitMs: options.waitMs, profileId: options.profileId, ...(only ? { only } : {}) });
        const owed = options.owed?.take();
        if (!swept) {
            await settle();
            swept = true;
        } else {
            const named = [...namedRevisions(facts), ...(owed?.refs ?? [])];
            if (named.length > 0) await settle(named);
        }
        owed?.settled();
    };
}

export type BuildFunction = (job: DerivativeJob, options: BuildOptions) => Promise<BuildOutcome>;

/**
 * `build`, then settle the built revision's replacement items, for #10's
 * worker. A build that throws is a crash: it settles nothing, and the next
 * start's build or pass does. A settle that fails (a busy curation lock, say)
 * is logged and added to `owed`, so the candidate sink settles it on its
 * next delivery, the next pass's; with no `owed`, the watcher's next start
 * does. It never changes the build's outcome.
 */
export function settlingAfterBuild(build: BuildFunction, options: Omit<CandidateSinkOptions, 'root'> = {}): BuildFunction {
    const { logger = console, owed, ...settleOptions } = options;
    return async (job, buildOptions) => {
        const outcome = await build(job, buildOptions);
        if (outcome.status !== 'ready' && outcome.status !== 'failed') return outcome;
        try {
            await settleCandidates(readyRoot(buildOptions.root), { ...settleOptions, logger, only: job });
        } catch (error) {
            owed?.add(job);
            const when = owed ? 'the next pass settles it' : "the watcher's next start settles it";
            logger.warn(`[curation] Could not record the set for ${job.photoId} ${job.assetRevision} on its replacement item yet; ${when}: ${error instanceof Error ? error.message : String(error)}`);
        }
        return outcome;
    };
}
