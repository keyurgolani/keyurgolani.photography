import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assetLockName, STAGING_ID, stagingLockName, stagingRoot } from '../identity/derivatives';
import { CURATION_LOCK } from '../curation/repository';
import { ASSET_REVISION_RE, PHOTO_ID_RE, PROFILE_ID_RE } from '../identity/ids';
import { atomicCreateJson } from '../storage/atomicWrite';
import { canonicalJson } from '../storage/canonical';
import { configuredLibraryRoot, dataRootStatus } from '../storage/config';
import { hasErrorCode, isInside, PRIVATE_DIR_MODE, realpathLoose } from '../storage/fsx';
import { LockTimeoutError, withLock, type LockContext, type LockRecord } from '../storage/lock';
import { folderFacts, manifestContent, sizeText, type SetFile } from './asset-folders';
import { CATALOG_LEASE_MS, type CatalogLogger } from './publish';
import { ALWAYS_PROTECTED, alwaysHolder, liveReferences, protectedText, references, ReferenceScanError, type AssetReference, type ReferenceSource } from './references';
import { collectedFile, graceEndsMs, holdsRecorded, renameBack, SET_ASIDE_PREFIX, trashName, WHOLE_THEN, TRASH_DIR, wholeThen, problemText, readTombstones, setAsideFolders, setAsideFrom, setAsideName, setAsideText, standingFor, TOMBSTONES_DIR, type CollectedPath, type SetAsideFolder, type TombstoneRead } from './tombstones';
import { CATALOG_LOCK, CatalogIntegrityError, listActivations, readLastPublish } from './repository';
import { errorText as sharedErrorText } from './error-text';
import { holderText } from './rollback';
import { parseCandidateFile, REVISION_ID_RE } from './schema';
import { AUTHORED_LOCK } from './working-layer-writer';
import { catalogPaths } from './working-layer';

/**
 * #15's retention and GC, 15-3: `photos gc` and `photos gc --apply
 * <planDigest>`. Only the CLI imports this module, so no HTTP route and
 * nothing in the watcher can delete files through it.
 *
 * GC deletes two kinds of path and nothing else:
 *   - `staging/<id>/`, a folder #10's derivative build left when it was
 *     killed before publishing, once nothing in it changed for more than
 *     GC_GRACE_MS and no build holds stagingLockName(<id>). The delete
 *     takes that lock with no wait, as removeAbandonedStaging() does, so a
 *     live build's folder is skipped.
 *   - `catalog/candidates/<id>.json`, a compile #13's publish wrote that
 *     never became a revision, once it is older than GC_GRACE_MS and no
 *     revision file, activation record, or last-publish summary names its
 *     ID. An active pointer naming it with no revision file stops GC
 *     altogether, since references() refuses that root.
 *
 *   - `assets/<photoId>/<assetRevision>/`, #181's A10, the one asset
 *     folder it ever deletes: one a standing tombstone lists
 *     (lib/catalog/tombstones.ts) whose 7-day grace has passed, and that
 *     nothing in #15's always-protected set names (ALWAYS_PROTECTED in
 *     references.ts): the active revision, a working-layer series listing
 *     the photo at that asset revision, an open Inbox item, or a staging
 *     entry. A standing tombstone past its grace overrides references from
 *     older revisions, candidates and the photo's own record, and nothing
 *     else. A revoked tombstone protects nothing and deletes nothing.
 *
 * It never deletes any other asset, a revision, an activation, the pointer,
 * a working-layer record, the registry, a tombstone, `edits/`, anything in
 * the photo library, or anything it can't classify. It still runs
 * references() under the locks and stops on anything that scan can't read,
 * since a data root it can't read is one it can't reason about. Asset sets
 * nothing references and no tombstone lists are `unreferenced`: reported
 * with their bytes, and never deleted.
 *
 * A tombstoned folder goes only when its manifests account for every file
 * in it: each entry a real profile folder with a regular `manifest.json` for
 * that set, and each other file one its manifest lists. Anything else, such
 * as an owner's file, keeps the whole folder as `unexpected-content`.
 *
 * Before its first asset delete, apply checks every planned folder against
 * the always-protected set again, read fresh, and stops with NOW_PROTECTED,
 * deleting nothing, if one is protected now. It then writes this run's marker
 * for each tombstone, `<tombstoneId>.collected.<digest-prefix>.json`, with
 * every exact folder it will delete for it, and prints one plain line saying
 * what it deletes. Per folder, it checks it again, renames it aside to
 * `assets/<photoId>/.gc-<assetRevision>-<digest-prefix>-<uuid>`, checks the
 * always-protected set once more, checks the folder set aside against its
 * manifests and the plan again, and that it still holds its locks, puts it
 * back and stops if any of that fails, and only then deletes the folder it
 * set aside. Every stop from the rename on puts the folder back first. A delete that fails partway is
 * reported as "partly deleted", and what is left stays aside: GC reports a
 * `.gc-` folder in every plan and never deletes one it didn't make in the
 * same run.
 *
 * Bytes go only here, on the owner's explicit `photos gc --apply <digest>`:
 * never on a timer, at startup, or as a side effect of another command
 * (retentionBoundary.test.ts, and test/deleteRail.test.ts for every other
 * delete call in the tree).
 *
 * The dry run and apply take the same path: both the catalog and the
 * authored lock, held from the scan through the last delete (#13's
 * references() needs both), then the same plan. The dry run prints the plan
 * and its digest and deletes nothing. Apply recomputes the plan under the
 * locks and stops, deleting nothing, unless its digest is the one the
 * curator reviewed, so a path added to the plan, gone from it, or newly
 * protected since the dry run stops it. Each delete then checks its path
 * again, and refuses any path that resolves outside the data root.
 */

/** How long a path must sit unchanged before GC may delete it: 7 days. */
export const GC_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** How long GC waits for another command's catalog or authored lock. */
export const GC_WAIT_MS = 30_000;

export type GcClass = 'abandoned-staging' | 'orphan-candidate' | 'tombstoned';

/** Why GC keeps a path of a class it deletes. */
export type GcKeptReason =
    | 'within-grace'
    | 'build-lock-held'
    | 'not-a-folder'
    | 'not-a-regular-file'
    | 'has-revision'
    | 'named-by-activation'
    | 'named-by-last-publish'
    /** A tombstoned asset folder every standing tombstone for which is 7 days old or less. */
    | 'tombstone-within-grace'
    /** A tombstoned asset folder holding something its manifests don't list, such as an owner's file. GC deletes none of it. */
    | 'unexpected-content'
    /** A tombstoned asset folder whose asset revision has a `.gc-<r>-…` folder a stopped run left: GC plans nothing over it. */
    | 'set-aside-leftover'
    /** A tombstoned asset folder #15's always-protected set names, by the source that names it. */
    | 'active-revision'
    | 'working-layer-series'
    | 'open-inbox'
    | 'live-staging';

export interface GcEntry {
    class: GcClass;
    /** Relative to the data root, with `/`. */
    path: string;
    /** The rule that made it safe to delete. */
    rule: string;
    /** Its size, in bytes: every file in a staging folder, and the files a tombstoned folder's manifests list. */
    bytes: number;
    /** The newest change GC found in it, in ms. */
    newestMs: number;
    /** `tombstoned` only: the standing tombstones past their grace that list it, sorted. */
    tombstoneIds?: string[];
    /** `tombstoned` only: every file in it, its manifests included, by name and size, as its manifests account for them. */
    files?: SetFile[];
}

export interface GcKept {
    class: GcClass;
    path: string;
    reason: GcKeptReason;
    /** `tombstoned` only: the standing tombstones that list it. */
    tombstoneIds?: string[];
    /** For `unexpected-content`: the first path in it its manifests don't account for. For `set-aside-leftover`: the `.gc-` folder. Relative to the data root. */
    detail?: string;
}

/** A set nothing references and no standing tombstone lists. GC reports it and deletes none. */
export interface GcUnreferenced {
    /** `assets/<photoId>/<assetRevision>/<profileId>`. */
    path: string;
    bytes: number;
}

/** What keeps asset bytes, for the byte totals: each reference source, and a tombstone's grace. */
export type GcProtection = ReferenceSource | 'tombstone-within-grace';

export interface GcPlan {
    graceMs: number;
    /** Paths whose newest change is before this, so more than 7 days ago, may go. */
    cutoff: string;
    delete: GcEntry[];
    kept: GcKept[];
    /** How many asset references references() found, every one of which GC keeps. */
    references: number;
    /** #181's A10: report-only sets. Never deleted, and not in the digest. */
    unreferenced: GcUnreferenced[];
    /** Standing tombstones GC read. */
    tombstones: number;
    /**
     * Byte totals: what the plan deletes, what is unreferenced, and the asset
     * bytes each protection keeps. A set several sources name counts under
     * each of them, so the protected totals can add up to more than the store.
     */
    bytes: { delete: number; unreferenced: number; protected: Partial<Record<GcProtection, number>> };
    /** Why GC reports no asset totals, such as `assets/` being a symlink, or null. */
    assetsNote: string | null;
    /** `assets/<photoId>/.gc-…` folders a stopped run set aside, whole or partly deleted. Reported, never deleted, and not in the digest. */
    leftovers: SetAsideFolder[];
    /** What `photos gc --apply` takes: a hash of every path in `delete` with its class, size, and newest change. */
    digest: string;
}

