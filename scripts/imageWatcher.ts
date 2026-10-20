#!/usr/bin/env node
/**
 * Image Watcher Script
 * 
 * Watches the photos directory for changes and processes new images automatically.
 * Uses chokidar for reliable file watching in Docker bind-mount scenarios.
 * It never deletes a source or a derivative. Removing a source keeps its
 * derivatives, and `npm run images:cleanup` reviews the leftovers.
 *
 * The library root is PHOTOGRAPHY_LIBRARY_DIR, or public/assets/photos under
 * the working directory. Both modes exit 1 if the root is missing, and watch
 * mode also exits 1 if the root disappears while it runs.
 * 
 * Usage:
 *   # Watch mode (continuous)
 *   npx tsx scripts/imageWatcher.ts --watch
 *   
 *   # One-shot mode (process once and exit)
 *   npx tsx scripts/imageWatcher.ts
 *   
 *   # Process and exit. Exits 1 if any photo failed.
 *   npx tsx scripts/imageWatcher.ts --once
 *
 *   # Regenerate every derivative, not only missing or outdated ones
 *   npx tsx scripts/imageWatcher.ts --once --force
 */

import path from 'path';
import chokidar from 'chokidar';
import { ensureDirectories, libraryPaths, libraryRootExists } from '../utils/imageOptimizer';
import { createIgnoreFilter, createWatcherHandlers } from '../utils/watcherHandlers';

const WATCH_MODE = process.argv.includes('--watch');
const ONCE_MODE = process.argv.includes('--once') || !WATCH_MODE;
const FORCE = process.argv.includes('--force');

/** Docker kills a container 10 s after SIGTERM, so queued jobs get this long to finish. */
const SHUTDOWN_GRACE_MS = 8000;

/** How often watch mode checks that the library root is still there. */
const ROOT_CHECK_MS = 5000;
    
/** Exit 1 instead of recreating a missing root, which would hide an unmounted library. */
function requireLibraryRoot(): string {
    const { root } = libraryPaths();
    if (!libraryRootExists(root)) {
        console.error(
            `[ImageWatcher] Library root not found: ${root}. Check the mount or PHOTOGRAPHY_LIBRARY_DIR. Nothing was processed.`,
        );
        process.exit(1);
    }
    return root;
}

function startWatcher(): void {
    const root = requireLibraryRoot();
    ensureDirectories();
    
    console.log(`[ImageWatcher] Starting chokidar watcher for: ${root}`);
    
    const handlers = createWatcherHandlers();
    
    // Queue offline changes first. Live events still jump ahead of this backlog.
    handlers.queueStartupBatch({ force: FORCE }).catch((error) => {
        console.error('[ImageWatcher] Startup batch failed:', error);
    });
    
    // Set up chokidar watcher with Docker-friendly options
    const watcher = chokidar.watch(root, {
        persistent: true,
        ignoreInitial: true, // Don't fire events for existing files on startup
        usePolling: true, // Reliable in Docker bind mounts
        interval: 2000, // Poll every 2 seconds
        binaryInterval: 3000, // Poll binary files every 3 seconds
        alwaysStat: true, // Always provide stats
        depth: 0, // Only watch the top level (not subdirectories)
        ignored: createIgnoreFilter(root), // Skip the generated folders
        awaitWriteFinish: {
            stabilityThreshold: 3000, // Wait until file size is stable for 3 seconds
            pollInterval: 500, // Check size every 500ms
        },
    });
    
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
        if (path.resolve(dirPath) === root) void shutdown(1, `Library root removed: ${root}`);
    });
    
    watcher.on('error', (error) => {
        console.error('[ImageWatcher] Watcher error:', error);
    });
    
    watcher.on('ready', () => {
        console.log('[ImageWatcher] Initial scan complete. Watching for changes...');
    });
    
    // Polling may not report the root itself going away, so check it directly too
    const rootCheck = setInterval(() => {
        if (!libraryRootExists(root)) void shutdown(1, `Library root disappeared: ${root}`);
    }, ROOT_CHECK_MS);

    // Stop taking events, close chokidar, give queued jobs a bounded time to finish, then exit
    let shuttingDown = false;
    async function shutdown(code: number, reason: string): Promise<void> {
        if (shuttingDown) return;
        shuttingDown = true;
        clearInterval(rootCheck);
        (code === 0 ? console.log : console.error)(`[ImageWatcher] ${reason}. Shutting down...`);
        handlers.stop();
        try {
            await watcher.close();
        } catch (err) {
            console.error('[ImageWatcher] Error closing watcher:', err);
            code = 1;
        }
        if (!(await handlers.drain(SHUTDOWN_GRACE_MS))) {
            console.error(`[ImageWatcher] Jobs still running after ${SHUTDOWN_GRACE_MS / 1000}s. Exiting anyway.`);
        }
        console.log('[ImageWatcher] Watcher closed.');
        process.exit(code);
    }
    
    process.on('SIGINT', () => void shutdown(0, 'Received SIGINT'));
    process.on('SIGTERM', () => void shutdown(0, 'Received SIGTERM'));
    
    console.log('[ImageWatcher] Watching for changes. Press Ctrl+C to exit.');
}

/** The same startup batch watch mode runs, then exit. Returns 1 if any photo failed. */
async function runOnce(): Promise<number> {
    console.log('[ImageWatcher] Running in one-shot mode...');
    requireLibraryRoot();
    ensureDirectories();
    const handlers = createWatcherHandlers();
    const result = await handlers.queueStartupBatch({ force: FORCE });
    await handlers.idle();
    return result.errors.length > 0 ? 1 : 0;
}

// Main execution
if (ONCE_MODE) {
    runOnce()
        .then((code) => {
            console.log(code === 0 ? '[ImageWatcher] Done.' : '[ImageWatcher] Done, but some photos failed.');
            process.exit(code);
        })
        .catch((error) => {
            console.error('[ImageWatcher] Error:', error);
            process.exit(1);
        });
} else {
    startWatcher();
}
