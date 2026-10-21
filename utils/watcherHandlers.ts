import type { EventEmitter } from 'events';
import path from 'path';
import type { FSWatcherEventMap } from 'chokidar';
import {
    generatedFolderNames,
    hasErrorCode,
    isSourceFile,
    ownerAfterRemoval,
    ownerOf,
    planSources,
    refreshImage,
    reprocessImage,
    setKeyOf,
    setMembers,
    sharesSet,
    SOURCE_CHANGED,
} from './imageOptimizer';

type Logger = Pick<Console, 'log' | 'error'>;

export interface StartupBatchResult {
    processed: string[];
    /** Changed or removed while processed, superseded by a live change, or dropped by stop() */
    skipped: string[];
    errors: string[];
}

export interface WatcherHandlers {
    /**
     * Regenerate a new source's outputs when its set is incomplete or older than
     * it, the same rule as the startup batch, so an unchanged file a sync tool
     * removed and copied back costs nothing.
     */
    onAdd(filePath: string): Promise<void>;
    /** Regenerate all seven outputs for a changed source, including a save-by-rename. */
    onChange(filePath: string): Promise<void>;
    /** Keep the derivatives, and point at images:cleanup. */
    onUnlink(filePath: string): Promise<void>;
    /** Queue every unprocessed source, using the overwrite rule in refreshImage(). */
    queueStartupBatch(options?: { force?: boolean }): Promise<StartupBatchResult>;
    /**
     * Stop taking events and drop the queued startup jobs, which the next start
     * finds again on disk. Queued live jobs still run.
     */
    stop(): void;
    /** Resolve once every queued job has finished. */
    idle(): Promise<void>;
    /** Wait up to `timeoutMs` for queued jobs. Resolves false if some were still running. */
    drain(timeoutMs: number): Promise<boolean>;
    /** The photos with a job running or queued. */
    unfinished(): string[];
}

/**
 * The chokidar `ignored` filter: skip the generated folders directly under the
 * root, matched by exact name on the first path segment, never by substring,
 * so a root like `/srv/cache/photos` or a photo named `thumbnails-beach.jpg`
 * is still watched.
 */
export function createIgnoreFilter(root: string): (watchedPath: string) => boolean {
    const generated = new Set(generatedFolderNames());
    const resolvedRoot = path.resolve(root);
    return (watchedPath) => {
        const relative = path.relative(resolvedRoot, path.resolve(watchedPath));
        if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            return false;
        }
        return generated.has(relative.split(path.sep)[0]);
    };
}

type Outcome = 'done' | 'skipped' | 'failed';

interface Job {
    key: string;
    live: boolean;
    label: string;
    run: () => Promise<unknown>;
    settle: (outcome: Outcome) => void;
}

