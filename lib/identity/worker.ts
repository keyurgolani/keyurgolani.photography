import fs from 'node:fs';
import { assetsRoot } from '../media/path';
import { dataRootStatus, type DataRootState } from '../storage/config';
import { UnsupportedSchemaError } from '../storage/document';
import { PRIVATE_DIR_MODE } from '../storage/fsx';
import { LockTimeoutError, withLock, type LockRecord } from '../storage/lock';
import { buildDerivativeSet, stagingRoot, type BuildOptions, type BuildOutcome, type WriterFaults } from './derivatives';
import type { Hasher } from './ids';
import { currentProfileId } from './profile';
import { readRegistry, writeRegistry } from './registry';
import type { DerivativeJob, Registry } from './types';

/**
 * The derivative worker: one in-process queue that builds the current
 * profile's sets one at a time, for the watcher. At start it moves pending
 * and failed entries from older profiles to the current one, puts failed
 * entries back to pending once, and queues every pending entry. After each
 * pass the watcher calls enqueuePending() to queue what the pass left
 * pending. Revisions moved to another photo (`reassignedTo`) are never built.
 */

type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

/**
 * Failures a start-up retry can't fix. `source-superseded` returns only
 * through a `retry` decision or a revert. An `undecodable` revision has no
 * dimensions, so the writer refuses it without reading anything new.
 */
const KEPT_FAILED_AT_START = new Set(['source-superseded', 'undecodable']);

export interface WorkerOptions {
    /** The data root. Defaults to the configured one, resolved at start. */
    root?: string;
    /** The library. Defaults to libraryRoot() at each build. */
    library?: string;
    /** Defaults to currentProfileId(). */
    profileId?: string;
    hasher?: Hasher;
    clock?: () => number;
    idGen?: () => string;
    faults?: WriterFaults;
    lock?: { waitMs?: number; leaseMs?: number };
    logger?: Logger;
    /** Builds one set. Defaults to buildDerivativeSet(). */
    build?: (job: DerivativeJob, options: BuildOptions) => Promise<BuildOutcome>;
    /** `stat().dev` of a directory, so a test can put staging on another device. */
    deviceOf?: (dir: string) => number;
    /** Called when a build left its entry pending, so the watcher schedules a pass. */
    onPassNeeded?: (reason: Extract<BuildOutcome, { status: 'pending' }>['reason']) => void;
}

export interface WorkerResult {
    job: DerivativeJob;
    /** A build that threw is `failed` here, and its entry stays pending in the registry. */
    outcome: BuildOutcome;
}

export type WorkerStart =
    | { started: true; queued: number }
    | { started: false; reason: 'data-root'; state: DataRootState; detail?: string }
    | { started: false; reason: 'locked'; holder: LockRecord | null }
    | { started: false; reason: 'stopped' };

/** `assets/` and `staging/` are on different devices, so publishing a set couldn't be one rename. */
export class WorkerStartError extends Error {
    readonly code = 'EXDEV';

    constructor(readonly assets: string, readonly staging: string) {
        super(`The derivative worker won't start: ${staging} and ${assets} are on different devices, so a set can't be published with one rename (EXDEV). Keep both on the data root's filesystem.`);
        this.name = 'WorkerStartError';
    }
}

export interface DerivativeWorker {
    /**
     * Check the data root, move older profiles' entries, retry failed ones
     * once, and queue every pending entry. Until it returns `started`, the
     * worker builds nothing, and the watcher can call it again later. Throws
     * WorkerStartError when staging and the asset store are on different devices.
     */
    start(): Promise<WorkerStart>;
    /** Queue the registry's pending entries that aren't queued or building yet. Returns how many it added. */
    enqueuePending(): Promise<number>;
    /** Resolves once the queue is empty and nothing is building. */
    idle(): Promise<void>;
    /** Take no more jobs. A build already running finishes. */
    stop(): void;
    /** What each build did since start or the last takeResults(). */
    readonly results: readonly WorkerResult[];
    /** Return the results and forget them, so a long-running watcher doesn't keep every one. */
    takeResults(): WorkerResult[];
}

const iso = (ms: number) => new Date(ms).toISOString();
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const keyOf = (job: DerivativeJob) => `${job.photoId}/${job.assetRevision}/${job.profileId}`;
const describe = (job: DerivativeJob) => `${job.photoId} ${job.assetRevision} ${job.profileId}`;

