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
 * the working directory. Both modes exit 1 if the root is missing.
 * 
 * Usage:
 *   # Watch mode (continuous)
 *   npx tsx scripts/imageWatcher.ts --watch
 *   
 *   # One-shot mode (process once and exit)
 *   npx tsx scripts/imageWatcher.ts
 *   
 *   # Process and exit
 *   npx tsx scripts/imageWatcher.ts --once
 *
 *   # Regenerate every derivative, not only missing or outdated ones
 *   npx tsx scripts/imageWatcher.ts --once --force
 */

import chokidar from 'chokidar';
import {
    ensureDirectories,
    filesToProcess,
    libraryPaths,
    libraryRootExists,
    processAllImages,
} from '../utils/imageOptimizer';
import { createWatcherHandlers } from '../utils/watcherHandlers';

const WATCH_MODE = process.argv.includes('--watch');
const ONCE_MODE = process.argv.includes('--once') || !WATCH_MODE;
const FORCE = process.argv.includes('--force');

// Directories to skip when watching
const SKIP_DIRS = [
    'thumbnails',
    'medium',
    'optimized',
    'thumbnails-avif',
    'medium-avif',
    'optimized-avif',
    'lqip',
    'cache',
];

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

async function processUnprocessedImages(): Promise<void> {
    console.log('[ImageWatcher] Checking for unprocessed images...');
    
    const unprocessed = filesToProcess({ force: FORCE });
    
    if (unprocessed.length === 0) {
        console.log('[ImageWatcher] All images are processed.');
        return;
    }
    
    console.log(`[ImageWatcher] Found ${unprocessed.length} unprocessed images.`);
    
    const result = await processAllImages((current, total, file) => {
        console.log(`[ImageWatcher] Processing ${current}/${total}: ${file}`);
    }, { force: FORCE });
    
    console.log(`[ImageWatcher] Completed: ${result.processed.length} processed, ${result.errors.length} errors`);
    
    if (result.errors.length > 0) {
        result.errors.forEach(e => {
            console.error(`[ImageWatcher] Error processing ${e.file}:`, e.error.message);
        });
    }
}

function startWatcher(): void {
    const root = requireLibraryRoot();
    ensureDirectories();
    
    console.log(`[ImageWatcher] Starting chokidar watcher for: ${root}`);
    
    const handlers = createWatcherHandlers();
    
    // Queue offline changes before live events, so each source's startup job runs first
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
        ignored: (watchedPath: string) => {
            // Skip processing directories
            return SKIP_DIRS.some(dir => {
                const normalizedPath = watchedPath.replace(/\\/g, '/');
                return normalizedPath.includes(`/${dir}`) || normalizedPath.endsWith(`/${dir}`);
            });
        },
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
    
    // Removing a source keeps its derivatives
    watcher.on('unlink', (filePath: string) => {
        handlers.onUnlink(filePath);
    });
    
    watcher.on('error', (error) => {
        console.error('[ImageWatcher] Watcher error:', error);
    });
    
    watcher.on('ready', () => {
        console.log('[ImageWatcher] Initial scan complete. Watching for changes...');
    });
    
    // Handle graceful shutdown
    const shutdown = () => {
        console.log('\n[ImageWatcher] Shutting down...');
        watcher.close().then(() => {
            console.log('[ImageWatcher] Watcher closed.');
            process.exit(0);
        }).catch((err) => {
            console.error('[ImageWatcher] Error closing watcher:', err);
            process.exit(1);
        });
    };
    
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    
    console.log('[ImageWatcher] Watching for changes. Press Ctrl+C to exit.');
}

async function runOnce(): Promise<void> {
    console.log('[ImageWatcher] Running in one-shot mode...');
    requireLibraryRoot();
    ensureDirectories();
    await processUnprocessedImages();
}

// Main execution
if (ONCE_MODE) {
    runOnce()
        .then(() => {
            console.log('[ImageWatcher] Done.');
            process.exit(0);
        })
        .catch((error) => {
            console.error('[ImageWatcher] Error:', error);
            process.exit(1);
        });
} else {
    startWatcher();
}
