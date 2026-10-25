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
 *   npx tsx scripts/photos.ts identity bind <path> <photoId> [--merge <photoId>] [--reason <text>]
 *   npx tsx scripts/photos.ts identity new <path> [--reason <text>]
 *   npx tsx scripts/photos.ts identity archive <photoId> [--reason <text>]
 *   npx tsx scripts/photos.ts identity retry <photoId> [<assetRevision>] [--reason <text>]
 *   npx tsx scripts/photos.ts identity reprofile (<photoId> | --all) [--reason <text>]
 *     Write an identity decision to identity/decisions/ and run a pass that
 *     applies it. If the registry is busy, the decision stays saved and the
 *     watcher applies it on its next pass. Exits 0 when applied or saved, 1
 *     when refused, when the data root isn't ready, or when the pass fails
 *     after the decision is saved, and 2 on a usage error.
 *     <path> is relative to the library, or an absolute path inside it. A
 *     bind to a path another photo holds merges that photo into <photoId>
 *     only when --merge names it, and only if it was minted at that path.
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
 *     import before it writes anything. The file is a regular file of at most
 *     5 MiB in UTF-8, and describe-import.ts lists the characters and field
 *     lengths it refuses. --dry-run takes no lock and writes nothing.
 *
 *   npx tsx scripts/photos.ts edit (<photoId> | <seriesId> | site) [--file <path>] [--expect-version <N>]
 *     Open a record's newest version in $VISUAL or $EDITOR, check it, and
 *     commit it as the next version. A series without a record opens as a
 *     draft to fill in. --file commits a file instead of opening an editor,
 *     and needs --expect-version, the version the edit started from, when
 *     the record exists. An edit it can't commit stays in edits/ in the data
 *     root, with the command that commits it. Exits 0 when saved or
 *     unchanged, 1 when the edit or the record can't be used, 2 on a usage
 *     error, 3 when the record isn't at the version the edit started from or
 *     the authored lock stays busy, and 4 for I/O.
 *
 *   npx tsx scripts/photos.ts sequence <command> <seriesId> ...
 *   npx tsx scripts/photos.ts series order <seriesId>...
 *   npx tsx scripts/photos.ts series featured (<seriesId>... | --clear)
 *     Change a series' photos, cover, opening photo, and chapters, or the
 *     Work order and featured series, through #8's operations. The usage
 *     below lists each form. sequence set and series order need at least one
 *     ID. Exits 0 on success, 1 when the operation is refused, 2 on a usage
 *     error, 3 on a version conflict or a busy authored lock, and 4 for I/O.
 *
 *   npx tsx scripts/photos.ts validate [--reprofile]
 *     Compile the working layer and run every rule, taking no lock and
 *     writing nothing, so it runs on a read-only data root too. Prints the
 *     candidate ID and the first 200 issues. Exits 0 when only warnings
 *     remain, 1 on any error, 2 on a usage error, 4 when a catalog file is
 *     damaged or can't be read, and 3 when the data root isn't ready.
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
 * production, run it in the watcher's container, which mounts the data root
 * read-write:
 * docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/photos.mjs <command>.
 * The README's "Curating the catalog" section walks through the commands.
 *
 * Every command refuses a flag given twice. The owner commands, status to
 * series, exit 1 when PHOTOGRAPHY_DATA_DIR is unset, and status still prints
 * its report then.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDescribeImport } from '../lib/catalog/describe-import';
