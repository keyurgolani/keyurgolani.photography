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
 *   npx tsx scripts/photos.ts migrate --apply --plan <file>
 *     Commit a dry run's plan: write the registry with exactly its photo IDs,
 *     data-root.json if there is none, and applied-<ts>.json mapping each
 *     source path and legacy URL to its photo. Refuses if the library or the
 *     registry changed since the dry run, or if it runs in a container whose
 *     data root is not a mounted volume. Builds no derivatives. Exits 0 when
 *     applied or already applied, 1 when refused, and 2 on a usage error.
 *
 *   npx tsx scripts/photos.ts identity status [--json]
 *     Counts by source health, holds, failed profiles, pending jobs, the data
 *     root's state, and the watcher's heartbeat age. Exits 1 unless the data
 *     root is ready.
 *
 *   npx tsx scripts/photos.ts identity bind <path> <photoId> [--reason <text>]
 *   npx tsx scripts/photos.ts identity new <path> [--reason <text>]
 *   npx tsx scripts/photos.ts identity archive <photoId> [--reason <text>]
 *   npx tsx scripts/photos.ts identity retry <photoId> [<assetRevision>] [--reason <text>]
 *   npx tsx scripts/photos.ts identity reprofile (<photoId> | --all) [--reason <text>]
 *     Write an identity decision to identity/decisions/ and run a pass that
 *     applies it. If the registry is busy, the decision stays saved and the
 *     watcher applies it on its next pass. Exits 0 when applied or saved, 1
 *     when refused or the data root isn't ready, and 2 on a usage error.
 *     <path> is relative to the library, or an absolute path inside it.
 *
 *   npx tsx scripts/photos.ts validate [--reprofile]
 *     Compile the working layer and run every rule, writing nothing. Prints
 *     the candidate ID and the first 200 issues. Exits 0 when only warnings
 *     remain, 1 on any error, 2 on a usage error, 4 when a catalog file is
 *     damaged or can't be read, and 3 on any other stop, such as a data
 *     root that isn't ready or a working layer that stays busy.
 *
 *   npx tsx scripts/photos.ts publish [--actor <name>] [--reason <text>] [--expect <candidateId>]
 *                                     [--dry-run] [--confirm-launch] [--reprofile]
 *     Compile the working layer, validate it under the catalog lock, write
 *     its revision, and make that revision active. The actor is --actor or
 *     PHOTOS_ACTOR, and one is required. --reason defaults to publish.
 *     --expect stops unless the candidate has that ID, and --dry-run stops
 *     after validation. The first publish replaces the legacy Home and
 *     Gallery, so it needs --confirm-launch, and prints what changes.
 *     --reprofile moves every photograph the watcher can rebuild to the
 *     current profile: run identity reprofile --all first. Exits 0 when
 *     published, unchanged, or a dry run passes, 1 on validation errors, 2
 *     on a usage error, 4 when a catalog file is damaged or an I/O error
 *     stops it, and 3 on any other stop. Logs one JSON line per event.
 *
 * The library is PHOTOGRAPHY_LIBRARY_DIR, or public/assets/photos under the
 * working directory. The data root is PHOTOGRAPHY_DATA_DIR, or portfolio-data
 * under the working directory outside production.
 *
 * The image has no tsx, so it runs the bundle `npm run build:scripts` writes,
 * with the same arguments: node dist/scripts/photos.mjs <command>.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { publish, PUBLISH_EXIT_CODES, validateWorkingLayer, VALIDATE_EXIT_CODES, type PublishResult } from '../lib/catalog/publish';
import { REVISION_ID_RE } from '../lib/catalog/schema';
import type { Issue } from '../lib/catalog/types';
import { catalogPaths } from '../lib/catalog/working-layer';
import { ApplyRefusedError, migrateApply } from '../lib/identity/apply';
import { createDecision, decisionFileName, isLibraryPath, writeDecision, type DecisionInput } from '../lib/identity/decisions';
import { ASSET_REVISION_RE, PHOTO_ID_RE } from '../lib/identity/ids';
import { DryRunRefusedError, migrateDryRun } from '../lib/identity/migration';
import { jsonLogSink, runReconcilePass } from '../lib/identity/pass';
import { identityPaths } from '../lib/identity/registry';
import { LibraryRootMissingError } from '../lib/identity/scan';
import { formatStatus, identityStatus } from '../lib/identity/status';
import { dataRoot, dataRootStatus, libraryRoot } from '../lib/storage/config';
import { isInside } from '../lib/storage/fsx';

/** This CLI the way it was started: the bundle in the image, or the source under tsx. */
const PROGRAM = fileURLToPath(import.meta.url).endsWith('.mjs') ? 'node dist/scripts/photos.mjs' : 'npx tsx scripts/photos.ts';

