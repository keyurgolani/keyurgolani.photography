import os from 'node:os';
import { dataRootStatus, libraryRoot, type DataRootState, type DataRootStatus } from '../storage/config';
import { readPendingDecisions } from './decisions';
import { writeWatcherHeartbeat, type PassResult } from './heartbeat';
import type { LibraryVerdict } from './library';
import { jsonLogSink, runReconcilePass, type FactSink, type PassOptions } from './pass';
import { currentProfileId } from './profile';
import { readRegistry } from './registry';
import { createWorker, onceExitCode, pendingJobs, requeueIoErrors, summarizeResults, WorkerStartError, type DerivativeWorker, type WorkerOptions } from './worker';

/**
 * The watcher's identity step, the only one it has. When the data root is
 * ready, a pass reconciles the library, delivers
 * the facts, and hands the derivative worker what the pass left pending.
 * While the data root isn't ready it does no identity work and logs why,
 * once per state. Each pass, and the 30 s check, update
 * `status/watcher.json` when the data root can be written. Nothing here
 * deletes anything: the worker only adds sets to the asset store.
 *
 * A6 (#17): a library root that is missing, empty, or unreadable refuses
 * the pass. The step tells its `library` hook, which the watcher points at
 * the curation inbox's `library-unavailable` item, after every pass, logs
 * once per cause, and looks again after LIBRARY_RETRY_MS, doubling up to
 * LIBRARY_RETRY_MAX_MS, so an unmounted library costs one look every ten
 * minutes, not a pass a minute.
 */

type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

/** Why a pass was asked for. */
export type PassReason = 'startup' | 'event' | 'timer' | 'decisions' | 'facts' | 'pending-sets' | 'settling' | 'locked' | 'worker' | 'library-empty' | 'library-unavailable';

export type PassReport =
    | { status: 'committed'; facts: number; queued: number; retryAfterMs: number | null }
    | { status: 'off'; state: Exclude<DataRootState, 'ready'> }
    | { status: 'locked' }
    | { status: 'refused'; reason: 'library-empty'; present: number }
    | { status: 'refused'; reason: 'library-unavailable'; cause: 'missing' }
    | { status: 'refused'; reason: 'library-unavailable'; cause: 'unreadable'; detail: string }
    | { status: 'failed'; error: string }
    | { status: 'stopped' };

export interface IdentityStepOptions {
    /**
     * Called when the step wants another pass: the registry was busy, a file
     * was too fresh to read (after `delayMs`), a build was left pending, or
     * check() found work waiting.
     */
    requestPass?: (reason: PassReason, delayMs?: number) => void;
    /**
     * Awaited before each pass reads anything, outside the time the
     * healthcheck counts. Tests hold a pass here. The watcher passes none.
     */
    beforePass?: () => Promise<void>;
    logger?: Logger;
    /** The heartbeat's clock. */
    clock?: () => number;
    pid?: number;
    hostname?: string;
    /** Inputs for each reconcile pass, such as an injected hasher, ID generator, clock, or lock wait. */
    pass?: Pick<PassOptions, 'hasher' | 'idGen' | 'clock' | 'profileId' | 'lock' | 'faults'>;
    /** Options for the worker the first ready pass creates. */
    worker?: Omit<WorkerOptions, 'onPassNeeded' | 'logger' | 'profileId'>;
    /** Makes that worker. Defaults to createWorker(). */
    createWorker?: (options: WorkerOptions) => DerivativeWorker;
    /** Where committed facts go. Defaults to one JSON log line per fact. */
    sinks?: FactSink[];
    /**
     * A6: told after each pass that reached the library whether it was
     * available, and why not. The watcher passes the curation inbox's
     * reporter (lib/curation/library.ts). A throw is logged, never fatal.
     */
    library?: (verdict: LibraryVerdict, hooks?: LibraryHooks) => void | Promise<void>;
    /**
     * A6 review (7a): called once when an unreadable root, or an empty one
     * while the registry holds photos, has refused LIBRARY_REBIND_LOOKS
     * passes in a row over LIBRARY_REBIND_AFTER_MS. The watcher exits so
     * Docker's restart re-binds a share remounted on the host.
     */
    onRebind?: (cause: 'empty' | 'unreadable') => void;
    /**
     * Keep what each build did until the caller takes it, as `--once` does.
     * Otherwise each pass drops the results, so a watcher that runs for
     * months doesn't keep one per build.
     */
    keepResults?: boolean;
}

