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
 *   # Limit both steps to one photo's set, for a takedown. --only=<name> also
 *   # takes a name that starts with a dash.
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
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import {
    applyOrphanCleanup,
    CleanupRefusedError,
    planOrphanCleanup,
    STALE_TEMP_FILE_MS,
    type OrphanCleanupPlan,
    type OrphanEntry,
} from '../utils/imageOptimizer';

export const USAGE =
    'Usage: npm run images:cleanup -- [--only=<name>] [--allow-empty-library] [--apply --plan <hash>]';

interface Output {
    log(line: string): void;
    error(line: string): void;
}

interface Options {
    help: boolean;
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

/** Strict, so a mistyped flag exits 2. A photo name that starts with a dash goes in as `--only=<name>`. */
function readOptions(argv: string[]): Options | string {
    let values: { apply?: boolean; plan?: string; only?: string; 'allow-empty-library'?: boolean; help?: boolean };
    try {
        ({ values } = parseArgs({
            args: argv,
            options: {
                apply: { type: 'boolean' },
                plan: { type: 'string' },
                only: { type: 'string' },
                'allow-empty-library': { type: 'boolean' },
                help: { type: 'boolean', short: 'h' },
            },
            strict: true,
        }));
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }

    const options: Options = {
        help: values.help ?? false,
        apply: values.apply ?? false,
        plan: values.plan ?? null,
        only: values.only ?? null,
        allowEmptyLibrary: values['allow-empty-library'] ?? false,
    };
    if (options.plan !== null && !/^[0-9a-f]{12}$/.test(options.plan)) {
        return '--plan needs the 12-character hash a dry run printed.';
    }
    if (options.only !== null && (options.only === '' || /[/\\]/.test(options.only) || options.only === '.' || options.only === '..')) {
        return '--only needs a photo name, such as landscape or landscape.jpg.';
    }
    if (options.apply && options.plan === null) {
        return '--apply needs --plan <hash> from a dry run, so it deletes only what you reviewed.';
    }
    if (!options.apply && options.plan !== null) return '--plan goes with --apply.';
    return options;
}

/**
 * Quote a value for a POSIX shell, so the printed command can be pasted as is.
 * A leading `=` gets quoted too, since zsh expands `=word`.
 */
function shellQuote(value: string): string {
    return /^[\w.,:+@%-][\w.,:+=@%-]*$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The flags that reproduce this plan, for the dry run's next-step commands. */
function planFlags(plan: OrphanCleanupPlan): string {
    return [
        plan.only === null ? '' : `--only=${shellQuote(plan.only)} `,
        plan.allowEmptyLibrary ? '--allow-empty-library ' : '',
        `--apply --plan ${plan.hash}`,
    ].join('');
}

function reportSkips(plan: OrphanCleanupPlan, output: Output): void {
    for (const { name, code } of plan.unreadableSources) {
        output.log(`Kept the set for ${name}, a source that can't be read (${code}).`);
    }
    if (plan.onlyVariants.length > 0) {
        output.log(
            `No file is named exactly ${plan.only}, but ${plan.onlyVariants.map(shellQuote).join(', ')} ` +
            `${plan.onlyVariants.length === 1 ? 'differs' : 'differ'} only in case or Unicode form. --only matches the exact name.`,
        );
    }
    for (const folder of plan.skippedFolders) {
        output.log(`Skipped ${folder}/, which is a symlink, not a folder, or can't be listed, so cleanup deletes nothing in it.`);
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
    const options = readOptions(argv);
    if (typeof options === 'string') {
        output.error(options);
        output.error(USAGE);
        return 2;
    }
    if (options.help) {
        output.log(USAGE);
        return 0;
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
        if (plan.otherOrphans.length > 0) {
            output.log(
                `Other sets with no source, which may be earlier names of this photo: ${plan.otherOrphans.map(shellQuote).join(', ')}. ` +
                'The dry run without --only lists their files.',
            );
        }
        if (plan.entries.length === 0) {
            output.log('Nothing to delete.');
        } else {
            output.log(`Would delete ${summarize(plan.entries)}. This was a dry run.`);
            output.log(`Plan ${plan.hash}. To delete exactly these files, run one of:`);
            output.log(`  npm run images:cleanup -- ${planFlags(plan)}`);
            output.log(`  npx tsx scripts/imageCleanup.ts ${planFlags(plan)}`);
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
