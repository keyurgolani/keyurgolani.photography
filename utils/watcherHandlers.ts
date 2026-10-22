import type { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import type { ChokidarOptions, FSWatcherEventMap } from 'chokidar';
import { isScanExcluded } from '../lib/identity/scan';
import {
    cacheFolderWritable,
    generatedFolderNames,
    hasErrorCode,
    isSourceFile,
    lastBuiltFrom,
    libraryPaths,
    ownerAfterRemoval,
    ownerOf,
    planSources,
    refreshImage,
    reprocessImage,
    setKeyOf,
    setMembers,
    sharesSet,
    SOURCE_CHANGED,
    uprightMarkerPath,
    writeUprightMarker,
} from './imageOptimizer';

type Logger = Pick<Console, 'log' | 'error'>;

/** `1 photo`, `2 photos`. */
function photos(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

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
     * removed and copied back costs nothing. A source that owns a set it shares
     * with another is the exception: its set is rebuilt from it whatever its
     * mtime, since the other may have built the set, as its removal did.
     */
    onAdd(filePath: string): Promise<void>;
    /** Regenerate all seven outputs for a changed source, including a save-by-rename. */
    onChange(filePath: string): Promise<void>;
    /** Keep the derivatives, and rebuild a set the source shared from the source that owns it now. */
    onUnlink(filePath: string): Promise<void>;
    /** Queue every unprocessed source, using the overwrite rule in refreshImage(). */
    queueStartupBatch(options?: { force?: boolean }): Promise<StartupBatchResult>;
    /**
     * Stop taking events and drop the queued startup jobs, which the next start
     * finds again on disk. Queued live jobs still run.
     */
    stop(): void;
    /** Resolve once every queued job has finished and no startup batch is still working out its jobs. */
    idle(): Promise<void>;
    /** Wait up to `timeoutMs` for queued jobs. Resolves false if some were still running. */
    drain(timeoutMs: number): Promise<boolean>;
    /** The photos with a job running or queued. */
    unfinished(): string[];
}

/**
 * The chokidar `ignored` filter. It always skips the generated folders
 * directly under the root, matched by exact name on the first path segment,
 * never by substring, so a root like `/srv/cache/photos`, a photo named
 * `thumbnails-beach.jpg`, and a nested `trips/thumbnails/` folder are still
 * watched. With `identity`, the default, it also skips what the identity scan
 * skips: dot-entries at any depth, every symlink below the root, and a
 * symlink in the root to a folder, since the scan reads nothing through a
 * symlink. A symlink in the root to a file is still watched through the link,
 * the way the legacy step reads it.
 */
export function createIgnoreFilter(root: string, { identity = true }: { identity?: boolean } = {}): (watchedPath: string, stats?: fs.Stats) => boolean {
    const generated = new Set(generatedFolderNames());
    const resolvedRoot = path.resolve(root);
    return (watchedPath, stats) => {
        const relative = path.relative(resolvedRoot, path.resolve(watchedPath));
        if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            return false;
        }
        const posix = relative.split(path.sep).join('/');
        if (generated.has(posix.split('/')[0])) return true;
        if (!identity) return false;
        if (isScanExcluded(posix)) return true;
        // chokidar passes lstat's stats while it lists a folder, so a symlink shows as one there.
        if (!stats?.isSymbolicLink()) return false;
        if (posix.includes('/')) return true;
        try {
            return fs.statSync(watchedPath).isDirectory();
        } catch {
            return false; // A link to nothing, which chokidar passes over by itself.
        }
    };
}

/** What the watcher hands chokidar: the path to watch, and the options. */
export interface WatchSetup {
    path: string;
    options: ChokidarOptions;
}

/**
 * How the watcher watches the library, polling either way, as Docker bind
 * mounts need. Without a data root the identity step never runs, so it
 * watches exactly as it did before that step: the root's own files, through
 * symlinks, skipping the generated folders. With one, it watches every depth
 * for the identity step, from the root's real path, so a symlinked root still
 * reports its changes, and createIgnoreFilter() keeps it out of everything
 * reached through a symlink but a file in the root.
 */
