import fs from 'node:fs';
import path from 'node:path';
import { PHOTO_ID_RE } from '../identity/ids';
import { dataRootStatus } from '../storage/config';
import type { VersionedWriteOptions } from '../storage/document';
import { LockLostError, LockTimeoutError, withLock } from '../storage/lock';
import { codePointName, FIELD_LIMITS, plainText } from './plain-text';
import type { CommandResult, LayerHandle } from './sequence-commands';
import type { AuthoredPhoto } from './types';
import { AUTHORED_LEASE_MS, AUTHORED_LOCK, AUTHORED_WAIT_MS, AuthoredWriteError, writeAuthoredRecord } from './working-layer-writer';
import { readAuthoredRecord } from './working-layer';

/**
 * `photos describe --import <file> [--dry-run]`, #13 slice D: set the
 * description, decorative flag, title, and caption of many photo records
 * from one CSV or JSON file. An empty cell leaves its field as it is.
 * Imported descriptions count as reviewed, since the owner wrote them. The
 * import fails whole, writing nothing, on any row it can't apply, an unknown
 * photo ID among them.
 *
 * CSV has a header row naming its columns, and JSON is an array of objects
 * with the same keys. Columns: photoId (required), alt, decorative, title,
 * caption. `decorative` is true or false: true marks the photo decorative,
 * and false with an empty alt takes a decorative flag off, leaving no
 * description until one is imported.
 *
 * Since every imported description goes to the publish gate as reviewed, the
 * file is held to plain text: a regular file of at most
 * IMPORT_FILE_MAX_BYTES, strict UTF-8, no control, bidi, or zero-width
 * characters (plain-text.ts lists them), NFC, a line break only in a
 * caption, and each field within FIELD_LIMITS.
 *
 * Exit codes follow sequence-commands.ts: 0 on success, 1 for a file it
 * refuses or a data root that isn't ready, 2 for a usage error, 3 when the
 * authored lock stays busy or is lost part way, and 4 for I/O.
 */

export const DESCRIPTION_COLUMNS = ['photoId', 'alt', 'decorative', 'title', 'caption'] as const;

/** The largest file the import reads. */
export const IMPORT_FILE_MAX_BYTES = 5 * 1024 * 1024;


export { FIELD_LIMITS };

type TextColumn = 'alt' | 'title' | 'caption';

export interface DescriptionRow {
    /** Where the row is, for messages: `line 4` in CSV, `item 3` in JSON. */
    at: string;
    photoId: string;
    alt?: string;
    decorative?: boolean;
    title?: string;
    caption?: string;
}

export type ParsedDescriptions = { ok: true; rows: DescriptionRow[] } | { ok: false; errors: string[] };

/** How many problems or changes the output lists before it only counts the rest. */
const LISTED = 200;

/** How much of a cell a message quotes. */
const QUOTED = 60;

function listed(lines: string[]): string[] {
    return lines.length > LISTED ? [...lines.slice(0, LISTED), `  and ${lines.length - LISTED} more`] : lines;
}


/** Anything a terminal could act on or hide: controls, format characters, separators, surrogates, private use, and unassigned. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;

/** Text for a message: at most `max` characters, with anything unprintable written as `\u{XXXX}`. */
export function printable(value: string, max = QUOTED): string {
    const characters = [...value];
    const shown = characters.slice(0, max).map((character) => {
        if (character === '"') return '\\"';
        if (character === '\\') return '\\\\';
        return UNPRINTABLE.test(character) ? `\\u{${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}}` : character;
    });
    return `${shown.join('')}${characters.length > max ? '...' : ''}`;
}

/** A cell quoted for a message, cut short and escaped by printable(). */
export function quoteCell(value: string): string {
    return `"${printable(value)}"`;
}

/** A value of any JSON type for a message. */
const quoteValue = (value: unknown) => (typeof value === 'string' ? quoteCell(value) : printable(JSON.stringify(value) ?? String(value)));

/**
 * RFC 4180 records: fields split by commas, records by LF, CRLF, or CR, and a
 * quoted field may hold commas, line breaks, and `""` for a quote. Each
 * record comes with the line it starts on.
 */
