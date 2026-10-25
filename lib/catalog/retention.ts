import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STAGING_ID, stagingLockName, stagingRoot } from '../identity/derivatives';
import { canonicalJson } from '../storage/canonical';
import { dataRootStatus } from '../storage/config';
import { hasErrorCode, isInside } from '../storage/fsx';
import { LockTimeoutError, withLock, type LockContext, type LockRecord } from '../storage/lock';
import { CATALOG_LEASE_MS, type CatalogLogger } from './publish';
import { references, ReferenceScanError } from './references';
import { CATALOG_LOCK, CatalogIntegrityError, listActivations, readLastPublish } from './repository';
import { errorText as sharedErrorText, holderText } from './rollback';
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
 * It never deletes an asset, a revision, an activation, the pointer, a
 * working-layer record, the registry, `edits/`, or anything it can't
 * classify, so every asset references() finds survives. It still runs
 * references() under the locks and stops on anything that scan can't read,
 * since a data root it can't read is one it can't reason about.
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

export type GcClass = 'abandoned-staging' | 'orphan-candidate';

/** Why GC keeps a path of a class it deletes. */
export type GcKeptReason =
    | 'within-grace'
    | 'build-lock-held'
    | 'not-a-folder'
    | 'not-a-regular-file'
    | 'has-revision'
    | 'named-by-activation'
    | 'named-by-last-publish';

export interface GcEntry {
    class: GcClass;
    /** Relative to the data root, with `/`. */
    path: string;
    /** The rule that made it safe to delete. */
    rule: string;
    /** Its size, in bytes, counting every file in a folder. */
    bytes: number;
    /** The newest change GC found in it, in ms. */
    newestMs: number;
}

export interface GcKept {
    class: GcClass;
    path: string;
    reason: GcKeptReason;
}

export interface GcPlan {
    graceMs: number;
    /** Paths whose newest change is before this, so more than 7 days ago, may go. */
    cutoff: string;
    delete: GcEntry[];
    kept: GcKept[];
    /** How many asset references references() found, every one of which GC keeps. */
    references: number;
    /** What `photos gc --apply` takes: a hash of every path in `delete` with its class, size, and newest change. */
    digest: string;
}

export type GcOutcome =
    | 'PLANNED'
    | 'APPLIED'
    | 'PLAN_CHANGED'
    | 'UNSAFE_PATH'
    | 'CATALOG_LOCKED'
    | 'AUTHORED_LOCKED'
    | 'LOCK_LOST'
    | 'DATA_ROOT_NOT_READY'
    | 'INTEGRITY_MISMATCH'
    | 'STORAGE_ERROR';

/** The CLI's exit codes, #13's: 1 for a layout GC refuses, 4 for a damaged file or I/O, 3 for any other stop. Usage errors, 2, are the CLI's own. */
export const GC_EXIT_CODES: Record<GcOutcome, 0 | 1 | 3 | 4> = {
    PLANNED: 0,
    APPLIED: 0,
    UNSAFE_PATH: 1,
    PLAN_CHANGED: 3,
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
    holder?: LockRecord | null;
}

export interface GcHooks {
    /** Runs just before each delete, under every lock. A test changes the data root here. */
    beforeDelete?(entry: GcEntry): void | Promise<void>;
    /** Runs after an entry's last check and before the delete-time check of its folders. A test changes a folder here. */
    afterRecheck?(entry: GcEntry): void | Promise<void>;
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
}

/** A path GC would have to reach through a symlink or a non-folder, so it may lead outside the data root. */
export class UnsafePathError extends Error {
    readonly file: string;

    constructor(file: string, detail: string) {
        super(`${file} ${detail}, so GC can't be sure what it would delete. Nothing was deleted.`);
        this.name = 'UnsafePathError';
        this.file = file;
    }
}

/** A path changed between its plan and its delete. */
class EntryChangedError extends Error {}

const STAGING_RULE = 'gc.staging.unlocked-past-grace';
const CANDIDATE_RULE = 'gc.candidate.unpublished-past-grace';
const CANDIDATE_FILE_RE = /^(rev_[0-9a-f]{64})\.json$/;

/** The only paths GC ever deletes, by shape. Checked again right before every delete. */
const DELETABLE = [/^staging\/[a-z0-9-]+$/, /^catalog\/candidates\/rev_[0-9a-f]{64}\.json$/];

const iso = (ms: number) => new Date(ms).toISOString();
const posix = (relative: string) => relative.split(path.sep).join('/');
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);
const jsonLogger: CatalogLogger = { log: (line) => console.log(line) };

