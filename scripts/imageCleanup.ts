#!/usr/bin/env node
/**
 * Image Cleanup Script
 *
 * Lists derivatives that no source needs anymore, with the reason for each,
 * and deletes them only with --apply. Nothing else in the pipeline deletes
 * derivatives, so this is how leftovers from removed photos go away.
 *
 * Usage:
 *   # Dry run: print each path and why it would be deleted
 *   npm run images:cleanup
 *
 *   # Delete what the dry run lists, re-checking each path first
 *   npm run images:cleanup -- --apply
 *
 *   # In production
 *   docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher npx tsx scripts/imageCleanup.ts
 *
 * Refuses, with exit code 2, a missing library root, a library with no
 * sources (unless --allow-empty-library is passed), and unknown options.
 */

import fs from 'fs';
import { fileURLToPath } from 'url';
import {
    applyOrphanCleanup,
    CleanupRefusedError,
    planOrphanCleanup,
    STALE_TEMP_FILE_MS,
    type OrphanCleanupPlan,
    type OrphanEntry,
} from '../utils/imageOptimizer';

export const USAGE = 'Usage: npm run images:cleanup [-- [--apply] [--allow-empty-library]]';

interface Output {
    log(line: string): void;
    error(line: string): void;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} bytes`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${bytes} bytes (${value.toFixed(1)} ${units[unit]})`;
}

function summarize(entries: OrphanEntry[]): string {
    const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    return `${entries.length} ${entries.length === 1 ? 'file' : 'files'}, ${formatBytes(bytes)}`;
}

function reportYoungTempFiles(plan: OrphanCleanupPlan, output: Output): void {
    const count = plan.youngTempFiles.length;
    if (count === 0) return;
    output.log(
        `Kept ${count} temp ${count === 1 ? 'file' : 'files'} under ${STALE_TEMP_FILE_MS / (60 * 1000)} minutes old, ` +
        'since a running job may still own them.',
    );
}

/** Runs the cleanup CLI and returns its exit code: 0 done, 1 a deletion failed, 2 refused. */
export function runImageCleanup(argv: string[], output: Output = console): number {
    let apply = false;
    let allowEmptyLibrary = false;
    for (const arg of argv) {
        if (arg === '--apply') {
            apply = true;
        } else if (arg === '--allow-empty-library') {
            allowEmptyLibrary = true;
        } else if (arg === '--help' || arg === '-h') {
            output.log(USAGE);
            return 0;
        } else {
            output.error(`Unknown option: ${arg}`);
            output.error(USAGE);
            return 2;
        }
    }

    let plan: OrphanCleanupPlan;
    try {
        plan = planOrphanCleanup({ allowEmptyLibrary });
    } catch (error) {
        if (error instanceof CleanupRefusedError) {
            output.error(`Refusing to clean up: ${error.message}`);
            return 2;
        }
        throw error;
    }

    output.log(`Library root: ${plan.root}`);

    if (!apply) {
        for (const entry of plan.entries) {
            output.log(`Would delete ${entry.relativePath} (${entry.reason})`);
        }
        output.log(`Would delete ${summarize(plan.entries)}. This was a dry run. Re-run with --apply to delete.`);
        reportYoungTempFiles(plan, output);
        return 0;
    }

    const result = applyOrphanCleanup(plan);
    for (const entry of result.deleted) {
        output.log(`Deleted ${entry.relativePath} (${entry.reason})`);
    }
    for (const entry of result.skipped) {
        output.log(`Kept ${entry.relativePath}, which no longer qualifies`);
    }
    for (const { entry, error } of result.failed) {
        output.error(`Could not delete ${entry.relativePath}: ${error.message}`);
    }
    output.log(
        `Deleted ${summarize(result.deleted)}.` +
        (result.skipped.length > 0 ? ` Kept ${result.skipped.length} that no longer qualified.` : ''),
    );
    reportYoungTempFiles(plan, output);
    return result.failed.length > 0 ? 1 : 0;
}

function isMainModule(): boolean {
    const entry = process.argv[1];
    if (!entry) return false;
    try {
        return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (isMainModule()) {
    try {
        process.exitCode = runImageCleanup(process.argv.slice(2));
    } catch (error) {
        console.error('[ImageCleanup] Error:', error);
        process.exitCode = 1;
    }
}