import { runDraftInit } from '../lib/catalog/draft-init';
import { recordRef, runEditRecord } from '../lib/catalog/edit-record';
import { runListCommand, runStatusCommand } from '../lib/catalog/owner-status';
import { issueLines, photoIdArg, publishReport, sequenceArgs, seriesArgs, parseFlags, UsageError } from '../lib/catalog/owner-cli';
import { publish, PUBLISH_EXIT_CODES, validateWorkingLayer, VALIDATE_EXIT_CODES } from '../lib/catalog/publish';
import { REVISION_ID_RE } from '../lib/catalog/schema';
import { runSequenceCommand, type CommandResult, type SequenceCommand } from '../lib/catalog/sequence-commands';
import { ApplyRefusedError, migrateApply } from '../lib/identity/apply';
import { createDecision, decisionFileName, isLibraryPath, writeDecision, type DecisionInput } from '../lib/identity/decisions';
import { ASSET_REVISION_RE } from '../lib/identity/ids';
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
  ${PROGRAM} identity bind <path> <photoId> [--merge <photoId>] [--reason <text>]
  ${PROGRAM} identity new <path> [--reason <text>]
  ${PROGRAM} identity archive <photoId> [--reason <text>]
  ${PROGRAM} identity retry <photoId> [<assetRevision>] [--reason <text>]
  ${PROGRAM} identity reprofile (<photoId> | --all) [--reason <text>]
  ${PROGRAM} status [--json]
  ${PROGRAM} list [--unassigned] [--json]
  ${PROGRAM} draft:init
  ${PROGRAM} describe --import <file> [--dry-run]
  ${PROGRAM} edit (<photoId> | <seriesId> | site) [--file <path>] [--expect-version <N>]
  ${PROGRAM} sequence show <seriesId>
  ${PROGRAM} sequence set <seriesId> <photoId>... [--expect-version <N>]
  ${PROGRAM} sequence (insert | move) <seriesId> <photoId> (--start | --end | --after <photoId> | --to <N>) [--expect-version <N>]
  ${PROGRAM} sequence remove <seriesId> <photoId> [--expect-version <N>]
  ${PROGRAM} sequence cover <seriesId> <photoId> [--focal <x>,<y> | --clear-focal] [--expect-version <N>]
  ${PROGRAM} sequence opening <seriesId> (<photoId> | --clear) [--expect-version <N>]
  ${PROGRAM} sequence chapter add <seriesId> <title> --start <photoId> [--expect-version <N>]
  ${PROGRAM} sequence chapter move <seriesId> <chapterId> --start <photoId> [--expect-version <N>]
  ${PROGRAM} sequence chapter remove <seriesId> <chapterId> [--expect-version <N>]
  ${PROGRAM} series order <seriesId>... [--expect-version <N>]
  ${PROGRAM} series featured (<seriesId>... | --clear) [--expect-version <N>]
  ${PROGRAM} validate [--reprofile]
  ${PROGRAM} publish [--actor <name>] [--reason <text>] [--expect <candidateId>] [--dry-run] [--confirm-launch] [--reprofile]
A flag given twice is refused. An argument that starts with - goes after --.
In production: docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/photos.mjs <command>
The README's "Curating the catalog" section has the commands, the hand-edit rules, and the launch checklist.`;

/** A path argument as a library-relative POSIX path. */
function libraryPath(arg: string): string {
    const library = libraryRoot();
    const relative = path.isAbsolute(arg) ? (isInside(arg, library) ? path.relative(library, arg) : '..') : arg;
    const posix = path.posix.normalize(relative.split(path.sep).join('/')).replace(/^(\.\/)+/, '');
    if (!isLibraryPath(posix)) throw new UsageError(`${arg} is not inside the library.`);
    return posix;
}

