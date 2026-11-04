import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../storage/atomicWrite';
import { hasErrorCode, PRIVATE_DIR_MODE } from '../storage/fsx';
import { count, parseFlags, UsageError } from './owner-cli';
import { REVISION_ID_RE } from './schema';
import { verifyCatalog, verifyRecordPath, VERIFY_EXIT_CODES, type ChainCheck, type RevisionCheck, type VerifyOptions, type VerifyRecord, type VerifyReport } from './verify';

/**
 * `photos verify [--revision <revisionId>] [--json]`, #117: argv parsing,
 * the run, its report text, and the one write, `status/verify.json`, kept
 * here so tests can run it in-process. Nothing but the CLI and its tests
 * imports this module, so no page or route writes the record
 * (verifyBoundary.test.ts). Runs on demand only: no watcher, publish, or
 * web process runs it.
 */

export interface VerifyArgs {
    /** Check this revision alone, and record nothing. */
    revisionId?: string;
    json: boolean;
}

/** `photos verify [--revision <revisionId>] [--json]`. */
export function verifyArgs(args: string[]): VerifyArgs {
    const { values } = parseFlags({ args, options: { revision: { type: 'string' }, json: { type: 'boolean' } } });
    if (values.revision !== undefined && !REVISION_ID_RE.test(values.revision)) throw new UsageError(`--revision takes a revision ID, rev_ plus 64 hex, not ${values.revision}.`);
    return { json: values.json === true, ...(values.revision === undefined ? {} : { revisionId: values.revision }) };
}

/** Replace `status/verify.json` atomically, creating `status/` for its owner only, as the watcher's heartbeat does. */
export async function writeVerifyRecord(root: string, record: VerifyRecord): Promise<void> {
    const file = verifyRecordPath(root);
    try {
        await fs.promises.mkdir(path.dirname(file), { mode: PRIVATE_DIR_MODE });
    } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) throw error;
    }
    await atomicWriteJson(file, record);
}

function revisionLines(entry: RevisionCheck): string[] {
    const name = `${entry.revisionNumber === null ? 'not activated' : `revision ${entry.revisionNumber}`}, ${entry.revisionId}`;
    let head: string;
    if (entry.live) head = `${name}: LIVE, ${entry.ok ? 'passes' : 'FAILS'}`;
    else if (entry.eligible) head = entry.ok ? `${name}: passes. A rollback can return to it.` : `${name}: FAILS. It was live before, but don't roll back to it until it passes.`;
    else head = entry.ok ? `${name}: passes. It was never live, so a rollback can't return to it.` : `${name}: FAILS. It was never live, so nothing serves it.`;
    const lines = [head, ...entry.problems.map((problem) => `    ${problem}`)];
    if (entry.problemCount > entry.problems.length) lines.push(`    And ${count(entry.problemCount - entry.problems.length, 'more problem')}.`);
    lines.push(...entry.warnings.map((warning) => `    Warning, which a rollback can accept: ${warning}`));
    if (entry.fix) lines.push(`    Fix: ${entry.fix}`);
    return lines;
}

function chainLines(chain: ChainCheck): string[] {
    if (chain.ok && chain.warnings.length === 0) return ['Activation chain: passes.'];
    return [...chain.problems.map((problem) => `Activation chain: ${problem}`), ...chain.warnings.map((warning) => `Activation chain, a warning: ${warning}`)];
}

/** What `photos verify` prints: a line per revision, oldest first, the chain, any note, and the verdict last. */
export function verifyLines(report: VerifyReport, note: string | null = null): string[] {
    const verdict = `[photos] ${report.outcome}: ${report.message}`;
    const { record } = report;
    if (!record) return [verdict];
    const lines = [`[photos] Checked ${count(record.revisions.length, 'revision')} and ${count(record.sets.checked, 'derivative set')} in ${(record.durationMs / 1000).toFixed(1)} s.`];
    for (const entry of record.revisions) lines.push(...revisionLines(entry));
    if (report.full) lines.push(...chainLines(record.chain));
    else lines.push('Nothing was recorded: --revision checks one revision, without the activation chain, and writes nothing.');
    if (note) lines.push(note);
    lines.push(verdict);
    return lines;
}

export interface VerifyIo {
    out(line: string): void;
    err(line: string): void;
}

/**
 * `photos verify`: check, record a full run in `status/verify.json`, and
 * print the report, on stdout when it exits 0 and on stderr otherwise, or
 * as JSON on stdout with `--json`. A record it can't write gets a note and
 * leaves the exit code as it is. Returns the exit code.
 */
export async function runVerifyCommand(dataRoot: string, args: VerifyArgs, io: VerifyIo, options: Partial<Omit<VerifyOptions, 'dataRoot' | 'revisionId'>> = {}): Promise<number> {
    const root = path.resolve(dataRoot);
    const report = await verifyCatalog({ ...options, dataRoot: root, ...(args.revisionId === undefined ? {} : { revisionId: args.revisionId }) });
    const exitCode = VERIFY_EXIT_CODES[report.outcome];
    let recorded = false;
    let note: string | null = null;
    if (report.full && report.record) {
        try {
            await writeVerifyRecord(root, report.record);
            recorded = true;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException | null)?.code;
            note = `[photos] status/verify.json couldn't be written (${typeof code === 'string' ? code : 'an I/O error'}), so the Publish screen doesn't know about this run. The checks above still stand.`;
        }
    }
    if (args.json) {
        io.out(JSON.stringify({ outcome: report.outcome, exitCode, message: report.message, recorded, ...(note ? { note } : {}), record: report.record }, null, 2));
        return exitCode;
    }
    const print = exitCode === 0 ? io.out : io.err;
    for (const line of verifyLines(report, note)) print(line);
    return exitCode;
}
