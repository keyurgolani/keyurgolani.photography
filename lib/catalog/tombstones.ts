import fs from 'node:fs';
import path from 'node:path';
import { ASSET_REVISION_RE, PHOTO_ID_RE } from '../identity/ids';
import { hasErrorCode } from '../storage/fsx';

/**
 * #15's tombstones, the read side (#181's A10). A tombstone is the logged
 * takedown `photos purge --yes` writes under the catalog lock, as
 * `catalog/tombstones/<tombstoneId>.json`. It names a photo and the asset
 * revisions it takes down, so `/media` answers 410 for every set under
 * them, `assets.tombstoned` stops any revision that shows one from being
 * published or rolled back to, and after its 7-day grace `photos gc --apply`
 * may delete their folders under `assets/`, within #15's limits.
 *
 * Beside it, `<tombstoneId>.revoked.json` is the undo `photos purge --revoke`
 * writes during the grace, after which nothing here counts the tombstone,
 * and `<tombstoneId>.collected.json` is the marker GC writes before it
 * deletes the first byte a tombstone lists, after which a revoke is refused.
 * Every file is created whole by a hard link and never rewritten.
 *
 * This module only reads. The web process imports it for `/media`, and the
 * rule engine for `assets.tombstoned`, so it must never reach purge.ts or
 * retention.ts, the only writers (retentionBoundary.test.ts). It never
 * reads the library.
 */

/** `tomb_` plus a v4 UUID. */
export const TOMBSTONE_ID_RE = /^tomb_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** How long a tombstone stands before GC may delete what it lists: 7 days, GC_GRACE_MS. */
export const TOMBSTONE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** A tombstone file is a few hundred bytes. Anything far larger is not one. */
const MAX_FILE_BYTES = 256 * 1024;

export interface Tombstone {
    tombstoneId: string;
    photoId: string;
    /** The one asset revision `--asset-revision` named, or null for the whole photo. */
    assetRevision: string | null;
    /** Every asset revision it takes down: the one named, or every one the registry held when it was written. */
    assetRevisions: string[];
    actor: string;
    reason: string;
    createdAt: string;
}

export interface TombstoneRevoke {
    tombstoneId: string;
    actor: string;
    reason: string;
    createdAt: string;
}

/** GC's marker, written before its first delete for the tombstone. */
export interface TombstoneCollected {
    tombstoneId: string;
    planDigest: string;
    startedAt: string;
    /** The asset folders the run planned to delete for it, relative to the data root. */
    paths: string[];
}

export interface TombstoneEntry extends Tombstone {
    revoked: TombstoneRevoke | null;
    collected: TombstoneCollected | null;
}

export type TombstoneProblemReason = 'unreadable' | 'not-a-file' | 'not-a-folder' | 'too-large' | 'invalid-json' | 'invalid' | 'file-name' | 'orphan';

/** A file or the folder that couldn't be read as what its name says. `file` is relative to the data root. */
export interface TombstoneProblem {
    file: string;
    reason: TombstoneProblemReason;
    detail: string;
}

export interface TombstoneRead {
    /** Sorted by createdAt, then ID. */
    tombstones: TombstoneEntry[];
    problems: TombstoneProblem[];
}

export const TOMBSTONES_DIR = 'catalog/tombstones';

export function tombstonesDir(root: string): string {
    return path.join(/*turbopackIgnore: true*/ root, 'catalog', 'tombstones');
}

function checkedId(tombstoneId: string): string {
    if (!TOMBSTONE_ID_RE.test(tombstoneId)) throw new TypeError(`${JSON.stringify(tombstoneId)} is not a tombstone ID.`);
    return tombstoneId;
}

export const tombstoneFile = (root: string, tombstoneId: string) => path.join(/*turbopackIgnore: true*/ tombstonesDir(root), `${checkedId(tombstoneId)}.json`);
export const revokeFile = (root: string, tombstoneId: string) => path.join(/*turbopackIgnore: true*/ tombstonesDir(root), `${checkedId(tombstoneId)}.revoked.json`);
export const collectedFile = (root: string, tombstoneId: string) => path.join(/*turbopackIgnore: true*/ tombstonesDir(root), `${checkedId(tombstoneId)}.collected.json`);

type FileKind = 'tombstone' | 'revoked' | 'collected';

const NAME_RE = /^(tomb_[^.]*)(\.revoked|\.collected)?\.json$/;