export function parseCsvRecords(text: string): { records: { line: number; fields: string[] }[] } | { error: string } {
    const records: { line: number; fields: string[] }[] = [];
    let fields: string[] = [];
    let field = '';
    let quoted = false;
    let line = 1;
    let start = 1;
    let afterQuote = false;
    const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
    const endRecord = () => {
        fields.push(field);
        records.push({ line: start, fields });
        fields = [];
        field = '';
        afterQuote = false;
    };
    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        if (quoted) {
            if (char === '"') {
                if (source[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    quoted = false;
                    afterQuote = true;
                }
            } else {
                // CRLF counts once, and a CR alone, as old Mac files write, counts too.
                if (char === '\n' || (char === '\r' && source[i + 1] !== '\n')) line++;
                field += char;
            }
            continue;
        }
        if (char === '"') {
            if (field !== '' || afterQuote) return { error: `line ${line} has a quote inside an unquoted field. Quote the whole field, and double any quote in it.` };
            quoted = true;
        } else if (char === ',') {
            fields.push(field);
            field = '';
            afterQuote = false;
        } else if (char === '\n' || char === '\r') {
            if (char === '\r' && source[i + 1] === '\n') i++;
            endRecord();
            line++;
            start = line;
        } else {
            if (afterQuote) return { error: `line ${line} has text after a closing quote.` };
            field += char;
        }
    }
    if (quoted) return { error: `the quoted field that starts on line ${start} never ends.` };
    if (field !== '' || fields.length > 0 || afterQuote) endRecord();
    // A blank line, the trailing newline's included, is no record.
    return { records: records.filter((record) => record.fields.some((value) => value !== '')) };
}

function decorativeValue(value: unknown, at: string, errors: string[]): boolean | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string' && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === 'true';
    errors.push(`${at}: decorative is ${quoteValue(value)}, but it takes true or false.`);
    return undefined;
}

/** A text cell as it is stored: line breaks as LF, trimmed, NFC, and checked against the column's rules. */
function textValue(value: unknown, column: TextColumn, at: string, errors: string[]): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
        errors.push(`${at}: ${column} must be text, not ${quoteValue(value)}.`);
        return undefined;
    }
    const checked = plainText(value, { limit: FIELD_LIMITS[column], lineBreaks: column === 'caption' });
    const where = `${at}, ${column}:`;
    if (!checked.ok) {
        const { problem } = checked;
        if (problem.kind === 'character') errors.push(`${where} has ${codePointName(problem.codePoint)}, ${problem.why}, at character ${problem.index}. Remove it and import the file again.`);
        else if (problem.kind === 'line-break') errors.push(`${where} has a line break, which only caption can hold.`);
        else errors.push(`${where} is ${problem.length} characters long, over its limit of ${problem.limit}.`);
        return undefined;
    }
    return checked.text === '' ? undefined : checked.text;
}

/** One row's cells as a DescriptionRow, or null with its problems added to `errors`. */
function toRow(cells: Record<string, unknown>, at: string, errors: string[]): DescriptionRow | null {
    const before = errors.length;
    const photoId = typeof cells.photoId === 'string' ? cells.photoId.trim() : '';
    if (photoId === '') errors.push(`${at}: there is no photoId.`);
    else if (!PHOTO_ID_RE.test(photoId)) errors.push(`${at}: ${quoteCell(photoId)} is not a photo ID.`);
    const row: DescriptionRow = { at, photoId };
    const alt = textValue(cells.alt, 'alt', at, errors);
    const decorative = decorativeValue(cells.decorative, at, errors);
    const title = textValue(cells.title, 'title', at, errors);
    const caption = textValue(cells.caption, 'caption', at, errors);
    if (alt !== undefined && decorative === true) errors.push(`${at}: a photo is described or decorative, not both. Leave alt empty or set decorative to false.`);
    if (alt !== undefined) row.alt = alt;
    if (decorative !== undefined) row.decorative = decorative;
    if (title !== undefined) row.title = title;
    if (caption !== undefined) row.caption = caption;
    return errors.length === before ? row : null;
}

function checkColumns(names: readonly string[], where: string, errors: string[]): void {
    for (const name of names) {
        if (!(DESCRIPTION_COLUMNS as readonly string[]).includes(name)) errors.push(`${where} names ${quoteCell(name)}, which isn't one of ${DESCRIPTION_COLUMNS.join(', ')}.`);
    }
}

/**
 * Read a description file's rows from its decoded text. `format` comes from
 * the file name; anything else is sniffed from the text. A duplicate key in a
 * JSON object keeps its last value, as JSON.parse does.
 */
