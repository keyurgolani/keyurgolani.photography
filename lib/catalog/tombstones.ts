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
 * writes, after which nothing here counts the tombstone, and
 * `<tombstoneId>.collected.<digest-prefix>.json` is the marker each
 * `photos gc --apply` run writes before its first delete: every exact folder
 * that run will delete for the tombstone, with its bytes, newest change and
 * every file by name and size. A revoke is refused once one of those
 * folders is gone and not set aside whole, or one of its recorded files is
 * missing or shorter than recorded, and only then. Every file is created whole by a hard link and never rewritten.
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

/**
 * When restore stops being possible, in the same words wherever purge, GC and
 * the docs say it: revoke works until `photos gc --apply` deletes a listed
 * folder, and after that the takedown is permanent. A folder set aside whole
 * isn't deleted: setAsideText() says how to bring it back.
 */
export const PERMANENT_TEXT = 'Once photos gc --apply has deleted a folder a tombstone lists, that takedown is permanent: the revisions that show it can never be rolled back to, and only a backup of the data root brings it back.';

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

/** One folder a GC run will delete for a tombstone, as the run's plan saw it. */
export interface CollectedPath {
    /** `assets/<photoId>/<assetRevision>`, relative to the data root. */
    path: string;
    /** The bytes its manifests list. */
    bytes: number;
    /** The newest change in it, in ms. */
    newestMs: number;
    /** Every file in it, its manifests included, as `<profileId>/<name>` with its size. */
    files: { name: string; bytes: number }[];
}

/** One GC run's marker, written before that run's first delete for the tombstone. */
export interface TombstoneCollected {
    tombstoneId: string;
    planDigest: string;
    startedAt: string;
    /** Every folder the run will delete for it, each exactly as planned. */
    paths: CollectedPath[];
}

export interface TombstoneEntry extends Tombstone {
    revoked: TombstoneRevoke | null;
    /** Every GC run's marker for it, oldest first. Empty until a run began deleting what it lists. */
    collected: TombstoneCollected[];
    /** The tombstone file's ctime, in ms: the grace starts no earlier than this, whatever createdAt says. */
    ctimeMs: number;
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
/** `gc_` plus 64 hex, a GC plan's digest. */
const PLAN_DIGEST_RE = /^gc_[0-9a-f]{64}$/;

/** The part of a plan digest a marker's name carries. */
export const digestPrefix = (planDigest: string) => {
    if (!PLAN_DIGEST_RE.test(planDigest)) throw new TypeError(`${JSON.stringify(planDigest)} is not a plan digest.`);
    return planDigest.slice(3, 19);
};

export const collectedFile = (root: string, tombstoneId: string, planDigest: string) => path.join(/*turbopackIgnore: true*/ tombstonesDir(root), `${checkedId(tombstoneId)}.collected.${digestPrefix(planDigest)}.json`);

type FileKind = 'tombstone' | 'revoked' | 'collected';

const NAME_RE = /^(tomb_[^.]*)(?:\.(revoked)|\.collected\.([0-9a-f]{16}))?\.json$/;

/** What a name in the folder is, or null for one this module doesn't make. Dot-files are temp files and OS metadata. */
function classify(name: string): { id: string; kind: FileKind; prefix?: string } | null | 'skip' {
    if (name.startsWith('.')) return 'skip';
    const match = NAME_RE.exec(name);
    if (!match || !TOMBSTONE_ID_RE.test(match[1])) return null;
    if (match[2]) return { id: match[1], kind: 'revoked' };
    if (match[3]) return { id: match[1], kind: 'collected', prefix: match[3] };
    return { id: match[1], kind: 'tombstone' };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasExactly = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => key in value);
const isText = (value: unknown): value is string => typeof value === 'string' && /\S/.test(value);
/**
 * Strict ISO-8601 in UTC with Z, as toISOString() writes it, and a real
 * date: no date alone, no offset, no space, and no 30 February. A looser one
 * could start the grace somewhere else than it reads.
 */
const STRICT_TIME_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;
export function isStrictTime(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const match = STRICT_TIME_RE.exec(value);
    if (!match) return false;
    const ms = Date.parse(value);
    return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 19) === match[1];
}
const isTime = isStrictTime;