async function migrate(args: string[]): Promise<number> {
    const { values } = parseFlags({
        args,
        options: { 'dry-run': { type: 'boolean' }, apply: { type: 'boolean' }, out: { type: 'string' }, plan: { type: 'string' } },
    });
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

function decisionInput(type: DecisionInput['type'], positionals: string[], values: { reason?: string; all?: boolean; merge?: string }): DecisionInput {
    const base = { actor: 'cli', reason: values.reason ?? '' };
    switch (type) {
        case 'bind': {
            if (positionals.length !== 2) throw new UsageError('identity bind needs a path and a photo ID.');
            const photoId = photoIdArg(positionals[1]);
            if (values.merge !== undefined && photoIdArg(values.merge) === photoId) throw new UsageError(`--merge must name a photo other than ${photoId}.`);
            return { ...base, type, path: libraryPath(positionals[0]), photoId, ...(values.merge === undefined ? {} : { merge: values.merge }) };
        }
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
    const { values, positionals } = parseFlags({
        args,
        options: { reason: { type: 'string' }, all: { type: 'boolean' }, merge: { type: 'string' } },
        allowPositionals: true,
    });
    if (values.all !== undefined && type !== 'reprofile') throw new UsageError('--all goes with identity reprofile.');
    if (values.merge !== undefined && type !== 'bind') throw new UsageError('--merge goes with identity bind.');
    const input = decisionInput(type, positionals, values);
    const status = dataRootStatus({ versioned: true });
    if (status.state !== 'ready' || status.root === null) {
        console.error(`[photos] The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}. Nothing was written.`);
        return 1;
    }
    const decision = createDecision(input);
    const file = await writeDecision(status.root, decision);
    let outcome: Awaited<ReturnType<typeof runReconcilePass>>;
    try {
        outcome = await runReconcilePass({ lock: { waitMs: 0 }, sinks: [jsonLogSink()] });
    } catch (error) {
        // The decision is saved, so running the command again would make a second one, and a second photo for `new`.
        const why = error instanceof LibraryRootMissingError ? `${error.message}. Check the mount or PHOTOGRAPHY_LIBRARY_DIR` : `The pass failed: ${error instanceof Error ? error.message : String(error)}`;
        console.error(`[photos] ${why}. The decision is saved in ${file}, and the next pass that runs applies it. Don't run the command again.`);
        return 1;
    }
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
    const { values } = parseFlags({ args: rest, options: { json: { type: 'boolean' } } });
    const status = await identityStatus();
    process.stdout.write(values.json ? `${JSON.stringify(status, null, 2)}\n` : formatStatus(status));
    return status.dataRoot.state === 'ready' && !status.registryError ? 0 : 1;
}

/** Lines for a command's report: stdout when it succeeded, stderr when it didn't, as the identity commands do. */
function reporter(exitCode: number): (line: string) => void {
    return exitCode === 0 ? (line) => console.log(line) : (line) => console.error(line);
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
    const { values } = parseFlags({ args, options: { reprofile: { type: 'boolean' } } });
    const root = catalogRoot();
    if (typeof root === 'number') return root;
    const result = await validateWorkingLayer({ dataRoot: root, reprofile: values.reprofile });
    const exitCode = VALIDATE_EXIT_CODES[result.outcome];
    const print = reporter(exitCode);
    print(`[photos] ${result.outcome}: ${result.message}`);
    if (result.candidateId) print(`Candidate: ${result.candidateId}`);
    for (const line of issueLines(result.issues, 'publish --dry-run writes them all to the diagnostics file.')) print(line);
    return exitCode;
}

async function publishCommand(args: string[]): Promise<number> {
    const { values } = parseFlags({
        args,
        options: {
            actor: { type: 'string' },
            reason: { type: 'string' },
            expect: { type: 'string' },
            'dry-run': { type: 'boolean' },
            'confirm-launch': { type: 'boolean' },
            reprofile: { type: 'boolean' },
        },
    });
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
    for (const line of publishReport(result, root)) reporter(exitCode)(line);
    return exitCode;
}

/** Print a handler's text, on stdout when it succeeded and stderr when it didn't, and return its exit code. */
function printed(result: CommandResult): number {
    (result.exitCode === 0 ? process.stdout : process.stderr).write(result.output);
    return result.exitCode;
}

/**
 * The data root for the owner commands, or 1 after saying it is unset. These
 * commands use 1 for a data root that isn't ready and 3 only for a busy or
 * lost authored lock and a version conflict, so a wrapper that retries on 3
 * never loops on a missing PHOTOGRAPHY_DATA_DIR.
 */
function ownerRoot(): string | number {
    const root = dataRoot();
    if (root !== null) return root;
    console.error('[photos] The data root is unset: PHOTOGRAPHY_DATA_DIR is not set. Nothing was written.');
    return 1;
}

async function statusCommand(args: string[]): Promise<number> {
    const { values } = parseFlags({ args, options: { json: { type: 'boolean' } } });
    // status is the diagnostic command, so it reports even with no data root.
    return printed(await runStatusCommand({ dataRoot: dataRoot() }, { json: values.json }));
}

async function listCommand(args: string[]): Promise<number> {
    const { values } = parseFlags({ args, options: { unassigned: { type: 'boolean' }, json: { type: 'boolean' } } });
    const root = ownerRoot();
    if (typeof root === 'number') return root;
    return printed(await runListCommand({ dataRoot: root }, { unassigned: values.unassigned, json: values.json }));
}

async function draftInitCommand(args: string[]): Promise<number> {
    parseFlags({ args, options: {} });
    const root = ownerRoot();
    if (typeof root === 'number') return root;
    return printed(await runDraftInit({ dataRoot: root }));
}

async function describeCommand(args: string[]): Promise<number> {
    const { values } = parseFlags({ args, options: { import: { type: 'string' }, 'dry-run': { type: 'boolean' } } });
    if (!values.import) throw new UsageError('photos describe needs --import <file>.');
    const root = ownerRoot();
    if (typeof root === 'number') return root;
    return printed(await runDescribeImport({ dataRoot: root }, { file: values.import, dryRun: values['dry-run'] }));
}

async function editCommand(args: string[]): Promise<number> {
    const { values, positionals } = parseFlags({ args, options: { file: { type: 'string' }, 'expect-version': { type: 'string' } }, allowPositionals: true });
    if (positionals.length !== 1) throw new UsageError('photos edit needs one record: a photo ID, a series ID, or site.');
    const ref = recordRef(positionals[0]);
    if (ref === null) throw new UsageError(`${positionals[0]} is not a photo ID, a series ID, or site.`);
    if (values.file === '') throw new UsageError('--file needs a path.');
    const expect = values['expect-version'];
    if (expect !== undefined && !/^\d+$/.test(expect)) throw new UsageError('--expect-version takes a version from 0.');
    const root = ownerRoot();
    if (typeof root === 'number') return root;
    return printed(await runEditRecord({ dataRoot: root }, ref, { file: values.file, expectVersion: expect === undefined ? undefined : Number(expect) }));
}

async function orderCommand(parse: () => SequenceCommand): Promise<number> {
    const command = parse();
    const root = ownerRoot();
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
        if (command === 'edit') return await editCommand(args);
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