/** What a name in the folder is, or null for one this module doesn't make. Dot-files are temp files and OS metadata. */
function classify(name: string): { id: string; kind: FileKind } | null | 'skip' {
    if (name.startsWith('.')) return 'skip';
    const match = NAME_RE.exec(name);
    if (!match || !TOMBSTONE_ID_RE.test(match[1])) return null;
    return { id: match[1], kind: match[2] === '.revoked' ? 'revoked' : match[2] === '.collected' ? 'collected' : 'tombstone' };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasExactly = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => key in value);
const isText = (value: unknown): value is string => typeof value === 'string' && /\S/.test(value);
const isTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

const TOMBSTONE_KEYS = ['tombstoneId', 'photoId', 'assetRevision', 'assetRevisions', 'actor', 'reason', 'createdAt'] as const;
const REVOKE_KEYS = ['tombstoneId', 'actor', 'reason', 'createdAt'] as const;
const COLLECTED_KEYS = ['tombstoneId', 'planDigest', 'startedAt', 'paths'] as const;

/** `value` as the tombstone named `id`, or why it isn't one. */
export function parseTombstone(value: unknown, id: string): Tombstone | string {
    if (!isObject(value) || !hasExactly(value, TOMBSTONE_KEYS)) return `it doesn't have exactly the fields ${TOMBSTONE_KEYS.join(', ')}`;
    if (value.tombstoneId !== id) return `it holds ${String(value.tombstoneId)}`;
    if (typeof value.photoId !== 'string' || !PHOTO_ID_RE.test(value.photoId)) return 'photoId is not a photo ID';
    if (value.assetRevision !== null && (typeof value.assetRevision !== 'string' || !ASSET_REVISION_RE.test(value.assetRevision))) return 'assetRevision is not an asset revision or null';
    const revisions = value.assetRevisions;
    if (!Array.isArray(revisions) || revisions.length === 0 || !revisions.every((entry) => typeof entry === 'string' && ASSET_REVISION_RE.test(entry))) return 'assetRevisions is not a list of asset revisions';
    if (new Set(revisions).size !== revisions.length) return 'assetRevisions lists one twice';
    if (value.assetRevision !== null && (revisions.length !== 1 || revisions[0] !== value.assetRevision)) return 'assetRevisions is not the one assetRevision names';
    if (!isText(value.actor) || !isText(value.reason)) return 'actor or reason is empty';
    if (!isTime(value.createdAt)) return 'createdAt is not a time';
    return value as unknown as Tombstone;
}

export function parseRevoke(value: unknown, id: string): TombstoneRevoke | string {
    if (!isObject(value) || !hasExactly(value, REVOKE_KEYS)) return `it doesn't have exactly the fields ${REVOKE_KEYS.join(', ')}`;
    if (value.tombstoneId !== id) return `it holds ${String(value.tombstoneId)}`;
    if (!isText(value.actor) || !isText(value.reason)) return 'actor or reason is empty';
    if (!isTime(value.createdAt)) return 'createdAt is not a time';
    return value as unknown as TombstoneRevoke;
}