/** `assets/<photoId>/<assetRevision>`, the one shape a marker's path may take. */
const ASSET_FOLDER_RE = /^assets\/([^/]+)\/([^/]+)$/;
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

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
    if (!isTime(value.createdAt)) return 'createdAt is not a strict ISO-8601 time in UTC, such as 2026-12-02T10:00:00.000Z';
    return value as unknown as Tombstone;
}

export function parseRevoke(value: unknown, id: string): TombstoneRevoke | string {
    if (!isObject(value) || !hasExactly(value, REVOKE_KEYS)) return `it doesn't have exactly the fields ${REVOKE_KEYS.join(', ')}`;
    if (value.tombstoneId !== id) return `it holds ${String(value.tombstoneId)}`;
    if (!isText(value.actor) || !isText(value.reason)) return 'actor or reason is empty';
    if (!isTime(value.createdAt)) return 'createdAt is not a strict ISO-8601 time in UTC';
    return value as unknown as TombstoneRevoke;
}

const PATH_KEYS = ['path', 'bytes', 'newestMs', 'files'] as const;
const FILE_KEYS = ['name', 'bytes'] as const;
/** `<profileId>/<name>`, a file in a set. */
const SET_FILE_RE = /^(p_[0-9a-f]{16})\/([a-z0-9]+\.[a-z0-9]+)$/;

/**
 * `value` as GC's marker for tombstone `id` from the run whose digest starts
 * `prefix`, or why it isn't one. Each path must be an asset folder by shape,
 * `assets/<photoId>/<assetRevision>`, so a marker can never name anything
 * else for revoke to look at; assemble() checks it is one the tombstone lists.
 */
export function parseCollected(value: unknown, id: string, prefix?: string): TombstoneCollected | string {
    if (!isObject(value) || !hasExactly(value, COLLECTED_KEYS)) return `it doesn't have exactly the fields ${COLLECTED_KEYS.join(', ')}`;
    if (value.tombstoneId !== id) return `it holds ${String(value.tombstoneId)}`;
    if (typeof value.planDigest !== 'string' || !PLAN_DIGEST_RE.test(value.planDigest)) return 'planDigest is not a plan digest';
    if (prefix !== undefined && value.planDigest.slice(3, 19) !== prefix) return `planDigest is not the run its name says, ${prefix}`;
    if (!isTime(value.startedAt)) return 'startedAt is not a strict ISO-8601 time in UTC';
    const paths = value.paths;
    if (!Array.isArray(paths) || paths.length === 0) return 'paths is not a list of folders';
    for (const entry of paths) {
        if (!isObject(entry) || !hasExactly(entry, PATH_KEYS) || !isCount(entry.bytes) || !isCount(entry.newestMs) || !Array.isArray(entry.files)) return 'a path is not {path, bytes, newestMs, files}';
        for (const file of entry.files) {
            if (!isObject(file) || !hasExactly(file, FILE_KEYS) || typeof file.name !== 'string' || !SET_FILE_RE.test(file.name) || !isCount(file.bytes)) return `a file of ${String(entry.path)} is not {name: <profileId>/<file>, bytes}`;
        }
        const match = typeof entry.path === 'string' ? ASSET_FOLDER_RE.exec(entry.path) : null;
        if (!match || !PHOTO_ID_RE.test(match[1]) || !ASSET_REVISION_RE.test(match[2])) return `${JSON.stringify(entry.path)} is not an asset folder, assets/<photoId>/<assetRevision>`;
    }
    if (new Set(paths.map((entry) => (entry as CollectedPath).path)).size !== paths.length) return 'paths lists a folder twice';
    return value as unknown as TombstoneCollected;
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code ?? 'an I/O error';

/** One name's contents as read, with its ctime, or why it couldn't be. */
type Loaded = { value: unknown; ctimeMs: number } | { problem: Omit<TombstoneProblem, 'file'> };

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
        return { value: JSON.parse(text) as unknown, ctimeMs: info.ctimeMs };
    } catch {
        return { problem: { reason: 'invalid-json', detail: 'it is not valid JSON' } };
    }
}

