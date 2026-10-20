#!/usr/bin/env node
/**
 * Image Cleanup Script
 *
 * Lists derivatives that no source needs anymore, with the reason for each,
 * and deletes them only when you pass back the plan hash its dry run printed.
 * Nothing else in the pipeline deletes derivatives, so this is how leftovers
 * from removed photos go away.
 *
 * Usage:
 *   # Dry run: print each path, why it would be deleted, and the plan hash
 *   npm run images:cleanup
 *
 *   # Delete exactly what that dry run listed, re-checking each path first
 *   npm run images:cleanup -- --apply --plan <hash>
 *
 *   # Limit both steps to one photo's exact base name, for a takedown
 *   npm run images:cleanup -- --only <name>
 *
 *   # In production
 *   docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher npx tsx scripts/imageCleanup.ts
 *
 * Refuses, with exit code 2, a missing library root, a library with no
 * sources (unless --allow-empty-library is passed), a plan hash that no
 * longer matches the library, and bad options.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    applyOrphanCleanup,
    CleanupRefusedError,
    isSourceFile,
    planOrphanCleanup,
    STALE_TEMP_FILE_MS,
    type OrphanCleanupPlan,
    type OrphanEntry,
} from '../utils/imageOptimizer';

export const USAGE =
    'Usage: npm run images:cleanup -- [--only <name>] [--allow-empty-library] [--apply --plan <hash>]';

interface Output {
    log(line: string): void;
    error(line: string): void;
}

interface Options {
    apply: boolean;
    plan: string | null;
    only: string | null;
    allowEmptyLibrary: boolean;
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

/** A photo's base name. Accepts `landscape` or `landscape.jpg`. */
function parseOnly(value: string | undefined): string | null {
    if (!value || value.startsWith('-') || /[/\\]/.test(value) || value === '.' || value === '..') return null;
    return isSourceFile(value) ? path.basename(value, path.extname(value)) : value;
}

function parseArgs(argv: string[]): Options | string {
    const options: Options = { apply: false, plan: null, only: null, allowEmptyLibrary: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--apply') {
            options.apply = true;
        } else if (arg === '--allow-empty-library') {
            options.allowEmptyLibrary = true;
        } else if (arg === '--plan') {
            const value = argv[++i];
            if (!value || !/^[0-9a-f]{12}$/.test(value)) return '--plan needs the 12-character hash a dry run printed.';
            options.plan = value;
        } else if (arg === '--only') {
            const only = parseOnly(argv[++i]);
            if (only === null) return '--only needs a photo name, such as landscape or landscape.jpg.';
            options.only = only;
        } else {
            return `Unknown option: ${arg}`;
        }
    }
    if (options.apply && options.plan === null) {
        return '--apply needs --plan <hash> from a dry run, so it deletes only what you reviewed.';
    }
    if (!options.apply && options.plan !== null) return '--plan goes with --apply.';
    return options;
}

/** Quote a value for a POSIX shell, so the printed command can be pasted as is. */
function shellQuote(value: string): string {
    return /^[\w.,:+=@%-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The flags that reproduce this plan, for the dry run's next-step line. */
function planFlags(plan: OrphanCleanupPlan): string {
    return [
        plan.only === null ? '' : ` --only ${shellQuote(plan.only)}`,
        plan.allowEmptyLibrary ? ' --allow-empty-library' : '',
        ` --apply --plan ${plan.hash}`,
    ].join('');
}

function reportSkips(plan: OrphanCleanupPlan, output: Output): void {
    if (plan.onlyVariants.length > 0) {
        output.log(
            `No file is named exactly ${plan.only}, but ${plan.onlyVariants.map(shellQuote).join(', ')} ` +
            `${plan.onlyVariants.length === 1 ? 'differs' : 'differ'} only in case or Unicode form. --only matches the exact name.`,
        );
    }
    for (const folder of plan.skippedFolders) {
        output.log(`Skipped ${folder}/, which is a symlink or not a folder, so cleanup stays inside the library.`);
    }
    const count = plan.youngTempFiles.length;
    if (count > 0) {
        output.log(
            `Kept ${count} temp ${count === 1 ? 'file' : 'files'} under ${STALE_TEMP_FILE_MS / (60 * 1000)} minutes old, ` +
            'since a running job may still own them.',
        );
    }
}

/** Runs the cleanup CLI and returns its exit code: 0 done, 1 a deletion failed, 2 refused. */
export function runImageCleanup(argv: string[], output: Output = console): number {
    if (argv.includes('--help') || argv.includes('-h')) {
        output.log(USAGE);
        return 0;
    }
    const options = parseArgs(argv);
    if (typeof options === 'string') {
        output.error(options);
        output.error(USAGE);
        return 2;
    }

    let plan: OrphanCleanupPlan;
    try {
        plan = planOrphanCleanup({ allowEmptyLibrary: options.allowEmptyLibrary, only: options.only });
    } catch (error) {
        if (error instanceof CleanupRefusedError) {
            output.error(`Refusing to clean up: ${error.message}`);
            return 2;
        }
        throw error;
    }

    output.log(`Library root: ${plan.root}`);
    if (plan.only !== null) output.log(`Only files for: ${plan.only}`);

    if (!options.apply) {
        for (const entry of plan.entries) {
            output.log(`Would delete ${entry.relativePath} (${entry.reason})`);
        }
        reportSkips(plan, output);
        if (plan.entries.length === 0) {
            output.log('Nothing to delete.');
        } else {
            output.log(`Would delete ${summarize(plan.entries)}. This was a dry run.`);
            output.log(`Plan ${plan.hash}. To delete exactly these files, re-run with${planFlags(plan)}`);
        }
        return 0;
    }

    if (plan.hash !== options.plan) {
        output.error(
            `Refusing to clean up: this run plans ${plan.hash}, not ${options.plan}. Files may have changed since ` +
            `that dry run, or temp files passed the ${STALE_TEMP_FILE_MS / (60 * 1000)}-minute mark. ` +
            'Run the dry run again with the same flags and review it.',
        );
        return 2;
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
    reportSkips(plan, output);
    output.log(
        `Deleted ${summarize(result.deleted)}.` +
        (result.skipped.length > 0 ? ` Kept ${result.skipped.length} that no longer qualified.` : ''),
    );
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