export type GcOutcome =
    | 'PLANNED'
    | 'APPLIED'
    | 'PLAN_CHANGED'
    | 'NOW_PROTECTED'
    | 'UNSAFE_PATH'
    | 'CATALOG_LOCKED'
    | 'AUTHORED_LOCKED'
    | 'LOCK_LOST'
    | 'DATA_ROOT_NOT_READY'
    | 'INTEGRITY_MISMATCH'
    | 'STORAGE_ERROR';

/**
 * The CLI's exit codes, #13's: 1 for a layout GC refuses, 4 for a damaged
 * file or I/O, and for #181's NOW_PROTECTED, a planned asset folder
 * something always protected names now, 3 for any other stop. Usage errors,
 * 2, are the CLI's own.
 */
export const GC_EXIT_CODES: Record<GcOutcome, 0 | 1 | 3 | 4> = {
    PLANNED: 0,
    APPLIED: 0,
    UNSAFE_PATH: 1,
    PLAN_CHANGED: 3,
    NOW_PROTECTED: 4,
    CATALOG_LOCKED: 3,
    AUTHORED_LOCKED: 3,
    LOCK_LOST: 3,
    DATA_ROOT_NOT_READY: 3,
    INTEGRITY_MISMATCH: 4,
    STORAGE_ERROR: 4,
};

export const GC_DIGEST_RE = /^gc_[0-9a-f]{64}$/;

export interface GcResult {
    outcome: GcOutcome;
    message: string;
    /** The plan this run made under the locks, or null when it stopped before one. */
    plan: GcPlan | null;
    /** The paths deleted, in plan order. */
    deleted: string[];
    /** The paths whose delete failed partway: part of what was in them is gone, and the rest is in a `.gc-` folder. */
    partial: string[];
    holder?: LockRecord | null;
}

export interface GcHooks {
    /** Runs once apply's plan matches the digest, before the always-protected check that comes before any delete. A test opens an Inbox item here. */
    afterPlan?(plan: GcPlan): void | Promise<void>;
    /** Runs just before each delete, under every lock. A test changes the data root here. */
    beforeDelete?(entry: GcEntry): void | Promise<void>;
    /** Runs after an entry's last check and before the delete-time check of its folders. A test changes a folder here. */
    afterRecheck?(entry: GcEntry): void | Promise<void>;
    /** Runs once a tombstoned folder is set aside as `aside`, before the always-protected check that follows. A test opens an Inbox item here. */
    afterAside?(entry: GcEntry, aside: string): void | Promise<void>;
    /** Runs after every check of a folder set aside, just before the lock check and its delete. A test stops the run here. */
    beforeRemove?(entry: GcEntry, aside: string): void | Promise<void>;
    /** Stands in for the delete of a folder set aside, given GC's own delete. A test makes it fail partway here. */
    remove?(aside: string, removeAt: (target: string) => Promise<void>): Promise<void>;
}

export interface GcOptions {
    dataRoot: string;
    /** The digest of the plan the curator reviewed. Without it, GC is a dry run. */
    apply?: string;
    clock?: () => number;
    /** How long to wait for the catalog and authored locks. Defaults to GC_WAIT_MS. */
    waitMs?: number;
    leaseMs?: number;
    hooks?: GcHooks;
    logger?: CatalogLogger;
    /** Gets apply's one plain line, "Deletes 3 asset folders, 112.4 MB, from 2 tombstones.", once every check passed and before the first delete. */
    announce?(line: string): void;
}

/** A path GC would have to reach through a symlink or a non-folder, so it may lead outside the data root. */
export class UnsafePathError extends Error {
    readonly file: string;
    readonly detail: string;

    constructor(file: string, detail: string) {
        super(`${file} ${detail}, so GC can't be sure what it would delete. Nothing was deleted.`);
        this.name = 'UnsafePathError';
        this.file = file;
        this.detail = detail;
    }
}

/** A path changed between its plan and its delete. */
class EntryChangedError extends Error {}


const STAGING_RULE = 'gc.staging.unlocked-past-grace';
const CANDIDATE_RULE = 'gc.candidate.unpublished-past-grace';
const TOMBSTONE_RULE = 'gc.tombstoned.past-grace';
const CANDIDATE_FILE_RE = /^(rev_[0-9a-f]{64})\.json$/;

/** `assets/<photoId>/<assetRevision>`, the one asset path GC deletes. */
const ASSET_FOLDER_RE = /^assets\/(ph_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(sha256-[0-9a-f]{64})$/;

/** The only paths GC ever deletes, by shape. Checked again right before every delete. */
const DELETABLE = [/^staging\/[a-z0-9-]+$/, /^catalog\/candidates\/rev_[0-9a-f]{64}\.json$/, ASSET_FOLDER_RE];

/** The order the always-protected sources are named in, the first that names a folder being why it stays. */
const PROTECTION_ORDER: readonly ReferenceSource[] = ALWAYS_PROTECTED;

const iso = (ms: number) => new Date(ms).toISOString();
const posix = (relative: string) => relative.split(path.sep).join('/');
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);
const jsonLogger: CatalogLogger = { log: (line) => console.log(line) };

function logEvent(logger: CatalogLogger, event: string, fields: Record<string, unknown>): void {
    logger.log(JSON.stringify({ event, ...fields }));
}

/** The plan digest: every entry's class, path, size, and newest change, so any of them changing changes it. */
export function planDigest(graceMs: number, entries: readonly GcEntry[]): string {
    // A tombstoned folder's tombstones are in it too, so a revoke or a new tombstone since the dry run changes it.
    const body = { graceMs, delete: entries.map((entry) => ({ class: entry.class, path: entry.path, bytes: entry.bytes, newestMs: entry.newestMs, ...(entry.tombstoneIds ? { tombstoneIds: entry.tombstoneIds } : {}), ...(entry.files ? { files: entry.files } : {}) })) };
    return `gc_${createHash('sha256').update(canonicalJson(body)).digest('hex')}`;
}

/** A folder GC checked, with the identity it had when it was checked. */
interface CheckedFolder {
    dir: string;
    dev: number;
    ino: number;
}

/** The folder a class lives in, and every folder from the data root down to it, each as it was checked. */
interface ClassDir {
    dir: string;
    chain: CheckedFolder[];
}

/**
 * The folder a class lives in, checked: a real folder inside the real data
 * root, reached through no symlink. The chain it returns starts at the data
 * root itself and holds each folder's identity from the same lstat that
 * checked it. Null when the folder doesn't exist. Throws UnsafePathError for
 * anything else.
 */
async function classDir(realRoot: string, segments: readonly string[]): Promise<ClassDir | null> {
    const rootStat = await fs.promises.lstat(realRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new UnsafePathError('The data root', 'is no longer the folder GC started in');
    const chain: CheckedFolder[] = [{ dir: realRoot, dev: rootStat.dev, ino: rootStat.ino }];
    let current = realRoot;
    for (const segment of segments) {
        current = path.join(current, segment);
        let stat: fs.Stats;
        try {
            stat = await fs.promises.lstat(current);
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) return null;
            throw error;
        }
        const name = posix(path.relative(realRoot, current));
        if (stat.isSymbolicLink()) throw new UnsafePathError(name, 'is a symlink');
        if (!stat.isDirectory()) throw new UnsafePathError(name, 'is not a folder');
        chain.push({ dir: current, dev: stat.dev, ino: stat.ino });
    }
    // The real path must be this one. That refuses a data root, or a folder above it, that no longer resolves to
    // where GC started, and on a case-insensitive disk a folder that answers for another spelling.
    if ((await fs.promises.realpath(current)) !== current) throw new UnsafePathError(posix(path.relative(realRoot, current)), 'resolves somewhere else');
    return { dir: current, chain };
}

/** A candidate file's size and newest change: its mtime or its compiledAt, whichever is later. */
async function candidateFacts(file: string, relative: string): Promise<{ bytes: number; newestMs: number }> {
    const stat = await fs.promises.lstat(file);
    let value: unknown;
    try {
        value = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code) throw error;
        throw new CatalogIntegrityError(relative, `${relative} is not valid JSON.`);
    }
    const parsed = parseCandidateFile(value);
    if (!parsed.ok) throw new CatalogIntegrityError(relative, `${relative} is not a valid candidate.`);
    const compiledMs = Date.parse(parsed.value.compiledAt);
    return { bytes: stat.size, newestMs: Math.max(Math.trunc(stat.mtimeMs), Number.isNaN(compiledMs) ? 0 : compiledMs) };
}