/** The folder's listing as tombstones, their revokes and their GC markers, every name it can't use a problem. */
function assemble(names: readonly string[], load: (name: string) => Loaded | null): TombstoneRead {
    const problems: TombstoneProblem[] = [];
    const found = new Map<string, { tombstone?: Tombstone; ctimeMs?: number; revoked?: TombstoneRevoke; collected: { file: string; marker: TombstoneCollected }[] }>();
    const of = (id: string) => {
        const files = found.get(id) ?? { collected: [] };
        found.set(id, files);
        return files;
    };
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
        const parsed = kind.kind === 'tombstone' ? parseTombstone(loaded.value, kind.id) : kind.kind === 'revoked' ? parseRevoke(loaded.value, kind.id) : parseCollected(loaded.value, kind.id, kind.prefix);
        if (typeof parsed === 'string') {
            problems.push({ file, reason: 'invalid', detail: parsed });
            continue;
        }
        const files = of(kind.id);
        if (kind.kind === 'tombstone') {
            files.tombstone = parsed as Tombstone;
            files.ctimeMs = loaded.ctimeMs;
        } else if (kind.kind === 'revoked') files.revoked = parsed as TombstoneRevoke;
        else files.collected.push({ file, marker: parsed as TombstoneCollected });
    }
    const tombstones: TombstoneEntry[] = [];
    for (const [id, files] of found) {
        if (!files.tombstone) {
            // A revoke or a marker with no tombstone: someone removed it, so nobody can tell what it listed.
            problems.push({ file: `${TOMBSTONES_DIR}/${id}.json`, reason: 'orphan', detail: 'its revoke or GC marker is there, but the tombstone is not' });
            continue;
        }
        const tombstone = files.tombstone;
        const listed = new Set(tombstone.assetRevisions.map((assetRevision) => `assets/${tombstone.photoId}/${assetRevision}`));
        const collected: TombstoneCollected[] = [];
        for (const { file, marker } of files.collected) {
            const stray = marker.paths.find((entry) => !listed.has(entry.path));
            if (stray) problems.push({ file, reason: 'invalid', detail: `${stray.path} is not a folder ${id} lists` });
            else collected.push(marker);
        }
        collected.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.planDigest < b.planDigest ? -1 : 1));
        tombstones.push({ ...tombstone, revoked: files.revoked ?? null, collected, ctimeMs: files.ctimeMs ?? 0 });
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

/**
 * When GC may first delete what `entry` lists: more than 7 days after it was
 * written, counted from the later of its createdAt and its file's ctime, so a
 * back-dated createdAt can't shorten the grace.
 */
export const graceEndsMs = (entry: Pick<Tombstone, 'createdAt'> & { ctimeMs?: number }) => Math.max(Date.parse(entry.createdAt), Math.ceil(entry.ctimeMs ?? 0)) + TOMBSTONE_GRACE_MS;

/** A problem as one line, for a message. */
export const problemText = (problem: TombstoneProblem) => `${problem.file}: ${problem.detail}`;

/** `.gc-<assetRevision>-<digest-prefix>-<uuid>`, the name `photos gc --apply` gives a folder it sets aside before its delete. */
export const SET_ASIDE_PREFIX = '.gc-';
const SET_ASIDE_RE = /^\.gc-(sha256-[0-9a-f]{64})-([0-9a-f]{16})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The name a run with digest `planDigest` sets `assetRevision`'s folder aside under. */
export const setAsideName = (assetRevision: string, planDigest: string, uuid: string) => `${SET_ASIDE_PREFIX}${assetRevision}-${digestPrefix(planDigest)}-${uuid}`;

