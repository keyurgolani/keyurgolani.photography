#!/usr/bin/env node
/**
 * Image Watcher Script
 * 
 * Watches the photos directory for changes and processes new images automatically.
 * Uses chokidar for reliable file watching in Docker bind-mount scenarios.
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
 */

import path from 'path';
import chokidar from 'chokidar';
import { 
    processImage, 
    reprocessImage, 
    getUnprocessedFiles, 
    processAllImages, 
    ensureDirectories,
    cleanupOrphaned,
    PHOTOS_DIR 
} from '../utils/imageOptimizer';

const WATCH_MODE = process.argv.includes('--watch');
const ONCE_MODE = process.argv.includes('--once') || !WATCH_MODE;

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

async function processUnprocessedImages(): Promise<void> {
    console.log('[ImageWatcher] Checking for unprocessed images...');
    
    const unprocessed = getUnprocessedFiles();
    
    if (unprocessed.length === 0) {
        console.log('[ImageWatcher] All images are processed.');
        return;
    }
    
    console.log(`[ImageWatcher] Found ${unprocessed.length} unprocessed images.`);
    
    const result = await processAllImages((current, total, file) => {
        console.log(`[ImageWatcher] Processing ${current}/${total}: ${file}`);
    });
    
    console.log(`[ImageWatcher] Completed: ${result.processed.length} processed, ${result.errors.length} errors`);
    
    if (result.errors.length > 0) {
        result.errors.forEach(e => {
            console.error(`[ImageWatcher] Error processing ${e.file}:`, e.error.message);
        });
    }
}

function startWatcher(): void {
    ensureDirectories();
    
    console.log(`[ImageWatcher] Starting chokidar watcher for: ${PHOTOS_DIR}`);
    
    // Initial processing
    processUnprocessedImages().catch(console.error);
    
    // Also clean up orphaned files on startup
    const cleaned = cleanupOrphaned();
    if (cleaned.length > 0) {
        console.log(`[ImageWatcher] Cleaned up ${cleaned.length} orphaned files`);
    }
    
    // Set up chokidar watcher with Docker-friendly options
    const watcher = chokidar.watch(PHOTOS_DIR, {
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
    
    // Handle new/changed files
    watcher.on('add', async (filePath: string, stats) => {
        const ext = path.extname(filePath).toLowerCase();
        if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return;
        
        const filename = path.basename(filePath);
        console.log(`[ImageWatcher] New file detected: ${filename}`);
        
        try {
            await processImage(filename);
            console.log(`[ImageWatcher] Processed: ${filename}`);
        } catch (error) {
            console.error(`[ImageWatcher] Error processing ${filename}:`, error);
        }
    });
    
    // Handle file changes (reprocess if source is updated)
    watcher.on('change', async (filePath: string, stats) => {
        const ext = path.extname(filePath).toLowerCase();
        if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return;
        
        const filename = path.basename(filePath);
        console.log(`[ImageWatcher] File changed, reprocessing: ${filename}`);
        
        try {
            await reprocessImage(filename);
            console.log(`[ImageWatcher] Reprocessed: ${filename}`);
        } catch (error) {
            console.error(`[ImageWatcher] Error reprocessing ${filename}:`, error);
        }
    });
    
    // Handle file unlinking
    watcher.on('unlink', (filePath: string) => {
        console.log(`[ImageWatcher] File removed: ${path.basename(filePath)}`);
        // Clean up orphaned processed files
        cleanupOrphaned();
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

// Main execution
if (ONCE_MODE) {
    console.log('[ImageWatcher] Running in one-shot mode...');
    processUnprocessedImages()
        .then(() => {
            // Also clean up orphaned files
            const cleaned = cleanupOrphaned();
            if (cleaned.length > 0) {
                console.log(`[ImageWatcher] Cleaned up ${cleaned.length} orphaned files`);
            }
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