/** Whether a build holds stagingLockName(`id`), by trying it with no wait, as removeAbandonedStaging() does. */
async function buildLockHeld(root: string, id: string, leaseMs: number | undefined): Promise<boolean> {
    try {
        await withLock(stagingLockName(id), { root, waitMs: 0, leaseMs }, async () => undefined);
        return false;
    } catch (error) {
        if (error instanceof LockTimeoutError) return true;
        throw error;
    }
}

async function existsAtAll(file: string): Promise<boolean> {
    try {
        await fs.promises.lstat(file);
        return true;
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return false;
        throw error;
    }
}

/**
 * The revision IDs a candidate must not be deleted under: every activation's
 * and the last publish's. The active pointer needs no entry here: one that
 * names a revision with no file makes references() throw, and one whose
 * revision exists is covered by the has-revision check.
 */
async function namedRevisions(root: string): Promise<Map<string, GcKeptReason>> {
    const named = new Map<string, GcKeptReason>();
    const lastPublish = await readLastPublish(root);
    for (const id of [lastPublish?.candidateId, lastPublish?.revisionId]) if (id) named.set(id, 'named-by-last-publish');
    for (const activation of await listActivations(root)) named.set(activation.revisionId, 'named-by-activation');
    return named;
}

/**
 * The plan, read under both locks. Fails closed: references() and every
 * catalog file it reads must parse, and a class folder reached through a
 * symlink throws UnsafePathError.
 */
