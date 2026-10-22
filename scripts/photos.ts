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
 *   npx tsx scripts/photos.ts status [--json]
 *     The data root, the catalog mode and active revision, the last publish,
 *     registry counts, the working layer's records, how many photos no series
 *     lists and how many have no reviewed description, and the watcher's
 *     heartbeat. Exits 1 unless the data root is ready and everything reads.
 *
 *   npx tsx scripts/photos.ts list [--unassigned] [--json]
 *     Every photo the registry holds, but not archived ones, with its library
 *     path, capture date, series, description state, and the data-root path
 *     of the 400 px WebP it would publish on. --unassigned keeps the photos in
 *     the library that no series lists.
 *
 *   npx tsx scripts/photos.ts draft:init
 *     Create site.json and a photo record for every photo without one, with
 *     no description and the asset revision its source is bound to. Never
 *     overwrites a record.
 *
 *   npx tsx scripts/photos.ts describe --import <file> [--dry-run]
 *     Set descriptions, decorative flags, titles, and captions from a CSV or
 *     JSON file with the columns photoId, alt, decorative, title, and caption.
 *     An empty cell changes nothing, imported descriptions count as reviewed,
 *     and any row it can't apply, such as an unknown photo ID, stops the whole
 *     import before it writes anything.
 *
 *   npx tsx scripts/photos.ts sequence <command> <seriesId> ...
 *   npx tsx scripts/photos.ts series (order | featured) <seriesId>...
 *     Change a series' photos, cover, opening photo, and chapters, or the
 *     Work order and featured series, through #8's operations. The usage
 *     below lists each form. Exits 0 on success, 1 when the operation is
 *     refused, 2 on a usage error, 3 on a version conflict or a busy authored
 *     lock, and 4 for I/O.
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
 * with the same arguments: node dist/scripts/photos.mjs <command>. In
 * production, docker-compose.prod.yml's `tools` service runs it:
 * docker compose -f docker-compose.prod.yml --profile tools run --rm tools <command>.
 * docs/curation.md walks through the commands.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runDescribeImport } from '../lib/catalog/describe-import';
import { runDraftInit } from '../lib/catalog/draft-init';
import { runListCommand, runStatusCommand } from '../lib/catalog/owner-status';
import { publish, PUBLISH_EXIT_CODES, validateWorkingLayer, VALIDATE_EXIT_CODES, type PublishResult } from '../lib/catalog/publish';
import { REVISION_ID_RE } from '../lib/catalog/schema';
import { runSequenceCommand, type CommandResult, type PlacementArg, type SequenceCommand } from '../lib/catalog/sequence-commands';
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
  ${PROGRAM} status [--json]
  ${PROGRAM} list [--unassigned] [--json]
  ${PROGRAM} draft:init
  ${PROGRAM} describe --import <file> [--dry-run]
  ${PROGRAM} sequence show <seriesId>
  ${PROGRAM} sequence set <seriesId> <photoId>... [--expect-version <N>]
  ${PROGRAM} sequence (insert | move) <seriesId> <photoId> (--start | --end | --after <photoId> | --to <N>) [--expect-version <N>]
  ${PROGRAM} sequence remove <seriesId> <photoId> [--expect-version <N>]
  ${PROGRAM} sequence cover <seriesId> <photoId> [--focal <x>,<y> | --clear-focal] [--expect-version <N>]
  ${PROGRAM} sequence opening <seriesId> (<photoId> | --clear) [--expect-version <N>]
  ${PROGRAM} sequence chapter add <seriesId> <title> --start <photoId> [--expect-version <N>]
  ${PROGRAM} sequence chapter move <seriesId> <chapterId> --start <photoId> [--expect-version <N>]
  ${PROGRAM} sequence chapter remove <seriesId> <chapterId> [--expect-version <N>]
  ${PROGRAM} series (order | featured) <seriesId>... [--expect-version <N>]
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

/** What the first publish asks of the owner. docs/curation.md's launch checklist has the whole list. */
const LAUNCH_CHECKLIST = [
    'Launch checklist, from docs/curation.md:',
    '  - The cutover milestone has shipped: Home, Work, the series pages, and the Viewer read the catalog (#4, #3, #5, #7), and a rollback works (#15 slice A).',
    '  - Viewer hardening (#9) is recommended first.',
    '  - A preview, this data root copied, published, and served on another port, looks right.',
];

