import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from '../storage/atomicWrite';
import { hasErrorCode, PRIVATE_DIR_MODE } from '../storage/fsx';
import { count, parseFlags, UsageError } from './owner-cli';
import { REVISION_ID_RE } from './schema';
import { MAX_RECORD_BYTES, readVerifyRecord, verifyCatalog, verifyRecordPath, VERIFY_EXIT_CODES, type ChainCheck, type RevisionCheck, type VerifyOptions, type VerifyRecord, type VerifyReport } from './verify';

/**
 * `photos verify [--revision <revisionId>] [--json]`, #117: argv parsing,
 * the run, its report text, and the one write, `status/verify.json`, kept
 * here so tests can run it in-process. Nothing but the CLI and its tests
 * imports this module, so no page or route writes the record
 * (verifyBoundary.test.ts). Runs on demand only: no watcher, publish, or
 * web process runs it.
 *
 * #181's A7: a `--revision` run that passes a revision the record fails
 * replaces that one entry, stamped with its own `checkedAt`, so the
 * rollback it refused can go ahead. It never records a failure, never
 * touches another entry or the run's own `checkedAt`, and writes nothing
 * when there is no record, no failure to clear, or a record it can't read.
 */

export interface VerifyArgs {
    /** Check this revision alone, recording only a pass that clears its recorded failure. */
    revisionId?: string;
    json: boolean;
}

/** `photos verify [--revision <revisionId>] [--json]`. */
export function verifyArgs(args: string[]): VerifyArgs {
    const { values } = parseFlags({ args, options: { revision: { type: 'string' }, json: { type: 'boolean' } } });
    if (values.revision !== undefined && !REVISION_ID_RE.test(values.revision)) throw new UsageError(`--revision takes a revision ID, rev_ plus 64 hex, not ${values.revision}.`);
    return { json: values.json === true, ...(values.revision === undefined ? {} : { revisionId: values.revision }) };
}

/**
 * The record as JSON, at most MAX_RECORD_BYTES, which the reader refuses
 * past. A big catalog's problems are cut to one per revision, then to none;
 * each entry's `ok` and `problemCount` always stay.
 */
function recordText(record: VerifyRecord): string {
    const text = (value: VerifyRecord) => `${JSON.stringify(value, null, 2)}\n`;
    const trimmed = (keep: number): VerifyRecord => ({
        ...record,
        revisions: record.revisions.map((entry) => ({ ...entry, problems: entry.problems.slice(0, keep), warnings: entry.warnings.slice(0, keep), failedSets: entry.failedSets.slice(0, keep) })),
    });
    for (const candidate of [record, trimmed(1), trimmed(0)]) {
        const out = text(candidate);
        if (Buffer.byteLength(out) <= MAX_RECORD_BYTES) return out;
    }
    return `${JSON.stringify(trimmed(0))}\n`;
}

export interface RecordWriteOptions {
    /** This process's uid. As root, the record takes the data root's owner. */
    uid?: number;
    chown?: (file: string, uid: number, gid: number) => Promise<void>;
}

/**
 * Replace `status/verify.json` atomically, creating `status/` for its owner
 * only, as the watcher's heartbeat does: 0700 and 0600, the data root's
 * usual modes. Run as root, as `sudo` on the host would, both take the data
 * root's owner, so the curator, which runs as that user, can still read the
 * record. The docs run it in the watcher's container, as uid 1001.
 */
export async function writeVerifyRecord(root: string, record: VerifyRecord, { uid = process.getuid?.(), chown = (file, owner, group) => fs.promises.chown(file, owner, group) }: RecordWriteOptions = {}): Promise<void> {
    const file = verifyRecordPath(root);
    try {
        await fs.promises.mkdir(path.dirname(file), { mode: PRIVATE_DIR_MODE });
    } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) throw error;
    }
    await atomicWriteFile(file, recordText(record));
    if (uid !== 0) return;
    const owner = await fs.promises.stat(root);
    if (owner.uid === 0) return;
    for (const target of [path.dirname(file), file]) await chown(target, owner.uid, owner.gid);
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

/** What a `--revision` run did to the record, for its report. */
export type SingleRecord = 'cleared' | 'nothing' | 'damaged';

const SINGLE_LINES: Record<SingleRecord, (entry: RevisionCheck | undefined) => string> = {
    cleared: (entry) => `Recorded: ${!entry ? 'the revision' : entry.revisionNumber === null ? entry.revisionId : `revision ${entry.revisionNumber}`} passes now, so status/verify.json no longer fails it.`,
    nothing: () => 'Nothing was recorded: --revision checks one revision, without the activation chain, and records only a pass that clears a recorded failure.',
    damaged: () => "[photos] status/verify.json can't be read, so this pass cleared nothing. Run photos verify without --revision to record a full check.",
};

/** What `photos verify` prints: a line per revision, oldest first, the chain, any note, and the verdict last. */
export function verifyLines(report: VerifyReport, note: string | null = null, single: SingleRecord = 'nothing'): string[] {
    const verdict = `[photos] ${report.outcome}: ${report.message}`;
    const { record } = report;
    if (!record) return [verdict];
    const lines = [`[photos] Checked ${count(record.revisions.length, 'revision')} and ${count(record.sets.checked, 'derivative set')} in ${(record.durationMs / 1000).toFixed(1)} s.`];
    for (const entry of record.revisions) lines.push(...revisionLines(entry));
    if (report.full) lines.push(...chainLines(record.chain));
    else lines.push(SINGLE_LINES[single](record.revisions[0]));
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
    let single: SingleRecord = 'nothing';
    const unwritten = (error: unknown) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        return `[photos] status/verify.json couldn't be written (${typeof code === 'string' ? code : 'an I/O error'}), so the Publish screen doesn't know about this run. The checks above still stand.`;
    };
    if (report.full && report.record) {
        try {
            await writeVerifyRecord(root, report.record);
            recorded = true;
        } catch (error) {
            note = unwritten(error);
        }
    } else if (report.record && report.outcome === 'VERIFIED') {
        const checked = report.record.revisions[0];
        const read = await readVerifyRecord(root);
        if (read.state === 'damaged') single = 'damaged';
        else if (read.state === 'ok' && checked && read.record.revisions.some((entry) => entry.revisionId === checked.revisionId && !entry.ok)) {
            // Only this revision's entries change, to this pass. The run's checkedAt stays the full run's.
            const entry: RevisionCheck = { ...checked, checkedAt: report.record.checkedAt };
            const next: VerifyRecord = { ...read.record, revisions: read.record.revisions.map((other) => (other.revisionId === checked.revisionId ? entry : other)) };
            try {
                await writeVerifyRecord(root, next);
                recorded = true;
                single = 'cleared';
            } catch (error) {
                note = unwritten(error);
            }
        }
    }
    if (args.json) {
        io.out(JSON.stringify({ outcome: report.outcome, exitCode, message: report.message, recorded, ...(note ? { note } : {}), record: report.record }, null, 2));
        return exitCode;
    }
    const print = exitCode === 0 ? io.out : io.err;
    for (const line of verifyLines(report, note, single)) print(line);
    return exitCode;
}
