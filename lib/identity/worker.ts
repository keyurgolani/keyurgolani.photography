import fs from 'node:fs';
import { assetsRoot } from '../media/path';
import { dataRootStatus, type DataRootState } from '../storage/config';
import { UnsupportedSchemaError } from '../storage/document';
import { PRIVATE_DIR_MODE } from '../storage/fsx';
import { LockTimeoutError, withLock, type LockRecord } from '../storage/lock';
import { buildDerivativeSet, removeAbandonedStaging, stagingRoot, type BuildOptions, type BuildOutcome, type WriterFaults } from './derivatives';
import { failureCodeOf, RETRY_DELAYS_MS } from './failures';
import type { Hasher } from './ids';
import { currentProfileId } from './profile';
import { readRegistry, writeRegistry } from './registry';
import type { DerivativeJob, Registry } from './types';

/**
 * The derivative worker: one in-process queue that builds the current
 * profile's sets one at a time, for the watcher. At start it moves pending
 * and failed entries from older profiles to the current one, puts failed
 * entries a v1.7.x worker left back to pending once, removes the staging
 * folders killed builds left, and queues every pending entry. After each
 * pass the watcher calls enqueuePending() to queue what the pass left
 * pending. Revisions moved to another photo (`reassignedTo`) are never built.
 *
 * A6 (#17): a transient failure retries after 30 s, 2 min and 10 min, then
 * fails as `retries-exhausted`; a failure with a code never retries
 * (lib/identity/failures.ts). The schedule is the entry's `retries` and
 * `retryAt` in the registry, so a restart keeps it: an entry whose retry
 * isn't due waits on a timer instead of the queue, and isQueued() counts it,
 * so the watcher's 30 s check asks for no pass for it. Each outcome logs
 * one JSON line, `{"event":"derivative-build",...}`.
 */

type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

/** The timers the worker schedules retries with, injectable so tests control time. */
export interface WorkerTimers {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

const realTimers: WorkerTimers = {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

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
    /** Called when a build left its entry pending, so the watcher schedules a pass. A retry waits on its own timer instead. */
    onPassNeeded?: (reason: Exclude<Extract<BuildOutcome, { status: 'pending' }>['reason'], 'retrying'>) => void;
    /** A6: the retry schedule for transient failures, RETRY_DELAYS_MS by default. `false` records every failure at once, as v1.7.x did. */
    retry?: false | { delaysMs?: readonly number[] };
    /** A6: the retries' timers. */
    timers?: WorkerTimers;
    /** A6: the pixel cap each build applies, MAX_SOURCE_PIXELS by default. */
    maxSourcePixels?: number;
}

export interface WorkerResult {
    job: DerivativeJob;
    /** A build that threw is `failed` here, and its entry stays pending in the registry. A failure keeps its error text, not its cause. */
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
     * once, remove the staging folders no live build holds, and queue every
     * pending entry. Until it returns `started`, the
     * worker builds nothing, and the watcher can call it again later. Throws
     * WorkerStartError when staging and the asset store are on different devices.
     */
    start(): Promise<WorkerStart>;
    /** Queue the registry's pending entries that aren't queued or building yet. Returns how many it added. */
    enqueuePending(): Promise<number>;
    /** Whether a build for `job` is queued, under way, or waiting for its retry. */
    isQueued(job: DerivativeJob): boolean;
    /** Resolves once the queue is empty and nothing is building. */
    idle(): Promise<void>;
    /** Take no more jobs, and clear the retries' timers. A build already running finishes. */
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
 * failed entries with no code, as v1.7.x records every failure, back to
 * pending once, keeping their attempt counts. A failure with a code (A6) is
 * kept: `retries-exhausted` has had its retries, and the others fail the
 * same way again, so a restart repeats no work. `source-superseded` returns
 * only through a `retry` decision or a revert, and an `undecodable` revision
 * has no dimensions, as before. Returns whether anything changed.
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
            if (entry?.state === 'failed' && failureCodeOf(entry.error) === null) {
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
    const { clock = Date.now, logger = console, build = buildDerivativeSet, onPassNeeded, timers = realTimers } = options;
    const deviceOf = options.deviceOf ?? ((dir: string) => fs.statSync(dir).dev);
    const profileId = options.profileId ?? currentProfileId();
    const retry = options.retry === false ? undefined : { delaysMs: options.retry?.delaysMs ?? RETRY_DELAYS_MS };

    let state: 'new' | 'running' | 'stopped' = 'new';
    let root: string | null = null;
    const queue: DerivativeJob[] = [];
    const queued = new Set<string>();
    /** Jobs waiting for a retry that isn't due yet, by key, with their timers. */
    const waiting = new Map<string, unknown>();
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
        ...(retry === undefined ? {} : { retry }),
        ...(options.maxSourcePixels === undefined ? {} : { maxSourcePixels: options.maxSourcePixels }),
    });

