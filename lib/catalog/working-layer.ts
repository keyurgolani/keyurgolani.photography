import fs from 'node:fs';
import path from 'node:path';
import { PHOTO_ID_RE } from '../identity/ids';
import { CorruptDocumentError, EditedInPlaceError, MisnamedVersionError, readVersionedDocument } from '../storage/document';
import { hasErrorCode } from '../storage/fsx';
import { parseActivePointer, parseAuthoredRecord, SERIES_ID_RE, type AuthoredKind, type SchemaIssue } from './schema';
import type { ActivePointer, AuthoredPhoto, AuthoredSeries, AuthoredSite } from './types';

/**
 * Read-only access to the authored working layer and the active pointer. Each
 * record is a version folder (lib/storage/document.ts): `authored/site/`,
 * `authored/series/<seriesId>/`, and `authored/photos/<photoId>/`, each read
 * from its newest `v<N>.json`. Any process may import this, the watcher
 * included. Writes go through working-layer-writer.ts, which nothing on the
 * read path imports.
 */

export function authoredPaths(root: string) {
    const dir = path.join(root, 'authored');
    return { dir, site: path.join(dir, 'site'), seriesDir: path.join(dir, 'series'), photosDir: path.join(dir, 'photos') };
}

/** Where catalog state lives. Only the CLI writes here; slice B's repository owns those writes. */
export function catalogPaths(root: string) {
    const dir = path.join(root, 'catalog');
    return {
        dir,
        active: path.join(dir, 'active.json'),
        revisionsDir: path.join(dir, 'revisions'),
        activationsDir: path.join(dir, 'activations'),
        candidatesDir: path.join(dir, 'candidates'),
        diagnosticsDir: path.join(dir, 'diagnostics'),
    };
}

/** Whether `id` can name a record of `kind`, which also keeps its folder inside its kind's folder. */
export function isRecordId(kind: AuthoredKind, id: string): boolean {
    if (kind === 'site') return id === 'site';
    return kind === 'series' ? SERIES_ID_RE.test(id) : PHOTO_ID_RE.test(id);
}

/** The version folder a record lives in. Throws for an ID that can't name one. */
export function authoredRecordDir(root: string, kind: AuthoredKind, id: string): string {
    if (!isRecordId(kind, id)) throw new Error(`Invalid ${kind} ID: ${JSON.stringify(id)}`);
    const paths = authoredPaths(root);
    if (kind === 'site') return paths.site;
    return path.join(kind === 'series' ? paths.seriesDir : paths.photosDir, id);
}

export type RecordProblemReason = 'unreadable' | 'invalid-json' | 'unknown-schema-version' | 'invalid' | 'file-name' | 'edited-in-place';

/** A working-layer record that isn't usable. It names the record, never a path. */
export interface RecordProblem {
    kind: AuthoredKind;
    /** The record ID its folder name gives, or `site`. */
    id: string;
    reason: RecordProblemReason;
    issues: SchemaIssue[];
}

/** One snapshot of the working layer. Unusable records are left out and listed in `problems`. */
export interface WorkingLayer {
    site: AuthoredSite | null;
    /** Sorted by ID. */
    series: AuthoredSeries[];
    /** Sorted by ID. */
    photos: AuthoredPhoto[];
    /** Sorted by kind, then ID. */
    problems: RecordProblem[];
}

type RecordOf<K extends AuthoredKind> = K extends 'site' ? AuthoredSite : K extends 'series' ? AuthoredSeries : AuthoredPhoto;

type Loaded<K extends AuthoredKind> = { record: RecordOf<K> } | { problem: RecordProblem } | null;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** How many records are read at once. */
const READ_CONCURRENCY = 64;

async function load<K extends AuthoredKind>(dir: string, kind: K, id: string): Promise<Loaded<K>> {
    const problem = (reason: RecordProblemReason, message: string) => ({ problem: { kind, id, reason, issues: [{ path: '', message }] } });
    let stored: Awaited<ReturnType<typeof readVersionedDocument>>;
    try {
        stored = await readVersionedDocument(dir);
    } catch (error) {
        if (error instanceof EditedInPlaceError) {
            const { version } = error;
            return problem(
                'edited-in-place',
                `v${version}.json was edited in place. To keep the edit, copy it to the next number while no command runs (cp -n v${version}.json v${version + 1}.json)`,
            );
        }
        if (error instanceof MisnamedVersionError) return problem('file-name', `${path.basename(error.file)} looks like a version but isn't named v<N>.json`);
        if (error instanceof CorruptDocumentError) return problem('invalid-json', 'the newest version is not a JSON object');
        const code = (error as NodeJS.ErrnoException).code;
        return problem('unreadable', code ? `the record can't be read (${code})` : `the record can't be read: ${(error as Error).message}`);
    }
    if (stored === null) return null;
    const parsed = parseAuthoredRecord(kind, stored.value);
    if (!parsed.ok) {
        const reason = parsed.error.reason === 'unknown-schema-version' ? 'unknown-schema-version' : 'invalid';
        return { problem: { kind, id, reason, issues: parsed.error.issues } };
    }
    const record = parsed.value as RecordOf<K>;
    if (kind !== 'site' && (record as AuthoredSeries | AuthoredPhoto).id !== id) {
        const message = `the record's id is ${JSON.stringify((record as AuthoredSeries | AuthoredPhoto).id)}, but its folder is named for ${JSON.stringify(id)}`;
        return { problem: { kind, id, reason: 'file-name', issues: [{ path: 'id', message }] } };
    }
    return { record };
}