function logEvent(logger: CatalogLogger, event: string, fields: Record<string, unknown>): void {
    logger.log(JSON.stringify({ event, ...fields }));
}

/** The plan digest: every entry's class, path, size, and newest change, so any of them changing changes it. */
export function planDigest(graceMs: number, entries: readonly GcEntry[]): string {
    const body = { graceMs, delete: entries.map((entry) => ({ class: entry.class, path: entry.path, bytes: entry.bytes, newestMs: entry.newestMs })) };
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

/** Every file's size under `dir` and the newest change to it or anything in it, read with lstat, so no symlink is followed. */
async function folderFacts(dir: string): Promise<{ bytes: number; newestMs: number }> {
    const stat = await fs.promises.lstat(dir);
    let bytes = 0;
    let newestMs = Math.trunc(stat.mtimeMs);
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        const inner = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const facts = await folderFacts(inner);
            bytes += facts.bytes;
            newestMs = Math.max(newestMs, facts.newestMs);
            continue;
        }
        const innerStat = await fs.promises.lstat(inner);
        if (innerStat.isFile()) bytes += innerStat.size;
        newestMs = Math.max(newestMs, Math.trunc(innerStat.mtimeMs));
    }
    return { bytes, newestMs };
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

    return { graceMs: GC_GRACE_MS, cutoff: iso(cutoffMs), delete: toDelete, kept, references: found.length, digest: planDigest(GC_GRACE_MS, toDelete) };
}

interface Checked {
    target: string;
    /** The data root and the folders down to the target's parent, each with the identity classDir() checked. */
    chain: CheckedFolder[];
}

/**
 * Check one entry again right before its delete. Returns its absolute path
 * and its folders' identities. Throws if it changed, or for any path GC must
 * not touch.
 */
async function recheck(root: string, realRoot: string, entry: GcEntry, now: number): Promise<Checked> {
    if (!DELETABLE.some((shape) => shape.test(entry.path))) throw new UnsafePathError(entry.path, 'is not a path GC deletes');
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
    const isStaging = entry.class === 'abandoned-staging';
    if (isStaging ? !stat.isDirectory() : !stat.isFile()) throw new EntryChangedError(`${entry.path} is no longer a ${isStaging ? 'folder' : 'file'}.`);
    const facts = isStaging ? await folderFacts(target) : await candidateFacts(target, entry.path);
    if (facts.bytes !== entry.bytes || facts.newestMs !== entry.newestMs) throw new EntryChangedError(`${entry.path} changed since the plan.`);
    if (facts.newestMs >= now - GC_GRACE_MS) throw new EntryChangedError(`${entry.path} is within the grace period.`);
    if (!isStaging) {
        const id = segments[segments.length - 1].replace(/\.json$/, '');
        if (await existsAtAll(path.join(catalogPaths(root).revisionsDir, `${id}.json`))) throw new EntryChangedError(`${entry.path} has a revision now.`);
    }
    return { target, chain: checkedDir.chain };
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
    const result: GcResult = { outcome: 'STORAGE_ERROR', message: '', plan: null, deleted: [] };
    const finish = (outcome: GcOutcome, message: string, details: Partial<GcResult> = {}): GcResult => {
        Object.assign(result, details, { outcome, message });
        if (applying) {
            const fields = { outcome, digest: options.apply, deleted: result.deleted.length };
            logEvent(logger, outcome === 'APPLIED' ? 'catalog.gc.applied' : 'catalog.gc.failed', fields);
        }
        return result;
    };
    const deletedSoFar = () => {
        const count = result.deleted.length;
        return count > 0 ? ` It had deleted ${count} of the plan's ${result.plan?.delete.length ?? count} paths, and deleted nothing else.` : ' Nothing was deleted.';
    };

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
        for (const entry of plan.delete) {
            if (!(await stillHeld(locks))) return finish('LOCK_LOST', `GC lost the catalog or authored lock.${deletedSoFar()}`);
            await hooks.beforeDelete?.(entry);
            try {
                if (entry.class === 'abandoned-staging') {
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
            logEvent(logger, 'catalog.gc.deleted', { class: entry.class, path: entry.path, rule: entry.rule, bytes: entry.bytes, newestAt: iso(entry.newestMs) });
        }
        const count = result.deleted.length;
        return finish('APPLIED', count === 0 ? 'The plan was empty, so nothing was deleted.' : `Deleted ${count} ${count === 1 ? 'path' : 'paths'}.`);
    }
}