export function createWatcherHandlers(
    { logger = console, maxConcurrentJobs = 1 }: { logger?: Logger; maxConcurrentJobs?: number } = {},
): WatcherHandlers {
    // One queue, in arrival order. A job starts only when no job for its set,
    // setKeyOf() of its name, is running or queued ahead of it, so the jobs of
    // the sources sharing one set run in turn and never at once. Each job holds
    // its source in memory, so at most maxConcurrentJobs run. A free slot goes
    // first to a set with a live event waiting, so a photo added after start
    // doesn't wait behind the whole startup backlog.
    const queue: Job[] = [];
    const running = new Map<string, Job>();
    // Live jobs in the queue, so pick() skips looking for them when there are none
    let liveQueued = 0;
    let idleWaiters: (() => void)[] = [];
    let stopped = false;

    function unqueue(job: Job): void {
        queue.splice(queue.indexOf(job), 1);
        if (job.live) liveQueued--;
    }

    function pick(): Job | undefined {
        const liveKeys = liveQueued > 0 ? new Set(queue.filter((job) => job.live).map((job) => job.key)) : null;
        const seen = new Set<string>();
        let firstReady: Job | undefined;
        for (const job of queue) {
            const ready = !running.has(job.key) && !seen.has(job.key);
            seen.add(job.key);
            if (!ready) continue;
            if (!liveKeys || liveKeys.has(job.key)) return job;
            firstReady ??= job;
        }
        return firstReady;
    }

    function pump(): void {
        while (running.size < maxConcurrentJobs) {
            const job = pick();
            if (!job) break;
            unqueue(job);
            running.set(job.key, job);
            Promise.resolve()
                .then(job.run)
                .then(
                    () => job.settle('done'),
                    (error: unknown) => {
                        if (hasErrorCode(error, SOURCE_CHANGED)) {
                            logger.log(`[ImageWatcher] Skipped ${job.label}: it changed or was removed while it was processed.`);
                            job.settle('skipped');
                        } else {
                            logger.error(`[ImageWatcher] Error processing ${job.label}:`, error);
                            job.settle('failed');
                        }
                    },
                )
                .finally(() => {
                    running.delete(job.key);
                    pump();
                });
        }
        if (running.size === 0 && queue.length === 0) {
            const waiters = idleWaiters;
            idleWaiters = [];
            waiters.forEach((resolve) => resolve());
        }
    }

    /** Settle the queued, not yet started startup jobs that match, as skipped. */
    function dropStartupJobs(matches: (job: Job) => boolean): void {
        for (const job of queue.filter((queued) => !queued.live && matches(queued))) {
            unqueue(job);
            job.settle('skipped');
        }
    }

    function enqueue(filename: string, live: boolean, run: () => Promise<unknown>): Promise<Outcome> {
        return new Promise((settle) => {
            queue.push({ key: setKeyOf(filename), live, label: filename, run, settle });
            if (live) liveQueued++;
            pump();
        });
    }

    function idle(): Promise<void> {
        if (running.size === 0 && queue.length === 0) return Promise.resolve();
        return new Promise((resolve) => idleWaiters.push(resolve));
    }

    return {
        async onAdd(filePath) {
            if (stopped || !isSourceFile(filePath)) return;
            const filename = path.basename(filePath);
            logger.log(`[ImageWatcher] New file detected: ${filename}`);
            let written: string[] = [];
            let owner = filename;
            let tookOver = false;
            const outcome = await enqueue(filename, true, async () => {
                owner = await ownerOf(filename);
                if (owner !== filename) return;
                // Another source built the set it now owns, so its mtime says nothing about the set.
                tookOver = setMembers(filename).length > 1;
                written = await refreshImage(filename, { force: tookOver });
            });
            if (outcome !== 'done') return;
            if (owner !== filename) logger.log(`[ImageWatcher] Skipping ${filename}: it shares its derivatives with ${owner}.`);
            else if (tookOver) logger.log(`[ImageWatcher] Rebuilt the set ${filename} now owns from it.`);
            else logger.log(`[ImageWatcher] ${written.length > 0 ? 'Processed' : 'Already up to date'}: ${filename}`);
        },

        async onChange(filePath) {
            if (stopped || !isSourceFile(filePath)) return;
            const filename = path.basename(filePath);
            logger.log(`[ImageWatcher] File changed, reprocessing: ${filename}`);
            // This job rebuilds or refreshes the set, so a startup job still waiting for it is redundant
            const key = setKeyOf(filename);
            dropStartupJobs((job) => job.key === key && sharesSet(job.label, filename));
            let owner = filename;
            const outcome = await enqueue(filename, true, async () => {
                owner = await ownerOf(filename);
                if (owner === filename) await reprocessImage(filename);
                // It owned the set until this change, as when it no longer decodes, so the set may show its old pixels
                else if (filename < owner) await reprocessImage(owner);
                // The owner's startup job may have just been dropped
                else await refreshImage(owner);
            });
            if (outcome !== 'done') return;
            if (owner === filename) logger.log(`[ImageWatcher] Reprocessed: ${filename}`);
            else if (filename < owner) logger.log(`[ImageWatcher] Rebuilt the set ${filename} shared from ${owner}, which owns it now.`);
            else logger.log(`[ImageWatcher] Skipping ${filename}: it shares its derivatives with ${owner}.`);
        },

        async onUnlink(filePath) {
            if (stopped || !isSourceFile(filePath)) return;
            const filename = path.basename(filePath);
            logger.log(`[ImageWatcher] Source removed: ${filename}. Derivatives kept. See npm run images:cleanup.`);
            // The set it shared may show its pixels, so the source that owns it now builds it again.
            let next: string | null = null;
            const outcome = await enqueue(filename, true, async () => {
                next = await ownerAfterRemoval(filename);
                if (next) await reprocessImage(next);
            });
            if (outcome === 'done' && next) logger.log(`[ImageWatcher] Rebuilt the set ${filename} shared from ${next}.`);
        },

        async queueStartupBatch({ force = false } = {}) {
            const result: StartupBatchResult = { processed: [], skipped: [], errors: [] };
            if (stopped) return result;
            logger.log('[ImageWatcher] Checking for unprocessed images...');
            const { files, shared } = await planSources({ force });
            for (const { file, owner, undecodable } of shared) {
                logger.log(`[ImageWatcher] Skipping ${file}: ${undecodable ? `it can't be decoded, so ${owner} has the derivatives they share` : `it shares its derivatives with ${owner}`}.`);
            }
            if (files.length === 0) {
                logger.log('[ImageWatcher] All images are processed.');
                return result;
            }

            logger.log(`[ImageWatcher] Found ${files.length} unprocessed images.`);
            const outcomes = await Promise.all(files.map((file, index) => enqueue(file, false, async () => {
                logger.log(`[ImageWatcher] Processing ${index + 1}/${files.length}: ${file}`);
                await refreshImage(file, { force });
            })));

            const lists: Record<Outcome, string[]> = { done: result.processed, skipped: result.skipped, failed: result.errors };
            files.forEach((file, index) => lists[outcomes[index]].push(file));
            logger.log(
                `[ImageWatcher] Completed: ${result.processed.length} processed, ` +
                `${result.skipped.length} skipped, ${result.errors.length} errors`,
            );
            return result;
        },

        stop() {
            stopped = true;
            dropStartupJobs(() => true);
            pump();
        },

        idle,

        async drain(timeoutMs) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timedOut = new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), timeoutMs);
            });
            try {
                return await Promise.race([idle().then(() => true), timedOut]);
            } finally {
                clearTimeout(timer);
            }
        },

        unfinished: () => [...running.values(), ...queue].map((job) => job.label),
    };
}