export function parseCollected(value: unknown, id: string): TombstoneCollected | string {
    if (!isObject(value) || !hasExactly(value, COLLECTED_KEYS)) return `it doesn't have exactly the fields ${COLLECTED_KEYS.join(', ')}`;
    if (value.tombstoneId !== id) return `it holds ${String(value.tombstoneId)}`;
    if (typeof value.planDigest !== 'string' || !isTime(value.startedAt)) return 'planDigest or startedAt is missing';
    if (!Array.isArray(value.paths) || !value.paths.every((entry) => typeof entry === 'string')) return 'paths is not a list';
    return value as unknown as TombstoneCollected;
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code ?? 'an I/O error';

/** One name's contents as read, or why it couldn't be. */
type Loaded = { value: unknown } | { problem: Omit<TombstoneProblem, 'file'> };

/** How one file reads: a regular file, small, valid JSON. Shared by the sync and async readers. */
function loadedFrom(stat: () => fs.Stats, read: () => string): Loaded | null {
    let info: fs.Stats;
    try {
        info = stat();
    } catch (error) {
        // Gone since the listing.
        if (hasErrorCode(error, 'ENOENT')) return null;
        return { problem: { reason: 'unreadable', detail: `it can't be read (${errorCode(error)})` } };
    }
    if (!info.isFile()) return { problem: { reason: 'not-a-file', detail: 'it is not a regular file' } };
    if (info.size > MAX_FILE_BYTES) return { problem: { reason: 'too-large', detail: `it is ${info.size} bytes, too large for one` } };
    let text: string;
    try {
        text = read();
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return null;
        return { problem: { reason: 'unreadable', detail: `it can't be read (${errorCode(error)})` } };
    }
    try {
        return { value: JSON.parse(text) as unknown };
    } catch {
        return { problem: { reason: 'invalid-json', detail: 'it is not valid JSON' } };
    }
}

/** The folder's listing as tombstones, their revokes and their GC markers, every name it can't use a problem. */
function assemble(names: readonly string[], load: (name: string) => Loaded | null): TombstoneRead {
    const problems: TombstoneProblem[] = [];
    const found = new Map<string, Partial<Record<FileKind, unknown>>>();
    for (const name of [...names].sort()) {
        const file = `${TOMBSTONES_DIR}/${name}`;
        const kind = classify(name);
        if (kind === 'skip') continue;
        if (kind === null) {
            problems.push({ file, reason: 'file-name', detail: 'it is not named as a tombstone, a revoke, or a GC marker' });
            continue;
        }
        const loaded = load(name);
        if (loaded === null) continue;
        if ('problem' in loaded) {
            problems.push({ file, ...loaded.problem });
            continue;
        }
        const parse = kind.kind === 'tombstone' ? parseTombstone : kind.kind === 'revoked' ? parseRevoke : parseCollected;
        const parsed = parse(loaded.value, kind.id);
        if (typeof parsed === 'string') {
            problems.push({ file, reason: 'invalid', detail: parsed });
            continue;
        }
        found.set(kind.id, { ...found.get(kind.id), [kind.kind]: parsed });
    }
    const tombstones: TombstoneEntry[] = [];
    for (const [id, files] of found) {
        if (!files.tombstone) {
            // A revoke or a marker with no tombstone: someone removed it, so nobody can tell what it listed.
            problems.push({ file: `${TOMBSTONES_DIR}/${id}.json`, reason: 'orphan', detail: 'its revoke or GC marker is there, but the tombstone is not' });
            continue;
        }
        tombstones.push({
            ...(files.tombstone as Tombstone),
            revoked: (files.revoked as TombstoneRevoke | undefined) ?? null,
            collected: (files.collected as TombstoneCollected | undefined) ?? null,
        });
    }
    tombstones.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.tombstoneId < b.tombstoneId ? -1 : 1));
    problems.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    return { tombstones, problems };
}

function folderProblem(error: unknown): TombstoneRead {
    if (hasErrorCode(error, 'ENOTDIR')) return { tombstones: [], problems: [{ file: TOMBSTONES_DIR, reason: 'not-a-folder', detail: 'it is not a folder' }] };
    return { tombstones: [], problems: [{ file: TOMBSTONES_DIR, reason: 'unreadable', detail: `the folder can't be listed (${errorCode(error)})` }] };
}

/**
 * Every tombstone in the data root, with its revoke and GC marker, and every
 * file there that can't be read as one. A missing folder is no tombstones.
 * A folder that is a symlink is a problem, since GC must not reason about
 * a folder somewhere else. Never throws for what it finds on disk.
 */
export async function readTombstones(root: string): Promise<TombstoneRead> {
    const dir = tombstonesDir(root);
    let names: string[];
    try {
        if ((await fs.promises.lstat(dir)).isSymbolicLink()) return { tombstones: [], problems: [{ file: TOMBSTONES_DIR, reason: 'not-a-folder', detail: 'it is a symlink' }] };
        names = await fs.promises.readdir(dir);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return { tombstones: [], problems: [] };
        return folderProblem(error);
    }
    const loads = new Map<string, Loaded | null>();
    await Promise.all(names.filter((name) => classify(name) !== 'skip' && classify(name) !== null).map(async (name) => {
        const file = path.join(dir, name);
        let stat: fs.Stats | null = null;
        let text = '';
        let failure: unknown = null;
        try {
            stat = await fs.promises.lstat(file);
            if (stat.isFile() && stat.size <= MAX_FILE_BYTES) text = await fs.promises.readFile(file, 'utf8');
        } catch (error) {
            failure = error;
        }
        loads.set(name, loadedFrom(
            () => {
                if (stat === null) throw failure;
                return stat;
            },
            () => {
                if (failure !== null) throw failure;
                return text;
            },
        ));
    }));
    return assemble(names, (name) => loads.get(name) ?? null);
}