async function scan(root: string, realRoot: string, now: number, leaseMs: number | undefined): Promise<GcPlan> {
    const found = await references(root);
    const cutoffMs = now - GC_GRACE_MS;
    const toDelete: GcEntry[] = [];
    const kept: GcKept[] = [];

    const staging = (await classDir(realRoot, [path.basename(stagingRoot(root))]))?.dir;
    if (staging) {
        for (const entry of (await fs.promises.readdir(staging, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            if (!STAGING_ID.test(entry.name)) continue;
            const relative = `staging/${entry.name}`;
            const keep = (reason: GcKeptReason) => kept.push({ class: 'abandoned-staging', path: relative, reason });
            if (!entry.isDirectory()) {
                keep('not-a-folder');
                continue;
            }
            const facts = await folderFacts(path.join(staging, entry.name));
            if (facts.newestMs >= cutoffMs) keep('within-grace');
            else if (await buildLockHeld(root, entry.name, leaseMs)) keep('build-lock-held');
            else toDelete.push({ class: 'abandoned-staging', path: relative, rule: STAGING_RULE, ...facts });
        }
    }

    const candidates = (await classDir(realRoot, ['catalog', 'candidates']))?.dir;
    if (candidates) {
        const named = await namedRevisions(root);
        const { revisionsDir } = catalogPaths(root);
        for (const entry of (await fs.promises.readdir(candidates, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const match = CANDIDATE_FILE_RE.exec(entry.name);
            if (!match || !REVISION_ID_RE.test(match[1])) continue;
            const id = match[1];
            const relative = `catalog/candidates/${entry.name}`;
            const keep = (reason: GcKeptReason) => kept.push({ class: 'orphan-candidate', path: relative, reason });
            if (!entry.isFile()) {
                keep('not-a-regular-file');
                continue;
            }
            const facts = await candidateFacts(path.join(candidates, entry.name), relative);
            if (await existsAtAll(path.join(revisionsDir, `${id}.json`))) keep('has-revision');
            else if (named.has(id)) keep(named.get(id) as GcKeptReason);
            else if (facts.newestMs >= cutoffMs) keep('within-grace');
            else toDelete.push({ class: 'orphan-candidate', path: relative, rule: CANDIDATE_RULE, ...facts });
        }
    }

    // #181's A10: the asset store, against every reference, the live ones included, and the tombstones.
    const live = await liveReferences(root);
    const tombstones = await readTombstones(root);
    assertTombstonesRead(tombstones);
    const leftovers = await setAsideFolders(realRoot, tombstones);
    const assets = await assetPlan(realRoot, [...found, ...live], tombstones, now, leftovers);
    toDelete.push(...assets.delete);
    kept.push(...assets.kept);
    const deleteBytes = toDelete.reduce((sum, entry) => sum + entry.bytes, 0);

    return {
        graceMs: GC_GRACE_MS,
        cutoff: iso(cutoffMs),
        delete: toDelete,
        kept,
        references: found.length,
        unreferenced: assets.unreferenced,
        tombstones: tombstones.tombstones.filter((entry) => entry.revoked === null).length,
        bytes: { delete: deleteBytes, unreferenced: assets.unreferenced.reduce((sum, set) => sum + set.bytes, 0), protected: assets.protectedBytes },
        assetsNote: assets.note,
        leftovers,
        digest: planDigest(GC_GRACE_MS, toDelete),
    };
}

/** Stops on a tombstone file nobody can read: a damaged revoke could make GC delete what the owner took back. */
function assertTombstonesRead(read: TombstoneRead): void {
    const [problem] = read.problems;
    if (problem) throw new CatalogIntegrityError(problem.file, `${problemText(problem)}, so GC can't tell what is taken down`);
}

/** One `assets/<photoId>/<assetRevision>/` folder as GC found it. */
interface AssetFolder {
    photoId: string;
    assetRevision: string;
    /** Relative to the data root. */
    path: string;
    /** Absolute. */
    dir: string;
    /** False for a symlink or a file in its place, which GC never deletes through. */
    isFolder: boolean;
    sets: { profileId: string; path: string; bytes: number }[];
    bytes: number;
    newestMs: number;
}

/** Every asset folder in the store, read with lstat, so nothing is followed through a symlink. Throws UnsafePathError for a store that is one. */
async function assetFolders(realRoot: string): Promise<{ folders: AssetFolder[]; notFolders: string[] }> {
    const store = await classDir(realRoot, ['assets']);
    const folders: AssetFolder[] = [];
    // Photo folders that are a symlink or a file: GC reasons about nothing under them.
    const notFolders: string[] = [];
    if (store === null) return { folders, notFolders };
    const byName = (a: fs.Dirent, b: fs.Dirent) => (a.name < b.name ? -1 : 1);
    for (const photo of (await fs.promises.readdir(store.dir, { withFileTypes: true })).sort(byName)) {
        if (!PHOTO_ID_RE.test(photo.name)) continue;
        if (!photo.isDirectory()) {
            notFolders.push(photo.name);
            continue;
        }
        const photoDir = path.join(store.dir, photo.name);
        for (const revision of (await fs.promises.readdir(photoDir, { withFileTypes: true })).sort(byName)) {
            if (!ASSET_REVISION_RE.test(revision.name)) continue;
            const relative = `assets/${photo.name}/${revision.name}`;
            const dir = path.join(photoDir, revision.name);
            if (!revision.isDirectory()) {
                folders.push({ photoId: photo.name, assetRevision: revision.name, path: relative, dir, isFolder: false, sets: [], bytes: 0, newestMs: 0 });
                continue;
            }
            const sets: AssetFolder['sets'] = [];
            for (const profile of (await fs.promises.readdir(dir, { withFileTypes: true })).sort(byName)) {
                if (!PROFILE_ID_RE.test(profile.name) || !profile.isDirectory()) continue;
                sets.push({ profileId: profile.name, path: `${relative}/${profile.name}`, bytes: (await folderFacts(path.join(dir, profile.name))).bytes });
            }
            folders.push({ photoId: photo.name, assetRevision: revision.name, path: relative, dir, isFolder: true, sets, ...(await folderFacts(dir)) });
        }
    }
    return { folders, notFolders };
}

/**
 * The asset half of the plan. A folder no standing tombstone lists is never
 * deleted: each of its sets counts toward the sources that name it, or is
 * `unreferenced`. A folder a standing tombstone lists stays when #15's
 * always-protected set names the photo at that asset revision at any
 * profile, or when every such tombstone is 7 days old or less. Otherwise it
 * goes, whatever older revisions, candidates or the photo's own record say.
 */
async function assetPlan(realRoot: string, refs: readonly AssetReference[], tombstones: TombstoneRead, now: number, leftovers: readonly SetAsideFolder[]) {
    const toDelete: GcEntry[] = [];
    const kept: GcKept[] = [];
    const unreferenced: GcUnreferenced[] = [];
    const protectedBytes: Partial<Record<GcProtection, number>> = {};
    const count = (key: GcProtection, bytes: number) => {
        if (bytes > 0) protectedBytes[key] = (protectedBytes[key] ?? 0) + bytes;
    };

    let found: Awaited<ReturnType<typeof assetFolders>>;
    try {
        found = await assetFolders(realRoot);
    } catch (error) {
        // A store GC can't walk safely: with nothing taken down that's only a missing report, but a tombstone could need a delete there.
        if (error instanceof UnsafePathError && !tombstones.tombstones.some((entry) => entry.revoked === null)) {
            return { delete: toDelete, kept, unreferenced, protectedBytes, note: `${error.message.replace(/ Nothing was deleted\.$/, '')}, so GC reports no asset bytes.` };
        }
        throw error;
    }

    for (const photoId of found.notFolders) {
        for (const entry of tombstones.tombstones.filter((each) => each.revoked === null && each.photoId === photoId)) {
            for (const assetRevision of entry.assetRevisions) kept.push({ class: 'tombstoned', path: `assets/${photoId}/${assetRevision}`, reason: 'not-a-folder', tombstoneIds: [entry.tombstoneId] });
        }
    }

    for (const folder of found.folders) {
        const named = refs.filter((ref) => ref.photoId === folder.photoId && (ref.assetRevision === null || ref.assetRevision === folder.assetRevision));
        const standing = standingFor(tombstones, folder.photoId, folder.assetRevision);
        if (standing.length === 0) {
            for (const set of folder.sets) {
                const sources = new Set(named.filter((ref) => ref.profileId === null || ref.profileId === set.profileId).map((ref) => ref.source));
                if (sources.size === 0) unreferenced.push({ path: set.path, bytes: set.bytes });
                for (const source of sources) count(source, set.bytes);
            }
            continue;
        }
        const tombstoneIds = standing.map((entry) => entry.tombstoneId).sort();
        const keep = (reason: GcKeptReason, detail?: string) => kept.push({ class: 'tombstoned', path: folder.path, reason, tombstoneIds, ...(detail ? { detail } : {}) });
        if (!folder.isFolder) {
            keep('not-a-folder');
            continue;
        }
        const always = PROTECTION_ORDER.find((source) => named.some((ref) => ref.source === source));
        if (always) {
            keep(always as GcKeptReason);
            count(always, folder.bytes);
            continue;
        }
        const past = standing.filter((entry) => graceEndsMs(entry) < now).map((entry) => entry.tombstoneId).sort();
        if (past.length === 0) {
            keep('tombstone-within-grace');
            count('tombstone-within-grace', folder.bytes);
            continue;
        }
        // A stopped run's .gc- folder for this asset revision, whole or not, waits for the owner: nothing is planned over it (item 21).
        const left = leftovers.find((each) => setAsideFrom(each, folder.path));
        if (left) {
            keep('set-aside-leftover', left.path);
            continue;
        }
        // Only what a build made: a folder its manifests don't account for stays whole.
        const content = await manifestContent(folder.dir, folder.path, folder.photoId, folder.assetRevision);
        if (!content.listed) {
            keep('unexpected-content', content.unexpected);
            continue;
        }
        toDelete.push({ class: 'tombstoned', path: folder.path, rule: TOMBSTONE_RULE, bytes: content.bytes, newestMs: folder.newestMs, tombstoneIds: past, files: content.files });
    }
    return { delete: toDelete, kept, unreferenced, protectedBytes, note: null as string | null };
}

/**
 * Why a planned tombstoned folder can't go now, read fresh: the reference
 * that always protects it, as a sentence, or null. Throws EntryChangedError
 * when its standing tombstones past their grace aren't the plan's any more.
 */
async function nowProtected(root: string, entry: GcEntry, now: number): Promise<string | null> {
    const match = ASSET_FOLDER_RE.exec(entry.path);
    if (!match) throw new UnsafePathError(entry.path, 'is not a path GC deletes');
    const [, photoId, assetRevision] = match;
    const refs = await references(root, { live: true });
    const holder = alwaysHolder(refs, photoId, assetRevision);
    if (holder) return `${entry.path} is protected now: ${protectedText(holder)}.`;
    const tombstones = await readTombstones(root);
    assertTombstonesRead(tombstones);
    const past = standingFor(tombstones, photoId, assetRevision).filter((each) => graceEndsMs(each) < now).map((each) => each.tombstoneId).sort();
    if (past.join() !== (entry.tombstoneIds ?? []).join()) throw new EntryChangedError(`${entry.path}'s tombstones changed since the plan.`);
    return null;
}

const sameFile = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino;

/** `dir` and every folder above it, up to the filesystem's root. */
function withAncestors(dir: string): string[] {
    const chain = [dir];
    for (let current = dir; path.dirname(current) !== current; current = path.dirname(current)) chain.push(path.dirname(current));
    return chain;
}

/**
 * Throws for a target inside the photo library, the library itself, or one
 * that holds it: the owner's originals are never GC's. It compares paths,
 * symlinks resolved, and then identities: the dev and inode of the target
 * and each folder above it against the library's, and the library and each
 * folder above it against the target's, so another path to the same folder,
 * a bind mount or a case GC can't spell, doesn't get past. A stat that fails,
 * the library's included, refuses too, since then GC can't tell.
 */
function assertOutsideLibrary(realRoot: string, entry: Pick<GcEntry, 'path'>): void {
    const library = configuredLibraryRoot();
    if (library === null) return;
    const target = path.join(realRoot, ...entry.path.split('/'));
    const refuse = (detail: string) => new UnsafePathError(entry.path, detail);
    const libraryPath = realpathLoose(library);
    if (isInside(target, libraryPath) || isInside(libraryPath, target)) throw refuse('is inside the photo library, or holds it');
    const stat = (file: string, what: string) => {
        try {
            return fs.statSync(file);
        } catch (error) {
            throw refuse(`can't be checked against the photo library, since ${what} can't be read (${(error as NodeJS.ErrnoException).code ?? 'an I/O error'})`);
        }
    };
    const libraryStat = stat(library, 'PHOTOGRAPHY_LIBRARY_DIR');
    for (const dir of withAncestors(target)) {
        if (sameFile(stat(dir, dir === target ? 'it' : 'a folder above it'), libraryStat)) throw refuse('is inside the photo library, or is it');
    }
    const targetStat = stat(target, 'it');
    for (const dir of withAncestors(libraryPath)) {
        if (sameFile(stat(dir, 'a folder above the photo library'), targetStat)) throw refuse('holds the photo library');
    }
}

/** Apply's one plain line, said before the first delete. */
export function deleteLine(plan: Pick<GcPlan, 'delete'>): string {
    const assets = plan.delete.filter((entry) => entry.class === 'tombstoned');
    const others = plan.delete.filter((entry) => entry.class !== 'tombstoned');
    const sum = (entries: readonly GcEntry[]) => entries.reduce((total, entry) => total + entry.bytes, 0);
    const n = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
    const tombstones = new Set(assets.flatMap((entry) => entry.tombstoneIds ?? []));
    const parts: string[] = [];
    if (assets.length > 0) parts.push(`${n(assets.length, 'asset folder')}, ${sizeText(sum(assets))}, from ${n(tombstones.size, 'tombstone')}`);
    if (others.length > 0) parts.push(`${n(others.length, assets.length > 0 ? 'other path' : 'path')}, ${sizeText(sum(others))}`);
    return `Deletes ${parts.join(', and ')}.`;
}

interface Checked {
    target: string;
    /** The data root and the folders down to the target's parent, each with the identity classDir() checked. */
    chain: CheckedFolder[];
    /** The target's own identity, from the same lstat. */
    dev: number;
    ino: number;
}

/**
 * Check one entry again right before its delete. Returns its absolute path
 * and its folders' identities. Throws if it changed, or for any path GC must
 * not touch.
 */
async function recheck(root: string, realRoot: string, entry: GcEntry, now: number): Promise<Checked> {
    if (!DELETABLE.some((shape) => shape.test(entry.path))) throw new UnsafePathError(entry.path, 'is not a path GC deletes');
    if ((entry.class === 'tombstoned') !== ASSET_FOLDER_RE.test(entry.path)) throw new UnsafePathError(entry.path, `is not a path GC deletes as ${entry.class}`);
    assertOutsideLibrary(realRoot, entry);
    const segments = entry.path.split('/');
    const checkedDir = await classDir(realRoot, segments.slice(0, -1));
    if (checkedDir === null) throw new EntryChangedError(`${entry.path} is gone.`);
    const target = path.join(checkedDir.dir, segments[segments.length - 1]);
    let stat: fs.Stats;
    try {
        stat = await fs.promises.lstat(target);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) throw new EntryChangedError(`${entry.path} is gone.`);
        throw error;
    }
    const isFolder = entry.class !== 'orphan-candidate';
    if (isFolder ? !stat.isDirectory() : !stat.isFile()) throw new EntryChangedError(`${entry.path} is no longer a ${isFolder ? 'folder' : 'file'}.`);
    const facts = isFolder ? await folderFacts(target) : await candidateFacts(target, entry.path);
    if (entry.class === 'tombstoned') {
        const [, photoId, assetRevision] = segments;
        const content = await manifestContent(target, entry.path, photoId, assetRevision);
        if (!content.listed) throw new EntryChangedError(`${entry.path} holds ${content.unexpected} now, which its manifests don't list.`);
        if (canonicalJson(content.files) !== canonicalJson(entry.files ?? [])) throw new EntryChangedError(`${entry.path} holds other files than the plan.`);
        facts.bytes = content.bytes;
    }
    if (facts.bytes !== entry.bytes || facts.newestMs !== entry.newestMs) throw new EntryChangedError(`${entry.path} changed since the plan.`);
    // A tombstoned folder's grace is its tombstone's, which nowProtected() checks again.
    if (entry.class !== 'tombstoned' && facts.newestMs >= now - GC_GRACE_MS) throw new EntryChangedError(`${entry.path} is within the grace period.`);
    if (entry.class === 'orphan-candidate') {
        const id = segments[segments.length - 1].replace(/\.json$/, '');
        if (await existsAtAll(path.join(catalogPaths(root).revisionsDir, `${id}.json`))) throw new EntryChangedError(`${entry.path} has a revision now.`);
    }
    return { target, chain: checkedDir.chain, dev: stat.dev, ino: stat.ino };
}

/**
 * Re-verify, synchronously and in the same tick as the delete that follows,
 * that the data root still resolves to the folder GC started in and that
 * every folder from it down to the target is the one classDir() checked, by
 * identity, and no symlink. Node can't delete relative to an open folder, so
 * this runs as close to the delete as it can.
 */
function assertSameFolders(realRoot: string, checked: Checked): void {
    const changed = (dir: string) => new UnsafePathError(dir === realRoot ? 'The data root' : posix(path.relative(realRoot, dir)), 'changed just before the delete');
    let resolved: string | null;
    try {
        resolved = fs.realpathSync(realRoot);
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) throw error;
        resolved = null;
    }
    if (resolved !== realRoot) throw new UnsafePathError('The data root', 'no longer resolves to the folder GC started in');
    for (const { dir, dev, ino } of checked.chain) {
        let stat: fs.Stats;
        try {
            stat = fs.lstatSync(dir);
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) throw changed(dir);
            throw error;
        }
        if (stat.isSymbolicLink() || stat.dev !== dev || stat.ino !== ino) throw changed(dir);
    }
}

/** Throws unless `aside` is the very folder `checked` checked, moved: same dev and inode, a folder, no symlink. */
function assertSetAside(realRoot: string, aside: string, checked: Checked): void {
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(aside);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) throw new UnsafePathError(posix(path.relative(realRoot, aside)), 'is gone just after GC set it aside');
        throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== checked.dev || stat.ino !== checked.ino) throw new UnsafePathError(posix(path.relative(realRoot, aside)), 'is not the folder GC set aside');
}