/**
 * Wait up to `timeoutMs` for queued jobs. If some are still unfinished, name
 * them: a restart redoes only a photo whose source is newer than its set.
 */
export async function drainOrReport(handlers: WatcherHandlers, timeoutMs: number, logger: Logger = console): Promise<boolean> {
    if (await handlers.drain(timeoutMs)) return true;
    const names = handlers.unfinished();
    logger.error(
        `[ImageWatcher] Jobs still running after ${timeoutMs / 1000}s. Exiting anyway.` +
        (names.length > 0 ? ` Not finished: ${names.join(', ')}. Touch them, or run --once --force, to process them.` : ''),
    );
    return false;
}

/**
 * `--once`: queue the startup batch watch mode runs, wait for it, and return
 * the exit status, 1 if any photo failed or changed while it was processed,
 * since that one still needs a run.
 */
export async function processOnce(
    handlers: WatcherHandlers,
    { force = false, logger = console }: { force?: boolean; logger?: Logger } = {},
): Promise<number> {
    const result = await handlers.queueStartupBatch({ force });
    await handlers.idle();
    if (result.errors.length > 0) {
        logger.log('[ImageWatcher] Done, but some photos failed.');
        return 1;
    }
    if (result.skipped.length > 0) {
        logger.log('[ImageWatcher] Done, but some photos changed while they were processed. Run it again.');
        return 1;
    }
    logger.log('[ImageWatcher] Done.');
    return 0;
}

export interface AttachOptions {
    root: string;
    force?: boolean;
    logger?: Logger;
    /** Called when chokidar reports the library root itself removed. */
    onRootRemoved: () => void;
}

/**
 * Wire chokidar's events to the handlers. The startup batch is queued on
 * `ready`, once chokidar has its baseline: it reports no event for a file it
 * finds during the initial scan, so only a batch that lists the library after
 * that scan catches a file saved before it finished.
 */
export function attachWatcher(
    watcher: Pick<EventEmitter<FSWatcherEventMap>, 'on'>,
    handlers: WatcherHandlers,
    { root, force = false, logger = console, onRootRemoved }: AttachOptions,
): void {
    // New files regenerate only when their set is incomplete or older than them
    watcher.on('add', (filePath: string) => {
        void handlers.onAdd(filePath);
    });

    // Changed files, including a save-by-rename, regenerate in place
    watcher.on('change', (filePath: string) => {
        void handlers.onChange(filePath);
    });

    // Removing a source keeps its derivatives
    watcher.on('unlink', (filePath: string) => {
        void handlers.onUnlink(filePath);
    });

    watcher.on('unlinkDir', (dirPath: string) => {
        if (path.resolve(dirPath) === path.resolve(root)) onRootRemoved();
    });

    watcher.on('error', (error) => {
        logger.error('[ImageWatcher] Watcher error:', error);
    });

    watcher.on('ready', () => {
        logger.log('[ImageWatcher] Initial scan complete. Watching for changes...');
        handlers.queueStartupBatch({ force }).catch((error: unknown) => {
            logger.error('[ImageWatcher] Startup batch failed:', error);
        });
    });
}
