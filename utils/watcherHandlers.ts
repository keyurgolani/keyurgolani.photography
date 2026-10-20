import type { EventEmitter } from 'events';
import path from 'path';
import type { FSWatcherEventMap } from 'chokidar';
import {
    filesToProcess,
    generatedFolderNames,
    isSourceFile,
    markStale,
    refreshImage,
    reprocessImage,
    SOURCE_CHANGED,
} from './imageOptimizer';

type Logger = Pick<Console, 'log' | 'error'>;

export interface StartupBatchResult {
    processed: string[];
    /** Changed or removed while processed, superseded by a live event, or dropped by stop() */
    skipped: string[];
    errors: string[];
}

export interface WatcherHandlers {
    /** Regenerate all seven outputs for a new source, including one re-added after an unlink. */
    onAdd(filePath: string): Promise<void>;
    /** Regenerate all seven outputs for a changed source, including a save-by-rename. */
    onChange(filePath: string): Promise<void>;
    /**
     * Keep the derivatives, but mark them stale, so a different file that later
     * arrives under the same name is regenerated whatever its mtime.
     */
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
}

/** `a.jpg` and `a.png` write the same outputs, so jobs are keyed by basename without extension. */
export function jobKey(filename: string): string {
    return path.basename(filename, path.extname(filename));
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

function hasCode(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

export function createWatcherHandlers(
    { logger = console, maxConcurrentJobs = 1 }: { logger?: Logger; maxConcurrentJobs?: number } = {},
): WatcherHandlers {
    // One queue, in arrival order. A job starts only when no job for its basename
    // is running or queued ahead of it, so one source's jobs run in turn and never
    // at once. Each job holds its source in memory, so at most maxConcurrentJobs
    // run. A free slot goes first to a basename with a live event waiting, so a
    // photo added after start doesn't wait behind the whole startup backlog.
    const queue: Job[] = [];
    const running = new Set<string>();
    let idleWaiters: (() => void)[] = [];
    let stopped = false;

    function pick(): Job | undefined {
        const liveKeys = new Set(queue.filter((job) => job.live).map((job) => job.key));
        const seen = new Set<string>();
        let firstReady: Job | undefined;
        for (const job of queue) {
            const ready = !running.has(job.key) && !seen.has(job.key);
            seen.add(job.key);
            if (!ready) continue;
            if (liveKeys.has(job.key)) return job;
            firstReady ??= job;
        }
        return firstReady;
    }

    function pump(): void {
        while (running.size < maxConcurrentJobs) {
            const job = pick();
            if (!job) break;
            queue.splice(queue.indexOf(job), 1);
            running.add(job.key);
            Promise.resolve()
                .then(job.run)
                .then(
                    () => job.settle('done'),
                    (error: unknown) => {
                        if (hasCode(error, SOURCE_CHANGED)) {
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
            queue.splice(queue.indexOf(job), 1);
            job.settle('skipped');
        }
    }

    function enqueue(filename: string, live: boolean, run: () => Promise<unknown>): Promise<Outcome> {
        return new Promise((settle) => {
            const key = jobKey(filename);
            // A live job for this photo regenerates it anyway, so a startup job still waiting is redundant
            if (live) dropStartupJobs((job) => job.key === key);
            queue.push({ key, live, label: filename, run, settle });
            pump();
        });
    }

    function idle(): Promise<void> {
        if (running.size === 0 && queue.length === 0) return Promise.resolve();
        return new Promise((resolve) => idleWaiters.push(resolve));
    }

    /**
     * Mark a source's derivatives stale when its event is queued, not when the
     * job runs, so a restart still redoes a job that never ran. The job's new
     * thumbnail clears the mark.
     */
    function markQueued(filename: string): void {
        const failure = markStale(filename);
        if (failure) {
            logger.error(
                `[ImageWatcher] Could not mark ${filename}'s derivatives stale: ${failure.message}. ` +
                'If a different photo replaces it with an older mtime, touch that file.',
            );
        }
    }

    async function regenerate(filePath: string, detected: string, done: string): Promise<void> {
        if (stopped || !isSourceFile(filePath)) return;
        const filename = path.basename(filePath);
        logger.log(`[ImageWatcher] ${detected}: ${filename}`);
        markQueued(filename);
        if (await enqueue(filename, true, () => reprocessImage(filename)) === 'done') {
            logger.log(`[ImageWatcher] ${done}: ${filename}`);
        }
    }

    return {
        onAdd: (filePath) => regenerate(filePath, 'New file detected', 'Processed'),

        onChange: (filePath) => regenerate(filePath, 'File changed, reprocessing', 'Reprocessed'),

        async onUnlink(filePath) {
            if (stopped || !isSourceFile(filePath)) return;
            const filename = path.basename(filePath);
            logger.log(`[ImageWatcher] Source removed: ${filename}. Derivatives kept. See npm run images:cleanup.`);
            markQueued(filename);
            // Again once any swap still running for this name is done, since its new thumbnail clears the mark
            await enqueue(filename, true, async () => markQueued(filename));
        },

        async queueStartupBatch({ force = false } = {}) {
            const result: StartupBatchResult = { processed: [], skipped: [], errors: [] };
            if (stopped) return result;
            logger.log('[ImageWatcher] Checking for unprocessed images...');
            const files = filesToProcess({ force });
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
    };
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
    // New files, including one copied back after a delete, regenerate in place
    watcher.on('add', (filePath: string) => {
        void handlers.onAdd(filePath);
    });

    // Changed files, including a save-by-rename, regenerate in place
    watcher.on('change', (filePath: string) => {
        void handlers.onChange(filePath);
    });

    // Removing a source keeps its derivatives, marked stale
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
