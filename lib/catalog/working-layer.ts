import fs from 'node:fs';
import path from 'node:path';
import { PHOTO_ID_RE } from '../identity/ids';
import { CorruptDocumentError, EditedInPlaceError, MisnamedVersionError, readVersionedDocument } from '../storage/document';
import { hasErrorCode, pathExists } from '../storage/fsx';
import { parseActivePointer, parseAuthoredRecord, SERIES_ID_RE, type AuthoredKind } from './schema';
import type { ActivePointer, AuthoredPhoto, AuthoredSeries, AuthoredSite, RecordProblem, RecordProblemReason, WorkingLayer } from './types';

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

/**
 * Why a record's folder can't be read or written as the record, or null when
 * it can:
 * - its file in the old one-file layout (#28's `authored/site.json`, or
 *   `<id>.json` in its kind's folder) is still there. Reading only the folder
 *   would pass over that file, and a write would add a second copy beside it;
 * - the disk holds the folder under another name, as a case-insensitive disk
 *   finds `PH_…/` under `ph_…`. readWorkingLayer() reports that folder as
 *   misnamed, so reading or extending it here would disagree.
 *
 * - the folder is itself a symlink, dangling or not. readWorkingLayer()
 *   refuses one too: a link can alias another record's folder, so a write for
 *   one record would land in the other's, and a dangling one would read as no
 *   record at all. The data root itself may be a symlink.
 *
 * A symlink is named by its own name in its parent's listing, as
 * readWorkingLayer() finds it, not by its target's name. Anything else is
 * checked with the native realpath, which returns the name the disk holds on
 * APFS and Windows. glibc and musl return the name they're given, so off
 * macOS and Windows the spelling check is best effort.
 */
const SYMLINKED = 'is a symlink, and symlinked record folders aren\'t supported. Put the record\'s folder itself there, not a link to it (the data root itself may be a symlink)';

export async function recordFolderProblem(root: string, kind: AuthoredKind, id: string): Promise<string | null> {
    const dir = authoredRecordDir(root, kind, id);
    const relative = path.relative(root, dir).split(path.sep).join('/');
    if (await pathExists(`${dir}.json`)) {
        return `${relative}.json is in the old layout, which this build no longer reads: the data root's layout changed, and a record is now the folder `
            + `${relative}/, holding v<N>.json. Move the file there as its next version (v1.json in an empty folder) while no command runs`;
    }
    const name = path.basename(dir);
    let stored: string | undefined;
    try {
        if ((await fs.promises.lstat(dir)).isSymbolicLink()) {
            // realpath would give the target's name. The working layer goes by the link's own name in the listing.
            const names = await fs.promises.readdir(path.dirname(dir));
            if (names.includes(name)) return `${relative}/ ${SYMLINKED}`;
            stored = names.find((entry) => entry.toLowerCase() === name.toLowerCase());
        } else {
            // fs.promises.realpath is the native realpath, as the `--only` lookup in images:cleanup checks it.
            stored = path.basename(await fs.promises.realpath(dir));
        }
    } catch {
        // Missing, or unreadable, which the read itself reports.
        return null;
    }
    if (stored === undefined) return `${relative}/ isn't listed under that name in its folder, so the working layer doesn't read it. Name it ${JSON.stringify(name)}`;
    if (stored !== name) {
        return `${relative}/ is ${JSON.stringify(stored)} on disk, which the working layer reads as misnamed. Name it ${JSON.stringify(name)}`;
    }
    return null;
}

export type { RecordProblem, RecordProblemReason, WorkingLayer } from './types';

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
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return [];
        throw error;
    }
    const ids: string[] = [];
    // Dot-files are OS metadata.
    for (const entry of entries.filter(({ name }) => !name.startsWith('.')).sort((a, b) => compare(a.name, b.name))) {
        const { name } = entry;
        if (isRecordId(kind, name)) {
            if (entry.isSymbolicLink()) problems.push({ kind, id: name, reason: 'file-name', issues: [{ path: '', message: `the folder ${SYMLINKED}` }] });
            else ids.push(name);
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
    const siteFolder = await recordFolderProblem(root, 'site', 'site');
    const loadedSite = siteFolder === null
        ? await load(paths.site, 'site', 'site')
        : { problem: { kind: 'site' as const, id: 'site', reason: 'file-name' as const, issues: [{ path: '', message: siteFolder }] } };
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
    const folder = await recordFolderProblem(root, kind, id);
    if (folder !== null) throw new Error(`The ${kind} record ${id} can't be used: ${folder}`);
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
