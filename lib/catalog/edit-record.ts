import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PHOTO_ID_RE } from '../identity/ids';
import { dataRootStatus } from '../storage/config';
import { hasErrorCode, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from '../storage/fsx';
import { LockLostError, LockTimeoutError } from '../storage/lock';
import { SERIES_ID_RE, type AuthoredKind } from './schema';
import type { CommandResult, LayerHandle } from './sequence-commands';
import type { AuthoredRecord, AuthoredRecordInput } from './types';
import { AuthoredWriteError, MANAGED_FIELDS, writeAuthoredRecord, type WriteAuthoredOptions } from './working-layer-writer';
import { readAuthoredRecord } from './working-layer';

/**
 * `photos edit <photoId | seriesId | site> [--file <path>]`, #13 slice D: the
 * owner's way to change what no other command covers, such as a series' copy
 * and visibility or a photo's focal point. It opens the record's newest
 * version in $VISUAL or $EDITOR, checks the result against the record's
 * schema, and commits it as the next version, the way every other command
 * writes. A series that has no record yet opens as a draft to fill in, which
 * is how a new series starts. `--file` commits a file instead of opening an
 * editor, such as an edit an earlier run kept.
 *
 * The managed fields (schemaVersion, version, baseRevisionId, and the site's
 * baseSeriesOrder) are left out of the text, and the writer keeps them. The
 * edit holds no lock while the editor is open: the commit checks the version
 * it opened, so a record that changed meanwhile stops it, and the edit is kept
 * for `--file`.
 *
 * Exit codes follow sequence-commands.ts: 0 when it committed or nothing
 * changed, 1 for an edit it refuses, an unusable record, or a data root that
 * isn't ready, 2 for a usage error, 3 when the record changed or the authored
 * lock stays busy, and 4 for I/O.
 */

export type RecordRef = { kind: AuthoredKind; id: string };

/** The record an argument names: a photo ID, a series ID, or `site`. Null when it names none. */
export function recordRef(arg: string): RecordRef | null {
    if (arg === 'site') return { kind: 'site', id: 'site' };
    if (PHOTO_ID_RE.test(arg)) return { kind: 'photo', id: arg };
    if (SERIES_ID_RE.test(arg)) return { kind: 'series', id: arg };
    return null;
}

/** Opens `file` for the owner and resolves with the editor's exit code. */
export type Editor = (file: string) => Promise<number>;

/**
 * $VISUAL, then $EDITOR, then vi, run through `sh -c` so a value such as
 * `code --wait` works. The file goes in as an argument, never into the
 * command text.
 */
export const shellEditor: Editor = (file) => new Promise((resolve, reject) => {
    const command = process.env.VISUAL || process.env.EDITOR || 'vi';
    const child = spawn('sh', ['-c', `${command} "$1"`, 'sh', file], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
});

const MANAGED = new Set<string>(MANAGED_FIELDS);

/** What the owner edits: the record without its managed fields. */
function editable(record: object): Record<string, unknown> {
    return Object.fromEntries(Object.entries(record).filter(([key]) => !MANAGED.has(key)));
}

/** The text a new series opens with: a draft with every field the owner fills in. */
function newSeries(id: string): Record<string, unknown> {
    return { kind: 'series', id, slug: id.slice('ser_'.length), title: '', statement: '', shortStatement: '', photoIds: [], chapters: [], cover: null, visibility: 'draft' };
}

const text = (value: object) => `${JSON.stringify(value, null, 2)}\n`;

export interface EditOptions {
    /** Commit this file's contents instead of opening an editor. */
    file?: string;
    editor?: Editor;
    /** The folder the edit's private working folder goes in. Defaults to the system temp folder. */
    workDir?: string;
    /** Test hooks: after the editor closes, before the commit. */
    afterEdit?(): void | Promise<void>;
}

/** `photos edit`. Never throws: every outcome is an exit code and the text to print. */
export async function runEditRecord(layer: LayerHandle, ref: RecordRef, options: EditOptions = {}): Promise<CommandResult> {
    const root = path.resolve(layer.dataRoot);
    const status = dataRootStatus({ write: true, root });
    if (status.state !== 'ready') return { exitCode: 1, output: `Error: The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}. Nothing was written.\n` };
    const name = ref.kind === 'site' ? 'the site record' : `${ref.kind} ${ref.id}`;

    let current: AuthoredRecord | null;
    try {
        current = await readAuthoredRecord(root, ref.kind, ref.id);
    } catch (error) {
        return { exitCode: 1, output: `Error: ${(error as Error).message}. photos edit opens only a record it can read. Nothing was written.\n` };
    }
    if (current === null && ref.kind !== 'series') {
        const hint = ref.kind === 'photo' ? ' photos draft:init creates a record for every photo.' : ' photos draft:init creates it.';
        return { exitCode: 1, output: `Error: There is no ${name}.${hint}\n` };
    }
    const expectedVersion = current?.version ?? 0;
    const before = text(current ? editable(current) : newSeries(ref.id));

    let workDir: string | null = null;
    let working: string;
    if (options.file !== undefined) {
        working = options.file;
    } else {
        // A folder of its own each run, readable by the owner only, so an edit kept from an earlier run is never overwritten.
        workDir = await fs.promises.mkdtemp(path.join(options.workDir ?? os.tmpdir(), 'photos-edit-'));
        await fs.promises.chmod(workDir, PRIVATE_DIR_MODE);
        working = path.join(workDir, `${ref.id}.json`);
        await fs.promises.writeFile(working, before, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
        const code = await (options.editor ?? shellEditor)(working);
        if (code !== 0) {
            await fs.promises.rm(workDir, { recursive: true, force: true });
            return { exitCode: 1, output: `Error: The editor exited ${code}, so nothing was written.\n` };
        }
    }
    // Kept when the commit doesn't happen, so the edit isn't lost.
    const kept = () => (options.file === undefined ? ` Your edit is in ${working}. Fix it there and run photos edit ${ref.id} --file ${working}.` : '');
    const done = async () => {
        if (workDir !== null) await fs.promises.rm(workDir, { recursive: true, force: true });
    };

    let edited: string;
    try {
        edited = await fs.promises.readFile(working, 'utf8');
    } catch (error) {
        return { exitCode: 1, output: `Error: ${working} can't be read (${hasErrorCode(error, 'ENOENT') ? 'ENOENT' : (error as Error).message}). Nothing was written.\n` };
    }
    if (edited === before) {
        await done();
        return { exitCode: 0, output: `No change to ${name}.\n` };
    }
    let value: unknown;
    try {
        value = JSON.parse(edited);
    } catch (error) {
        return { exitCode: 1, output: `Error: The edit is not valid JSON: ${(error as Error).message}. Nothing was written.${kept()}\n` };
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { exitCode: 1, output: `Error: The edit must be one JSON object. Nothing was written.${kept()}\n` };
    const record = value as Record<string, unknown>;
    // The kind and the ID say which record the commit writes, so an edit can't move it to another.
    if (record.kind !== ref.kind || (ref.kind !== 'site' && record.id !== ref.id)) {
        return { exitCode: 1, output: `Error: The edit changes the record's kind or id. It has to stay ${ref.kind}${ref.kind === 'site' ? '' : ` ${ref.id}`}. Nothing was written.${kept()}\n` };
    }
    await options.afterEdit?.();

    try {
        const write = writeAuthoredRecord as (record: AuthoredRecordInput, options: WriteAuthoredOptions) => Promise<AuthoredRecord>;
        const saved = await write(editable(record) as unknown as AuthoredRecordInput, { expectedVersion, root, waitMs: layer.waitMs });
        await done();
        return { exitCode: 0, output: `Saved ${name} as version ${saved.version}. photos validate checks it against the rest of the catalog.\n` };
    } catch (error) {
        if (error instanceof AuthoredWriteError) {
            const exitCode = ['VERSION_CONFLICT', 'AUTHORED_LOCKED', 'LOCK_NOT_HELD'].includes(error.code) ? 3 : 1;
            const issues = error.issues?.map((issue) => `\n  ${issue.path || '(the record)'}: ${issue.message}`).join('') ?? '';
            const why = error.code === 'VERSION_CONFLICT' ? ' It changed while you edited it.' : '';
            return { exitCode, output: `Error (${error.code}): ${error.message}${why}${issues}\nNothing was written.${kept()}\n` };
        }
        if (error instanceof LockTimeoutError || error instanceof LockLostError) return { exitCode: 3, output: `Error (authored-locked): ${error.message} Nothing was written.${kept()}\n` };
        return { exitCode: 4, output: `Error: ${(error as Error).message}${kept()}\n` };
    }
}