export function watchSetup(root: string, { identity }: { identity: boolean }): WatchSetup {
    const polling = {
        persistent: true,
        ignoreInitial: true, // Don't fire events for existing files on startup
        usePolling: true, // Reliable in Docker bind mounts
        interval: 2000, // Poll every 2 seconds
        binaryInterval: 3000, // Poll binary files every 3 seconds
        alwaysStat: true, // Always provide stats
        awaitWriteFinish: {
            stabilityThreshold: 3000, // Wait until file size is stable for 3 seconds
            pollInterval: 500, // Check size every 500ms
        },
    };
    if (!identity) return { path: root, options: { ...polling, depth: 0, ignored: createIgnoreFilter(root, { identity: false }) } };
    const real = fs.realpathSync(root);
    return { path: real, options: { ...polling, followSymlinks: true, ignored: createIgnoreFilter(real) } };
}

/** Whether `filePath` sits directly in the library root, the only folder the legacy step reads sources from. */
function inRoot(root: string, filePath: string): boolean {
    return path.dirname(path.resolve(filePath)) === path.resolve(root);
}

type Outcome = 'done' | 'skipped' | 'failed';

interface Job {
    key: string;
    live: boolean;
    label: string;
    /** A startup job's --force, which a live job that drops it takes on. */
    force: boolean;
    run: () => Promise<unknown>;
    settle: (outcome: Outcome) => void;
}

/**
 * The handlers watch mode runs: with awaitStartup, so they aren't idle before
 * chokidar's ready queues the startup batch, and the identity step's first
 * pass, which waits on idle(), can't build alongside it.
 */
export function createWatchModeHandlers(options: { logger?: Logger } = {}): WatcherHandlers {
    return createWatcherHandlers({ ...options, awaitStartup: true });
}

