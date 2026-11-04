import type { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import type { ChokidarOptions, FSWatcherEventMap } from 'chokidar';
import { isScanExcluded } from '../lib/identity/scan';

/**
 * How the watcher watches the library. It only watches: every change
 * schedules an identity pass, which reads the library and writes the data
 * root. Since v1.7.0 (#13's slice E) nothing here writes the library, and
 * the legacy basename derivatives a v1.6 watcher wrote into it are left as
 * they are, unwatched.
 */

type Logger = Pick<Console, 'log' | 'error'>;

/**
 * The chokidar `ignored` filter: exactly what the identity scan skips. That
 * is the legacy output folders directly under the root, matched by exact
 * name on the first path segment, never by substring, so a root like
 * `/srv/cache/photos`, a photo named `thumbnails-beach.jpg`, and a nested
 * `trips/thumbnails/` folder are still watched; dot-entries at any depth;
 * every symlink below the root; and a symlink in the root to a folder, since
 * the scan reads nothing through a symlink. A symlink in the root to a file
 * is still watched through the link.
 */
export function createIgnoreFilter(root: string): (watchedPath: string, stats?: fs.Stats) => boolean {
    const resolvedRoot = path.resolve(root);
    return (watchedPath, stats) => {
        const relative = path.relative(resolvedRoot, path.resolve(watchedPath));
        if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            return false;
        }
        const posix = relative.split(path.sep).join('/');
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
 * Watch every depth of the library, polling, as Docker bind mounts need,
 * from the root's real path, so a symlinked root still reports its changes.
 * createIgnoreFilter() keeps it out of everything reached through a symlink
 * but a file in the root.
 */
export function watchSetup(root: string): WatchSetup {
    const real = fs.realpathSync(root);
    return {
        path: real,
        options: {
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
            followSymlinks: true,
            ignored: createIgnoreFilter(real),
        },
    };
}

/** A chokidar event under the library root. */
export type LibraryChange = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

export interface AttachOptions {
    root: string;
    logger?: Logger;
    /** Called when chokidar reports the library root itself removed. */
    onRootRemoved: () => void;
    /** Called for every file or folder change in the library, at any depth. The identity step schedules a pass here. */
    onLibraryChange?: (event: LibraryChange, changedPath: string) => void;
    /** Called on `ready`, once chokidar has its baseline. */
    onReady?: () => void;
}

/**
 * Wire chokidar's events to the identity step. Every change, nested ones
 * included, goes to `onLibraryChange`, but the root's own add and removal:
 * removing the root calls `onRootRemoved` instead. `onReady` runs once
 * chokidar has its baseline: it reports no event for a file it finds during
 * the initial scan, so only a pass that reads the library after that scan
 * catches a file saved before it finished.
 */
export function attachWatcher(
    watcher: Pick<EventEmitter<FSWatcherEventMap>, 'on'>,
    { root, logger = console, onRootRemoved, onLibraryChange, onReady }: AttachOptions,
): void {
    for (const event of ['add', 'change', 'unlink'] as const) {
        watcher.on(event, (filePath: string) => onLibraryChange?.(event, filePath));
    }

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
        onReady?.();
    });
}