const USAGE = `Usage:
  ${PROGRAM} migrate --dry-run [--out <dir>]
  ${PROGRAM} migrate --apply --plan <file>
  ${PROGRAM} identity status [--json]
  ${PROGRAM} identity bind <path> <photoId> [--reason <text>]
  ${PROGRAM} identity new <path> [--reason <text>]
  ${PROGRAM} identity archive <photoId> [--reason <text>]
  ${PROGRAM} identity retry <photoId> [<assetRevision>] [--reason <text>]
  ${PROGRAM} identity reprofile (<photoId> | --all) [--reason <text>]
  ${PROGRAM} validate [--reprofile]
  ${PROGRAM} publish [--actor <name>] [--reason <text>] [--expect <candidateId>] [--dry-run] [--confirm-launch] [--reprofile]`;

class UsageError extends Error {}

/** Parse flags strictly: an unknown flag, a stray argument, or a missing value is a usage error. */
function strictly<T>(parse: () => T): T {
    try {
        return parse();
    } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : String(error));
    }
}

/** A path argument as a library-relative POSIX path. */
function libraryPath(arg: string): string {
    const library = libraryRoot();
    const relative = path.isAbsolute(arg) ? (isInside(arg, library) ? path.relative(library, arg) : '..') : arg;
    const posix = path.posix.normalize(relative.split(path.sep).join('/')).replace(/^(\.\/)+/, '');
    if (!isLibraryPath(posix)) throw new UsageError(`${arg} is not inside the library.`);
    return posix;
}

function photoIdArg(arg: string): string {
    if (!PHOTO_ID_RE.test(arg)) throw new UsageError(`${arg} is not a photo ID.`);
    return arg;
}

async function migrate(args: string[]): Promise<number> {
    const { values } = strictly(() => parseArgs({
        args,
        options: { 'dry-run': { type: 'boolean' }, apply: { type: 'boolean' }, out: { type: 'string' }, plan: { type: 'string' } },
        strict: true,
    }));
    if (values['dry-run'] && values.apply) throw new UsageError("--dry-run and --apply don't go together.");
    if (values.apply) {
        if (!values.plan) throw new UsageError('--apply needs --plan <file>.');
        if (values.out !== undefined) throw new UsageError('--out goes with --dry-run.');
        const result = await migrateApply({ planPath: values.plan });
        if (result.status === 'already-applied') {
            console.log(`[photos] Plan ${result.planId} is already applied.`);
            console.log(`Mapping: ${result.mappingPath}`);
            return 0;
        }
        console.log(`[photos] Applied plan ${result.planId}: ${result.photos} ${result.photos === 1 ? 'photo' : 'photos'}. The watcher builds the derivatives.`);
        console.log(`Mapping: ${result.mappingPath}`);
        return 0;
    }
    if (!values['dry-run']) throw new UsageError('photos migrate needs --dry-run or --apply.');
    if (values.plan !== undefined) throw new UsageError('--plan goes with --apply.');
    if (values.out === '') throw new UsageError('--out needs a value.');
    const result = await migrateDryRun({ outDir: values.out });
    const counts = new Map<string, number>();
    for (const fact of result.plan.facts) counts.set(fact.type, (counts.get(fact.type) ?? 0) + 1);
    const summary = [...counts.entries()].map(([type, count]) => `${type} ${count}`).join(', ') || 'no facts';
    console.log(`[photos] Dry run over ${result.plan.sources.length} files: ${summary}.`);
    const { unreadableFolders } = result.plan;
    if (unreadableFolders.length > 0) {
        console.warn(`[photos] These folders can't be listed, so their files aren't in the plan: ${unreadableFolders.join(', ')}`);
    }
    console.log(`Plan: ${result.planPath}`);
    console.log(`Report: ${result.reportPath}`);
    return 0;
}

const DECISION_COMMANDS: readonly DecisionInput['type'][] = ['bind', 'new', 'archive', 'retry', 'reprofile'];

