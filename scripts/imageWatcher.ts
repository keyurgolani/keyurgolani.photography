#!/usr/bin/env node
/**
 * Image Watcher Script
 * 
 * Watches the photos directory for changes and processes new images automatically.
 * Can also be run in one-shot mode for periodic processing.
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

import fs from 'fs';
import path from 'path';
import { processImage, getUnprocessedFiles, processAllImages, ensureDirectories, PHOTOS_DIR } from '../utils/imageOptimizer';

const WATCH_MODE = process.argv.includes('--watch');
const ONCE_MODE = process.argv.includes('--once') || !WATCH_MODE;

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
    
    if (!fs.existsSync(PHOTOS_DIR)) {
        console.log(`[ImageWatcher] Photos directory does not exist: ${PHOTOS_DIR}`);
        console.log('[ImageWatcher] Creating directory...');
        fs.mkdirSync(PHOTOS_DIR, { recursive: true });
    }
    
    console.log(`[ImageWatcher] Watching directory: ${PHOTOS_DIR}`);
    
    // Initial processing
    processUnprocessedImages().catch(console.error);
    
    // Set up watcher
    const watcher = fs.watch(PHOTOS_DIR, { persistent: true, recursive: false }, async (eventType, filename) => {
        if (!filename) return;
        
        // Only process image files
        if (!/\.(jpg|jpeg|png|webp)$/i.test(filename)) return;
        
        // Skip thumbnails and optimized directories
        if (filename.includes('thumbnails') || filename.includes('optimized')) return;
        
        const filePath = path.join(PHOTOS_DIR, filename);
        
        // Wait a moment for file to be fully written
        setTimeout(async () => {
            try {
                // Check if file still exists (might have been deleted)
                if (!fs.existsSync(filePath)) return;
                
                // Check if it's a file, not a directory
                const stats = fs.statSync(filePath);
                if (stats.isDirectory()) return;
                
                console.log(`[ImageWatcher] New/modified file detected: ${filename}`);
                await processImage(filename);
                console.log(`[ImageWatcher] Processed: ${filename}`);
            } catch (error) {
                console.error(`[ImageWatcher] Error processing ${filename}:`, error);
            }
        }, 1000);
    });
    
    watcher.on('error', (error) => {
        console.error('[ImageWatcher] Watcher error:', error);
    });
    
    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n[ImageWatcher] Shutting down...');
        watcher.close();
        process.exit(0);
    });
    
    process.on('SIGTERM', () => {
        console.log('\n[ImageWatcher] Shutting down...');
        watcher.close();
        process.exit(0);
    });
    
    console.log('[ImageWatcher] Watching for changes. Press Ctrl+C to exit.');
}

// Main execution
if (ONCE_MODE) {
    console.log('[ImageWatcher] Running in one-shot mode...');
    processUnprocessedImages()
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