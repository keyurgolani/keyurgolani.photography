import type { BuildOptions, BuildOutcome } from '../identity/derivatives';
import type { FactSink } from '../identity/pass';
import { currentProfileId } from '../identity/profile';
import { readRegistry } from '../identity/registry';
import type { DerivativeJob, ProfileEntry, Registry } from '../identity/types';
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
 * confirm, or `failed` (the item turns `failed`, and #14's retry applies).
 * An older revision's bytes coming back reuse the set already committed for
 * them, so that item is ready without a build.
 *
 * It runs after each build and on every pass, so a crash between the
 * registry's `ready` and the item's write is settled by the next pass. It
 * reads the registry without its lock and takes only the curation lock, so
 * the lock order stays `registry` then `curation`. It writes only under
 * `curation/`, and never the working layer: confirming the new bytes is the
 * curator's (lib/curation/resolutions.ts), and only a #13 publish makes them
 * public.
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
 * or deferred item `failed`, and one that becomes ready after a failure
 * turns it `open` again. So a curator who defers a failed item keeps it
 * deferred. Approved and dismissed items are never touched.
 */
export function withCandidate(event: CurationEvent, view: CandidateView, at: string): CurationEvent | null {
    if (event.type !== 'replacement' || !STILL_OPEN.has(event.status)) return null;
    if (view.state !== 'ready' && view.state !== 'failed') return null;
    if (sameCandidate(event.candidate, view)) return null;
    const candidate: Candidate = { state: view.state, profileId: view.profileId, ...(view.state === 'failed' ? { failure: view.failure } : {}), at };
    let status = event.status;
    if (view.state === 'failed' && (status === 'open' || status === 'deferred')) status = 'failed';
    if (view.state === 'ready' && status === 'failed' && event.candidate?.state !== 'ready') status = 'open';
    return { ...event, candidate, status };
}

/** The replacement items #14's sink opens for a photo's revision: one per fact type, since #10's fact key names it. */
export function replacementEventIds(photoId: string, assetRevision: string): string[] {
    return (['replaced', 'metadata-changed'] as const).map((type) => eventIdOf(eventKey('replacement', { photoId, assetRevision, key: `${type}:${photoId}:${assetRevision}` })));
}

export interface SettleOptions {
    /** Settle only this revision's items, as after its build. Otherwise every open replacement item. */
    only?: Pick<DerivativeJob, 'photoId' | 'assetRevision'>;
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
}

/** The items to look at: `only`'s, or every one, damaged ones aside, as #14's sink leaves them. */
async function eventsFor(root: string, only: SettleOptions['only']): Promise<CurationEvent[]> {
    if (!only) return (await listEvents(root)).events;
    const found: CurationEvent[] = [];
    for (const id of replacementEventIds(only.photoId, only.assetRevision)) {
        const event = await readEvent(root, id).catch((error: unknown) => {
            if (error instanceof EventUnusableError && error.problem.reason !== 'unreadable') return null;
            throw error;
        });
        if (event) found.push(event);
    }
    return found;
}

/**
 * Record what #10's registry says on each open replacement item whose
 * candidate it changes. It looks first without the curation lock, and takes
 * the lock only when an item needs a write, so an unchanged run writes
 * nothing at all. Under the lock it reads the registry and each item again
 * and writes with compare-and-swap. A damaged item is skipped, as the sink
 * skips one. I/O errors and a busy lock are thrown.
 */
export async function settleCandidates(root: string, options: SettleOptions = {}): Promise<SettleResult> {
    const { clock = Date.now, logger = console, waitMs = SINK_WAIT_MS } = options;
    const profileId = options.profileId ?? currentProfileId();
    const result: SettleResult = { ready: [], failed: [] };
    const at = () => new Date(clock()).toISOString();

    const looked = await readRegistry(root);
    const due = (await eventsFor(root, options.only)).filter((event) => event.photoId !== null && event.assetRevision !== null
        && withCandidate(event, candidateOf(looked, event.photoId, event.assetRevision, profileId), at()) !== null);
    if (due.length === 0) return result;

    await withCurationLock(root, { waitMs }, async (hold) => {
        const registry = await readRegistry(root);
        for (const { id } of due) {
            const event = await readEvent(root, id).catch((error: unknown) => {
                if (error instanceof EventUnusableError && error.problem.reason !== 'unreadable') return null;
                throw error;
            });
            if (event === null || event.photoId === null || event.assetRevision === null) continue;
            const next = withCandidate(event, candidateOf(registry, event.photoId, event.assetRevision, profileId), at());
            if (next === null) continue;
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
            (next.candidate?.state === 'ready' ? result.ready : result.failed).push(id);
        }
    });
    if (result.ready.length > 0 || result.failed.length > 0) {
        logger.log(`[curation] Replacements: ${result.ready.length} ready to confirm, ${result.failed.length} failed.`);
    }
    return result;
}

export interface CandidateSinkOptions {
    /** Defaults to the data root at each delivery. */
    root?: string;
    clock?: () => number;
    logger?: Logger;
    waitMs?: number;
    profileId?: string;
}

function readyRoot(root: string | undefined): string {
    const status = dataRootStatus({ versioned: true, ...(root === undefined ? {} : { root }) });
    if (status.state !== 'ready' || status.root === null) throw new Error(`The data root is ${status.state}, so the curation inbox can't be written.`);
    return status.root;
}

/**
 * A fact sink that settles every open replacement item on each pass, facts
 * or none, after #14's sink has opened the pass's items. Like that sink, an
 * I/O or lock error fails the delivery, so the pass delivers again.
 */
export function createCandidateSink(options: CandidateSinkOptions = {}): FactSink {
    return async () => {
        await settleCandidates(readyRoot(options.root), { clock: options.clock, logger: options.logger, waitMs: options.waitMs, profileId: options.profileId });
    };
}

export type BuildFunction = (job: DerivativeJob, options: BuildOptions) => Promise<BuildOutcome>;

/**
 * `build`, then settle the built revision's replacement items, for #10's
 * worker. A build that throws is a crash: it settles nothing, and the next
 * start's build or pass does. A settle that fails is logged and left to the
 * next pass, and never changes the build's outcome.
 */
export function settlingAfterBuild(build: BuildFunction, options: Omit<CandidateSinkOptions, 'root'> = {}): BuildFunction {
    const { logger = console } = options;
    return async (job, buildOptions) => {
        const outcome = await build(job, buildOptions);
        if (outcome.status !== 'ready' && outcome.status !== 'failed') return outcome;
        try {
            await settleCandidates(readyRoot(buildOptions.root), { ...options, only: job });
        } catch (error) {
            logger.warn(`[curation] Could not record the set for ${job.photoId} ${job.assetRevision} on its replacement item yet; the next pass does: ${error instanceof Error ? error.message : String(error)}`);
        }
        return outcome;
    };
}