function printPublish(print: (line: string) => void, result: PublishResult, root: string): void {
    print(`[photos] ${result.outcome}: ${result.message}`);
    if (result.candidateId) print(`Candidate: ${result.candidateId}`);
    if (result.revisionId) print(`Active: ${result.revisionId}${result.revisionNumber === null ? '' : `, revision ${result.revisionNumber}`}`);
    if (result.missingRules?.length) print(`Missing rules: ${result.missingRules.join(', ')}`);
    if (result.launch) {
        const { published, gone } = result.launch;
        const leaving = gone === 0 ? 'Every photograph in the library is in it.' : `${count(gone, 'photograph')} in the library ${gone === 1 ? "isn't" : "aren't"} in it, so ${gone === 1 ? 'it leaves' : 'they leave'} the site.`;
        print(`Launch: this revision replaces the legacy Home and Gallery with ${count(published, 'photograph')}. ${leaving}`);
        for (const line of LAUNCH_CHECKLIST) print(line);
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

/** Print a handler's text, on stdout when it succeeded and stderr when it didn't, and return its exit code. */
function printed(result: CommandResult): number {
    (result.exitCode === 0 ? process.stdout : process.stderr).write(result.output);
    return result.exitCode;
}

async function statusCommand(args: string[]): Promise<number> {
    const { values } = strictly(() => parseArgs({ args, options: { json: { type: 'boolean' } }, strict: true }));
    const root = catalogRoot();
    if (typeof root === 'number') return root;
    return printed(await runStatusCommand({ dataRoot: root }, { json: values.json }));
}

async function listCommand(args: string[]): Promise<number> {
    const { values } = strictly(() => parseArgs({ args, options: { unassigned: { type: 'boolean' }, json: { type: 'boolean' } }, strict: true }));
    const root = catalogRoot();
    if (typeof root === 'number') return root;
    return printed(await runListCommand({ dataRoot: root }, { unassigned: values.unassigned, json: values.json }));
}

async function draftInitCommand(args: string[]): Promise<number> {
    strictly(() => parseArgs({ args, options: {}, strict: true }));
    const root = catalogRoot();
    if (typeof root === 'number') return root;
    return printed(await runDraftInit({ dataRoot: root }));
}

async function describeCommand(args: string[]): Promise<number> {
    const { values } = strictly(() => parseArgs({ args, options: { import: { type: 'string' }, 'dry-run': { type: 'boolean' } }, strict: true }));
    if (!values.import) throw new UsageError('photos describe needs --import <file>.');
    const root = catalogRoot();
    if (typeof root === 'number') return root;
    return printed(await runDescribeImport({ dataRoot: root }, { file: values.import, dryRun: values['dry-run'] }));
}

/** `--expect-version`: the version the record must be at, the current one when omitted. */
function expectVersionArg(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) throw new UsageError('--expect-version takes a version from 0.');
    return Number(value);
}

/** Where insert and move put a photo: exactly one of --start, --end, --after <photoId>, and --to <N>. */
function placementArg(values: { start?: boolean; end?: boolean; after?: string; to?: string }): PlacementArg {
    const given = [values.start === true, values.end === true, values.after !== undefined, values.to !== undefined].filter(Boolean).length;
    if (given !== 1) throw new UsageError('Place the photo with exactly one of --start, --end, --after <photoId>, and --to <N>.');
    if (values.start) return 'start';
    if (values.end) return 'end';
    if (values.after !== undefined) return { after: photoIdArg(values.after) };
    if (!/^\d+$/.test(values.to ?? '')) throw new UsageError('--to takes a position from 1.');
    return { to: Number(values.to) };
}

/** `--focal <x>,<y>`, each from 0 to 1. */
function focalArg(value: string): { x: number; y: number } {
    const match = /^\s*([0-9.]+)\s*,\s*([0-9.]+)\s*$/.exec(value);
    const [x, y] = match ? [Number(match[1]), Number(match[2])] : [Number.NaN, Number.NaN];
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) throw new UsageError('--focal takes x,y, each from 0 to 1, such as --focal 0.5,0.4.');
    return { x, y };
}

/** One positional count, or a usage error that names the form. */
function exactly(positionals: string[], n: number, form: string): string[] {
    if (positionals.length !== n) throw new UsageError(`Usage: photos ${form}`);
    return positionals;
}

/** Parsed flags and positionals. Each command reads only the flags it declares. */
interface Parsed {
    values: Record<string, string | boolean | undefined>;
    positionals: string[];
}

type Options = NonNullable<Parameters<typeof parseArgs>[0]>['options'];

/** Strict parsing with --expect-version, which every changing command takes. */
function parseOrder(args: string[], options: Options = {}): Parsed {
    return strictly(() => parseArgs({ args, options: { 'expect-version': { type: 'string' }, ...options }, allowPositionals: true, strict: true })) as Parsed;
}

const text = (value: string | boolean | undefined): string | undefined => (typeof value === 'string' ? value : undefined);