/** A6 review: what the library hook calls back. */
export interface LibraryHooks {
    /**
     * Called with the outage's id before the hook closes an open
     * `library-unavailable` item, outside any curation lock, so the step can
     * put the outage's io-error builds back once (requeueIoErrors()).
     */
    beforeClose?(outageId: string): Promise<void>;
}

export interface IdentityStep {
    /** One pass. Passes never overlap: one asked for while another runs waits for it, and requests made meanwhile share it. */
    pass(reason: PassReason): Promise<PassReport>;
    /** The 30 s check: write the heartbeat, and ask for a pass when another process left work for the watcher. */
    check(): Promise<void>;
    /** The worker, once a ready pass has created it. */
    readonly worker: DerivativeWorker | null;
    /** Why the worker can never start here, such as staging on another device. */
    readonly workerError: string | null;
    /** Why the last try to start the worker failed, when a later pass may still start it. Null once it starts. */
    readonly startError: string | null;
    /** Start nothing new. A pass or build under way finishes. */
    stop(): void;
    /** Resolves once no pass is running or waiting and the worker is idle. */
    idle(): Promise<void>;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** How soon the watcher looks again after a pass found the library empty, missing, or unreadable. */
export const LIBRARY_RETRY_MS = 60_000;
/** v2.0.0 keeps the name it had. */
export const LIBRARY_EMPTY_RETRY_MS = LIBRARY_RETRY_MS;
/** The backoff doubles to this, the periodic pass's 10 minutes. */
export const LIBRARY_RETRY_MAX_MS = 10 * 60_000;
/** A6 review (7a): how many refused looks in a row, and over how long, before the watcher exits to re-bind the share. */
export const LIBRARY_REBIND_LOOKS = 3;
export const LIBRARY_REBIND_AFTER_MS = 30 * 60_000;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

export function createIdentityStep(options: IdentityStepOptions = {}): IdentityStep {
    const {
        requestPass = () => undefined,
        beforePass = async () => undefined,
        logger = console,
        clock = Date.now,
        pid = process.pid,
        hostname = os.hostname(),
    } = options;
    const sinks = options.sinks ?? [jsonLogSink(logger)];
    const profileId = options.pass?.profileId ?? currentProfileId();

    let stopped = false;
    let worker: DerivativeWorker | null = null;
    let started = false;
    let workerError: string | null = null;
    let startError: string | null = null;
    // Decision files the last committed pass deferred. The check doesn't ask for a pass for them alone.
    let deferredDecisions = new Set<string>();
    let stateSeen: string | null = null;
    let heartbeatWarned = false;
    let lastPassAt: string | null = null;
    let lastPassResult: PassResult | null = null;
    let passStartedAt: string | null = null;
    // When a pass last got through the library (committed, or refused an empty one), and the start before the first.
    let lastProgressAt = iso(clock());
    let running: Promise<PassReport> | null = null;
    let waiting: Promise<PassReport> | null = null;
    // A6: the library's last cause, logged once, and the backoff's last delay. Both reset once a pass gets through.
    let libraryCause: string | null = null;
    let libraryDelay = 0;
    // A6 review (7a): the refused looks in a row at an empty or unreadable root, since when, and whether the step asked to re-bind.
    let refusedLooks = 0;
    let refusedSince: number | null = null;
    let rebindAsked = false;

    /** Count one refused look; ask to re-bind once an empty or unreadable root has refused long enough. */
    function noteRefusal(cause: 'missing' | 'empty' | 'unreadable'): void {
        worker?.pause?.();
        refusedLooks++;
        refusedSince ??= clock();
        if (cause === 'missing' || rebindAsked || refusedLooks < LIBRARY_REBIND_LOOKS || clock() - refusedSince < LIBRARY_REBIND_AFTER_MS) return;
        rebindAsked = true;
        logger.error(`[identity] The library root has been ${cause === 'empty' ? 'empty' : "unreadable"} for ${Math.round((clock() - refusedSince) / 60_000)} minutes over ${refusedLooks} looks. A share remounted on the host is seen only after a restart, so the watcher exits to let Docker's restart re-bind it.`);
        try {
            options.onRebind?.(cause);
        } catch (error) {
            logger.error(`[identity] Asking to re-bind the library failed: ${errorText(error)}`);
        }
    }

    /** Tell the library hook, logging a throw. */
    async function tellLibrary(verdict: LibraryVerdict, hooks?: LibraryHooks): Promise<void> {
        if (!options.library) return;
        try {
            await options.library(verdict, hooks);
        } catch (error) {
            logger.warn(`[identity] Could not report the library ${verdict.available ? 'available' : 'unavailable'} to the inbox; the next pass tries again: ${errorText(error)}`);
        }
    }

    /** The next look at an unavailable library: 1 min, doubling to 10 min. */
    function nextLibraryDelay(): number {
        libraryDelay = libraryDelay === 0 ? LIBRARY_RETRY_MS : Math.min(libraryDelay * 2, LIBRARY_RETRY_MAX_MS);
        return libraryDelay;
    }

    /** Log an unavailable library once per cause. */
    function noteUnavailable(cause: string, line: () => string): void {
        if (libraryCause === cause) return;
        libraryCause = cause;
        logger.error(line());
    }

    /** Log the data root's state when it changes, so a step that stays off says so once. */
    function noteState(status: Pick<DataRootStatus, 'state' | 'root' | 'detail'>): void {
        const seen = `${status.state}\0${status.root ?? ''}\0${status.detail ?? ''}`;
        if (seen === stateSeen) return;
        stateSeen = seen;
        if (status.state === 'ready') {
            logger.log(`[identity] Identity step on: data root ${status.root}.`);
        } else {
            logger.log(`[identity] Identity step off: the data root is ${status.state}${status.detail ? ` (${status.detail})` : ''}. Nothing is processed until it is ready.`);
        }
    }

    /** Write `status/watcher.json` when the data root exists and can be written: ready, or not initialized yet. */
    async function writeHeartbeat(status: DataRootStatus): Promise<void> {
        if (status.root === null || (status.state !== 'ready' && status.state !== 'uninitialized')) return;
        try {
            await writeWatcherHeartbeat(status.root, { pid, hostname, lastPassAt, lastPassResult, passStartedAt, heartbeatAt: iso(clock()), lastProgressAt, legacyDerivatives: false });
            heartbeatWarned = false;
        } catch (error) {
            if (!heartbeatWarned) logger.warn(`[identity] Could not write status/watcher.json: ${errorText(error)}`);
            heartbeatWarned = true;
        }
    }

    /** Start the worker on the first ready pass, and after that queue what each pass leaves pending. Returns how many builds it queued. */
    async function feedWorker(): Promise<number> {
        if (stopped || workerError !== null) return 0;
        worker ??= (options.createWorker ?? createWorker)({ ...options.worker, profileId, logger, onPassNeeded: () => requestPass('worker') });
        if (started) return worker.enqueuePending();
        try {
            const start = await worker.start();
            if (start.started) {
                started = true;
                startError = null;
                return start.queued;
            }
            if (start.reason === 'locked') {
                logger.log('[identity] The worker waits to start: the registry is busy. Trying again shortly.');
                requestPass('locked');
            }
        } catch (error) {
            if (error instanceof WorkerStartError) {
                workerError = error.message;
                logger.error(`[identity] ${error.message}`);
            } else {
                startError = errorText(error);
                logger.error(`[identity] The worker could not start, so the next pass tries again: ${startError}`);
            }
        }
        return 0;
    }

    async function reconcile(reason: PassReason, root: string): Promise<PassReport> {
        let outcome: Awaited<ReturnType<typeof runReconcilePass>>;
        try {
            outcome = await runReconcilePass({ ...options.pass, profileId, sinks, clearDelivered: true, logger });
        } catch (error) {
            logger.error(`[identity] The pass failed: ${errorText(error)}`);
            lastPassResult = 'failed';
            return { status: 'failed', error: errorText(error) };
        }
        if (outcome.status === 'skipped') {
            if (outcome.reason === 'locked') {
                const holder = outcome.holder ? ` (held by pid ${outcome.holder.pid} on ${outcome.holder.hostname})` : '';
                logger.log(`[identity] Skipped a pass: the registry is busy${holder}. Trying again shortly.`);
                lastPassResult = 'locked';
                requestPass('locked');
                return { status: 'locked' };
            }
            if (outcome.reason === 'library-empty') {
                // An unmounted or emptied library: committing would mark every photo missing. Look again soon, marking nothing.
                noteUnavailable('empty', () => `[identity] The library at ${libraryRoot()} has no photos, but the registry has ${outcome.present} present. It looks unmounted or emptied, so this pass marked nothing missing. Check the mount and PHOTOGRAPHY_LIBRARY_DIR.`);
                lastPassResult = 'library-empty';
                await tellLibrary({ available: false, cause: 'empty' });
                noteRefusal('empty');
                requestPass('library-empty', nextLibraryDelay());
                return { status: 'refused', reason: 'library-empty', present: outcome.present };
            }
            if (outcome.reason === 'library-unavailable') {
                // A6: the root is gone or can't be read. Nothing is marked missing, and the next look waits longer each time.
                const why = outcome.cause === 'missing' ? 'The library root is missing' : `The library root can't be read (${outcome.detail})`;
                noteUnavailable(`${outcome.cause}\0${outcome.cause === 'unreadable' ? outcome.detail : ''}`, () => `[identity] ${why}, so this pass changed nothing and marked nothing missing. Check the mount and PHOTOGRAPHY_LIBRARY_DIR. The watcher looks again in a minute, then less often.`);
                lastPassResult = 'library-unavailable';
                await tellLibrary(outcome.cause === 'missing' ? { available: false, cause: 'missing' } : { available: false, cause: 'unreadable', detail: outcome.detail });
                noteRefusal(outcome.cause);
                requestPass('library-unavailable', nextLibraryDelay());
                return outcome.cause === 'missing'
                    ? { status: 'refused', reason: 'library-unavailable', cause: 'missing' }
                    : { status: 'refused', reason: 'library-unavailable', cause: 'unreadable', detail: outcome.detail };
            }
            // The data root changed since this pass looked, or its registry comes from a newer build. Never ready here.
            const state = outcome.state as Exclude<DataRootState, 'ready'>;
            noteState({ state, root, detail: outcome.detail });
            lastPassResult = `data-root-${state}`;
            return { status: 'off', state };
        }

        lastPassResult = 'committed';
        if (libraryCause !== null) logger.log('[identity] The library is back, so passes run as usual again.');
        libraryCause = null;
        libraryDelay = 0;
        refusedLooks = 0;
        refusedSince = null;
        rebindAsked = false;
        // A6 review (2a): an outage that ends puts its io-error builds back once, by the outage's id, before its item
        // closes; then any io-error build gets its one try after a clean pass. Both are no-ops with nothing to put back.
        const requeue = async (outageId?: string) => {
            try {
                await requeueIoErrors(root, { profileId, logger, lock: options.pass?.lock, ...(outageId === undefined ? {} : { outageId }) });
            } catch (error) {
                logger.warn(`[identity] Could not put unreadable builds back for another try; the next pass tries again: ${errorText(error)}`);
            }
        };
        await tellLibrary({ available: true }, { beforeClose: (outageId) => requeue(outageId) });
        await requeue();
        worker?.resume?.();
        deferredDecisions = new Set(outcome.decisions.filter((decision) => decision.status === 'deferred').map((decision) => decision.name));
        if (!options.keepResults) worker?.takeResults();
        const queued = await feedWorker();
        if (outcome.facts.length > 0 || queued > 0) {
            logger.log(`[identity] Pass (${reason}) committed ${count(outcome.facts.length, 'fact')} and queued ${count(queued, 'set')} to build.`);
        }
        if (outcome.retryAfterMs !== null) requestPass('settling', outcome.retryAfterMs);
        return { status: 'committed', facts: outcome.facts.length, queued, retryAfterMs: outcome.retryAfterMs };
    }

    async function runPass(reason: PassReason): Promise<PassReport> {
        await beforePass();
        if (stopped) return { status: 'stopped' };
        // The 30 s check's heartbeats carry this while the pass runs, so the healthcheck sees a pass that never ends.
        passStartedAt = iso(clock());
        let status: DataRootStatus;
        let report: PassReport;
        try {
            status = dataRootStatus({ versioned: true });
            noteState(status);
            if (status.state === 'ready' && status.root !== null) {
                report = await reconcile(reason, status.root);
            } else {
                // A ready data root always has a root, so this one isn't ready.
                const state = status.state as Exclude<DataRootState, 'ready'>;
                lastPassResult = `data-root-${state}`;
                report = { status: 'off', state };
            }
        } finally {
            passStartedAt = null;
        }
        lastPassAt = iso(clock());
        // A locked, failed, or off pass got nowhere, so photos status --check measures a stall from the last one that did.
        // A6 review: a refused pass is no progress either, so a long outage reads as a stall too.
        if (report.status === 'committed') lastProgressAt = lastPassAt;
        await writeHeartbeat(status);
        return report;
    }

    function pass(reason: PassReason): Promise<PassReport> {
        if (running === null) {
            running = runPass(reason).finally(() => {
                running = null;
            });
            return running;
        }
        waiting ??= running.then(() => undefined, () => undefined).then(() => {
            waiting = null;
            return pass(reason);
        });
        return waiting;
    }

    /** Work another process left for the watcher: a decision, facts no sink has had, or pending sets the worker hasn't queued. */
    async function waitingWork(root: string): Promise<PassReason | null> {
        // A6 review: while the library is unavailable, only the backoff asks for a pass, never the 30 s check.
        if (libraryCause !== null) return null;
        try {
            // A decision the last pass deferred waits for what it waits on: a file to settle, which that pass
            // already asked another pass for, or a folder to become readable, which the 10-minute pass checks.
            if ((await readPendingDecisions(root)).some((file) => !deferredDecisions.has(file.name))) return 'decisions';
            const registry = await readRegistry(root);
            if (registry.pendingFacts.length > 0) return 'facts';
            // A worker that can never start would make this ask every 30 s for nothing.
            if (workerError !== null) return null;
            const current = started ? worker : null;
            if (pendingJobs(registry, profileId).some((job) => !current?.isQueued(job))) return 'pending-sets';
        } catch {
            // The next pass reports a registry or decision folder it can't read.
        }
        return null;
    }

    return {
        pass,

        async check() {
            if (stopped) return;
            const status = dataRootStatus({ versioned: true });
            noteState(status);
            await writeHeartbeat(status);
            if (status.state !== 'ready' || status.root === null) return;
            const reason = await waitingWork(status.root);
            if (reason !== null) requestPass(reason);
        },

        get worker() {
            return worker;
        },

        get workerError() {
            return workerError;
        },

        get startError() {
            return startError;
        },

        stop() {
            stopped = true;
            worker?.stop();
        },

        async idle() {
            while (running !== null || waiting !== null) await (waiting ?? running)?.then(() => undefined, () => undefined);
            await worker?.idle();
        },
    };
}

/** The timers watchIdentity() uses, injectable so tests control time. */
export interface WatchTimers {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
    setInterval(callback: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
}

const realTimers: WatchTimers = {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** A pass runs this long after the last request for it. */
export const PASS_DEBOUNCE_MS = 5_000;
/** A steady stream of requests still gets a pass this long after the first. */
export const PASS_MAX_DELAY_MS = 30_000;
/** How often watch mode asks for a pass with no event, to catch anything polling missed. */
export const PERIODIC_PASS_MS = 10 * 60_000;
/** How often watch mode writes the heartbeat and looks for work another process left. */
export const CHECK_MS = 30_000;

export interface IdentityWatchOptions {
    timers?: WatchTimers;
    clock?: () => number;
    logger?: Logger;
    debounceMs?: number;
    maxDelayMs?: number;
    periodicMs?: number;
    checkMs?: number;
}

export interface IdentityWatch {
    /**
     * Ask for a pass. It runs `debounceMs` after the last request, and no
     * later than `maxDelayMs` after the first one still waiting. A request
     * with `delayMs` runs after that delay instead, without putting off a
     * pass due sooner.
     */
    schedule(reason: PassReason, delayMs?: number): void;
    /** Clear every timer. A pass under way finishes. */
    stop(): void;
}

/** Watch mode's timing for the identity step: debounced passes on request, one every 10 minutes, and check() every 30 s. */
export function watchIdentity(step: Pick<IdentityStep, 'pass' | 'check'>, options: IdentityWatchOptions = {}): IdentityWatch {
    const {
        timers = realTimers,
        clock = Date.now,
        logger = console,
        debounceMs = PASS_DEBOUNCE_MS,
        maxDelayMs = PASS_MAX_DELAY_MS,
        periodicMs = PERIODIC_PASS_MS,
        checkMs = CHECK_MS,
    } = options;
    let stopped = false;
    let timer: unknown = null;
    let dueAt = 0;
    let firstAt: number | null = null;
    let reasonDue: PassReason = 'event';
    let checking = false;

    function fire(): void {
        timer = null;
        firstAt = null;
        step.pass(reasonDue).catch((error: unknown) => logger.error(`[identity] The pass failed: ${errorText(error)}`));
    }

    function schedule(reason: PassReason, delayMs?: number): void {
        if (stopped) return;
        const now = clock();
        firstAt ??= now;
        const wanted = delayMs === undefined ? Math.min(now + debounceMs, firstAt + maxDelayMs) : now + delayMs;
        const due = timer !== null && delayMs !== undefined ? Math.min(dueAt, wanted) : wanted;
        if (timer !== null) timers.clearTimeout(timer);
        dueAt = due;
        reasonDue = reason;
        timer = timers.setTimeout(fire, Math.max(0, due - now));
    }

    const periodic = timers.setInterval(() => schedule('timer'), periodicMs);
    const checker = timers.setInterval(() => {
        if (checking || stopped) return;
        checking = true;
        step.check()
            .catch((error: unknown) => logger.error(`[identity] The check failed: ${errorText(error)}`))
            .finally(() => {
                checking = false;
            });
    }, checkMs);

    return {
        schedule,
        stop() {
            stopped = true;
            if (timer !== null) timers.clearTimeout(timer);
            timer = null;
            timers.clearInterval(periodic);
            timers.clearInterval(checker);
        },
    };
}

export interface IdentityOnceOptions extends Omit<IdentityStepOptions, 'requestPass'> {
    /** Waits between passes while a file settles. */
    sleep?: (ms: number) => Promise<void>;
    /** The most passes to run while files settle or builds ask for another. */
    maxPasses?: number;
}

/** How many passes `--once` runs at most while files settle. */
export const ONCE_MAX_PASSES = 5;

/**
 * `--once`: a pass, the builds it queued, and another pass while a file is
 * still settling or a build asks for one, up to `maxPasses`. Returns 1 when a
 * build failed for any reason but `source-superseded`, when the registry
 * stayed busy, when the worker didn't start for any reason, or when files were still
 * changing after the last pass, and when the data root isn't ready, after
 * one log line, since then nothing was processed.
 */
export async function runIdentityOnce(options: IdentityOnceOptions = {}): Promise<0 | 1> {
    const { logger = console, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)), maxPasses = ONCE_MAX_PASSES } = options;
    let wanted: number | null = null;
    const step = createIdentityStep({
        ...options,
        keepResults: true,
        logger,
        requestPass: (reason, delayMs = 0) => {
            wanted = wanted === null ? delayMs : Math.min(wanted, delayMs);
        },
    });

