import fs from 'node:fs';
import path from 'node:path';
import { PHOTO_ID_RE } from '../identity/ids';
import { dataRootStatus } from '../storage/config';
import { LockTimeoutError, withLock } from '../storage/lock';
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
 * caption. `decorative` is true or false.
 *
 * Exit codes follow sequence-commands.ts: 0 on success, 1 for a file it
 * refuses or a data root that isn't ready, 2 for a usage error, 3 when the
 * authored lock stays busy, and 4 for I/O.
 */

export const DESCRIPTION_COLUMNS = ['photoId', 'alt', 'decorative', 'title', 'caption'] as const;

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

function listed(lines: string[]): string[] {
    return lines.length > LISTED ? [...lines.slice(0, LISTED), `  and ${lines.length - LISTED} more`] : lines;
}

/**
 * RFC 4180 records: fields split by commas, records by LF or CRLF, and a
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
                if (char === '\n') line++;
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
    errors.push(`${at}: decorative is ${JSON.stringify(value)}, but it takes true or false.`);
    return undefined;
}

function textValue(value: unknown, column: string, at: string, errors: string[]): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
        errors.push(`${at}: ${column} must be text, not ${JSON.stringify(value)}.`);
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}

/** One row's cells as a DescriptionRow, or null with its problems added to `errors`. */
function toRow(cells: Record<string, unknown>, at: string, errors: string[]): DescriptionRow | null {
    const before = errors.length;
    const photoId = typeof cells.photoId === 'string' ? cells.photoId.trim() : '';
    if (photoId === '') errors.push(`${at}: there is no photoId.`);
    else if (!PHOTO_ID_RE.test(photoId)) errors.push(`${at}: ${JSON.stringify(photoId)} is not a photo ID.`);
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
        if (!(DESCRIPTION_COLUMNS as readonly string[]).includes(name)) errors.push(`${where} names ${JSON.stringify(name)}, which isn't one of ${DESCRIPTION_COLUMNS.join(', ')}.`);
    }
}

/** Read a description file's rows. `format` comes from the file name; anything else is sniffed from the text. */
export function parseDescriptions(text: string, format: 'csv' | 'json'): ParsedDescriptions {
    const errors: string[] = [];
    const rows: DescriptionRow[] = [];
    if (format === 'json') {
        let value: unknown;
        try {
            value = JSON.parse(text);
        } catch (error) {
            return { ok: false, errors: [`The file is not valid JSON: ${(error as Error).message}`] };
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
        if (duplicate !== undefined) errors.push(`The header names ${JSON.stringify(duplicate)} twice.`);
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

/** The record a row turns `record` into. Equal to it when the row changes nothing. */
function applyRow(record: AuthoredPhoto, row: DescriptionRow): AuthoredPhoto {
    const next: AuthoredPhoto = { ...record };
    if (row.alt !== undefined) next.alt = { kind: 'described', text: row.alt, reviewed: true };
    else if (row.decorative === true) next.alt = { kind: 'decorative' };
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

class ImportRefused extends Error {
    readonly problems: string[];

    constructor(problems: string[]) {
        super(problems.join('\n'));
        this.problems = problems;
    }
}

/** Apply parsed rows under one authored hold, so the import is checked and written against one snapshot. */
export async function importDescriptions({ dataRoot, waitMs = AUTHORED_WAIT_MS }: LayerHandle, rows: readonly DescriptionRow[], { dryRun = false }: { dryRun?: boolean } = {}): Promise<DescribeImportResult> {
    const root = path.resolve(dataRoot);
    return withLock(AUTHORED_LOCK, { root, leaseMs: AUTHORED_LEASE_MS, waitMs }, async (lock) => {
        const problems: string[] = [];
        const plans: { record: AuthoredPhoto; next: AuthoredPhoto }[] = [];
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
            else plans.push({ record, next });
        }
        if (problems.length > 0) throw new ImportRefused(problems);
        if (!dryRun) {
            for (const { record, next } of plans) {
                lock.signal.throwIfAborted();
                await writeAuthoredRecord(next, { expectedVersion: record.version, lock, root });
            }
        }
        return { changed: plans.map(({ record }) => record.id), unchanged };
    });
}

/** `photos describe --import <file> [--dry-run]`. Never throws: every outcome is an exit code and the text to print. */
export async function runDescribeImport(layer: LayerHandle, { file, dryRun = false }: { file: string; dryRun?: boolean }): Promise<CommandResult> {
    let text: string;
    try {
        text = await fs.promises.readFile(file, 'utf8');
    } catch (error) {
        return { exitCode: 1, output: `Error: ${file} can't be read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}). Nothing was written.\n` };
    }
    const parsed = parseDescriptions(text, formatOf(file, text));
    if (!parsed.ok) return { exitCode: 1, output: `${['Nothing was written, since the file has problems:', ...listed(parsed.errors.map((error) => `  ${error}`))].join('\n')}\n` };
    const status = dataRootStatus({ write: !dryRun, root: path.resolve(layer.dataRoot) });
    if (status.state !== 'ready') return { exitCode: 1, output: `Error: The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}. Nothing was written.\n` };
    try {
        const result = await importDescriptions(layer, parsed.rows, { dryRun });
        const verb = dryRun ? 'Would update' : 'Updated';
        const lines = [
            `${verb} ${result.changed.length} photo record${result.changed.length === 1 ? '' : 's'}, and ${result.unchanged} ${result.unchanged === 1 ? 'row changes' : 'rows change'} nothing.`,
            ...listed(result.changed.map((photoId) => `  ${photoId}`)),
        ];
        if (dryRun) lines.push('Nothing was written. Run it again without --dry-run to write it.');
        return { exitCode: 0, output: `${lines.join('\n')}\n` };
    } catch (error) {
        if (error instanceof ImportRefused) return { exitCode: 1, output: `${['Nothing was written:', ...listed(error.problems.map((problem) => `  ${problem}`))].join('\n')}\n` };
        if (error instanceof LockTimeoutError) return { exitCode: 3, output: `Error (authored-locked): ${error.message}\n` };
        if (error instanceof AuthoredWriteError) {
            const exitCode = error.code === 'VERSION_CONFLICT' || error.code === 'AUTHORED_LOCKED' ? 3 : 1;
            const issues = error.issues?.map((issue) => ` ${issue.path}: ${issue.message}`).join(';') ?? '';
            return { exitCode, output: `Error (${error.code}): ${error.message}${issues} Records written before it stay as written.\n` };
        }
        return { exitCode: 4, output: `Error: ${(error as Error).message}\n` };
    }
}