function sequenceArgs(args: string[]): SequenceCommand {
    const [sub, ...rest] = args;
    const expectVersion = (values: Parsed['values']) => expectVersionArg(text(values['expect-version']));
    switch (sub) {
        case 'show': {
            const { values, positionals } = parseOrder(rest);
            if (values['expect-version'] !== undefined) throw new UsageError('sequence show takes no --expect-version.');
            const [seriesId] = exactly(positionals, 1, 'sequence show <seriesId>');
            return { command: 'show', seriesId };
        }
        case 'set': {
            const { values, positionals } = parseOrder(rest);
            if (positionals.length < 1) throw new UsageError('Usage: photos sequence set <seriesId> <photoId>...');
            const [seriesId, ...photoIds] = positionals;
            return { command: 'set', seriesId, photoIds: photoIds.map(photoIdArg), expectVersion: expectVersion(values) };
        }
        case 'insert':
        case 'move': {
            const { values, positionals } = parseOrder(rest, { start: { type: 'boolean' }, end: { type: 'boolean' }, after: { type: 'string' }, to: { type: 'string' } });
            const [seriesId, photoId] = exactly(positionals, 2, `sequence ${sub} <seriesId> <photoId> (--start | --end | --after <photoId> | --to <N>)`);
            const at = placementArg({ start: values.start === true, end: values.end === true, after: text(values.after), to: text(values.to) });
            return { command: sub, seriesId, photoId: photoIdArg(photoId), at, expectVersion: expectVersion(values) };
        }
        case 'remove': {
            const { values, positionals } = parseOrder(rest);
            const [seriesId, photoId] = exactly(positionals, 2, 'sequence remove <seriesId> <photoId>');
            return { command: 'remove', seriesId, photoId: photoIdArg(photoId), expectVersion: expectVersion(values) };
        }
        case 'cover': {
            const { values, positionals } = parseOrder(rest, { focal: { type: 'string' }, 'clear-focal': { type: 'boolean' } });
            const [seriesId, photoId] = exactly(positionals, 2, 'sequence cover <seriesId> <photoId> [--focal <x>,<y> | --clear-focal]');
            const focal = text(values.focal);
            if (focal !== undefined && values['clear-focal'] === true) throw new UsageError('--focal and --clear-focal don\'t go together.');
            const point = values['clear-focal'] === true ? 'clear' as const : focal === undefined ? undefined : focalArg(focal);
            return { command: 'cover', seriesId, photoId: photoIdArg(photoId), ...(point === undefined ? {} : { focal: point }), expectVersion: expectVersion(values) };
        }
        case 'opening': {
            const { values, positionals } = parseOrder(rest, { clear: { type: 'boolean' } });
            const form = 'sequence opening <seriesId> (<photoId> | --clear)';
            if (values.clear === true) {
                const [seriesId] = exactly(positionals, 1, form);
                return { command: 'opening', seriesId, photoId: null, expectVersion: expectVersion(values) };
            }
            const [seriesId, photoId] = exactly(positionals, 2, form);
            return { command: 'opening', seriesId, photoId: photoIdArg(photoId), expectVersion: expectVersion(values) };
        }
        case 'chapter': {
            const [action, ...tail] = rest;
            if (action === 'add' || action === 'move') {
                const { values, positionals } = parseOrder(tail, { start: { type: 'string' } });
                const form = action === 'add' ? 'sequence chapter add <seriesId> <title> --start <photoId>' : 'sequence chapter move <seriesId> <chapterId> --start <photoId>';
                const [seriesId, second] = exactly(positionals, 2, form);
                const start = text(values.start);
                if (start === undefined) throw new UsageError(`chapter ${action} needs --start <photoId>.`);
                return action === 'add'
                    ? { command: 'chapter-add', seriesId, title: second, startPhotoId: photoIdArg(start), expectVersion: expectVersion(values) }
                    : { command: 'chapter-move', seriesId, chapterId: second, startPhotoId: photoIdArg(start), expectVersion: expectVersion(values) };
            }
            if (action === 'remove') {
                const { values, positionals } = parseOrder(tail);
                const [seriesId, chapterId] = exactly(positionals, 2, 'sequence chapter remove <seriesId> <chapterId>');
                return { command: 'chapter-remove', seriesId, chapterId, expectVersion: expectVersion(values) };
            }
            throw new UsageError(action ? `Unknown chapter command: ${action}` : 'photos sequence chapter needs add, move, or remove.');
        }
        default:
            throw new UsageError(sub ? `Unknown sequence command: ${sub}` : 'photos sequence needs a command.');
    }
}

function seriesArgs(args: string[]): SequenceCommand {
    const [sub, ...rest] = args;
    if (sub !== 'order' && sub !== 'featured') throw new UsageError(sub ? `Unknown series command: ${sub}` : 'photos series needs order or featured.');
    const { values, positionals } = parseOrder(rest);
    return { command: sub === 'order' ? 'series-order' : 'series-featured', seriesIds: positionals, expectVersion: expectVersionArg(text(values['expect-version'])) };
}

async function orderCommand(parse: () => SequenceCommand): Promise<number> {
    const command = parse();
    const root = catalogRoot();
    if (typeof root === 'number') return root;
    return printed(await runSequenceCommand({ dataRoot: root }, command));
}

async function main(argv: string[]): Promise<number> {
    const [command, ...args] = argv;
    try {
        if (command === 'migrate') return await migrate(args);
        if (command === 'identity') return await identity(args);
        if (command === 'status') return await statusCommand(args);
        if (command === 'list') return await listCommand(args);
        if (command === 'draft:init') return await draftInitCommand(args);
        if (command === 'describe') return await describeCommand(args);
        if (command === 'sequence') return await orderCommand(() => sequenceArgs(args));
        if (command === 'series') return await orderCommand(() => seriesArgs(args));
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