    function finish(): 0 | 1 {
        const results = step.worker?.takeResults() ?? [];
        const summary = summarizeResults(results);
        for (const { job, outcome } of summary.failed) {
            logger.error(`[identity] Could not build ${job.photoId} ${job.assetRevision} ${job.profileId}: ${outcome.status === 'failed' ? outcome.error : outcome.status}`);
        }
        const superseded = summary.superseded > 0 ? `, ${summary.superseded} superseded` : '';
        logger.log(`[identity] Done: ${summary.built} built, ${summary.kept} kept, ${summary.failed.length} failed${superseded}.`);
        // A6 review: a build waiting for its retry, from this run or one before it, isn't built, so --once says so and exits 1.
        const waits = step.worker?.retryWaits?.() ?? { count: 0, earliest: null };
        if (waits.count > 0) {
            logger.log(`[identity] ${waits.count} ${waits.count === 1 ? 'build waits' : 'builds wait'} for a retry at ${waits.earliest}. Run it again after that, or leave it to the watcher.`);
            return 1;
        }
        if (step.workerError !== null) return 1;
        if (step.startError !== null) {
            logger.error('[identity] The worker never started, so no set was built. Run it again.');
            return 1;
        }
        return onceExitCode(results);
    }

    try {
        for (let passes = 1; ; passes++) {
            const report = await step.pass(passes === 1 ? 'startup' : 'settling');
            if (report.status === 'off') return 1;
            if (report.status === 'locked') {
                logger.log('[identity] The registry stayed busy, so the identity step did not run. Run it again.');
                return 1;
            }
            if (report.status !== 'committed') return 1;
            await step.worker?.idle();
            if (wanted === null) return finish();
            if (passes >= maxPasses) {
                finish();
                logger.log('[identity] Some photos were still changing, so not every set was built. Run it again.');
                return 1;
            }
            const delay: number = wanted;
            wanted = null;
            await sleep(delay);
        }
    } finally {
        step.stop();
        await step.idle();
    }
}
