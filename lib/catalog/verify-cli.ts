import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from '../storage/atomicWrite';
import { hasErrorCode, PRIVATE_DIR_MODE } from '../storage/fsx';
import { LockTimeoutError, withLock } from '../storage/lock';
import { count, parseFlags, UsageError } from './owner-cli';
import { REVISION_ID_RE } from './schema';
import { damagedText, MAX_RECORD_BYTES, readVerifyRecord, verifyCatalog, verifyRecordPath, VERIFY_EXIT_CODES, type ChainCheck, type RevisionCheck, type VerifyOptions, type DamagedCause, type VerifyRecord, type VerifyRecordRead, type VerifyReport } from './verify';

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
 *
 * The A7 review: both writes, a full run's and a clear, take a short lock
 * of their own, VERIFY_RECORD_LOCK, never the catalog lock, and read the
 * record again under it. A clear goes ahead only when this pass started
 * after the recorded run finished, so it never writes an older pass over a
 * newer failure. A full run leaves a record from a run that started after
 * it. Neither checks anything under the lock: it covers the write alone.
 */

/** The lock both record writes take, in `locks/`. */
export const VERIFY_RECORD_LOCK = 'verify-record';
/** How long a write waits for another one. Writes take milliseconds, so a holder past this crashed or hangs. */
export const VERIFY_RECORD_WAIT_MS = 10_000;
const VERIFY_RECORD_LEASE_MS = 30_000;

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

/** What a `--revision` run did to the record, for its report. `stale`: a full run finished after this pass started. */
export type SingleRecord = { kind: 'cleared' } | { kind: 'nothing' } | { kind: 'damaged'; cause: DamagedCause } | { kind: 'stale' };

const nameOf = (entry: RevisionCheck | undefined) => (!entry ? 'the revision' : entry.revisionNumber === null ? entry.revisionId : `revision ${entry.revisionNumber}`);

function singleLine(single: SingleRecord, entry: RevisionCheck | undefined): string {
    switch (single.kind) {
        case 'cleared':
            return `Recorded: ${nameOf(entry)} passes now, so status/verify.json no longer fails it.`;
        case 'damaged':
            return `[photos] status/verify.json can't be read: ${damagedText(single.cause)} This pass cleared nothing. Run photos verify without --revision to record a full check.`;
        case 'stale':
            return `[photos] A full photos verify finished after this pass started, so this pass cleared nothing. Run photos verify --revision ${entry?.revisionId ?? '<revisionId>'} again.`;
        case 'nothing':
        default:
            return 'Nothing was recorded: --revision checks one revision, without the activation chain, and records only a pass that clears a recorded failure.';
    }
}

/** What `photos verify` prints: a line per revision, oldest first, the chain, any note, and the verdict last. */
export function verifyLines(report: VerifyReport, note: string | null = null, single: SingleRecord = { kind: 'nothing' }): string[] {
    const verdict = `[photos] ${report.outcome}: ${report.message}`;
    const { record } = report;
    if (!record) return [verdict];
    const lines = [`[photos] Checked ${count(record.revisions.length, 'revision')} and ${count(record.sets.checked, 'derivative set')} in ${(record.durationMs / 1000).toFixed(1)} s.`];
    for (const entry of record.revisions) lines.push(...revisionLines(entry));
    if (report.full) lines.push(...chainLines(record.chain));
    else lines.push(singleLine(single, record.revisions[0]));
    if (note) lines.push(note);
    lines.push(verdict);
    return lines;
}

/**
 * Run `write` under VERIFY_RECORD_LOCK, with the record as it reads under
 * the lock. The lock lives in `locks/`, so a data root whose `status/` can't
 * be written still takes it, and the write's own error says why.
 */
async function underRecordLock(root: string, write: (read: VerifyRecordRead) => Promise<void>): Promise<void> {
    await withLock(VERIFY_RECORD_LOCK, { root, waitMs: VERIFY_RECORD_WAIT_MS, leaseMs: VERIFY_RECORD_LEASE_MS }, async () => write(await readVerifyRecord(root)));
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
    // Set inside the record lock's callback, so typed wide: a plain initializer would narrow them for the code after it.
    let recorded = false as boolean;
    let note = null as string | null;
    let single = { kind: 'nothing' } as SingleRecord;
    const unwritten = (error: unknown, stays = '') => {
        if (error instanceof LockTimeoutError) return `[photos] Another photos verify held status/verify.json's lock for ${VERIFY_RECORD_WAIT_MS / 1000} s, so ${stays || 'this run'} wasn't recorded. The checks above still stand.`;
        const code = (error as NodeJS.ErrnoException | null)?.code;
        const why = `status/verify.json couldn't be written (${typeof code === 'string' ? code : 'an I/O error'})`;
        return stays ? `[photos] ${why}, so ${stays}. The checks above still stand.` : `[photos] ${why}, so the Publish screen doesn't know about this run. The checks above still stand.`;
    };
    const start = report.record ? Date.parse(report.record.checkedAt) : Number.NaN;
    if (report.full && report.record) {
        const record = report.record;
        try {
            await underRecordLock(root, async (read) => {
                // A run that started after this one already recorded: it saw a newer catalog, so it stays.
                if (read.state === 'ok' && Date.parse(read.record.checkedAt) > start) {
                    note = "[photos] A newer photos verify recorded its run while this one ran, so this run wasn't recorded. The checks above still stand.";
                    return;
                }
                await writeVerifyRecord(root, record);
                recorded = true;
            });
        } catch (error) {
            note = unwritten(error);
        }
    } else if (report.record && report.outcome === 'VERIFIED') {
        const checked = report.record.revisions[0];
        const checkedAt = report.record.checkedAt;
        try {
            await underRecordLock(root, async (read) => {
                if (read.state === 'damaged') {
                    single = { kind: 'damaged', cause: read.cause };
                    return;
                }
                if (read.state !== 'ok' || !checked || !read.record.revisions.some((entry) => entry.revisionId === checked.revisionId && !entry.ok)) return;
                // Only a pass that started after the recorded run finished is newer than its failure.
                const finished = Date.parse(read.record.checkedAt) + (typeof read.record.durationMs === 'number' ? read.record.durationMs : 0);
                if (!(start >= finished)) {
                    single = { kind: 'stale' };
                    return;
                }
                // Only this revision's entries change, to this pass. The run's checkedAt stays the full run's.
                const entry: RevisionCheck = { ...checked, checkedAt };
                const next: VerifyRecord = { ...read.record, revisions: read.record.revisions.map((other) => (other.revisionId === checked.revisionId ? entry : other)) };
                try {
                    await writeVerifyRecord(root, next);
                } catch (error) {
                    note = unwritten(error, `${nameOf(checked)}'s recorded failure stays, and a rollback still refuses it`);
                    return;
                }
                recorded = true;
                single = { kind: 'cleared' };
            });
        } catch (error) {
            note = unwritten(error, `${nameOf(checked)}'s recorded failure stays, and a rollback still refuses it`);
        }
    }
    if (args.json) {
        // A --revision pass that cleared nothing for a reason says why, as the text report does.
        const said = note ?? (single.kind === 'damaged' || single.kind === 'stale' ? singleLine(single, report.record?.revisions[0]) : null);
        io.out(JSON.stringify({ outcome: report.outcome, exitCode, message: report.message, recorded, ...(said ? { note: said } : {}), record: report.record }, null, 2));
        return exitCode;
    }
    const print = exitCode === 0 ? io.out : io.err;
    for (const line of verifyLines(report, note, single)) print(line);
    return exitCode;
}