/** putBack()'s answer when what is at the aside path isn't the folder GC moved. */
const NOT_OURS = 'not-ours';

/**
 * Put a folder set aside back where it was. Null when it's back, else why it
 * isn't. Only the very folder GC moved goes back, by dev and inode: anything
 * else at `aside` stays where it is.
 */
function putBack(aside: string, checked: Checked): string | null {
    try {
        const stat = fs.lstatSync(aside);
        if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== checked.dev || stat.ino !== checked.ino) return NOT_OURS;
        fs.renameSync(aside, checked.target);
        return null;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code ?? 'an I/O error';
    }
}

/** A planned folder that something always protected names now, found after GC set it aside. */
class ProtectedNowError extends Error {}

/** GC lost a lock after setting a folder aside. */
class LockLostError extends Error {}

/**
 * The one delete of an asset folder: one GC set aside this run, as
 * `.gc-<assetRevision>-<digest-prefix>-<uuid>`, after every check. rm() unlinks a symlink
 * inside it rather than following it.
 */
async function removeSetAside(aside: string): Promise<void> {
    await fs.promises.rm(aside, { recursive: true, force: true });
}

/**
 * An error for a message, without the data root's absolute path: 15-2's
 * errorText(), which gives a Node fs error as its code and the path relative
 * to the data root, run against whichever of `roots` (the real path and the
 * one given) holds the path. Any other message that names a root says it
 * relative to it too, such as dataRootStatus()'s detail.
 */
export function errorText(error: unknown, roots: readonly string[]): string {
    const named = (error as NodeJS.ErrnoException | null)?.path ?? (error as { file?: unknown } | null)?.file;
    const file = typeof named === 'string' ? path.resolve(named) : null;
    const root = (file !== null ? roots.find((candidate) => isInside(file, candidate)) : undefined) ?? roots[0];
    const text = sharedErrorText(error, root);
    return roots.reduce((message, each) => message.split(`${each}${path.sep}`).join('').split(each).join('the data root'), text);
}

/**
 * `photos gc`: plan, and with `apply` delete, under the catalog and authored
 * locks. Never throws for an expected stop; see GcOutcome. A busy lock
 * names its holder, and no option breaks a live lock.
 */