export function parseDescriptions(input: string, format: 'csv' | 'json'): ParsedDescriptions {
    const text = input.startsWith('\uFEFF') ? input.slice(1) : input;
    const errors: string[] = [];
    const rows: DescriptionRow[] = [];
    if (format === 'json') {
        let value: unknown;
        try {
            value = JSON.parse(text);
        } catch (error) {
            return { ok: false, errors: [`The file is not valid JSON: ${printable((error as Error).message, 200)}`] };
        }
        if (!Array.isArray(value)) return { ok: false, errors: ['The JSON must be an array of objects, one per photo.'] };
        value.forEach((item, index) => {
            const at = `item ${index + 1}`;
            if (typeof item !== 'object' || item === null || Array.isArray(item)) {
                errors.push(`${at} is not an object.`);
                return;
            }
            checkColumns(Object.keys(item), at, errors);
            const row = toRow(item as Record<string, unknown>, at, errors);
            if (row) rows.push(row);
        });
    } else {
        const parsed = parseCsvRecords(text);
        if ('error' in parsed) return { ok: false, errors: [`The CSV can't be read: ${parsed.error}`] };
        const [header, ...records] = parsed.records;
        if (!header) return { ok: false, errors: ['The CSV is empty. Its first line names the columns, photoId first.'] };
        const names = header.fields.map((name) => name.trim());
        checkColumns(names, 'The header', errors);
        const duplicate = names.find((name, index) => names.indexOf(name) !== index);
        if (duplicate !== undefined) errors.push(`The header names ${quoteCell(duplicate)} twice.`);
        if (!names.includes('photoId')) errors.push('The header has no photoId column.');
        if (errors.length > 0) return { ok: false, errors };
        for (const record of records) {
            const at = `line ${record.line}`;
            if (record.fields.length > names.length) {
                errors.push(`${at} has ${record.fields.length} cells, but the header names ${names.length} columns.`);
                continue;
            }
            const row = toRow(Object.fromEntries(names.map((name, index) => [name, record.fields[index] ?? ''])), at, errors);
            if (row) rows.push(row);
        }
    }
    const seen = new Map<string, string>();
    for (const row of rows) {
        const first = seen.get(row.photoId);
        if (first !== undefined) errors.push(`${row.at}: ${row.photoId} is also on ${first}. Give each photo one row.`);
        else seen.set(row.photoId, row.at);
    }
    return errors.length > 0 ? { ok: false, errors } : { ok: true, rows };
}

