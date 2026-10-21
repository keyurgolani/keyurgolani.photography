import fs from 'node:fs';
import path from 'node:path';
import { PHOTO_ID_RE } from '../identity/ids';
import { hasErrorCode } from '../storage/fsx';
import { parseActivePointer, parseAuthoredRecord, SERIES_ID_RE, type AuthoredKind } from './schema';
import type { ActivePointer, AuthoredPhoto, AuthoredSeries, AuthoredSite, RecordProblem, WorkingLayer } from './types';

/**
 * Read-only access to the authored working layer (`authored/site.json`,
 * `authored/series/<seriesId>.json`, `authored/photos/<photoId>.json`) and the
 * active pointer. Any process may import this, the watcher included. Writes
 * go through working-layer-writer.ts, which nothing on the read path imports.
 */

export function authoredPaths(root: string) {
    const dir = path.join(root, 'authored');
    return { dir, site: path.join(dir, 'site.json'), seriesDir: path.join(dir, 'series'), photosDir: path.join(dir, 'photos') };
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

/** Whether `id` can name a record of `kind`, which also keeps its file inside its folder. */
export function isRecordId(kind: AuthoredKind, id: string): boolean {
    if (kind === 'site') return id === 'site';
    return kind === 'series' ? SERIES_ID_RE.test(id) : PHOTO_ID_RE.test(id);
}

/** The file a record lives in. Throws for an ID that can't name one. */
export function authoredRecordFile(root: string, kind: AuthoredKind, id: string): string {
    if (!isRecordId(kind, id)) throw new Error(`Invalid ${kind} ID: ${JSON.stringify(id)}`);
    const paths = authoredPaths(root);
    if (kind === 'site') return paths.site;
    return path.join(kind === 'series' ? paths.seriesDir : paths.photosDir, `${id}.json`);
}

export type { RecordProblem, RecordProblemReason, WorkingLayer } from './types';

type RecordOf<K extends AuthoredKind> = K extends 'site' ? AuthoredSite : K extends 'series' ? AuthoredSeries : AuthoredPhoto;

type Loaded<K extends AuthoredKind> = { record: RecordOf<K> } | { problem: RecordProblem } | null;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

async function load<K extends AuthoredKind>(file: string, kind: K, id: string): Promise<Loaded<K>> {
    let text: string;
    try {
        text = await fs.promises.readFile(/*turbopackIgnore: true*/ file, 'utf8');
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return null;
        const code = (error as NodeJS.ErrnoException).code ?? 'an I/O error';
        return { problem: { kind, id, reason: 'unreadable', issues: [{ path: '', message: `the file can't be read (${code})` }] } };
    }
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return { problem: { kind, id, reason: 'invalid-json', issues: [{ path: '', message: 'the file is not valid JSON' }] } };
    }
    const parsed = parseAuthoredRecord(kind, value);
    if (!parsed.ok) {
        const reason = parsed.error.reason === 'unknown-schema-version' ? 'unknown-schema-version' : 'invalid';
        return { problem: { kind, id, reason, issues: parsed.error.issues } };
    }
    const record = parsed.value as RecordOf<K>;
    if (kind !== 'site' && (record as AuthoredSeries | AuthoredPhoto).id !== id) {
        const message = `the record's id is ${JSON.stringify((record as AuthoredSeries | AuthoredPhoto).id)}, but its file is named for ${JSON.stringify(id)}`;
        return { problem: { kind, id, reason: 'file-name', issues: [{ path: 'id', message }] } };
    }
    return { record };
}

async function loadFolder<K extends 'series' | 'photo'>(dir: string, kind: K, problems: RecordProblem[]): Promise<RecordOf<K>[]> {
    let names: string[];
    try {
        names = await fs.promises.readdir(/*turbopackIgnore: true*/ dir);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return [];
        throw error;
    }
    const records: RecordOf<K>[] = [];
    // Dot-files are temp files from an interrupted atomic write, or OS metadata.
    for (const name of names.filter((entry) => !entry.startsWith('.') && entry.endsWith('.json')).sort(compare)) {
        const loaded = await load(path.join(dir, name), kind, name.slice(0, -'.json'.length));
        if (loaded === null) continue;
        if ('problem' in loaded) problems.push(loaded.problem);
        else records.push(loaded.record);
    }
    return records;
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

/** Every authored series, sorted by ID, without reading the photo records. Unusable files are listed in `problems`. */
export async function readAuthoredSeries(root: string): Promise<{ series: AuthoredSeries[]; problems: RecordProblem[] }> {
    const problems: RecordProblem[] = [];
    const series = await loadFolder(authoredPaths(root).seriesDir, 'series', problems);
    return { series, problems };
}

/** Read one record, or null when it doesn't exist. Throws when it exists but can't be used. */
export async function readAuthoredRecord<K extends AuthoredKind>(root: string, kind: K, id: string): Promise<RecordOf<K> | null> {
    if (!isRecordId(kind, id)) return null;
    const loaded = await load(authoredRecordFile(root, kind, id), kind, id);
    if (loaded === null) return null;
    if ('problem' in loaded) throw new Error(`The ${kind} record ${id} can't be used: ${loaded.problem.issues.map((issue) => issue.message).join('; ')}`);
    return loaded.record;
}

/** `catalog/active.json`, or null before the first activation. Throws when it exists but isn't valid. */
export async function readActivePointer(root: string): Promise<ActivePointer | null> {
    let text: string;
    try {
        text = await fs.promises.readFile(/*turbopackIgnore: true*/ catalogPaths(root).active, 'utf8');
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
