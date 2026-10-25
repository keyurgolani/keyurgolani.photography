import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PHOTO_ID_RE } from '../identity/ids';
import { dataRootStatus } from '../storage/config';
import { hasErrorCode, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from '../storage/fsx';
import { LockLostError, LockTimeoutError } from '../storage/lock';
import { codePointName, FIELD_LIMITS, plainText } from './plain-text';
import { canonicalJson } from '../storage/canonical';
import { SERIES_ID_RE, type AuthoredKind } from './schema';
import type { CommandResult, LayerHandle } from './sequence-commands';
import type { AuthoredRecord, AuthoredRecordInput } from './types';
import { AuthoredWriteError, MANAGED_FIELDS, writeAuthoredRecord, type WriteAuthoredOptions } from './working-layer-writer';
import { readAuthoredRecord } from './working-layer';

/**
 * `photos edit <photoId | seriesId | site> [--file <path>] [--expect-version <N>]`,
 * #13 slice D: the owner's way to change what no other command covers, such
 * as a series' copy and visibility or a photo's focal point. It opens the
 * record's newest version in $VISUAL or $EDITOR, checks the result, and
 * commits it as the next version, the way every other command writes. A
 * series that has no record yet opens as a draft to fill in, which is how a
 * new series starts. `--file` commits a file instead of opening an editor:
 * an edit an earlier run kept, or in production a copy edited on the host,
 * since the container has no editor of the owner's.
 *
 * The managed fields (schemaVersion, version, baseRevisionId, the site's
 * baseSeriesOrder) and a version file's `stamp` are left out of the text, and
 * the writer keeps its own. No lock is held while the editor is open. The
 * commit checks the version the edit started from: the one it opened, or
 * `--expect-version` for a file, which `--file` needs whenever the record
 * exists. So an edit made against an older version exits 3 instead of
 * replacing what was written since.
 *
 * The working copy is in `edits/` in the data root (0700, files 0600), not in
 * the record folders, so it survives a `run --rm` container and nothing reads
 * it as a record. A committed or unchanged edit removes its copy, and one that
 * can't be committed keeps it and prints the command that commits it.
 *
 * Its public text (alt, titles, caption, statements, credit, location, and
 * chapter titles) takes the import's plain-text rules and caps.
 *
 * Exit codes follow sequence-commands.ts: 0 when it committed or nothing
 * changed, 1 for an edit it refuses, an unusable record, or a data root that
 * isn't ready, 2 for a `--file` without `--expect-version`, 3 when the record
 * isn't at the version the edit started from or the authored lock stays busy,
 * and 4 for I/O.
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

/** Where kept edits go: a private folder of the data root, outside `authored/` and `catalog/`. */
export const editsDir = (root: string) => path.join(/*turbopackIgnore: true*/ root, 'edits');

const HIDDEN = new Set<string>([...MANAGED_FIELDS, 'stamp']);

/** What the owner edits: the record without its managed fields and stamp. */
function editable(record: object): Record<string, unknown> {
    return Object.fromEntries(Object.entries(record).filter(([key]) => !HIDDEN.has(key)));
}

/** A slug for a new series' ID: its words, joined by single hyphens. */
export function slugFor(id: string): string {
    return id.slice('ser_'.length).replace(/[_-]+/g, '-').replace(/^-|-$/g, '');
}

/** The text a new series opens with: a draft with every field the owner fills in. */
function newSeries(id: string): Record<string, unknown> {
    return { kind: 'series', id, slug: slugFor(id), title: '', statement: '', shortStatement: '', photoIds: [], chapters: [], cover: null, visibility: 'draft' };
}

const text = (value: object) => `${JSON.stringify(value, null, 2)}\n`;

type TextRule = { limit: number; lineBreaks?: boolean };

/** The public text fields an edit can set, by kind, and their rules. */
const TEXT_FIELDS: Record<AuthoredKind, Record<string, TextRule>> = {
    site: {},
    series: { title: { limit: FIELD_LIMITS.title }, statement: { limit: FIELD_LIMITS.statement, lineBreaks: true }, shortStatement: { limit: FIELD_LIMITS.shortStatement } },
    photo: { title: { limit: FIELD_LIMITS.title }, caption: { limit: FIELD_LIMITS.caption, lineBreaks: true }, credit: { limit: FIELD_LIMITS.title }, location: { limit: FIELD_LIMITS.title } },
};

/**
 * Run the edit's public text through plainText(), storing what it returns.
 * Non-string values are left for the schema. Returns the problems, field by
 * field, or none.
 */
function checkText(record: Record<string, unknown>, kind: AuthoredKind): string[] {
    const problems: string[] = [];
    const check = (value: unknown, field: string, rule: TextRule, store: (text: string) => void) => {
        if (typeof value !== 'string') return;
        const checked = plainText(value, rule);
        if (checked.ok) return store(checked.text);
        const { problem } = checked;
        if (problem.kind === 'character') problems.push(`${field} has ${codePointName(problem.codePoint)}, ${problem.why}, at character ${problem.index}.`);
        else if (problem.kind === 'line-break') problems.push(`${field} has a line break, which it can't hold.`);
        else problems.push(`${field} is ${problem.length} characters long, over its limit of ${problem.limit}.`);
    };
    for (const [field, rule] of Object.entries(TEXT_FIELDS[kind])) check(record[field], field, rule, (value) => { record[field] = value; });
    if (kind === 'photo' && typeof record.alt === 'object' && record.alt !== null && (record.alt as { kind?: unknown }).kind === 'described') {
        const alt = record.alt as { text?: unknown };
        check(alt.text, 'alt.text', { limit: FIELD_LIMITS.alt }, (value) => { alt.text = value; });
    }
    if (kind === 'series' && Array.isArray(record.chapters)) {
        record.chapters.forEach((chapter: unknown, index) => {
            if (typeof chapter !== 'object' || chapter === null) return;
            const entry = chapter as { title?: unknown };
            check(entry.title, `chapters[${index}].title`, { limit: FIELD_LIMITS.title }, (value) => { entry.title = value; });
        });
    }
    return problems;
}

export interface EditOptions {
    /** Commit this file's contents instead of opening an editor. */
    file?: string;
    /** The version the edit started from. Needed with `file` whenever the record exists. */
    expectVersion?: number;
    editor?: Editor;
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
    const currentVersion = current?.version ?? 0;
    if (options.file !== undefined && options.expectVersion === undefined && current !== null) {
        return {
            exitCode: 2,
            output: `Error: --file needs --expect-version <N>, the version the edit started from, so it can't replace a newer one. ${name} is at version ${currentVersion} now.\n`,
        };
    }
    const expectedVersion = options.expectVersion ?? currentVersion;
    const stale = (found: number) =>
        `${name} is at version ${found}, not ${expectedVersion}, the version the edit started from. Merge your edit into version ${found}, then run it with --expect-version ${found}.`;
    if (expectedVersion !== currentVersion) return { exitCode: 3, output: `Error (VERSION_CONFLICT): ${stale(currentVersion)} Nothing was written.\n` };
    const opened = current ? editable(current) : newSeries(ref.id);

    let working: string;
    let own = false;
    if (options.file !== undefined) {
        working = options.file;
    } else {
        const dir = editsDir(root);
        try {
            await fs.promises.mkdir(dir, { mode: PRIVATE_DIR_MODE });
        } catch (error) {
            if (!hasErrorCode(error, 'EEXIST')) throw error;
            // A link could send the working copy, and the record's text, outside the data root, as #49 refuses for record folders.
            const stat = await fs.promises.lstat(dir);
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                return { exitCode: 1, output: 'Error: edits/ in the data root is a symlink or not a folder, so photos edit won\'t keep a working copy there. Make it a folder of its own (0700). Nothing was written.\n' };
            }
        }
        await fs.promises.chmod(dir, PRIVATE_DIR_MODE);
        // The name carries the version the edit opened, so a kept one says what it was made against.
        working = path.join(dir, `${ref.id}.v${expectedVersion}.${randomUUID().slice(0, 8)}.json`);
        await fs.promises.writeFile(working, text(opened), { mode: PRIVATE_FILE_MODE, flag: 'wx' });
        own = true;
        const code = await (options.editor ?? shellEditor)(working);
        if (code !== 0) {
            await fs.promises.rm(working, { force: true });
            return { exitCode: 1, output: `Error: The editor exited ${code}, so nothing was written.\n` };
        }
    }
    const kept = () => ` Your edit is in ${working}. Fix it there and run photos edit ${ref.id} --file ${working} --expect-version ${expectedVersion}.`;
    const done = async () => {
        if (own) await fs.promises.rm(working, { force: true });
    };

    let edited: string;
    try {
        edited = await fs.promises.readFile(working, 'utf8');
    } catch (error) {
        return { exitCode: 1, output: `Error: ${working} can't be read (${hasErrorCode(error, 'ENOENT') ? 'ENOENT' : (error as Error).message}). Nothing was written.\n` };
    }
    let value: unknown;
    try {
        value = JSON.parse(edited);
    } catch (error) {
        return { exitCode: 1, output: `Error: The edit is not valid JSON: ${(error as Error).message}. Nothing was written.${kept()}\n` };
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { exitCode: 1, output: `Error: The edit must be one JSON object. Nothing was written.${kept()}\n` };
    const record = editable(value);
    // The kind and the ID say which record the commit writes, so an edit can't move it to another.
    if (record.kind !== ref.kind || (ref.kind !== 'site' && record.id !== ref.id)) {
        return { exitCode: 1, output: `Error: The edit changes the record's kind or id. It has to stay ${ref.kind}${ref.kind === 'site' ? '' : ` ${ref.id}`}. Nothing was written.${kept()}\n` };
    }
    const problems = checkText(record, ref.kind);
    if (problems.length > 0) return { exitCode: 1, output: `${['Error: The edit\'s text has problems:', ...problems.map((problem) => `  ${problem}`)].join('\n')}\nNothing was written.${kept()}\n` };
    // Compared as values, so a copy whose keys come in another order, or a version file with its stamp, is no change.
    if (canonicalJson(record) === canonicalJson(opened)) {
        await done();
        return { exitCode: 0, output: current ? `No change to ${name}.\n` : `No change, so ${name} isn't created.\n` };
    }
    await options.afterEdit?.();

    try {
        const write = writeAuthoredRecord as (record: AuthoredRecordInput, options: WriteAuthoredOptions) => Promise<AuthoredRecord>;
        const saved = await write(record as unknown as AuthoredRecordInput, { expectedVersion, root, waitMs: layer.waitMs });
        await done();
        return { exitCode: 0, output: `Saved ${name} as version ${saved.version}. photos validate checks it against the rest of the catalog.\n` };
    } catch (error) {
        if (error instanceof AuthoredWriteError) {
            if (error.code === 'VERSION_CONFLICT') {
                return { exitCode: 3, output: `Error (VERSION_CONFLICT): It changed while you edited it. ${stale(error.foundVersion ?? expectedVersion + 1)}\nNothing was written.${kept()}\n` };
            }
            const exitCode = ['AUTHORED_LOCKED', 'LOCK_NOT_HELD'].includes(error.code) ? 3 : 1;
            const issues = error.issues?.map((issue) => `\n  ${issue.path || '(the record)'}: ${issue.message}`).join('') ?? '';
            return { exitCode, output: `Error (${error.code}): ${error.message}${issues}\nNothing was written.${kept()}\n` };
        }
        if (error instanceof LockTimeoutError || error instanceof LockLostError) return { exitCode: 3, output: `Error (authored-locked): ${error.message} Nothing was written.${kept()}\n` };
        return { exitCode: 4, output: `Error: ${(error as Error).message}${kept()}\n` };
    }
}