/** The format a file's name gives, or the one its text looks like. */
export function formatOf(file: string, text: string): 'csv' | 'json' {
    const extension = path.extname(file).toLowerCase();
    if (extension === '.json') return 'json';
    if (extension === '.csv') return 'csv';
    return /^\s*\[/.test(text.replace(/^\uFEFF/, '')) ? 'json' : 'csv';
}

/** The offset of the first byte that isn't part of well-formed UTF-8, or -1. */
function firstInvalidByte(bytes: Uint8Array): number {
    for (let i = 0; i < bytes.length;) {
        const lead = bytes[i];
        if (lead < 0x80) {
            i++;
            continue;
        }
        const [need, initial, min] = lead >= 0xc2 && lead <= 0xdf ? [1, lead & 0x1f, 0x80] : lead >= 0xe0 && lead <= 0xef ? [2, lead & 0x0f, 0x800] : lead >= 0xf0 && lead <= 0xf4 ? [3, lead & 0x07, 0x10000] : [0, 0, 0];
        if (need === 0) return i;
        let codePoint = initial;
        for (let k = 1; k <= need; k++) {
            const next = bytes[i + k];
            if (next === undefined || (next & 0xc0) !== 0x80) return i;
            codePoint = (codePoint << 6) | (next & 0x3f);
        }
        if (codePoint < min || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return i;
        i += need + 1;
    }
    return -1;
}

/** The 1-based line `offset` is on, counting LF, CRLF, and CR breaks. */
function lineAt(bytes: Uint8Array, offset: number): number {
    let line = 1;
    for (let i = 0; i < offset; i++) {
        if (bytes[i] === 0x0a || (bytes[i] === 0x0d && bytes[i + 1] !== 0x0a)) line++;
    }
    return line;
}

type ReadFile = { ok: true; text: string } | { ok: false; output: string };

/**
 * Read an import file as text: a regular file of at most
 * IMPORT_FILE_MAX_BYTES, checked on the opened handle, decoded as strict
 * UTF-8 with a leading BOM dropped. Opened non-blocking, so a FIFO is
 * refused rather than waited on.
 */
export async function readImportFile(file: string): Promise<ReadFile> {
    const refuse = (why: string): ReadFile => ({ ok: false, output: `Error: ${file} ${why} Nothing was written.\n` });
    let handle: fs.promises.FileHandle;
    try {
        handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    } catch (error) {
        return refuse(`can't be read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}).`);
    }
    let bytes: Buffer;
    try {
        const stat = await handle.stat();
        if (!stat.isFile()) return refuse('is not a regular file.');
        const cap = `${IMPORT_FILE_MAX_BYTES / (1024 * 1024)} MiB`;
        if (stat.size > IMPORT_FILE_MAX_BYTES) return refuse(`is larger than ${cap}. Split it into smaller files.`);
        // Read one byte past the cap, so a file that grew since the stat is caught too.
        const buffer = Buffer.alloc(IMPORT_FILE_MAX_BYTES + 1);
        let length = 0;
        for (;;) {
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
            if (bytesRead === 0) break;
            length += bytesRead;
            if (length > IMPORT_FILE_MAX_BYTES) return refuse(`is larger than ${cap}. Split it into smaller files.`);
        }
        bytes = buffer.subarray(0, length);
    } catch (error) {
        return refuse(`can't be read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}).`);
    } finally {
        await handle.close();
    }
    try {
        return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {
        const offset = firstInvalidByte(bytes);
        const where = offset < 0 ? 'The file' : `line ${lineAt(bytes, offset)}`;
        return {
            ok: false,
            output: `Nothing was written, since the file has problems:\n  ${where} is not UTF-8 text. Save the file as "CSV UTF-8" (Excel's plain "CSV" and "CSV (Macintosh)" aren't), or as UTF-8 text, and import it again.\n`,
        };
    }
}

/** The record a row turns `record` into. Equal to it when the row changes nothing. */
function applyRow(record: AuthoredPhoto, row: DescriptionRow): AuthoredPhoto {
    const next: AuthoredPhoto = { ...record };
    if (row.alt !== undefined) next.alt = { kind: 'described', text: row.alt, reviewed: true };
    else if (row.decorative === true) next.alt = { kind: 'decorative' };
    // false un-flags a decorative photo. With no alt it then has no description, so the description gate holds it.
    else if (row.decorative === false && record.alt?.kind === 'decorative') next.alt = null;
    if (row.title !== undefined) next.title = row.title;
    if (row.caption !== undefined) next.caption = row.caption;
    return next;
}

const sameRecord = (a: AuthoredPhoto, b: AuthoredPhoto) => JSON.stringify(a) === JSON.stringify(b);

export interface DescribeImportResult {
    /** Photo IDs whose record changes, or changed, in file order. */
    changed: string[];
    /** Rows that change nothing. */
    unchanged: number;
}

export interface DescribeImportOptions {
    dryRun?: boolean;
    /** Test hooks, passed to every writeAuthoredRecord() call. */
    hooks?: VersionedWriteOptions['hooks'];
}

class ImportRefused extends Error {
    readonly problems: string[];

    constructor(problems: string[]) {
        super(problems.join('\n'));
        this.problems = problems;
    }
}

/** A write failed after the import checked every row: `written` landed, and `failed` and the rows after it didn't. */
export class ImportStoppedError extends Error {
    readonly written: string[];
    readonly failed: DescriptionRow;
    readonly total: number;
    readonly cause: unknown;

    constructor(written: string[], failed: DescriptionRow, total: number, cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = 'ImportStoppedError';
        this.written = written;
        this.failed = failed;
        this.total = total;
        this.cause = cause;
    }
}

type Plan = { row: DescriptionRow; record: AuthoredPhoto; next: AuthoredPhoto };

/** Every row's record and what it becomes, or ImportRefused with every problem. Reads only. */
async function plan(root: string, rows: readonly DescriptionRow[]): Promise<{ plans: Plan[]; unchanged: number }> {
    const problems: string[] = [];
    const plans: Plan[] = [];
    let unchanged = 0;
    for (const row of rows) {
        let record: AuthoredPhoto | null;
        try {
            record = await readAuthoredRecord(root, 'photo', row.photoId);
        } catch (error) {
            problems.push(`${row.at}: ${(error as Error).message}`);
            continue;
        }
        if (!record) {
            problems.push(`${row.at}: there is no photo record ${row.photoId}. photos list shows the IDs, and photos draft:init creates a record for every photo.`);
            continue;
        }
        const next = applyRow(record, row);
        if (sameRecord(record, next)) unchanged++;
        else plans.push({ row, record, next });
    }
    if (problems.length > 0) throw new ImportRefused(problems);
    return { plans, unchanged };
}

/**
 * Apply parsed rows under one authored hold, so the import is checked and
 * written against one snapshot. A dry run reads without the lock and writes
 * nothing at all, as `photos validate` does, so it also runs on a data root
 * it can only read.
 */
export async function importDescriptions({ dataRoot, waitMs = AUTHORED_WAIT_MS }: LayerHandle, rows: readonly DescriptionRow[], { dryRun = false, hooks }: DescribeImportOptions = {}): Promise<DescribeImportResult> {
    const root = path.resolve(dataRoot);
    if (dryRun) {
        const { plans, unchanged } = await plan(root, rows);
        return { changed: plans.map(({ record }) => record.id), unchanged };
    }
    return withLock(AUTHORED_LOCK, { root, leaseMs: AUTHORED_LEASE_MS, waitMs }, async (lock) => {
        const { plans, unchanged } = await plan(root, rows);
        const written: string[] = [];
        for (const { row, record, next } of plans) {
            try {
                lock.signal.throwIfAborted();
                await writeAuthoredRecord(next, { expectedVersion: record.version, lock, root, hooks });
            } catch (error) {
                throw new ImportStoppedError(written, row, plans.length, error);
            }
            written.push(record.id);
        }
        return { changed: written, unchanged };
    });
}

/** The exit code for an error that stopped the writes: 3 for a lock or version race, 1 for a record refused, 4 for I/O. */
function stoppedExitCode(cause: unknown): CommandResult['exitCode'] {
    if (cause instanceof LockLostError) return 3;
    if (cause instanceof AuthoredWriteError) return ['VERSION_CONFLICT', 'AUTHORED_LOCKED', 'LOCK_NOT_HELD'].includes(cause.code) ? 3 : 1;
    return 4;
}

function stoppedOutput(error: ImportStoppedError): string {
    const { cause, written, failed, total } = error;
    const code = cause instanceof AuthoredWriteError ? cause.code : cause instanceof LockLostError ? 'LOCK_LOST' : null;
    const issues = cause instanceof AuthoredWriteError ? cause.issues?.map((issue) => ` ${issue.path}: ${issue.message}`).join(';') ?? '' : '';
    const head = `Error${code ? ` (${code})` : ''}: ${error.message}${issues}`;
    if (written.length === 0) return `${head}\nNothing was written.\n`;
    return [
        head,
        `It wrote ${written.length} of ${total} records before it stopped at ${failed.photoId} (${failed.at}). Run the same import again to finish it: rows it already applied change nothing.`,
        '',
    ].join('\n');
}

/** `photos describe --import <file> [--dry-run]`. Never throws: every outcome is an exit code and the text to print. */
export async function runDescribeImport(layer: LayerHandle, { file, dryRun = false, hooks }: { file: string } & DescribeImportOptions): Promise<CommandResult> {
    const read = await readImportFile(file);
    if (!read.ok) return { exitCode: 1, output: read.output };
    const parsed = parseDescriptions(read.text, formatOf(file, read.text));
    if (!parsed.ok) return { exitCode: 1, output: `${['Nothing was written, since the file has problems:', ...listed(parsed.errors.map((error) => `  ${error}`))].join('\n')}\n` };
    const status = dataRootStatus({ write: !dryRun, root: path.resolve(layer.dataRoot) });
    if (status.state !== 'ready') return { exitCode: 1, output: `Error: The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}. Nothing was written.\n` };
    try {
        const result = await importDescriptions(layer, parsed.rows, { dryRun, hooks });
        const verb = dryRun ? 'Would update' : 'Updated';
        const lines = [
            `${verb} ${result.changed.length} photo record${result.changed.length === 1 ? '' : 's'}, and ${result.unchanged} ${result.unchanged === 1 ? 'row changes' : 'rows change'} nothing.`,
            ...listed(result.changed.map((photoId) => `  ${photoId}`)),
        ];
        if (dryRun) lines.push('Nothing was written. Run it again without --dry-run to write it.');
        return { exitCode: 0, output: `${lines.join('\n')}\n` };
    } catch (error) {
        if (error instanceof ImportRefused) return { exitCode: 1, output: `${['Nothing was written:', ...listed(error.problems.map((problem) => `  ${problem}`))].join('\n')}\n` };
        if (error instanceof LockTimeoutError) return { exitCode: 3, output: `Error (authored-locked): ${error.message} Nothing was written.\n` };
        if (error instanceof ImportStoppedError) return { exitCode: stoppedExitCode(error.cause), output: stoppedOutput(error) };
        return { exitCode: 4, output: `Error: ${(error as Error).message}\n` };
    }
}