/**
 * Why a name in a kind's folder, which a person or a case-insensitive disk
 * could mean as a record, can't be read as one: an ID in another case, or a
 * file in the old `<id>.json` layout. Null for anything else.
 */
function misnamedRecord(kind: 'series' | 'photo', name: string): string | null {
    const bare = name.replace(/\.json$/i, '');
    if (bare !== name) return isRecordId(kind, bare.toLowerCase()) ? 'a record is a folder holding v<N>.json, not a .json file' : null;
    return isRecordId(kind, name.toLowerCase()) ? 'a record folder is named for its ID, in lower case' : null;
}

async function loadFolder<K extends 'series' | 'photo'>(dir: string, kind: K, problems: RecordProblem[]): Promise<RecordOf<K>[]> {
    let names: string[];
    try {
        names = await fs.promises.readdir(dir);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return [];
        throw error;
    }
    const ids: string[] = [];
    // Dot-files are OS metadata.
    for (const name of names.filter((entry) => !entry.startsWith('.')).sort(compare)) {
        if (isRecordId(kind, name)) {
            ids.push(name);
            continue;
        }
        const misnamed = misnamedRecord(kind, name);
        if (misnamed) problems.push({ kind, id: name, reason: 'file-name', issues: [{ path: '', message: misnamed }] });
    }
    const loaded: Loaded<K>[] = new Array<Loaded<K>>(ids.length);
    for (let start = 0; start < ids.length; start += READ_CONCURRENCY) {
        await Promise.all(ids.slice(start, start + READ_CONCURRENCY).map(async (id, offset) => {
            loaded[start + offset] = await load(path.join(dir, id), kind, id);
        }));
    }
    const records: RecordOf<K>[] = [];
    for (const entry of loaded) {
        if (entry === null) continue;
        if ('problem' in entry) problems.push(entry.problem);
        else records.push(entry.record);
    }
    return records.sort((a, b) => compare(a.id, b.id));
}

/** Read every authored record. A missing `authored/` reads as an empty working layer. */
export async function readWorkingLayer(root: string): Promise<WorkingLayer> {
    const paths = authoredPaths(root);
    const problems: RecordProblem[] = [];
    const loadedSite = await load(paths.site, 'site', 'site');
    let site: AuthoredSite | null = null;
    if (loadedSite && 'problem' in loadedSite) problems.push(loadedSite.problem);
    else if (loadedSite) site = loadedSite.record;
    const series = await loadFolder(paths.seriesDir, 'series', problems);
    const photos = await loadFolder(paths.photosDir, 'photo', problems);
    problems.sort((a, b) => compare(a.kind, b.kind) || compare(a.id, b.id));
    return { site, series, photos, problems };
}

/** Read one record, or null when it doesn't exist. Throws when it exists but can't be used. */
export async function readAuthoredRecord<K extends AuthoredKind>(root: string, kind: K, id: string): Promise<RecordOf<K> | null> {
    if (!isRecordId(kind, id)) return null;
    const loaded = await load(authoredRecordDir(root, kind, id), kind, id);
    if (loaded === null) return null;
    if ('problem' in loaded) throw new Error(`The ${kind} record ${id} can't be used: ${loaded.problem.issues.map((issue) => issue.message).join('; ')}`);
    return loaded.record;
}

/** `catalog/active.json`, or null before the first activation. Throws when it exists but isn't valid. */
export async function readActivePointer(root: string): Promise<ActivePointer | null> {
    let text: string;
    try {
        text = await fs.promises.readFile(catalogPaths(root).active, 'utf8');
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return null;
        throw error;
    }
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new Error('catalog/active.json is not valid JSON');
    }
    const parsed = parseActivePointer(value);
    if (!parsed.ok) throw new Error(`catalog/active.json is not a valid active pointer: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
    return parsed.value;
}