/** readTombstones(), synchronously, for `assets.tombstoned`: rules run synchronously. */
export function readTombstonesSync(root: string): TombstoneRead {
    const dir = tombstonesDir(root);
    let names: string[];
    try {
        if (fs.lstatSync(dir).isSymbolicLink()) return { tombstones: [], problems: [{ file: TOMBSTONES_DIR, reason: 'not-a-folder', detail: 'it is a symlink' }] };
        names = fs.readdirSync(dir);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return { tombstones: [], problems: [] };
        return folderProblem(error);
    }
    return assemble(names, (name) => loadedFrom(() => fs.lstatSync(path.join(dir, name)), () => fs.readFileSync(path.join(dir, name), 'utf8')));
}

/** Whether a tombstone counts: one that was revoked takes nothing down and lets GC delete nothing. */
export const isStanding = (entry: TombstoneEntry) => entry.revoked === null;

/** The standing tombstones that list `photoId` at `assetRevision`. */
export function standingFor(read: Pick<TombstoneRead, 'tombstones'>, photoId: string, assetRevision: string): TombstoneEntry[] {
    return read.tombstones.filter((entry) => isStanding(entry) && entry.photoId === photoId && entry.assetRevisions.includes(assetRevision));
}

/** When GC may first delete what `entry` lists: more than 7 days after it was written. */
export const graceEndsMs = (entry: Pick<Tombstone, 'createdAt'>) => Date.parse(entry.createdAt) + TOMBSTONE_GRACE_MS;

/** A problem as one line, for a message. */
export const problemText = (problem: TombstoneProblem) => `${problem.file}: ${problem.detail}`;

const keyOf = (photoId: string, assetRevision: string) => `${photoId}/${assetRevision}`;

/** A folder change this recent may hide another in the same mtime tick, so the folder is read again. */
const RACY_MS = 2_000;

export interface TombstoneIndexOptions {
    /** The data root for this request, or null when there is none. */
    root(): string | null;
    logger?: Pick<Console, 'warn'>;
    clock?: () => number;
}

/**
 * `isTombstoned()` for `/media`: whether a standing tombstone lists the
 * set's photo at its asset revision. It keeps the last read and reads the
 * folder again whenever its identity or mtime changes, so `web` sees a purge
 * or a revoke from `tools` on its next request. A change in the last 2 s is
 * read again on each request, so two changes in one mtime tick aren't
 * missed. A file it can't read is logged and passed over: a set no standing
 * tombstone lists falls through to the active revision's policy, which 404s
 * every set the live revision doesn't hold, and purge refuses those it does.
 */
export function createTombstoneIndex(options: TombstoneIndexOptions): (ref: { photoId: string; assetRevision: string }) => Promise<boolean> {
    const { logger = console, clock = Date.now } = options;
    let cached: { signature: string; mtimeMs: number; keys: Set<string> } | null = null;
    let warned = '';

    async function standing(root: string): Promise<Set<string>> {
        let signature: string;
        let mtimeMs = 0;
        try {
            const stat = await fs.promises.stat(tombstonesDir(root));
            mtimeMs = stat.mtimeMs;
            signature = `${root}\0${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) {
                cached = { signature: `${root}\0none`, mtimeMs: 0, keys: new Set() };
                return cached.keys;
            }
            // Keep what was last read for this root rather than serve as if nothing were taken down.
            logger.warn(`[media] Could not read ${TOMBSTONES_DIR} (${errorCode(error)}), so the last tombstones read stand.`);
            return cached?.signature.startsWith(`${root}\0`) ? cached.keys : new Set();
        }
        if (cached?.signature === signature && clock() - cached.mtimeMs > RACY_MS) return cached.keys;
        const read = await readTombstones(root);
        const keys = new Set<string>();
        for (const entry of read.tombstones) {
            if (!isStanding(entry)) continue;
            for (const assetRevision of entry.assetRevisions) keys.add(keyOf(entry.photoId, assetRevision));
        }
        const problems = read.problems.map(problemText).join('; ');
        if (problems && problems !== warned) logger.warn(`[media] Passed over what can't be read in ${TOMBSTONES_DIR}: ${problems}.`);
        warned = problems;
        cached = { signature, mtimeMs, keys };
        return keys;
    }

    return async ({ photoId, assetRevision }) => {
        const root = options.root();
        if (root === null) return false;
        return (await standing(root)).has(keyOf(photoId, assetRevision));
    };
}