    /** Queue `job` once its retry is due, at `retryAt`. */
    function waitForRetry(job: DerivativeJob, retryAt: string): void {
        const key = keyOf(job);
        if (state !== 'running' || waiting.has(key)) return;
        const handle = timers.setTimeout(() => {
            waiting.delete(key);
            enqueue([job]);
        }, Math.max(0, Date.parse(retryAt) - clock()));
        waiting.set(key, handle);
    }

    /**
     * One JSON line per build outcome, for a log reader: `built`, `kept`,
     * `retrying` (with the retry's number and when it is due), `failed` (with
     * its code, none for a transient failure the worker doesn't retry),
     * `superseded`, `pending` or `skipped` (with the reason). It carries no
     * error text, which the writer's own line has, so it never names a path.
     */
    function logOutcome(job: DerivativeJob, outcome: BuildOutcome, threw: boolean): void {
        const line: Record<string, unknown> = { event: 'derivative-build', photoId: job.photoId, assetRevision: job.assetRevision, profileId: job.profileId };
        if (outcome.status === 'ready') line.outcome = outcome.reused ? 'kept' : 'built';
        else if (outcome.status === 'pending' && outcome.reason === 'retrying') Object.assign(line, { outcome: 'retrying', retry: outcome.retries, retryAt: outcome.retryAt });
        else if (outcome.status === 'pending' || outcome.status === 'skipped') Object.assign(line, { outcome: outcome.status, reason: outcome.reason });
        else {
            const code = failureCodeOf(outcome.error);
            Object.assign(line, { outcome: code === 'source-superseded' ? 'superseded' : 'failed', ...(code === null || code === 'source-superseded' ? {} : { code }) });
            // A build that threw left its entry pending, unrecorded.
            if (threw) line.recorded = false;
        }
        logger.log(JSON.stringify(line));
    }

    async function run(job: DerivativeJob, dataRoot: string): Promise<void> {
        let outcome: BuildOutcome;
        let threw = false;
        try {
            outcome = await build(job, buildOptions(dataRoot));
        } catch (error) {
            threw = true;
            logger.error(`[derivatives] Building ${describe(job)} failed before it was recorded, so it stays pending: ${errorText(error)}`);
            outcome = { status: 'failed', error: errorText(error) };
        }
        // Only the error text: a failure's cause can hold as much memory as the source it read.
        results.push({ job, outcome: outcome.status === 'failed' ? { status: 'failed', error: outcome.error } : outcome });
        logOutcome(job, outcome, threw);
        if (outcome.status === 'ready') {
            logger.log(`[derivatives] ${outcome.reused ? 'Kept the set already in place for' : 'Built'} ${describe(job)}`);
        } else if (outcome.status === 'pending') {
            if (outcome.reason === 'retrying') {
                waitForRetry(job, outcome.retryAt);
                return;
            }
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

    /**
     * Queue `jobs`, each once. `registry`, when given, says which wait for a
     * retry that isn't due: those wait on a timer, and don't count as added.
     */
    function enqueue(jobs: readonly DerivativeJob[], registry?: Registry): number {
        let added = 0;
        for (const job of jobs) {
            const key = keyOf(job);
            if (queued.has(key) || waiting.has(key)) continue;
            const retryAt = registry?.photos[job.photoId]?.revisions[job.assetRevision]?.profiles[job.profileId]?.retryAt;
            if (retryAt !== undefined && Date.parse(retryAt) > clock()) {
                waitForRetry(job, retryAt);
                continue;
            }
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
        const status = dataRootStatus(options.root === undefined ? { versioned: true } : { versioned: true, root: options.root });
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
        try {
            for (const name of await removeAbandonedStaging(dataRoot, { leaseMs: options.lock?.leaseMs, logger })) {
                logger.log(`[derivatives] Removed staging/${name}, which a build stopped before publishing left.`);
            }
        } catch (error) {
            logger.warn(`[derivatives] Could not look for staging folders killed builds left: ${errorText(error)}`);
        }
        if (state !== 'new') return { started: false, reason: 'stopped' };
        root = dataRoot;
        state = 'running';
        return { started: true, queued: enqueue(pendingJobs(registry, profileId), registry) };
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
            return enqueue(pendingJobs(registry, profileId), registry);
        },

        isQueued: (job) => queued.has(keyOf(job)) || waiting.has(keyOf(job)),

        async idle() {
            while (draining) await draining;
        },

        stop() {
            state = 'stopped';
            for (const handle of waiting.values()) timers.clearTimeout(handle);
            waiting.clear();
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

/** A6: the builds left waiting for a retry, whose sets aren't built yet. */
export function retryingResults(results: readonly WorkerResult[]): WorkerResult[] {
    return results.filter(({ outcome }) => outcome.status === 'pending' && outcome.reason === 'retrying');
}

/** `--once` exits 1 when any build failed, except for `source-superseded`, or waits for a retry (A6). */
export function onceExitCode(results: readonly WorkerResult[]): 0 | 1 {
    return summarizeResults(results).failed.length > 0 || retryingResults(results).length > 0 ? 1 : 0;
}
