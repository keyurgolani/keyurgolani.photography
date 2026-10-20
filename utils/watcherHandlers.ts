import path from 'path';
import { filesToProcess, isSourceFile, refreshImage, reprocessImage } from './imageOptimizer';

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
    /** Log only. Removing a source never deletes its derivatives. */
    onUnlink(filePath: string): void;
    /** Queue every unprocessed source on the job chain, using processAllImages()'s overwrite rule. */
    queueStartupBatch(options?: { force?: boolean }): Promise<StartupBatchResult>;
    /** Resolve once every queued job has finished. */
    idle(): Promise<void>;
}

/** `a.jpg` and `a.png` write the same outputs, so jobs are keyed by basename without extension. */
export function jobKey(filename: string): string {
    return path.basename(filename, path.extname(filename));
}

/** Runs at most `max` jobs at once, handing a freed slot straight to the next waiter. */
function createLimiter(max: number) {
    let active = 0;
    const waiting: (() => void)[] = [];

    return async function limit<T>(job: () => Promise<T>): Promise<T> {
        if (active < max) {
            active++;
        } else {
            await new Promise<void>((resolve) => waiting.push(resolve));
        }
        try {
            return await job();
        } finally {
            const next = waiting.shift();
            if (next) next();
            else active--;
        }
    };
}

export function createWatcherHandlers(
    { logger = console, maxConcurrentJobs = 1 }: { logger?: Logger; maxConcurrentJobs?: number } = {},
): WatcherHandlers {
    // Jobs for one basename run in turn, so two quick edits, or an edit racing
    // the startup batch, never interleave their writes. The limiter bounds memory
    // when many files arrive at once, since each job holds its source in memory.
    const chains = new Map<string, Promise<void>>();
    const limit = createLimiter(maxConcurrentJobs);

    function enqueue(filename: string, job: () => Promise<unknown>): Promise<boolean> {
        const key = jobKey(filename);
        let succeeded = false;
        const run = (chains.get(key) ?? Promise.resolve())
            .then(() => limit(job))
            .then(
                () => {
                    succeeded = true;
                },
                (error: unknown) => {
                    logger.error(`[ImageWatcher] Error processing ${filename}:`, error);
                },
            );
        chains.set(key, run);
        void run.then(() => {
            if (chains.get(key) === run) chains.delete(key);
        });
        return run.then(() => succeeded);
    }

    async function regenerate(filePath: string, detected: string, done: string): Promise<void> {
        if (!isSourceFile(filePath)) return;
        const filename = path.basename(filePath);
        logger.log(`[ImageWatcher] ${detected}: ${filename}`);
        if (await enqueue(filename, () => reprocessImage(filename))) {
            logger.log(`[ImageWatcher] ${done}: ${filename}`);
        }
    }

    return {
        onAdd: (filePath) => regenerate(filePath, 'New file detected', 'Processed'),

        onChange: (filePath) => regenerate(filePath, 'File changed, reprocessing', 'Reprocessed'),

        onUnlink(filePath) {
            if (!isSourceFile(filePath)) return;
            logger.log(
                `[ImageWatcher] Source removed: ${path.basename(filePath)}. Derivatives kept. See npm run images:cleanup.`,
            );
        },

        async queueStartupBatch({ force = false } = {}) {
            logger.log('[ImageWatcher] Checking for unprocessed images...');
            const files = filesToProcess({ force });
            if (files.length === 0) {
                logger.log('[ImageWatcher] All images are processed.');
                return { processed: [], errors: [] };
            }

            logger.log(`[ImageWatcher] Found ${files.length} unprocessed images.`);
            const outcomes = await Promise.all(files.map((file, index) => enqueue(file, async () => {
                logger.log(`[ImageWatcher] Processing ${index + 1}/${files.length}: ${file}`);
                await refreshImage(file, { force });
            })));

            const processed = files.filter((_, index) => outcomes[index]);
            const errors = files.filter((_, index) => !outcomes[index]);
            logger.log(`[ImageWatcher] Completed: ${processed.length} processed, ${errors.length} errors`);
            return { processed, errors };
        },

        async idle() {
            while (chains.size > 0) {
                await Promise.all(chains.values());
            }
        },
    };
}