/**
 * Start-up bookkeeping on a registry, in place: move pending and failed
 * entries from older profiles to `profileId` (a `ready` one stays, since a
 * new profile applies only to revisions first seen after it), then put
 * failed entries back to pending once, keeping their attempt counts. Returns
 * whether anything changed.
 */
export function prepareForProfile(registry: Registry, profileId: string): boolean {
    let changed = false;
    for (const photo of Object.values(registry.photos)) {
        for (const revision of Object.values(photo.revisions)) {
            if (revision.reassignedTo) continue;
            for (const [id, entry] of Object.entries(revision.profiles)) {
                if (id === profileId || entry.state === 'ready') continue;
                delete revision.profiles[id];
                revision.profiles[profileId] ??= entry;
                changed = true;
            }
            const entry = revision.profiles[profileId];
            if (entry?.state === 'failed' && !KEPT_FAILED_AT_START.has(entry.error ?? '')) {
                revision.profiles[profileId] = { state: 'pending', attempts: entry.attempts };
                changed = true;
            }
        }
    }
    return changed;
}

/**
 * The registry's pending entries for `profileId`, skipping revisions moved to
 * another photo and photos whose source can't be built from now: missing,
 * archived, or at a held path. A held path holds bytes in dispute, so a build
 * would only find a digest mismatch and ask for another pass. The hold's end
 * queues them.
 */
export function pendingJobs(registry: Registry, profileId: string): DerivativeJob[] {
    const held = new Set(registry.holds.map((hold) => hold.path));
    const jobs: DerivativeJob[] = [];
    for (const photo of Object.values(registry.photos)) {
        if (!photo.source.present || photo.sourceHealth === 'archived' || held.has(photo.source.path)) continue;
        for (const revision of Object.values(photo.revisions)) {
            if (revision.reassignedTo || revision.profiles[profileId]?.state !== 'pending') continue;
            jobs.push({ photoId: photo.photoId, assetRevision: revision.assetRevision, profileId, path: photo.source.path });
        }
    }
    return jobs;
}