export async function runGc(options: GcOptions): Promise<GcResult> {
    const root = path.resolve(options.dataRoot);
    const { hooks = {}, logger = jsonLogger, clock = Date.now } = options;
    const waitMs = options.waitMs ?? GC_WAIT_MS;
    const leaseMs = options.leaseMs ?? CATALOG_LEASE_MS;
    if (options.apply !== undefined && !GC_DIGEST_RE.test(options.apply)) throw new TypeError(`A plan digest is gc_ plus 64 hex, not ${JSON.stringify(options.apply)}.`);
    const applying = options.apply !== undefined;
    const result: GcResult = { outcome: 'STORAGE_ERROR', message: '', plan: null, deleted: [], partial: [] };
    const finish = (outcome: GcOutcome, message: string, details: Partial<GcResult> = {}): GcResult => {
        Object.assign(result, details, { outcome, message });
        if (applying) {
            const fields = { outcome, digest: options.apply, deleted: result.deleted.length, ...(result.partial.length > 0 ? { partlyDeleted: result.partial } : {}) };
            logEvent(logger, outcome === 'APPLIED' ? 'catalog.gc.applied' : 'catalog.gc.failed', fields);
        }
        return result;
    };
    const deletedSoFar = () => {
        const count = result.deleted.length;
        const partly = result.partial.length > 0 ? ` and part of ${result.partial.length} more` : '';
        if (count === 0 && partly) return ` It had deleted part of ${result.partial.length === 1 ? 'that path' : `${result.partial.length} paths`}, and nothing else.`;
        return count > 0 ? ` It had deleted ${count} of the plan's ${result.plan?.delete.length ?? count} paths${partly}, and deleted nothing else.` : ' Nothing was deleted.';
    };
    const relative = (file: string) => posix(path.relative(realRoot, file));

    const status = dataRootStatus({ write: true, root });
    // The detail can carry a Node message with the root's absolute path, so it is said relative to the root.
    const detail = status.detail ? `: ${errorText(new Error(status.detail), [root])}` : '';
    if (status.state !== 'ready') return finish('DATA_ROOT_NOT_READY', `The data root is ${status.state}${detail}. Nothing was deleted.`);
    let realRoot = root;
    if (applying) logEvent(logger, 'catalog.gc.started', { digest: options.apply });

    try {
        realRoot = await fs.promises.realpath(root);
        return await withLock(CATALOG_LOCK, { root, leaseMs, waitMs }, async (catalogLock) => {
            try {
                return await withLock(AUTHORED_LOCK, { root, leaseMs, waitMs }, (authoredLock) => held([catalogLock, authoredLock]));
            } catch (error) {
                if (error instanceof LockTimeoutError) return finish('AUTHORED_LOCKED', `Another command holds the authored lock: ${holderText(error.holder)}. Nothing was deleted.`, { holder: error.holder });
                return failed(error);
            }
        });
    } catch (error) {
        if (error instanceof LockTimeoutError) return finish('CATALOG_LOCKED', `Another command holds the catalog lock: ${holderText(error.holder)}. Nothing was deleted.`, { holder: error.holder });
        return failed(error);
    }

    function failed(error: unknown): GcResult {
        if (error instanceof UnsafePathError) return finish('UNSAFE_PATH', `${error.message.replace(/ Nothing was deleted\.$/, '')}${deletedSoFar()}`);
        if (error instanceof ReferenceScanError) return finish('INTEGRITY_MISMATCH', `${error.message.replace(/ Nothing was deleted\.$/, '')}${deletedSoFar()}`);
        if (error instanceof CatalogIntegrityError) return finish('INTEGRITY_MISMATCH', `${sentence(error.message)}${deletedSoFar()}`);
        return finish('STORAGE_ERROR', `${sentence(errorText(error, [realRoot, root]))}${deletedSoFar()}`);
    }

    async function stillHeld(locks: readonly LockContext[]): Promise<boolean> {
        for (const lock of locks) if (lock.signal.aborted || !(await lock.isHeld().catch(() => false))) return false;
        return true;
    }

    async function held(locks: readonly LockContext[]): Promise<GcResult> {
        for (const lock of locks) if (lock.takeover) logEvent(logger, 'catalog.lock.takeover', { lock: lock.name, ...lock.takeover });
        const plan = await scan(root, realRoot, clock(), options.leaseMs);
        result.plan = plan;
        if (!applying) {
            const what = plan.delete.length === 0 ? 'Nothing is old enough and unreferenced to delete.' : `${plan.delete.length} ${plan.delete.length === 1 ? 'path' : 'paths'} can go.`;
            return finish('PLANNED', `${what} Nothing was deleted.`);
        }
        if (plan.digest !== options.apply) {
            return finish('PLAN_CHANGED', `The plan is ${plan.digest} now, not ${options.apply}: a path was added to it, left it, became protected, or changed since the dry run. Nothing was deleted. Check the plan below, and apply it only if it is still what you want.`);
        }
        if (plan.delete.length > 0) {
            await hooks.afterPlan?.(plan);
            const tombstoned = plan.delete.filter((entry) => entry.class === 'tombstoned');
            try {
                // #15's AC 8 again, read fresh: an Inbox item or a build that came to name a folder since the scan stops it all.
                for (const entry of tombstoned) {
                    const why = await nowProtected(root, entry, clock());
                    if (why) return finish('NOW_PROTECTED', `${why} GC deleted nothing. Run the dry run again.`);
                }
            } catch (error) {
                if (error instanceof EntryChangedError) return finish('PLAN_CHANGED', `${error.message} Nothing was deleted. Run the dry run again.`);
                throw error;
            }
            for (const entry of plan.delete) assertOutsideLibrary(realRoot, entry);
            // This run's marker for each tombstone, written before its first byte goes, so a revoke can tell exactly
            // which folders a run may have reached, even after a crash. One per run: a later run adds its own.
            for (const tombstoneId of [...new Set(tombstoned.flatMap((entry) => entry.tombstoneIds ?? []))].sort()) {
                const paths: CollectedPath[] = tombstoned.filter((entry) => entry.tombstoneIds?.includes(tombstoneId)).map((entry) => ({ path: entry.path, bytes: entry.bytes, newestMs: entry.newestMs, files: entry.files ?? [] }));
                if (await atomicCreateJson(collectedFile(root, tombstoneId, plan.digest), { tombstoneId, planDigest: plan.digest, startedAt: iso(clock()), paths })) continue;
                // The same plan began once before and stopped: its marker has to list the same folders.
                const before = (await readTombstones(root)).tombstones.find((each) => each.tombstoneId === tombstoneId)?.collected.find((each) => each.planDigest === plan.digest);
                if (!before || canonicalJson(before.paths) !== canonicalJson(paths)) {
                    throw new CatalogIntegrityError(TOMBSTONES_DIR, `${TOMBSTONES_DIR} holds a marker for ${tombstoneId} and this plan that lists other folders`);
                }
            }
            const line = deleteLine(plan);
            logEvent(logger, 'catalog.gc.deleting', { digest: plan.digest, line });
            options.announce?.(line);
        }
        for (const entry of plan.delete) {
            if (!(await stillHeld(locks))) return finish('LOCK_LOST', `GC lost the catalog or authored lock.${deletedSoFar()}`);
            await hooks.beforeDelete?.(entry);
            try {
                if (entry.class === 'tombstoned') {
                    const stopped = await collectTombstoned(entry, locks, plan.digest);
                    if (stopped) return stopped;
                } else if (entry.class === 'abandoned-staging') {
                    const id = entry.path.slice('staging/'.length);
                    await withLock(stagingLockName(id), { root, waitMs: 0, leaseMs: options.leaseMs }, async () => {
                        const checked = await recheck(root, realRoot, entry, clock());
                        await hooks.afterRecheck?.(entry);
                        assertSameFolders(realRoot, checked);
                        // In the same tick as the check. rm() unlinks a symlink inside the folder rather than following it.
                        await fs.promises.rm(checked.target, { recursive: true, force: true });
                    }).catch((error: unknown) => {
                        throw error instanceof LockTimeoutError ? new EntryChangedError(`A build holds ${stagingLockName(id)} now.`) : error;
                    });
                } else {
                    const checked = await recheck(root, realRoot, entry, clock());
                    await hooks.afterRecheck?.(entry);
                    assertSameFolders(realRoot, checked);
                    await fs.promises.unlink(checked.target);
                }
            } catch (error) {
                if (error instanceof EntryChangedError) {
                    return finish('PLAN_CHANGED', `${error.message} GC stopped there.${deletedSoFar()} Run the dry run again.`);
                }
                throw error;
            }
            result.deleted.push(entry.path);
            logEvent(logger, 'catalog.gc.deleted', { class: entry.class, path: entry.path, rule: entry.rule, bytes: entry.bytes, newestAt: iso(entry.newestMs), ...(entry.tombstoneIds ? { tombstoneIds: entry.tombstoneIds } : {}) });
        }
        const count = result.deleted.length;
        return finish('APPLIED', count === 0 ? 'The plan was empty, so nothing was deleted.' : `Deleted ${count} ${count === 1 ? 'path' : 'paths'}.`);
    }

    /**
     * One tombstoned folder: check it again, set it aside, check the
     * always-protected set once more, check the folder set aside is still
     * exactly what was checked, and that GC still holds its locks. Every
     * stop from the rename on puts the folder back first, and one that can't
     * exits 4 naming where it is. Only then delete what was set aside.
     * Returns the stop, or null once it's deleted.
     */
    async function collectTombstoned(entry: GcEntry, locks: readonly LockContext[], digest: string): Promise<GcResult | null> {
        const checked = await recheck(root, realRoot, entry, clock());
        await hooks.afterRecheck?.(entry);
        const [, photoId, assetRevision] = entry.path.split('/');
        const aside = path.join(path.dirname(checked.target), setAsideName(assetRevision, digest, randomUUID()));
        // Said once the folder is stuck aside, with whatever is in its place then, and what to do after, as every report says it (item 30).
        const whole = async () => {
            let occupied = true;
            try {
                fs.lstatSync(checked.target);
            } catch (error) {
                if (!hasErrorCode(error, 'ENOENT')) throw error;
                occupied = false;
            }
            // If the tombstones can't be read now, "rerun photos gc" is the step that is right either way.
            const then = await readTombstones(root).then((read) => wholeThen(root, read, entry.tombstoneIds ?? [])).catch(() => WHOLE_THEN.gc);
            return setAsideText({ path: relative(aside), original: entry.path, state: 'whole', occupied, originalHolds: false }, then);
        };
        assertSameFolders(realRoot, checked);
        // In the same tick as the check. A rename moves the folder itself, and follows no symlink in it.
        fs.renameSync(checked.target, aside);
        try {
            await hooks.afterAside?.(entry, aside);
            assertSetAside(realRoot, aside, checked);
            // The check after the rename: a build or an Inbox item that comes to name it from here on finds no folder to lose.
            const why = await nowProtected(root, entry, clock());
            if (why) throw new ProtectedNowError(why);
            // What is set aside is still what was checked: an owner's file that came in since keeps it.
            const content = await manifestContent(aside, entry.path, photoId, assetRevision);
            if (!content.listed || canonicalJson(content.files) !== canonicalJson(entry.files ?? []) || (await folderFacts(aside)).newestMs !== entry.newestMs) {
                throw new EntryChangedError(`${entry.path} changed after GC set it aside${content.listed ? '' : `: it holds ${content.unexpected}, which its manifests don't list`}.`);
            }
            await hooks.beforeRemove?.(entry, aside);
            if (!(await stillHeld(locks))) throw new LockLostError();
            assertSameFolders(realRoot, checked);
            assertSetAside(realRoot, aside, checked);
        } catch (error) {
            const stuck = putBack(aside, checked);
            const why = error instanceof ProtectedNowError ? error.message : error instanceof LockLostError ? 'GC lost the catalog or authored lock.' : sentence(error instanceof EntryChangedError || error instanceof UnsafePathError ? error.message.replace(/ Nothing was deleted\.$/, '') : errorText(error, [realRoot, root]));
            if (stuck !== null) {
                // Exit 4 either way, and the owner learns where the folder is, or that what is there isn't it.
                const where = stuck === NOT_OURS
                    ? `GC can't find the folder it set aside; what is at ${relative(aside)} isn't it.`
                    : `GC couldn't put ${entry.path} back (${stuck}), so it is ${await whole()}. GC never deletes it.`;
                return finish(error instanceof ProtectedNowError ? 'NOW_PROTECTED' : 'STORAGE_ERROR', `${why} ${where} GC stopped there.${deletedSoFar()}`);
            }
            const back = `GC put ${entry.path} back and stopped there.${deletedSoFar()}`;
            if (error instanceof ProtectedNowError) return finish('NOW_PROTECTED', `${why} ${back} Run the dry run again.`);
            if (error instanceof LockLostError) return finish('LOCK_LOST', `${why} ${back}`);
            if (error instanceof EntryChangedError) return finish('PLAN_CHANGED', `${why} ${back} Run the dry run again.`);
            if (error instanceof UnsafePathError) return finish('UNSAFE_PATH', `${why} ${back}`);
            return finish('STORAGE_ERROR', `${why} ${back}`);
        }
        try {
            if (hooks.remove) await hooks.remove(aside, removeSetAside);
            else await removeSetAside(aside);
        } catch (error) {
            // Item 26's S1: a delete that failed before it removed anything leaves the folder whole, and it is said so.
            if (await holdsRecorded(aside, entry.files ?? []).catch(() => false)) {
                return finish('STORAGE_ERROR', `GC stopped: the delete of ${entry.path} failed (${errorText(error, [realRoot, root])}) before it removed anything, so it is ${await whole()}. GC never deletes it.${deletedSoFar()}`);
            }
            result.partial.push(entry.path);
            const ids = (entry.tombstoneIds ?? []).join(', ');
            return finish('STORAGE_ERROR', `GC stopped: partly deleted: ${entry.path}. Its delete failed (${errorText(error, [realRoot, root])}), and what is left of it is in ${relative(aside)}, which every plan reports and GC never deletes. ${ids} can't be revoked for it now.${deletedSoFar()}`);
        }
        return null;
    }
}

/**
 * `photos gc --set-aside <assets/p/r>` (#181's A10 review, item 29a): the
 * owner's way to move a taken-down asset folder, or a `.gc-` aside, out of
 * the way without deleting it. It renames the folder into the data root's
 * own `trash/<p>-<r>-<date-time>/`, on the same filesystem, so it stays on
 * the persisted data-root volume, never a container's disk. It never deletes.
 * Nothing reads or collects `trash/`; emptying it is the owner's own step.
 *
 * It holds the asset's own lock and the catalog, curation and authored locks
 * (items 40, 40a, 45 and 46), so no publish, record write, Inbox item or
 * build for that asset lands between its checks and the rename. The asset's
 * lock comes first and isn't waited for, so it never holds a global lock
 * while a build runs; the global ones follow in the order publish and Inbox
 * approve take them. After the rename it
 * asks the always-protected set again, as a second guard, and puts the folder
 * back if anything names it now.
 */

export type SetAsideOutcome = 'SET_ASIDE_DONE' | 'NOT_AN_ASSET_PATH' | 'NOT_FOUND' | 'NOT_TAKEN_DOWN' | 'PROTECTED' | 'SET_ASIDE_WHOLE' | 'EXISTS' | 'CROSS_DEVICE' | 'UNSAFE_PATH' | 'CATALOG_LOCKED' | 'AUTHORED_LOCKED' | 'CURATION_LOCKED' | 'ASSET_LOCKED' | 'LOCK_LOST' | 'DATA_ROOT_NOT_READY' | 'INTEGRITY_MISMATCH' | 'PUT_BACK_BLOCKED' | 'STORAGE_ERROR';

export const SET_ASIDE_EXIT_CODES: Record<SetAsideOutcome, 0 | 1 | 3 | 4> = {
    SET_ASIDE_DONE: 0,
    NOT_AN_ASSET_PATH: 1,
    NOT_FOUND: 1,
    NOT_TAKEN_DOWN: 1,
    PROTECTED: 1,
    SET_ASIDE_WHOLE: 1,
    EXISTS: 1,
    CROSS_DEVICE: 1,
    UNSAFE_PATH: 1,
    CATALOG_LOCKED: 3,
    AUTHORED_LOCKED: 3,
    CURATION_LOCKED: 3,
    ASSET_LOCKED: 3,
    LOCK_LOST: 3,
    DATA_ROOT_NOT_READY: 3,
    INTEGRITY_MISMATCH: 4,
    PUT_BACK_BLOCKED: 4,
    STORAGE_ERROR: 4,
};

export interface SetAsideResult {
    outcome: SetAsideOutcome;
    message: string;
    /** Relative to the data root, when it moved. */
    moved?: { from: string; to: string };
}

export interface SetAsideOptions {
    dataRoot: string;
    /** `assets/<photoId>/<assetRevision>` or `assets/<photoId>/.gc-…`, relative to the data root. */
    path: string;
    clock?: () => number;
    waitMs?: number;
    leaseMs?: number;
    logger?: CatalogLogger;
    hooks?: {
        /** Runs after every check, just before the last re-checks and the rename. A test swaps something here. */
        beforeRename?(): void | Promise<void>;
        /** Runs just after the rename, before the holders are asked again. A test makes a holder here. */
        afterRename?(): void | Promise<void>;
        /** Runs as each lock is taken, with its name. A test checks the order here. */
        afterLock?(name: string): void | Promise<void>;
    };
}

/** `assets/<photoId>/<assetRevision>` or `assets/<photoId>/.gc-<assetRevision>-…`: the only paths --set-aside moves. */
const SET_ASIDE_TARGET_RE = /^assets\/(ph_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/((?:sha256-[0-9a-f]{64})|(?:\.gc-(sha256-[0-9a-f]{64})-[A-Za-z0-9._-]+))$/;

export { trashName };

/**
 * Why `name` isn't a folder of the photo folder `photoDir`, or null: `.` or
 * `..`, which would move the photo's folder or all of `assets/` (`dot`), or a
 * name that reaches another folder (`dirname`). The target regex rules these
 * out too; this guard holds on its own (item 42).
 */
export function setAsideTargetProblem(photoDir: string, name: string): 'dot' | 'dirname' | null {
    if (name === '.' || name === '..') return 'dot';
    if (name.includes('/') || name.includes(path.sep) || path.dirname(path.join(photoDir, name)) !== photoDir) return 'dirname';
    return null;
}

export async function runSetAside(options: SetAsideOptions): Promise<SetAsideResult> {
    const root = path.resolve(options.dataRoot);
    const { clock = Date.now, logger = jsonLogger, hooks = {} } = options;
    const nothing = ' Nothing was moved, and nothing was deleted.';
    const refuse = (outcome: SetAsideOutcome, message: string, suffix = nothing): SetAsideResult => {
        logEvent(logger, 'catalog.gc.set-aside.refused', { outcome, path: options.path });
        return { outcome, message: `${message}${suffix}` };
    };
    const notAsset = () => refuse('NOT_AN_ASSET_PATH', `${options.path} is not a taken-down asset folder, assets/<photoId>/<assetRevision>, or the .gc- folder a stopped photos gc --apply left beside one, so photos gc --set-aside won't move it.`);
    const match = SET_ASIDE_TARGET_RE.exec(options.path);
    if (!match || path.isAbsolute(options.path)) return notAsset();
    const [, photoId, name] = match;
    if (setAsideTargetProblem(path.join(root, 'assets', photoId), name) !== null) return notAsset();
    const isAside = name.startsWith(SET_ASIDE_PREFIX);
    // The asset revision whose lock it holds: the folder's own, or the one a .gc- folder was set aside from.
    const assetRevision = isAside ? match[3] : name;
    const status = dataRootStatus({ write: true, root });
    if (status.state !== 'ready') return refuse('DATA_ROOT_NOT_READY', `The data root is ${status.state}.`);
    const leaseMs = options.leaseMs ?? CATALOG_LEASE_MS;
    const waitMs = options.waitMs ?? GC_WAIT_MS;
    // The locks, outermost first. The asset's, which a build holds, without waiting, so --set-aside never sits on a global lock while a build
    // runs (item 46). Then the catalog, curation and authored locks, in the order publish and Inbox approve take them, so neither can hold one
    // this waits for while it waits for one this holds (item 45).
    const LOCKS: readonly { name: string; outcome: SetAsideOutcome; what: string; waitMs: number }[] = [
        { name: assetLockName(photoId, assetRevision), outcome: 'ASSET_LOCKED', what: `the lock for ${photoId}'s ${assetRevision}, which a build of it holds`, waitMs: 0 },
        { name: CATALOG_LOCK, outcome: 'CATALOG_LOCKED', what: 'the catalog lock', waitMs },
        { name: CURATION_LOCK, outcome: 'CURATION_LOCKED', what: 'the curation lock', waitMs },
        { name: AUTHORED_LOCK, outcome: 'AUTHORED_LOCKED', what: 'the authored lock', waitMs },
    ];
    const under = async (at: number, locks: readonly LockContext[]): Promise<SetAsideResult> => {
        if (at === LOCKS.length) return held(locks);
        const lock = LOCKS[at];
        try {
            return await withLock(lock.name, { root, leaseMs, waitMs: lock.waitMs }, async (context) => {
                await hooks.afterLock?.(lock.name);
                return under(at + 1, [...locks, context]);
            });
        } catch (error) {
            if (error instanceof LockTimeoutError && error.lockName === lock.name) return refuse(lock.outcome, `Another command holds ${lock.what}: ${holderText(error.holder)}.`);
            throw error;
        }
    };
    try {
        return await under(0, []);
    } catch (error) {
        // GC's words for a delete, said for a move.
        if (error instanceof UnsafePathError) return refuse('UNSAFE_PATH', `${error.file} ${error.detail.replace(/the delete$/, 'the move').replace(/\bGC\b/g, 'photos gc --set-aside')}, so photos gc --set-aside can't be sure what it would move.`);
        if (error instanceof ReferenceScanError) return refuse('INTEGRITY_MISMATCH', error.message.replace(/ Nothing was deleted\.$/, ''));
        if (error instanceof CatalogIntegrityError) return refuse('INTEGRITY_MISMATCH', sentence(error.message));
        return refuse('STORAGE_ERROR', sentence(errorText(error, [root])));
    }

    async function held(locks: readonly LockContext[]): Promise<SetAsideResult> {
        const realRoot = await fs.promises.realpath(root);
        // The photo folder must be a real folder in the real data root, reached through no symlink.
        const photoDir = await classDir(realRoot, ['assets', photoId]);
        if (photoDir === null) return refuse('NOT_FOUND', `${options.path} is not there.`);
        if (setAsideTargetProblem(photoDir.dir, name) !== null) return refuse('NOT_AN_ASSET_PATH', `${options.path} is not a folder in ${photoId}'s folder.`);
        const target = path.join(photoDir.dir, name);
        let stat: fs.Stats;
        try {
            stat = fs.lstatSync(target);
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) return refuse('NOT_FOUND', `${options.path} is not there.`);
            throw error;
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) return refuse('UNSAFE_PATH', `${options.path} is a symlink or not a folder, so photos gc --set-aside won't move it.`);
        assertOutsideLibrary(realRoot, { path: options.path });
        const tombstones = await readTombstones(root);
        assertTombstonesRead(tombstones);
        /** What holds the folder now, of the always-protected set; null for a .gc- folder, which nothing references. */
        const holderNow = async () => (isAside ? null : alwaysHolder(await references(root, { live: true }), photoId, name));
        const retry = 'Settle that, or wait for it, then run photos gc --set-aside again.';
        if (isAside) {
            // A whole .gc- folder goes back where it was, not into trash/.
            const whole = (await setAsideFolders(realRoot, tombstones)).find((each) => each.path === options.path && each.state === 'whole');
            if (whole) return refuse('SET_ASIDE_WHOLE', `${options.path} holds everything its run recorded, so it goes back, not into ${TRASH_DIR}/: ${whole.text}.`);
        } else {
            // Only what a standing tombstone takes down, and nothing #15's always-protected set names, so the live site never loses a set.
            if (standingFor(tombstones, photoId, name).length === 0) return refuse('NOT_TAKEN_DOWN', `No standing tombstone takes down ${options.path}, so photos gc --set-aside won't move it: it may be a set the site serves.`);
            const holder = await holderNow();
            if (holder) return refuse('PROTECTED', `${options.path} is kept: ${protectedText(holder)}, so photos gc --set-aside won't move it. ${retry}`);
        }
        const trashDir = path.join(realRoot, TRASH_DIR);
        const rootStat = fs.lstatSync(realRoot);
        // On the data root's own device: a rename never copies, so nothing is ever lost on the way.
        if (stat.dev !== rootStat.dev) return refuse('CROSS_DEVICE', `${options.path} is on another device than the data root, so a rename into ${TRASH_DIR}/ would become a copy.`);
        let trash: fs.Stats | null = null;
        try {
            trash = fs.lstatSync(trashDir);
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) throw error;
        }
        if (trash !== null && (trash.isSymbolicLink() || !trash.isDirectory())) return refuse('UNSAFE_PATH', `${TRASH_DIR}/ in the data root is a symlink or not a folder.`);
        if (trash !== null && trash.dev !== rootStat.dev) return refuse('CROSS_DEVICE', `${TRASH_DIR}/ is on another device than the data root, so a rename into it would become a copy.`);
        const to = trashName(photoId, name, clock());
        const destination = path.join(trashDir, to);
        try {
            fs.lstatSync(destination);
            return refuse('EXISTS', `${TRASH_DIR}/${to} is there already.`);
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) throw error;
        }
        await hooks.beforeRename?.();
        for (const lock of locks) {
            if (lock.signal.aborted || !(await lock.isHeld().catch(() => false))) return refuse('LOCK_LOST', 'photos gc --set-aside lost one of its locks: the asset, catalog, curation or authored lock.');
        }
        // The last checks, in the same tick as the rename: the target is the folder checked, by inode, and so is every folder above it, and trash/ too when it was there.
        const sameAs = (file: string, was: fs.Stats) => {
            const now = fs.lstatSync(file);
            return !now.isSymbolicLink() && now.isDirectory() && now.dev === was.dev && now.ino === was.ino;
        };
        if (!sameAs(target, stat)) return refuse('UNSAFE_PATH', `${options.path} changed just before the move.`);
        assertSameFolders(realRoot, { target, chain: photoDir.chain, dev: stat.dev, ino: stat.ino });
        if (trash !== null && !sameAs(trashDir, trash)) return refuse('UNSAFE_PATH', `${TRASH_DIR}/ changed just before the move.`);
        // trash/ is made only once every check has passed, so a refusal leaves none behind (item 42).
        // Synchronously, so nothing runs between these checks and the rename (item 51's N1).
        if (trash === null) {
            try {
                fs.mkdirSync(trashDir, { mode: PRIVATE_DIR_MODE });
            } catch (error) {
                if (!hasErrorCode(error, 'EEXIST')) throw error;
            }
            const made = fs.lstatSync(trashDir);
            if (made.isSymbolicLink() || !made.isDirectory() || made.dev !== rootStat.dev) return refuse('UNSAFE_PATH', `${TRASH_DIR}/ in the data root is not a folder on the data root's device.`);
        }
        try {
            fs.renameSync(target, destination);
        } catch (error) {
            if (hasErrorCode(error, 'EXDEV')) return refuse('CROSS_DEVICE', `${options.path} and ${TRASH_DIR}/ are on different devices.`);
            if (hasErrorCode(error, 'EEXIST', 'ENOTEMPTY')) return refuse('EXISTS', `${TRASH_DIR}/${to} is there already.`);
            throw error;
        }
        const moved = { from: options.path, to: `${TRASH_DIR}/${to}` };
        await hooks.afterRename?.();
        // The second guard (item 40): ask the always-protected set again, and put the folder back if anything names it now.
        let holder: AssetReference | null = null;
        let unread: unknown = null;
        try {
            holder = await holderNow();
        } catch (error) {
            unread = error;
        }
        if (holder !== null || unread !== null) {
            const why = holder !== null ? `${options.path} is held now: ${protectedText(holder)}` : `photos gc --set-aside couldn't read what holds ${options.path} after the move (${errorText(unread, [realRoot, root])})`;
            const blocked = putBack(destination, target, stat);
            if (blocked === null) {
                logEvent(logger, 'catalog.gc.set-aside.put-back', moved);
                return holder !== null
                    ? refuse('PROTECTED', `${why}, so photos gc --set-aside put it back. ${retry}`, ' It is where it was, and nothing was deleted.')
                    : refuse('INTEGRITY_MISMATCH', `${why}, so it put it back.`, ' It is where it was, and nothing was deleted.');
            }
            logEvent(logger, 'catalog.gc.set-aside.put-back-blocked', { ...moved, reason: blocked });
            // What status can say of it: its holder, or, while the holders can't be read, only that it is there (item 49).
            const status = holder !== null ? 'photos status names it with its holder' : 'photos status lists it, and its holders once they read again';
            return {
                outcome: 'PUT_BACK_BLOCKED',
                message: `${why}, and photos gc --set-aside couldn't put it back: ${blocked}. It is in ${moved.to}, in the data root, whole, and nothing was deleted; ${status}. Once ${options.path} is free, put it back with ${renameBack(moved.to, options.path)}.`,
                moved,
            };
        }
        logEvent(logger, 'catalog.gc.set-aside', moved);
        return { outcome: 'SET_ASIDE_DONE', message: `Set ${options.path} aside at ${moved.to}, in the data root. Nothing was deleted. Emptying trash/ is your own step.`, moved };

        /** Rename the folder back from trash/, only when it is the folder moved and nothing has taken its place. Null when it's back, else why not. */
        function putBack(from: string, to: string, was: fs.Stats): string | null {
            try {
                const now = fs.lstatSync(from);
                if (now.isSymbolicLink() || !now.isDirectory() || now.dev !== was.dev || now.ino !== was.ino) return `${moved.to} is not the folder it moved`;
            } catch (error) {
                return `${moved.to} can't be read (${errorText(error, [realRoot, root])})`;
            }
            try {
                fs.lstatSync(to);
                return `something is at ${options.path} now`;
            } catch (error) {
                if (!hasErrorCode(error, 'ENOENT')) return `${options.path} can't be read (${errorText(error, [realRoot, root])})`;
            }
            try {
                fs.renameSync(from, to);
                return null;
            } catch (error) {
                return `the rename back failed (${errorText(error, [realRoot, root])})`;
            }
        }
    }
}
