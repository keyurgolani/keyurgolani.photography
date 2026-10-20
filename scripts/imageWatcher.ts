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
 * mode also exits 1 if the root disappears while it runs. An unknown flag
 * exits 2.
 * 
 * Usage:
 *   # Watch mode (continuous)
 *   npx tsx scripts/imageWatcher.ts --watch
 *   
 *   # One-shot mode (process once and exit)
 *   npx tsx scripts/imageWatcher.ts
 *   
 *   # Process and exit. Exits 1 if any photo failed or changed while it was processed.
 *   npx tsx scripts/imageWatcher.ts --once
 *
 *   # Regenerate every derivative, not only missing or outdated ones
 *   npx tsx scripts/imageWatcher.ts --once --force
 */

import { parseArgs } from 'node:util';
import chokidar from 'chokidar';
import { ensureDirectories, libraryPaths, libraryRootExists } from '../utils/imageOptimizer';
import { attachWatcher, createIgnoreFilter, createWatcherHandlers, processOnce } from '../utils/watcherHandlers';

const USAGE = 'Usage: npx tsx scripts/imageWatcher.ts [--watch | --once] [--force]';

/** Strict, so a mistyped flag such as --froce exits 2 instead of being ignored. */
function readFlags(): { once: boolean; force: boolean } {
    let values: { watch?: boolean; once?: boolean; force?: boolean; help?: boolean };
    try {
        ({ values } = parseArgs({
            args: process.argv.slice(2),
            options: {
                watch: { type: 'boolean' },
                once: { type: 'boolean' },
                force: { type: 'boolean' },
                help: { type: 'boolean', short: 'h' },
            },
            strict: true,
        }));
    } catch (error) {
        console.error(`[ImageWatcher] ${error instanceof Error ? error.message : String(error)}`);
        console.error(USAGE);
        process.exit(2);
    }
    if (values.help) {
        console.log(USAGE);
        process.exit(0);
    }
    return { once: Boolean(values.once) || !values.watch, force: Boolean(values.force) };
}

const FLAGS = readFlags();
const ONCE_MODE = FLAGS.once;
const FORCE = FLAGS.force;

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
    
    // Events, and the startup batch once the initial scan is ready. Live events still jump ahead of that backlog.
    attachWatcher(watcher, handlers, {
        root,
        force: FORCE,
        onRootRemoved: () => void shutdown(1, `Library root removed: ${root}`),
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

/** The same startup batch watch mode runs, then exit. Returns 1 if any photo failed or changed meanwhile. */
async function runOnce(): Promise<number> {
    console.log('[ImageWatcher] Running in one-shot mode...');
    requireLibraryRoot();
    ensureDirectories();
    return processOnce(createWatcherHandlers(), { force: FORCE });
}

// Main execution
if (ONCE_MODE) {
    runOnce()
        .then((code) => {
            process.exit(code);
        })
        .catch((error) => {
            console.error('[ImageWatcher] Error:', error);
            process.exit(1);
        });
} else {
    startWatcher();
}