/**
 * Whether `dir` still holds every file `files` records, each a regular file
 * at least as long as recorded. Extra files and newer changes don't count:
 * only a file gone or cut short means GC reached it.
 */
export async function holdsRecorded(dir: string, files: readonly { name: string; bytes: number }[]): Promise<boolean> {
    for (const file of files) {
        let stat: fs.Stats;
        try {
            stat = await fs.promises.lstat(path.join(dir, ...file.name.split('/')));
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return false;
            throw error;
        }
        if (!stat.isFile() || stat.size < file.bytes) return false;
    }
    return true;
}

/** A folder a `photos gc --apply` run set aside and didn't finish with. */
export interface SetAsideFolder {
    /** `assets/<photoId>/.gc-…`, relative to the data root. */
    path: string;
    /** `assets/<photoId>/<assetRevision>`, where it came from. */
    original: string;
    /** `whole`: every file the run's marker recorded is there. `partial`: a delete reached it. `unknown`: no marker says what it held. */
    state: 'whole' | 'partial' | 'unknown';
    /** What to say about it, the same in revoke, the plan and `photos status --check`. */
    text: string;
}

/** The one sentence for a folder set aside, wherever it's reported. */
export function setAsideText(folder: Pick<SetAsideFolder, 'path' | 'original' | 'state'>): string {
    if (folder.state === 'whole') return `set aside whole at ${folder.path}: rename it back to ${folder.original}, then revoke, or rerun photos gc to finish the takedown`;
    if (folder.state === 'partial') return `${folder.path} is what is left of ${folder.original}, partly deleted by photos gc --apply: that takedown is permanent, and only a backup of the data root brings it back`;
    return `${folder.path} was set aside by photos gc --apply, which never deletes it, and no marker says what it held`;
}

/**
 * Every folder a `photos gc --apply` run set aside and didn't finish with,
 * `assets/<photoId>/.gc-…`, relative to the data root and sorted, each with
 * whether it is whole by its run's marker: one whose delete failed partway,
 * or that couldn't be put back. GC reports them and never deletes one it
 * didn't make in the same run. Reads with lstat and follows no symlink. A
 * missing `assets/` holds none.
 */
export async function setAsideFolders(root: string, read?: TombstoneRead): Promise<SetAsideFolder[]> {
    const store = path.join(/*turbopackIgnore: true*/ root, 'assets');
    let photos: fs.Dirent[];
    try {
        if ((await fs.promises.lstat(store)).isSymbolicLink()) return [];
        photos = await fs.promises.readdir(store, { withFileTypes: true });
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return [];
        throw error;
    }
    const tombstones = read ?? (await readTombstones(root));
    const found: SetAsideFolder[] = [];
    for (const photo of photos) {
        if (!photo.isDirectory() || !PHOTO_ID_RE.test(photo.name)) continue;
        for (const entry of await fs.promises.readdir(path.join(store, photo.name), { withFileTypes: true })) {
            if (!entry.name.startsWith(SET_ASIDE_PREFIX)) continue;
            const relative = `assets/${photo.name}/${entry.name}`;
            const match = SET_ASIDE_RE.exec(entry.name);
            const original = match ? `assets/${photo.name}/${match[1]}` : `assets/${photo.name}/?`;
            const recorded = match
                ? tombstones.tombstones.flatMap((each) => each.collected).filter((marker) => digestPrefix(marker.planDigest) === match[2]).flatMap((marker) => marker.paths).find((each) => each.path === original)
                : undefined;
            let state: SetAsideFolder['state'] = 'unknown';
            if (recorded && entry.isDirectory()) state = (await holdsRecorded(path.join(store, photo.name, entry.name), recorded.files)) ? 'whole' : 'partial';
            else if (recorded) state = 'partial';
            found.push({ path: relative, original, state, text: setAsideText({ path: relative, original, state }) });
        }
    }
    return found.sort((a, b) => (a.path < b.path ? -1 : 1));
}

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
