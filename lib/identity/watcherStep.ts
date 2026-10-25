import os from 'node:os';
import { dataRootStatus, type DataRootState, type DataRootStatus } from '../storage/config';
import { readPendingDecisions } from './decisions';
import { writeWatcherHeartbeat, type PassResult } from './heartbeat';
import { jsonLogSink, runReconcilePass, type FactSink, type PassOptions } from './pass';
import { currentProfileId } from './profile';
import { readRegistry } from './registry';
import { createWorker, onceExitCode, pendingJobs, summarizeResults, WorkerStartError, type DerivativeWorker, type WorkerOptions } from './worker';

/**
 * The watcher's identity step. A pass waits for the legacy step's queued
 * jobs, then, when the data root is ready, reconciles the library, delivers
 * the facts, and hands the derivative worker what the pass left pending.
 * While the data root isn't ready it does no identity work and logs why,
 * once per state. Each pass, and the 30 s check, update
 * `status/watcher.json` when the data root can be written. Nothing here
 * deletes anything: the worker only adds sets to the asset store.
 */

type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

/** Why a pass was asked for. */
export type PassReason = 'startup' | 'event' | 'timer' | 'decisions' | 'facts' | 'pending-sets' | 'settling' | 'locked' | 'worker';

export type PassReport =
    | { status: 'committed'; facts: number; queued: number; retryAfterMs: number | null }
    | { status: 'off'; state: Exclude<DataRootState, 'ready'> }
    | { status: 'locked' }
    | { status: 'failed'; error: string }
    | { status: 'stopped' };

export interface IdentityStepOptions {
    /**
     * Called when the step wants another pass: the registry was busy, a file
     * was too fresh to read (after `delayMs`), a build was left pending, or
     * check() found work waiting.
     */
    requestPass?: (reason: PassReason, delayMs?: number) => void;
    /** Resolves once the legacy step has no job queued or running. */
    legacyIdle?: () => Promise<void>;
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
     * Keep what each build did until the caller takes it, as `--once` does.
     * Otherwise each pass drops the results, so a watcher that runs for
     * months doesn't keep one per build.
     */
    keepResults?: boolean;
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
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

export function createIdentityStep(options: IdentityStepOptions = {}): IdentityStep {
    const {
        requestPass = () => undefined,
        legacyIdle = async () => undefined,
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
    let running: Promise<PassReport> | null = null;
    let waiting: Promise<PassReport> | null = null;

    /** Log the data root's state when it changes, so a step that stays off says so once. */
    function noteState(status: Pick<DataRootStatus, 'state' | 'root' | 'detail'>): void {
        const seen = `${status.state}\0${status.root ?? ''}\0${status.detail ?? ''}`;
        if (seen === stateSeen) return;
        stateSeen = seen;
        if (status.state === 'ready') {
            logger.log(`[identity] Identity step on: data root ${status.root}.`);
        } else {
            logger.log(`[identity] Identity step off: the data root is ${status.state}${status.detail ? ` (${status.detail})` : ''}. Only legacy derivatives are written.`);
        }
    }

    /** Write `status/watcher.json` when the data root exists and can be written: ready, or not initialized yet. */
    async function writeHeartbeat(status: DataRootStatus): Promise<void> {
        if (status.root === null || (status.state !== 'ready' && status.state !== 'uninitialized')) return;
        try {
            await writeWatcherHeartbeat(status.root, { pid, hostname, lastPassAt, lastPassResult, passStartedAt, heartbeatAt: iso(clock()) });
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
            // The data root changed since this pass looked, or its registry comes from a newer build. Never ready here.
            const state = outcome.state as Exclude<DataRootState, 'ready'>;
            noteState({ state, root, detail: outcome.detail });
            lastPassResult = `data-root-${state}`;
            return { status: 'off', state };
        }

        lastPassResult = 'committed';
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
        await legacyIdle();
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
 * changing after the last pass. A data root that isn't ready gives 0, after
 * one log line, so the legacy step alone decides the exit code.
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
            if (report.status === 'off') return 0;
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