function decisionInput(type: DecisionInput['type'], positionals: string[], values: { reason?: string; all?: boolean }): DecisionInput {
    const base = { actor: 'cli', reason: values.reason ?? '' };
    switch (type) {
        case 'bind':
            if (positionals.length !== 2) throw new UsageError('identity bind needs a path and a photo ID.');
            return { ...base, type, path: libraryPath(positionals[0]), photoId: photoIdArg(positionals[1]) };
        case 'new':
            if (positionals.length !== 1) throw new UsageError('identity new needs a path.');
            return { ...base, type, path: libraryPath(positionals[0]) };
        case 'archive':
            if (positionals.length !== 1) throw new UsageError('identity archive needs a photo ID.');
            return { ...base, type, photoId: photoIdArg(positionals[0]) };
        case 'retry': {
            if (positionals.length < 1 || positionals.length > 2) throw new UsageError('identity retry needs a photo ID and takes at most one asset revision.');
            const [photoId, assetRevision] = positionals;
            if (assetRevision !== undefined && !ASSET_REVISION_RE.test(assetRevision)) throw new UsageError(`${assetRevision} is not an asset revision.`);
            return { ...base, type, photoId: photoIdArg(photoId), ...(assetRevision === undefined ? {} : { assetRevision }) };
        }
        case 'reprofile': {
            const all = values.all === true;
            if (all && positionals.length > 0) throw new UsageError('identity reprofile takes a photo ID or --all, not both.');
            if (!all && positionals.length !== 1) throw new UsageError('identity reprofile needs a photo ID or --all.');
            return { ...base, type, ...(all ? {} : { photoId: photoIdArg(positionals[0]) }) };
        }
    }
}

/** Write a decision and run a pass that applies it, or leave it for the watcher when the registry is busy. */
async function decide(type: DecisionInput['type'], args: string[]): Promise<number> {
    const { values, positionals } = strictly(() => parseArgs({
        args,
        options: { reason: { type: 'string' }, all: { type: 'boolean' } },
        allowPositionals: true,
        strict: true,
    }));
    if (values.all !== undefined && type !== 'reprofile') throw new UsageError('--all goes with identity reprofile.');
    const input = decisionInput(type, positionals, values);
    const status = dataRootStatus({ write: true });
    if (status.state !== 'ready' || status.root === null) {
        console.error(`[photos] The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}. Nothing was written.`);
        return 1;
    }
    const decision = createDecision(input);
    const file = await writeDecision(status.root, decision);
    const outcome = await runReconcilePass({ lock: { waitMs: 0 }, sinks: [jsonLogSink()] });
    if (outcome.status === 'skipped') {
        if (outcome.reason === 'locked') {
            console.log(`[photos] Saved ${file}. The registry is busy, so the watcher applies it on its next pass.`);
            return 0;
        }
        console.error(`[photos] The data root is ${outcome.state}${outcome.detail ? `: ${outcome.detail}` : ''}. The decision is saved in ${file}.`);
        return 1;
    }
    const result = outcome.decisions.find((entry) => entry.decisionId === decision.decisionId);
    if (result === undefined) {
        console.error(`[photos] The pass didn't find ${file}, so the decision wasn't applied.`);
        return 1;
    }
    if (result.status === 'applied') {
        console.log(`[photos] Applied: ${result.detail}.`);
        if (decision.type === 'new') console.log(`Photo ID: ${decision.photoId}`);
        return 0;
    }
    if (result.status === 'deferred') {
        console.log(`[photos] Saved ${file}. It waits because ${result.reason}, and a later pass applies it.`);
        return 0;
    }
    const record = path.join(identityPaths(status.root).decisions, 'rejected', decisionFileName(decision));
    console.error(`[photos] Rejected: ${result.reason}. The record is in ${record}.`);
    return 1;
}

async function identity(args: string[]): Promise<number> {
    const [subcommand, ...rest] = args;
    const decisionType = DECISION_COMMANDS.find((type) => type === subcommand);
    if (decisionType !== undefined) return decide(decisionType, rest);
    if (subcommand !== 'status') throw new UsageError(subcommand ? `Unknown identity command: ${subcommand}` : 'photos identity needs a command.');
    const { values } = strictly(() => parseArgs({ args: rest, options: { json: { type: 'boolean' } }, strict: true }));
    const status = await identityStatus();
    process.stdout.write(values.json ? `${JSON.stringify(status, null, 2)}\n` : formatStatus(status));
    return status.dataRoot.state === 'ready' && !status.registryError ? 0 : 1;
}

/** How many issues the CLI prints. The diagnostics file holds every one. */
const PRINTED_ISSUES = 200;

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** Lines for a command's report: stdout when it succeeded, stderr when it didn't, as the identity commands do. */
function reporter(exitCode: number): (line: string) => void {
    return exitCode === 0 ? (line) => console.log(line) : (line) => console.error(line);
}

function printIssues(print: (line: string) => void, issues: readonly Issue[], rest: string): void {
    for (const issue of issues.slice(0, PRINTED_ISSUES)) {
        print(`${issue.severity} ${issue.record.kind} ${issue.record.id} ${issue.field}: ${issue.message} (${issue.code})`);
        if (issue.hint) print(`    ${issue.hint}`);
    }
    if (issues.length > PRINTED_ISSUES) print(`${count(issues.length - PRINTED_ISSUES, 'more issue')} not shown. ${rest}`);
}

/** The data root to compile from, or an exit code after saying why there is none. */
function catalogRoot(): string | number {
    const root = dataRoot();
    if (root !== null) return root;
    const status = dataRootStatus();
    console.error(`[photos] DATA_ROOT_NOT_READY: The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}.`);
    return 3;
}

