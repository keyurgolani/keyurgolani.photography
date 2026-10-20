import path from 'path';
import {
    filesToProcess,
    generatedFolderNames,
    isSourceFile,
    markStale,
    refreshImage,
    reprocessImage,
} from './imageOptimizer';

type Logger = Pick<Console, 'log' | 'error'>;

export interface StartupBatchResult {
    processed: string[];
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
    /** Stop taking events. Jobs already queued still run. */
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

interface Job {
    key: string;
    live: boolean;
    label: string;
    run: () => Promise<unknown>;
    settle: (succeeded: boolean) => void;
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
                    () => job.settle(true),
                    (error: unknown) => {
                        logger.error(`[ImageWatcher] Error processing ${job.label}:`, error);
                        job.settle(false);
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

    function enqueue(filename: string, live: boolean, run: () => Promise<unknown>): Promise<boolean> {
        return new Promise((settle) => {
            queue.push({ key: jobKey(filename), live, label: filename, run, settle });
            pump();
        });
    }

    function idle(): Promise<void> {
        if (running.size === 0 && queue.length === 0) return Promise.resolve();
        return new Promise((resolve) => idleWaiters.push(resolve));
    }

    async function regenerate(filePath: string, detected: string, done: string): Promise<void> {
        if (stopped || !isSourceFile(filePath)) return;
        const filename = path.basename(filePath);
        logger.log(`[ImageWatcher] ${detected}: ${filename}`);
        if (await enqueue(filename, true, () => reprocessImage(filename))) {
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
            // Queued like any job, so it lands after a swap still running for this name
            await enqueue(filename, true, async () => {
                if (!markStale(filename)) {
                    logger.log(`[ImageWatcher] Could not mark ${filename}'s derivatives stale. A later file under this name may need --force.`);
                }
            });
        },

        async queueStartupBatch({ force = false } = {}) {
            if (stopped) return { processed: [], errors: [] };
            logger.log('[ImageWatcher] Checking for unprocessed images...');
            const files = filesToProcess({ force });
            if (files.length === 0) {
                logger.log('[ImageWatcher] All images are processed.');
                return { processed: [], errors: [] };
            }

            logger.log(`[ImageWatcher] Found ${files.length} unprocessed images.`);
            const outcomes = await Promise.all(files.map((file, index) => enqueue(file, false, async () => {
                logger.log(`[ImageWatcher] Processing ${index + 1}/${files.length}: ${file}`);
                await refreshImage(file, { force });
            })));

            const processed = files.filter((_, index) => outcomes[index]);
            const errors = files.filter((_, index) => !outcomes[index]);
            logger.log(`[ImageWatcher] Completed: ${processed.length} processed, ${errors.length} errors`);
            return { processed, errors };
        },

        stop() {
            stopped = true;
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