export function createWorker(options: WorkerOptions = {}): DerivativeWorker {
    const { clock = Date.now, logger = console, build = buildDerivativeSet, onPassNeeded } = options;
    const deviceOf = options.deviceOf ?? ((dir: string) => fs.statSync(dir).dev);
    const profileId = options.profileId ?? currentProfileId();

    let state: 'new' | 'running' | 'stopped' = 'new';
    let root: string | null = null;
    const queue: DerivativeJob[] = [];
    const queued = new Set<string>();
    let results: WorkerResult[] = [];
    let draining: Promise<void> | null = null;

    const buildOptions = (dataRoot: string): BuildOptions => ({
        root: dataRoot,
        library: options.library,
        hasher: options.hasher,
        clock,
        idGen: options.idGen,
        faults: options.faults,
        lock: options.lock,
        logger,
    });

    async function run(job: DerivativeJob, dataRoot: string): Promise<void> {
        let outcome: BuildOutcome;
        try {
            outcome = await build(job, buildOptions(dataRoot));
        } catch (error) {
            logger.error(`[derivatives] Building ${describe(job)} failed before it was recorded, so it stays pending: ${errorText(error)}`);
            outcome = { status: 'failed', error: errorText(error) };
        }
        results.push({ job, outcome });
        if (outcome.status === 'ready') {
            logger.log(`[derivatives] ${outcome.reused ? 'Kept the set already in place for' : 'Built'} ${describe(job)}`);
        } else if (outcome.status === 'pending') {
            logger.log(`[derivatives] ${describe(job)} stays pending (${outcome.reason}). Asking for another pass.`);
            try {
                onPassNeeded?.(outcome.reason);
            } catch (error) {
                logger.error(`[derivatives] Scheduling a pass failed: ${errorText(error)}`);
            }
        }
    }

    /** Build queued jobs one at a time until the queue is empty or the worker stops. */
    async function drain(dataRoot: string): Promise<void> {
        try {
            while (state === 'running') {
                const job = queue.shift();
                if (!job) break;
                try {
                    await run(job, dataRoot);
                } finally {
                    queued.delete(keyOf(job));
                }
            }
        } finally {
            // Cleared in the same turn the loop sees an empty queue, so a job queued after it starts a new drain.
            draining = null;
        }
    }

    function pump(): void {
        if (draining || state !== 'running' || root === null || queue.length === 0) return;
        draining = drain(root);
    }

    function enqueue(jobs: readonly DerivativeJob[]): number {
        let added = 0;
        for (const job of jobs) {
            const key = keyOf(job);
            if (queued.has(key)) continue;
            queued.add(key);
            queue.push(job);
            added++;
        }
        pump();
        return added;
    }

    async function begin(): Promise<WorkerStart> {
        if (state === 'stopped') return { started: false, reason: 'stopped' };
        if (state === 'running') return { started: true, queued: 0 };
        const status = dataRootStatus(options.root === undefined ? { write: true } : { write: true, root: options.root });
        if (status.state !== 'ready' || status.root === null) {
            return { started: false, reason: 'data-root', state: status.state, ...(status.detail === undefined ? {} : { detail: status.detail }) };
        }
        const dataRoot = status.root;

        let registry: Registry | null;
        try {
            registry = await withLock('registry', { root: dataRoot, waitMs: options.lock?.waitMs, leaseMs: options.lock?.leaseMs }, async ({ signal }) => {
                // Read first, so a registry from a newer build stops the start before anything is created.
                const current = await readRegistry(dataRoot);
                const assets = assetsRoot(dataRoot);
                const staging = stagingRoot(dataRoot);
                await fs.promises.mkdir(assets, { recursive: true, mode: PRIVATE_DIR_MODE });
                await fs.promises.mkdir(staging, { recursive: true, mode: PRIVATE_DIR_MODE });
                if (deviceOf(assets) !== deviceOf(staging)) throw new WorkerStartError(assets, staging);
                // Stopped while waiting for the lock: change nothing.
                if (state === 'stopped') return null;
                if (!prepareForProfile(current, profileId)) return current;
                signal.throwIfAborted();
                return writeRegistry(dataRoot, { ...current, updatedAt: iso(clock()) }, current.version);
            });
        } catch (error) {
            if (error instanceof LockTimeoutError) return { started: false, reason: 'locked', holder: error.holder };
            if (error instanceof UnsupportedSchemaError) return { started: false, reason: 'data-root', state: 'unavailable', detail: error.message };
            throw error;
        }
        // Stopped while the start-up bookkeeping was being written: queue nothing.
        if (registry === null || state !== 'new') return { started: false, reason: 'stopped' };
        root = dataRoot;
        state = 'running';
        return { started: true, queued: enqueue(pendingJobs(registry, profileId)) };
    }

    let starting: Promise<WorkerStart> | null = null;

    return {
        start() {
            // Calls made while a start is under way share it.
            starting ??= begin().finally(() => {
                starting = null;
            });
            return starting;
        },

        async enqueuePending() {
            if (state !== 'running' || root === null) return 0;
            let registry: Registry;
            try {
                registry = await readRegistry(root);
            } catch (error) {
                logger.warn(`[derivatives] Could not read the registry to queue pending sets: ${errorText(error)}`);
                return 0;
            }
            return enqueue(pendingJobs(registry, profileId));
        },

        async idle() {
            while (draining) await draining;
        },

        stop() {
            state = 'stopped';
        },

        get results() {
            return [...results];
        },

        takeResults() {
            const taken = results;
            results = [];
            return taken;
        },
    };
}

/** What a run of builds did, for `--once`. Failures exclude `source-superseded`, which only a decision or a revert brings back. */
export function summarizeResults(results: readonly WorkerResult[]): { built: number; kept: number; pending: number; skipped: number; superseded: number; failed: WorkerResult[] } {
    const summary = { built: 0, kept: 0, pending: 0, skipped: 0, superseded: 0, failed: [] as WorkerResult[] };
    for (const result of results) {
        const { outcome } = result;
        if (outcome.status === 'ready') {
            if (outcome.reused) summary.kept++;
            else summary.built++;
        } else if (outcome.status === 'pending') summary.pending++;
        else if (outcome.status === 'skipped') summary.skipped++;
        else if (outcome.error === 'source-superseded') summary.superseded++;
        else summary.failed.push(result);
    }
    return summary;
}

/** `--once` exits 1 when any build failed, except for `source-superseded`. */
export function onceExitCode(results: readonly WorkerResult[]): 0 | 1 {
    return summarizeResults(results).failed.length > 0 ? 1 : 0;
}