async function validate(args: string[]): Promise<number> {
    const { values } = strictly(() => parseArgs({ args, options: { reprofile: { type: 'boolean' } }, strict: true }));
    const root = catalogRoot();
    if (typeof root === 'number') return root;
    const result = await validateWorkingLayer({ dataRoot: root, reprofile: values.reprofile });
    const exitCode = VALIDATE_EXIT_CODES[result.outcome];
    const print = reporter(exitCode);
    print(`[photos] ${result.outcome}: ${result.message}`);
    if (result.candidateId) print(`Candidate: ${result.candidateId}`);
    printIssues(print, result.issues, 'publish --dry-run writes them all to the diagnostics file.');
    return exitCode;
}

function printPublish(print: (line: string) => void, result: PublishResult, root: string): void {
    print(`[photos] ${result.outcome}: ${result.message}`);
    if (result.candidateId) print(`Candidate: ${result.candidateId}`);
    if (result.revisionId) print(`Active: ${result.revisionId}${result.revisionNumber === null ? '' : `, revision ${result.revisionNumber}`}`);
    if (result.missingRules?.length) print(`Missing rules: ${result.missingRules.join(', ')}`);
    if (result.launch) {
        const { published, gone } = result.launch;
        const leaving = gone === 0 ? 'Every photograph in the library is in it.' : `${count(gone, 'photograph')} in the library ${gone === 1 ? "isn't" : "aren't"} in it, so ${gone === 1 ? 'it leaves' : 'they leave'} the site.`;
        print(`Launch: this revision replaces the legacy Home and Gallery with ${count(published, 'photograph')}. ${leaving}`);
        if (result.outcome === 'LAUNCH_CONFIRMATION_REQUIRED') print('Run it again with --confirm-launch to publish it.');
    }
    if (result.reprofiled) {
        const { moved, kept } = result.reprofiled;
        if (moved.length) print(`Moved to the current profile: ${moved.slice(0, PRINTED_ISSUES).join(', ')}${moved.length > PRINTED_ISSUES ? `, and ${moved.length - PRINTED_ISSUES} more` : ''}`);
        if (kept.length) print(`Kept their profile, since the watcher can't rebuild them: ${kept.slice(0, PRINTED_ISSUES).join(', ')}${kept.length > PRINTED_ISSUES ? `, and ${kept.length - PRINTED_ISSUES} more` : ''}`);
    }
    const diagnostics = result.candidateId ? path.relative(root, path.join(catalogPaths(root).diagnosticsDir, `${result.candidateId}.json`)) : null;
    printIssues(print, result.issues, diagnostics ? `All of them are in ${diagnostics}.` : '');
}

async function publishCommand(args: string[]): Promise<number> {
    const { values } = strictly(() => parseArgs({
        args,
        options: {
            actor: { type: 'string' },
            reason: { type: 'string' },
            expect: { type: 'string' },
            'dry-run': { type: 'boolean' },
            'confirm-launch': { type: 'boolean' },
            reprofile: { type: 'boolean' },
        },
        strict: true,
    }));
    const actor = values.actor ?? process.env.PHOTOS_ACTOR ?? '';
    if (!/\S/.test(actor)) throw new UsageError('photos publish needs --actor <name> or PHOTOS_ACTOR.');
    if (values.reason !== undefined && !/\S/.test(values.reason)) throw new UsageError('--reason needs some text.');
    if (values.expect !== undefined && !REVISION_ID_RE.test(values.expect)) throw new UsageError(`${values.expect} is not a candidate ID.`);
    const root = catalogRoot();
    if (typeof root === 'number') return root;
    const result = await publish({
        dataRoot: root,
        actor: actor.trim(),
        reason: values.reason?.trim(),
        expectedRevisionId: values.expect,
        dryRun: values['dry-run'],
        confirmLaunch: values['confirm-launch'],
        reprofile: values.reprofile,
    });
    const exitCode = PUBLISH_EXIT_CODES[result.outcome];
    printPublish(reporter(exitCode), result, root);
    return exitCode;
}

async function main(argv: string[]): Promise<number> {
    const [command, ...args] = argv;
    try {
        if (command === 'migrate') return await migrate(args);
        if (command === 'identity') return await identity(args);
        if (command === 'validate') return await validate(args);
        if (command === 'publish') return await publishCommand(args);
        throw new UsageError(command ? `Unknown command: ${command}` : 'No command given.');
    } catch (error) {
        if (error instanceof UsageError) {
            console.error(`[photos] ${error.message}\n${USAGE}`);
            return 2;
        }
        if (error instanceof DryRunRefusedError || error instanceof ApplyRefusedError) {
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