export function createWatcherHandlers(
    { logger = console, maxConcurrentJobs = 1, awaitStartup = false }: {
        logger?: Logger;
        maxConcurrentJobs?: number;
        /**
         * Not idle until the first startup batch has queued its jobs, as in watch
         * mode, where that batch waits for chokidar's `ready`. Without it, a step
         * waiting on idle() before `ready` would run alongside that batch.
         */
        awaitStartup?: boolean;
    } = {},
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
    // Startup batches still listing the library, or still to come with awaitStartup. Until they queue their jobs, the handlers aren't idle.
    let planning = awaitStartup ? 1 : 0;
    let startupAwaited = awaitStartup;
    const isIdle = () => running.size === 0 && queue.length === 0 && planning === 0;

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
        if (isIdle()) {
            const waiters = idleWaiters;
            idleWaiters = [];
            waiters.forEach((resolve) => resolve());
        }
    }

    /** Settle the queued, not yet started startup jobs that match, as skipped, and return them. */
    function dropStartupJobs(matches: (job: Job) => boolean): Job[] {
        const dropped = queue.filter((queued) => !queued.live && matches(queued));
        for (const job of dropped) {
            unqueue(job);
            job.settle('skipped');
        }
        return dropped;
    }

    function enqueue(filename: string, live: boolean, run: () => Promise<unknown>, force = false): Promise<Outcome> {
        return new Promise((settle) => {
            queue.push({ key: setKeyOf(filename), live, label: filename, force, run, settle });
            if (live) liveQueued++;
            pump();
        });
    }

    function idle(): Promise<void> {
        if (isIdle()) return Promise.resolve();
        return new Promise((resolve) => idleWaiters.push(resolve));
    }

    /** Record the one-time upright rebuild done, so later starts skip it, apart from `retry`, which failed. */
    function recordUpright(rebuilt: number, retry: readonly string[] = []): void {
        try {
            writeUprightMarker(rebuilt, undefined, undefined, retry);
        } catch (error) {
            logger.error(`[ImageWatcher] Could not write ${uprightMarkerPath()}: ${error instanceof Error ? error.message : String(error)}. The next start rebuilds the orientation-tagged photos again.`);
            return;
        }
        if (rebuilt > 0) {
            logger.log(`[ImageWatcher] Rebuilt the sets of ${photos(rebuilt, 'orientation-tagged photo')}. Clear the /_next/image cache, so it drops what it made from the old sets.`);
        }
        if (retry.length > 0) {
            logger.log(`[ImageWatcher] These orientation-tagged photos failed to rebuild, so each start tries them again until they build: ${retry.join(', ')}.`);
        }
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
                const paths = libraryPaths();
                const members = setMembers(filename, paths);
                owner = await ownerOf(filename, paths, members);
                if (owner !== filename) return;
                // Another source built the set it now owns, so its mtime says nothing about the set.
                tookOver = members.length > 1;
                written = await refreshImage(filename, { force: tookOver, owns: true });
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
            // This job rebuilds or refreshes the set, so a startup job still waiting for it is redundant, and its --force carries over
            const key = setKeyOf(filename);
            const force = dropStartupJobs((job) => job.key === key && sharesSet(job.label, filename)).some((job) => job.force);
            let owner = filename;
            let rebuilt = false;
            const outcome = await enqueue(filename, true, async () => {
                owner = await ownerOf(filename);
                if (owner === filename) {
                    await reprocessImage(filename);
                    return;
                }
                // The set shows what last built it. Unless that was its owner, as when the changed source owned it
                // until it stopped decoding, or another process built it, it may show other pixels, so rebuild it.
                rebuilt = lastBuiltFrom(owner) !== owner;
                if (rebuilt) await reprocessImage(owner);
                // The owner's startup job may have just been dropped
                else await refreshImage(owner, { force });
            });
            if (outcome !== 'done') return;
            if (owner === filename) logger.log(`[ImageWatcher] Reprocessed: ${filename}`);
            else if (rebuilt && filename < owner) logger.log(`[ImageWatcher] Rebuilt the set ${filename} shared from ${owner}, which owns it now.`);
            else if (rebuilt) logger.log(`[ImageWatcher] Rebuilt the set ${filename} shares from its owner, ${owner}.`);
            else logger.log(`[ImageWatcher] Skipping ${filename}: it shares its derivatives with ${owner}.`);
        },

        async onUnlink(filePath) {
            if (stopped || !isSourceFile(filePath)) return;
            const filename = path.basename(filePath);
            logger.log(`[ImageWatcher] Source removed: ${filename}. Derivatives kept.`);
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
            // Busy from here until the jobs are queued, so a step waiting on idle() comes after them, not before.
            // The first batch with awaitStartup takes over the count held since creation.
            if (startupAwaited) startupAwaited = false;
            else planning++;
            let planned = false;
            const queued = () => {
                if (planned) return;
                planned = true;
                planning--;
                pump();
            };
            try {
                logger.log('[ImageWatcher] Checking for unprocessed images...');
                const { files, reowned, upright, shared } = await planSources({ force });
                if (!cacheFolderWritable()) {
                    logger.error(`[ImageWatcher] ${path.dirname(uprightMarkerPath())} can't be written, so the watcher can't record which sets it rebuilt. Until it can, every start rebuilds the orientation-tagged photos again. A set whose rebuild was refused, since another source still in the library last built it, keeps that source's outputs even after that source is edited, until cache/set-sources can be written again.`);
                }
                for (const { file, owner, undecodable } of shared) {
                    logger.log(`[ImageWatcher] Skipping ${file}: ${undecodable ? `it can't be decoded, so ${owner} has the derivatives they share` : `it shares its derivatives with ${owner}`}.`);
                }
                for (const { file, from, unfinished } of reowned) {
                    logger.log(unfinished
                        ? `[ImageWatcher] Rebuilding ${file}'s set, since a build of it from ${from} didn't finish.`
                        : from === null
                            ? `[ImageWatcher] Rebuilding ${file}'s set, which it shares, since nothing records which source it was built from.`
                            : `[ImageWatcher] Rebuilding ${file}'s set, which was last built from ${from}.`);
                }
                const turned = new Set(upright ?? []);
                if (turned.size > 0) {
                    logger.log(`[ImageWatcher] Rebuilding the sets of ${photos(turned.size, 'orientation-tagged photo')} once, since a set written before derivatives were turned upright shows its photo turned or mirrored.`);
                }
                // Rebuilt whatever their state, since their sets can look current
                const forced = new Set([...turned, ...reowned.map(({ file }) => file)]);
                if (files.length === 0) {
                    if (upright !== null) recordUpright(0);
                    logger.log('[ImageWatcher] All images are processed.');
                    return result;
                }

                logger.log(`[ImageWatcher] Found ${files.length} unprocessed images.`);
                const pending = Promise.all(files.map((file, index) => {
                    // Each job's own force, which a live change that drops the job takes on.
                    const jobForce = force || forced.has(file);
                    return enqueue(file, false, async () => {
                        logger.log(`[ImageWatcher] Processing ${index + 1}/${files.length}: ${file}`);
                        await refreshImage(file, { force: jobForce });
                    }, jobForce);
                }));
                queued();
                const outcomes = await pending;

                const lists: Record<Outcome, string[]> = { done: result.processed, skipped: result.skipped, failed: result.errors };
                files.forEach((file, index) => lists[outcomes[index]].push(file));
                if (upright !== null) {
                    // A photo that changed meanwhile, or a stop, leaves the whole rebuild to the next start. One that
                    // failed doesn't hold it back: it is recorded to retry, so the others aren't rebuilt at every start.
                    const outcome = (file: string) => outcomes[files.indexOf(file)];
                    const left = upright.filter((file) => outcome(file) === 'skipped');
                    const failed = upright.filter((file) => outcome(file) === 'failed');
                    if (left.length === 0) recordUpright(upright.length - failed.length, failed);
                    else logger.log(`[ImageWatcher] These orientation-tagged photos weren't rebuilt, so the next start tries again: ${left.join(', ')}.`);
                }
                // Last, once the batch has written everything, marker included.
                logger.log(
                    `[ImageWatcher] Completed: ${result.processed.length} processed, ` +
                    `${result.skipped.length} skipped, ${result.errors.length} errors`,
                );
                return result;
            } finally {
                queued();
            }
        },

        stop() {
            stopped = true;
            // No startup batch comes after stop(), so stop waiting for one.
            if (startupAwaited) {
                startupAwaited = false;
                planning--;
            }
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

/** A chokidar event under the library root. */
export type LibraryChange = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

export interface AttachOptions {
    root: string;
    force?: boolean;
    logger?: Logger;
    /** Called when chokidar reports the library root itself removed. */
    onRootRemoved: () => void;
    /** Called for every file or folder change in the library, at any depth. The identity step schedules a pass here. */
    onLibraryChange?: (event: LibraryChange, changedPath: string) => void;
    /** Called on `ready`, after the startup batch is queued. */
    onReady?: () => void;
}

/**
 * Wire chokidar's events to the handlers. Only files directly in the root
 * reach them, since the legacy step reads sources from there alone, and
 * every change, nested ones included, goes to `onLibraryChange`. The
 * startup batch is queued on `ready`, once chokidar has its baseline: it
 * reports no event for a file it finds during the initial scan, so only a
 * batch that lists the library after that scan catches a file saved before
 * it finished.
 */
export function attachWatcher(
    watcher: Pick<EventEmitter<FSWatcherEventMap>, 'on'>,
    handlers: WatcherHandlers,
    { root, force = false, logger = console, onRootRemoved, onLibraryChange, onReady }: AttachOptions,
): void {
    // New files regenerate only when their set is incomplete or older than them
    watcher.on('add', (filePath: string) => {
        onLibraryChange?.('add', filePath);
        if (inRoot(root, filePath)) void handlers.onAdd(filePath);
    });

    // Changed files, including a save-by-rename, regenerate in place
    watcher.on('change', (filePath: string) => {
        onLibraryChange?.('change', filePath);
        if (inRoot(root, filePath)) void handlers.onChange(filePath);
    });

    // Removing a source keeps its derivatives
    watcher.on('unlink', (filePath: string) => {
        onLibraryChange?.('unlink', filePath);
        if (inRoot(root, filePath)) void handlers.onUnlink(filePath);
    });

    watcher.on('addDir', (dirPath: string) => {
        if (path.resolve(dirPath) !== path.resolve(root)) onLibraryChange?.('addDir', dirPath);
    });

    watcher.on('unlinkDir', (dirPath: string) => {
        if (path.resolve(dirPath) === path.resolve(root)) onRootRemoved();
        else onLibraryChange?.('unlinkDir', dirPath);
    });

    watcher.on('error', (error) => {
        logger.error('[ImageWatcher] Watcher error:', error);
    });

    watcher.on('ready', () => {
        logger.log('[ImageWatcher] Initial scan complete. Watching for changes...');
        handlers.queueStartupBatch({ force }).catch((error: unknown) => {
            logger.error('[ImageWatcher] Startup batch failed:', error);
        });
        onReady?.();
    });
}
