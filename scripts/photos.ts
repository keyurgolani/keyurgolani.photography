#!/usr/bin/env node
/**
 * Photo identity commands.
 *
 *   npx tsx scripts/photos.ts migrate --dry-run [--out <dir>]
 *     Propose a photo ID for every source without writing identity state.
 *     Writes plan-<ts>.json and report-<ts>.md to identity/migration/ in the
 *     data root, or to --out, which is required when the data root is unset,
 *     unavailable, or unwritable. Prints both paths.
 *
 *   npx tsx scripts/photos.ts identity status [--json]
 *     Counts by source health, holds, failed profiles, pending jobs, the data
 *     root's state, and the watcher's heartbeat age. Exits 1 unless the data
 *     root is ready.
 *
 * The library is PHOTOGRAPHY_LIBRARY_DIR, or public/assets/photos under the
 * working directory. The data root is PHOTOGRAPHY_DATA_DIR, or portfolio-data
 * under the working directory outside production.
 */

import { DryRunRefusedError, migrateDryRun } from '../lib/identity/migration';
import { LibraryRootMissingError } from '../lib/identity/scan';
import { formatStatus, identityStatus } from '../lib/identity/status';

const USAGE = `Usage:
  npx tsx scripts/photos.ts migrate --dry-run [--out <dir>]
  npx tsx scripts/photos.ts identity status [--json]`;

class UsageError extends Error {}

function parseFlags(args: string[], known: { boolean: string[]; value: string[] }): Map<string, string | true> {
    const flags = new Map<string, string | true>();
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (known.boolean.includes(arg)) {
            flags.set(arg, true);
        } else if (known.value.includes(arg)) {
            const value = args[i + 1];
            if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value.`);
            flags.set(arg, value);
            i++;
        } else {
            throw new UsageError(`Unknown argument: ${arg}`);
        }
    }
    return flags;
}

async function migrate(args: string[]): Promise<number> {
    const flags = parseFlags(args, { boolean: ['--dry-run'], value: ['--out'] });
    if (!flags.has('--dry-run')) throw new UsageError('photos migrate runs only with --dry-run for now.');
    const out = flags.get('--out');
    const result = await migrateDryRun({ outDir: typeof out === 'string' ? out : undefined });
    const counts = new Map<string, number>();
    for (const fact of result.plan.facts) counts.set(fact.type, (counts.get(fact.type) ?? 0) + 1);
    const summary = [...counts.entries()].map(([type, count]) => `${type} ${count}`).join(', ') || 'no facts';
    console.log(`[photos] Dry run over ${result.plan.sources.length} files: ${summary}.`);
    console.log(`Plan: ${result.planPath}`);
    console.log(`Report: ${result.reportPath}`);
    return 0;
}

async function identity(args: string[]): Promise<number> {
    const [subcommand, ...rest] = args;
    if (subcommand !== 'status') throw new UsageError(subcommand ? `Unknown identity command: ${subcommand}` : 'photos identity needs a command.');
    const flags = parseFlags(rest, { boolean: ['--json'], value: [] });
    const status = await identityStatus();
    process.stdout.write(flags.has('--json') ? `${JSON.stringify(status, null, 2)}\n` : formatStatus(status));
    return status.dataRoot.state === 'ready' && !status.registryError ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
    const [command, ...args] = argv;
    try {
        if (command === 'migrate') return await migrate(args);
        if (command === 'identity') return await identity(args);
        throw new UsageError(command ? `Unknown command: ${command}` : 'No command given.');
    } catch (error) {
        if (error instanceof UsageError) {
            console.error(`[photos] ${error.message}\n${USAGE}`);
            return 2;
        }
        if (error instanceof DryRunRefusedError) {
            console.error(`[photos] ${error.message}`);
            return error.exitCode;
        }
        if (error instanceof LibraryRootMissingError) {
            console.error(`[photos] ${error.message}. Check the mount or PHOTOGRAPHY_LIBRARY_DIR. Nothing was written.`);
            return 1;
        }
        throw error;
    }
}

main(process.argv.slice(2))
    .then((code) => {
        process.exitCode = code;
    })
    .catch((error: unknown) => {
        console.error('[photos] Error:', error);
        process.exitCode = 1;
    });
