import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ASSET_REVISION_RE, PHOTO_ID_RE, PROFILE_ID_RE } from '../identity/ids';
import { readRegistry } from '../identity/registry';
import type { Registry } from '../identity/types';
import { atomicCreateJson } from '../storage/atomicWrite';
import { dataRootStatus } from '../storage/config';
import { CorruptDocumentError } from '../storage/document';
import { ensureDirectory, hasErrorCode } from '../storage/fsx';
import { LockTimeoutError, withLock, type LockContext, type LockRecord } from '../storage/lock';
import { errorText } from './error-text';
import { CATALOG_LEASE_MS, type CatalogLogger } from './publish';
import { references, ReferenceScanError, type AssetReference } from './references';
import { CATALOG_LOCK, CatalogIntegrityError, listActivations, readRevisionFile } from './repository';
import { folderFacts, sizeText } from './asset-folders';
import { holderText } from './rollback';
import {
    graceEndsMs,
    problemText,
    readTombstones,
    revokeFile,
    standingFor,
    tombstoneFile,
    tombstonesDir,
    recordedFolders,
    PERMANENT_TEXT,
    setAsideFolders,
    setAsideFrom,
    setAsideText,
    TOMBSTONE_ID_RE,
    TOMBSTONES_DIR,
    type Tombstone,
    type TombstoneEntry,
    type TombstoneRead,
    type TombstoneRevoke,
} from './tombstones';
import { AUTHORED_LOCK } from './working-layer-writer';
import { readActivePointer } from './working-layer';
import { ownerRefusal } from './data-root-owner';

/**
 * #15's purge, #181's A10: `photos purge <photoId> [--asset-revision <r>]`
 * writes a tombstone, and `photos purge --revoke <tombstoneId>` takes one
 * back during its grace. Only the CLI imports this module
 * (retentionBoundary.test.ts), so no route, page, or the watcher can write
 * a tombstone or a revoke.
 *
 * Purge deletes nothing. It writes one file, `catalog/tombstones/<id>.json`,
 * and from the next request `/media` answers 410 for every set it lists, and
 * `assets.tombstoned` stops any revision that shows one from going live.
 * Only `photos gc --apply`, more than 7 days later, may delete the bytes,
 * and only in `assets/` in the data root. Nothing here reads or writes the
 * photo library.
 *
 * Both are dry runs by default: without `yes` they write nothing, and say
 * what they would do. Both hold the catalog lock, and purge the authored
 * lock too, from the first read to the write, as GC does, so no publish,
 * rollback, record write, or GC lands in between. Each refusal writes
 * nothing. Purge refuses, as #15's AC 9 says:
 *   - an asset the active revision references;
 *   - a photo a working-layer series lists at a targeted asset revision.
 * A series member whose record pins another asset revision is listed at
 * that one only, so `--asset-revision` of a revision the record no longer
 * pins goes ahead with the photo still in its series.
 */

/** How long purge waits for the catalog and authored locks. */
export const PURGE_WAIT_MS = 30_000;

export type PurgeOutcome =
    | 'PLANNED'
    | 'PURGED'
    | 'ALREADY_TAKEN_DOWN'
    | 'IN_ACTIVE_REVISION'
    | 'IN_SERIES'
    | 'UNKNOWN_PHOTO'
    | 'UNKNOWN_ASSET_REVISION'
    | 'REVOKE_PLANNED'
    | 'REVOKED'
    | 'ALREADY_REVOKED'
    | 'UNKNOWN_TOMBSTONE'
    | 'ALREADY_COLLECTED'
    /** A folder a stopped GC run set aside whole: rename it back, then revoke. */
    | 'SET_ASIDE'
    /** The A11 ruling (c): --yes as a uid that doesn't own the data root, refused before any lock, so web never meets a file it can't read. */
    | 'WRONG_OWNER'
    | 'CATALOG_LOCKED'
    | 'AUTHORED_LOCKED'
    | 'LOCK_LOST'
    | 'DATA_ROOT_NOT_READY'
    | 'INTEGRITY_MISMATCH'
    | 'STORAGE_ERROR';

/** 0 when done or nothing to do, 1 for a refusal on the data, 4 for a damaged file or I/O, 3 for any other stop. Usage errors, 2, are the CLI's. */
export const PURGE_EXIT_CODES: Record<PurgeOutcome, 0 | 1 | 3 | 4> = {
    PLANNED: 0,
    PURGED: 0,
    ALREADY_TAKEN_DOWN: 0,
    IN_ACTIVE_REVISION: 1,
    IN_SERIES: 1,
    UNKNOWN_PHOTO: 1,
    UNKNOWN_ASSET_REVISION: 1,
    REVOKE_PLANNED: 0,
    REVOKED: 0,
    ALREADY_REVOKED: 0,
    UNKNOWN_TOMBSTONE: 1,
    ALREADY_COLLECTED: 1,
    SET_ASIDE: 1,
    WRONG_OWNER: 1,
    CATALOG_LOCKED: 3,
    AUTHORED_LOCKED: 3,
    LOCK_LOST: 3,
    DATA_ROOT_NOT_READY: 3,
    INTEGRITY_MISMATCH: 4,
    STORAGE_ERROR: 4,
};

/** One derivative set a purge takes down. */
export interface PurgeSet {
    /** `assets/<photoId>/<assetRevision>/<profileId>`. */
    path: string;
    profileId: string;
    bytes: number;
}

export interface PurgeAssetRevision {
    assetRevision: string;
    sets: PurgeSet[];
    bytes: number;
    /** Standing tombstones that list it already. */
    takenDownBy: string[];
}

/** A revision that was live before and shows a targeted asset, so no rollback can return to it while the tombstone stands. */
export interface LosingRevision {
    revisionId: string;
    revisionNumber: number;
    assetRevisions: string[];
}

export interface PurgePlan {
    photoId: string;
    assetRevision: string | null;
    assetRevisions: PurgeAssetRevision[];
    sets: number;
    bytes: number;
    losing: LosingRevision[];
    /** When GC may first delete the bytes, if the tombstone is written now. */
    graceEndsAt: string;
    /** The one plain line: "Takes down ph_…: 2 asset revisions, 14 sets, 38.2 MB. They answer 410 at once. GC can delete the bytes from …". */
    summary: string;
}

export interface RevokePlan {
    tombstone: TombstoneEntry;
    /** The one plain line, said before the write. */
    summary: string;
}

export interface PurgeResult {
    outcome: PurgeOutcome;
    message: string;
    plan: PurgePlan | null;
    revokePlan?: RevokePlan | null;
    /** The tombstone written, or the one that stands already. */
    tombstone: Tombstone | null;
    revoke?: TombstoneRevoke | null;
    holder?: LockRecord | null;
}

export interface PurgeHooks {
    /** Runs under the locks, once the plan is made and every check passed, just before the write. */
    beforeWrite?(): void | Promise<void>;
}

interface CommonOptions {
    dataRoot: string;
    reason: string;
    actor: string;
    /** Write. Without it, a dry run that writes nothing. */
    yes?: boolean;
    clock?: () => number;
    waitMs?: number;
    leaseMs?: number;
    logger?: CatalogLogger;
    hooks?: PurgeHooks;
}

export interface PurgeOptions extends CommonOptions {
    photoId: string;
    /** Take down this asset revision only. The whole photo when absent. */
    assetRevision?: string;
    /** The UUID after `tomb_`. Tests pin it. */
    idGen?: () => string;
    /** Gets the plan once it is made under the locks, before anything is written, so the CLI prints what it takes down first. */
    onPlan?(plan: PurgePlan): void;
}

export interface RevokeOptions extends CommonOptions {
    tombstoneId: string;
    onPlan?(plan: RevokePlan): void;
}

const jsonLogger: CatalogLogger = { log: (line) => console.log(line) };
const logEvent = (logger: CatalogLogger, event: string, fields: Record<string, unknown>) => logger.log(JSON.stringify({ event, ...fields }));
const iso = (ms: number) => new Date(ms).toISOString();
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const NOTHING = ' Nothing was written.';


const isAre = (n: number) => (n === 1 ? 'is' : 'are');

/** A time for the owner: 2026-12-09 10:00 UTC. */
export const whenText = (ms: number) => `${iso(ms).slice(0, 16).replace('T', ' ')} UTC`;

/** Every profile folder under one asset revision's folder, with its bytes, by lstat: nothing is followed through a symlink. */
async function setsOf(root: string, photoId: string, assetRevision: string): Promise<PurgeSet[]> {
    const relative = `assets/${photoId}/${assetRevision}`;
    const dir = path.join(root, 'assets', photoId, assetRevision);
    let entries: fs.Dirent[];
    try {
        if (!(await fs.promises.lstat(dir)).isDirectory()) return [];
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return [];
        throw error;
    }
    const sets: PurgeSet[] = [];
    for (const entry of entries.filter((each) => each.isDirectory() && PROFILE_ID_RE.test(each.name)).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        sets.push({ path: `${relative}/${entry.name}`, profileId: entry.name, bytes: (await folderFacts(path.join(dir, entry.name))).bytes });
    }
    return sets;
}

/** The revisions that were live before, by number, that show `photoId` at one of `targets`, newest first. */
async function losingRevisions(root: string, photoId: string, targets: readonly string[], activeRevisionId: string | null): Promise<LosingRevision[]> {
    const numbers = new Map<string, number>();
    for (const activation of await listActivations(root)) {
        if (activation.status === 'committed' && !numbers.has(activation.revisionId)) numbers.set(activation.revisionId, activation.revisionNumber);
    }
    const losing: LosingRevision[] = [];
    for (const [revisionId, revisionNumber] of numbers) {
        if (revisionId === activeRevisionId) continue;
        const revision = await readRevisionFile(root, revisionId);
        if (revision === null) continue;
        const shown = revision.content.photos.filter((photo) => photo.id === photoId && targets.includes(photo.assetRevision)).map((photo) => photo.assetRevision);
        if (shown.length > 0) losing.push({ revisionId, revisionNumber, assetRevisions: [...new Set(shown)].sort() });
    }
    return losing.sort((a, b) => b.revisionNumber - a.revisionNumber);
}

function summaryOf(photoId: string, assetRevision: string | null, revisions: readonly PurgeAssetRevision[], graceEnds: number): string {
    const sets = revisions.reduce((sum, each) => sum + each.sets.length, 0);
    const bytes = revisions.reduce((sum, each) => sum + each.bytes, 0);
    const what = assetRevision === null ? photoId : `${photoId} at ${assetRevision}`;
    return `Takes down ${what}: ${plural(revisions.length, 'asset revision')}, ${plural(sets, 'set')}, ${sizeText(bytes)}. They answer 410 at once. GC can delete the bytes from ${whenText(graceEnds)}.`;
}

function failedText(error: unknown, root: string): { outcome: PurgeOutcome; message: string } {
    if (error instanceof ReferenceScanError) return { outcome: 'INTEGRITY_MISMATCH', message: error.message.replace(/ Nothing was deleted\.$/, NOTHING) };
    if (error instanceof CatalogIntegrityError || error instanceof CorruptDocumentError) return { outcome: 'INTEGRITY_MISMATCH', message: `${sentence(errorText(error, root))}${NOTHING}` };
    return { outcome: 'STORAGE_ERROR', message: `${sentence(errorText(error, root))}${NOTHING}` };
}

async function stillHeld(locks: readonly LockContext[]): Promise<boolean> {
    for (const lock of locks) if (lock.signal.aborted || !(await lock.isHeld().catch(() => false))) return false;
    return true;
}

function tombstonesProblem(read: TombstoneRead): string | null {
    const [problem] = read.problems;
    return problem ? `${problemText(problem)}, so nobody can tell what is taken down already.${NOTHING} Put the file back from a backup of the data root.` : null;
}

/** Where a refused purge goes next: #15's "publishing without the asset or photos:sequence remove". */
function removeHint(photoId: string, seriesIds: readonly string[]): string {
    const ids = seriesIds.length > 0 ? seriesIds : ['<seriesId>'];
    return ids.map((id) => `photos sequence remove ${id} ${photoId}`).join(', then ');
}

/**
 * `photos purge`: plan the takedown under the locks, refuse it if #15 says
 * so, and with `yes` write the tombstone. Never throws for an expected stop.
 */
export async function runPurge(options: PurgeOptions): Promise<PurgeResult> {
    const root = path.resolve(options.dataRoot);
    const { logger = jsonLogger, clock = Date.now, idGen = randomUUID, hooks = {} } = options;
    if (!PHOTO_ID_RE.test(options.photoId)) throw new TypeError(`${JSON.stringify(options.photoId)} is not a photo ID.`);
    if (options.assetRevision !== undefined && !ASSET_REVISION_RE.test(options.assetRevision)) throw new TypeError(`${JSON.stringify(options.assetRevision)} is not an asset revision.`);
    if (!/\S/.test(options.reason) || !/\S/.test(options.actor)) throw new TypeError('A purge needs a reason and an actor.');
    const result: PurgeResult = { outcome: 'STORAGE_ERROR', message: '', plan: null, tombstone: null };
    const finish = (outcome: PurgeOutcome, message: string, details: Partial<PurgeResult> = {}): PurgeResult => {
        Object.assign(result, details, { outcome, message });
        if (options.yes) logEvent(logger, outcome === 'PURGED' ? 'catalog.purge.tombstoned' : 'catalog.purge.stopped', { outcome, photoId: options.photoId, assetRevision: options.assetRevision ?? null, ...(result.tombstone ? { tombstoneId: result.tombstone.tombstoneId } : {}) });
        return result;
    };

    const status = dataRootStatus({ write: options.yes === true, root });
    if (status.state !== 'ready') return finish('DATA_ROOT_NOT_READY', `The data root is ${status.state}${status.detail ? `: ${errorText(new Error(status.detail), root)}` : ''}.${NOTHING}`);
    // The A11 ruling (c): only the uid web runs as writes a takedown file, so web can always read it. Asked before any lock,
    // since a lock file a killed run left as another uid would stop the owner's commands. The dry run takes locks only to read.
    if (options.yes) {
        let wrongOwner: string | null;
        try {
            wrongOwner = ownerRefusal(root, 'purge');
        } catch (error) {
            const failed = failedText(error, root);
            return finish(failed.outcome, failed.message);
        }
        if (wrongOwner) return finish('WRONG_OWNER', wrongOwner);
    }
    const waitMs = options.waitMs ?? PURGE_WAIT_MS;
    const leaseMs = options.leaseMs ?? CATALOG_LEASE_MS;

    try {
        return await withLock(CATALOG_LOCK, { root, leaseMs, waitMs }, async (catalogLock) => {
            try {
                return await withLock(AUTHORED_LOCK, { root, leaseMs, waitMs }, (authoredLock) => held([catalogLock, authoredLock]));
            } catch (error) {
                if (error instanceof LockTimeoutError) return finish('AUTHORED_LOCKED', `Another command holds the authored lock: ${holderText(error.holder)}.${NOTHING}`, { holder: error.holder });
                const failed = failedText(error, root);
                return finish(failed.outcome, failed.message);
            }
        });
    } catch (error) {
        if (error instanceof LockTimeoutError) return finish('CATALOG_LOCKED', `Another command holds the catalog lock: ${holderText(error.holder)}.${NOTHING}`, { holder: error.holder });
        const failed = failedText(error, root);
        return finish(failed.outcome, failed.message);
    }

    async function held(locks: readonly LockContext[]): Promise<PurgeResult> {
        const { photoId } = options;
        const tombstones = await readTombstones(root);
        const damaged = tombstonesProblem(tombstones);
        if (damaged) return finish('INTEGRITY_MISMATCH', damaged);

        let registry: Registry;
        try {
            registry = await readRegistry(root);
        } catch (error) {
            const failed = failedText(error, root);
            return finish(failed.outcome, failed.message);
        }
        const photo = registry.photos[photoId];
        if (!photo) return finish('UNKNOWN_PHOTO', `The registry has no photo ${photoId}, so there's nothing to take down.${NOTHING} photos list shows the photo IDs.`);
        const known = Object.keys(photo.revisions).sort();
        if (options.assetRevision !== undefined && !known.includes(options.assetRevision)) {
            return finish('UNKNOWN_ASSET_REVISION', `The registry has no asset revision ${options.assetRevision} of ${photoId}. It has ${known.join(', ') || 'none'}.${NOTHING}`);
        }
        const targets = options.assetRevision !== undefined ? [options.assetRevision] : known;
        if (targets.length === 0) return finish('UNKNOWN_ASSET_REVISION', `The registry holds no asset revision of ${photoId}, so there's nothing to take down.${NOTHING}`);

        // #15's AC 9, under the locks. The refusals come before anything is planned, so each writes nothing.
        const refs = await references(root);
        const targeted = (ref: AssetReference) => ref.photoId === photoId && (ref.assetRevision === null || targets.includes(ref.assetRevision));
        const seriesIds = [...new Set(refs.filter((ref) => ref.source === 'working-layer-series' && ref.photoId === photoId).map((ref) => ref.holder))].sort();
        const live = refs.find((ref) => ref.source === 'active-revision' && targeted(ref));
        if (live) {
            const number = (await listActivations(root)).find((activation) => activation.status === 'committed' && activation.revisionId === live.holder)?.revisionNumber;
            const named = number === undefined ? live.holder : `revision ${number} (${live.holder})`;
            return finish('IN_ACTIVE_REVISION', `The live revision, ${named}, shows ${photoId} at ${live.assetRevision}, so a purge would take it off the live site.${NOTHING} Publish without it first: take it out with ${removeHint(photoId, seriesIds)}, publish, then purge it.`);
        }
        const listed = refs.find((ref) => ref.source === 'working-layer-series' && targeted(ref));
        if (listed) {
            const at = listed.assetRevision === null ? 'with no photo record to pin an asset revision' : `at ${listed.assetRevision}`;
            return finish('IN_SERIES', `The draft's series ${listed.holder} lists ${photoId} ${at}, so the next publish would show it.${NOTHING} Take it out with ${removeHint(photoId, [listed.holder])} and publish without it, or pin another asset revision and purge this one with --asset-revision.`);
        }

        const assetRevisions: PurgeAssetRevision[] = [];
        for (const assetRevision of targets) {
            const sets = await setsOf(root, photoId, assetRevision);
            const takenDownBy = standingFor(tombstones, photoId, assetRevision).map((entry) => entry.tombstoneId);
            assetRevisions.push({ assetRevision, sets, bytes: sets.reduce((sum, set) => sum + set.bytes, 0), takenDownBy });
        }
        const pointer = await readActivePointer(root);
        const now = clock();
        const graceEnds = graceEndsMs({ createdAt: iso(now) });
        const plan: PurgePlan = {
            photoId,
            assetRevision: options.assetRevision ?? null,
            assetRevisions,
            sets: assetRevisions.reduce((sum, each) => sum + each.sets.length, 0),
            bytes: assetRevisions.reduce((sum, each) => sum + each.bytes, 0),
            losing: await losingRevisions(root, photoId, targets, pointer?.revisionId ?? null),
            graceEndsAt: iso(graceEnds),
            summary: summaryOf(photoId, options.assetRevision ?? null, assetRevisions, graceEnds),
        };
        result.plan = plan;

        if (assetRevisions.every((each) => each.takenDownBy.length > 0)) {
            const by = [...new Set(assetRevisions.flatMap((each) => each.takenDownBy))];
            const standing = tombstones.tombstones.find((entry) => entry.tombstoneId === by[0]) ?? null;
            return finish('ALREADY_TAKEN_DOWN', `${by.join(', ')} already ${by.length === 1 ? 'takes' : 'take'} down every asset revision this would.${NOTHING}`, { tombstone: standing });
        }
        options.onPlan?.(plan);
        if (!options.yes) return finish('PLANNED', `This was a dry run.${NOTHING} Run it again with --yes to take it down.`);

        if (!(await stillHeld(locks))) return finish('LOCK_LOST', `Purge lost the catalog or authored lock.${NOTHING}`);
        await hooks.beforeWrite?.();
        const tombstone: Tombstone = {
            tombstoneId: `tomb_${idGen()}`,
            photoId,
            assetRevision: options.assetRevision ?? null,
            assetRevisions: targets,
            actor: options.actor.trim(),
            reason: options.reason.trim(),
            createdAt: iso(now),
        };
        if (!TOMBSTONE_ID_RE.test(tombstone.tombstoneId)) throw new TypeError(`${tombstone.tombstoneId} is not a tombstone ID.`);
        await ensureDirectory(path.dirname(tombstonesDir(root)));
        await ensureDirectory(tombstonesDir(root));
        if (!(await atomicCreateJson(tombstoneFile(root, tombstone.tombstoneId), tombstone))) {
            return finish('STORAGE_ERROR', `${TOMBSTONES_DIR}/${tombstone.tombstoneId}.json is there already.${NOTHING}`);
        }
        result.tombstone = tombstone;
        return finish('PURGED', `Wrote ${TOMBSTONES_DIR}/${tombstone.tombstoneId}.json. Its sets answer 410 from the next request. photos gc --apply can delete the bytes from ${whenText(graceEnds)}. photos purge --revoke ${tombstone.tombstoneId} --reason <text> takes it back until photos gc --apply deletes a folder it lists. ${PERMANENT_TEXT}`);
    }
}

/**
 * `photos purge --revoke <tombstoneId>`: write the tombstone's revoke under
 * the catalog lock, after which `/media`, `assets.tombstoned` and GC ignore
 * it. Refused once a folder a GC run recorded for it in its marker is gone,
 * or a file it recorded is missing or shorter, and only then: extra files,
 * newer changes, a marker whose folders all stand, or an asset revision that
 * never had a folder don't refuse it. A folder set aside whole stops it with
 * SET_ASIDE and says how to rename it back. Never throws for an
 * expected stop.
 */
export async function runRevoke(options: RevokeOptions): Promise<PurgeResult> {
    const root = path.resolve(options.dataRoot);
    const { logger = jsonLogger, clock = Date.now, hooks = {} } = options;
    if (!TOMBSTONE_ID_RE.test(options.tombstoneId)) throw new TypeError(`${JSON.stringify(options.tombstoneId)} is not a tombstone ID.`);
    if (!/\S/.test(options.reason) || !/\S/.test(options.actor)) throw new TypeError('A revoke needs a reason and an actor.');
    const result: PurgeResult = { outcome: 'STORAGE_ERROR', message: '', plan: null, revokePlan: null, tombstone: null, revoke: null };
    const finish = (outcome: PurgeOutcome, message: string, details: Partial<PurgeResult> = {}): PurgeResult => {
        Object.assign(result, details, { outcome, message });
        if (options.yes) logEvent(logger, outcome === 'REVOKED' ? 'catalog.purge.revoked' : 'catalog.purge.stopped', { outcome, tombstoneId: options.tombstoneId });
        return result;
    };

    const status = dataRootStatus({ write: options.yes === true, root });
    if (status.state !== 'ready') return finish('DATA_ROOT_NOT_READY', `The data root is ${status.state}${status.detail ? `: ${errorText(new Error(status.detail), root)}` : ''}.${NOTHING}`);
    // The A11 ruling (c): only the uid web runs as writes a takedown file, so web can always read it. Asked before any lock,
    // since a lock file a killed run left as another uid would stop the owner's commands. The dry run takes locks only to read.
    if (options.yes) {
        let wrongOwner: string | null;
        try {
            wrongOwner = ownerRefusal(root, 'revoke');
        } catch (error) {
            const failed = failedText(error, root);
            return finish(failed.outcome, failed.message);
        }
        if (wrongOwner) return finish('WRONG_OWNER', wrongOwner);
    }

    try {
        return await withLock(CATALOG_LOCK, { root, leaseMs: options.leaseMs ?? CATALOG_LEASE_MS, waitMs: options.waitMs ?? PURGE_WAIT_MS }, (lock) => held(lock));
    } catch (error) {
        if (error instanceof LockTimeoutError) return finish('CATALOG_LOCKED', `Another command holds the catalog lock: ${holderText(error.holder)}.${NOTHING}`, { holder: error.holder });
        const failed = failedText(error, root);
        return finish(failed.outcome, failed.message);
    }

    async function held(lock: LockContext): Promise<PurgeResult> {
        const tombstones = await readTombstones(root);
        const damaged = tombstonesProblem(tombstones);
        if (damaged) return finish('INTEGRITY_MISMATCH', damaged);
        const entry = tombstones.tombstones.find((each) => each.tombstoneId === options.tombstoneId);
        if (!entry) return finish('UNKNOWN_TOMBSTONE', `There's no tombstone ${options.tombstoneId} in ${TOMBSTONES_DIR}.${NOTHING}`);
        result.tombstone = entry;
        if (entry.revoked) return finish('ALREADY_REVOKED', `${entry.tombstoneId} was revoked at ${entry.revoked.createdAt} by ${entry.revoked.actor}.${NOTHING}`, { revoke: entry.revoked });
        // Each GC run writes its marker, with every exact folder it will delete, before its first delete. Only a
        // recorded folder that is gone, or a recorded file missing or cut short, means a revoke would bring back less than it says.
        const { reached, aside } = await recordedFolders(root, entry.collected);
        // The same words as photos gc and status --check give for each folder set aside (setAsideFolders()).
        const leftovers = await setAsideFolders(root, tombstones);
        const listed = entry.assetRevisions.map((assetRevision) => `assets/${entry.photoId}/${assetRevision}`);
        const wholeText = (folder: { path: string; original: string }, then?: string) => {
            const found = leftovers.find((each) => each.path === folder.path);
            // The same sentence status and the plan give, its "then" weighed across every tombstone the folder's run recorded (item 38). A folder
            // setAsideFolders() read but didn't find whole keeps what it found in the folder's place (item 42).
            if (found?.state === 'whole') return found.text;
            return setAsideText({ path: folder.path, original: folder.original, state: 'whole', occupied: found?.occupied ?? false, originalHolds: false }, then);
        };
        if (reached.length > 0) {
            const it = reached.length === 1 ? 'it' : 'them';
            // Item 26's S2: the revoke can't go through, but a folder set aside whole still comes back to finish the takedown with.
            const whole = aside.length > 0 ? ` Of the rest, ${aside.map((folder) => wholeText(folder, 'then rerun photos gc')).join('; ')}.` : '';
            return finish('ALREADY_COLLECTED', `photos gc --apply began deleting ${reached.join(', ')} for ${entry.tombstoneId}, and ${reached.length === 1 ? "it's" : "they're"} gone or cut short now, so a revoke can't bring ${it} back.${NOTHING} ${PERMANENT_TEXT}${whole}`);
        }
        if (aside.length > 0) {
            // Not deleted: a stopped run left it whole beside its place. Moved back as the text says, the revoke goes through.
            return finish('SET_ASIDE', `photos gc --apply stopped with ${aside.map((folder) => folder.original).join(', ')} out of place for ${entry.tombstoneId}: ${aside.map((folder) => wholeText(folder)).join('; ')}.${NOTHING}`);
        }
        // What a stopped run left beside its folders that doesn't block the revoke, said as everywhere else.
        const left = leftovers.filter((folder) => folder.state !== 'whole' && listed.some((target) => setAsideFrom(folder, target))).map((folder) => ` ${folder.text.charAt(0).toUpperCase()}${folder.text.slice(1)}.`).join('');
        const what = entry.assetRevision === null ? `${entry.photoId}, ${plural(entry.assetRevisions.length, 'asset revision')}` : `${entry.photoId} at ${entry.assetRevision}`;
        const notes = await othersText(entry, tombstones);
        let back = ' From the next request /media serves their sets again wherever the live revision shows them, and GC keeps their bytes.';
        if (notes.text) back = notes.rest > 0 ? ' The rest is served again from the next request wherever the live revision shows it, and GC keeps its bytes.' : '';
        const revokePlan: RevokePlan = { tombstone: entry, summary: `Revokes ${entry.tombstoneId}, written ${entry.createdAt} by ${entry.actor}: ${what}.${notes.text}${back}${left}` };
        result.revokePlan = revokePlan;
        options.onPlan?.(revokePlan);
        if (!options.yes) return finish('REVOKE_PLANNED', `This was a dry run.${NOTHING} Run it again with --yes to revoke it.`);

        if (!(await stillHeld([lock]))) return finish('LOCK_LOST', `Revoke lost the catalog lock.${NOTHING}`);
        await hooks.beforeWrite?.();
        const revoke: TombstoneRevoke = { tombstoneId: entry.tombstoneId, actor: options.actor.trim(), reason: options.reason.trim(), createdAt: iso(clock()) };
        if (!(await atomicCreateJson(revokeFile(root, entry.tombstoneId), revoke))) return finish('ALREADY_REVOKED', `${entry.tombstoneId} has a revoke already.${NOTHING}`);
        return finish('REVOKED', `Wrote ${TOMBSTONES_DIR}/${entry.tombstoneId}.revoked.json. ${notes.text ? 'Apart from the above, its' : 'Its'} sets answer as the live revision says from the next request, and no revision that shows them is refused for it any more.`, { revoke });
    }

    /**
     * What a revoke of `entry` leaves down anyway: the asset revisions another
     * standing tombstone still takes down, and the folders a GC run for
     * another tombstone deleted, which stay gone. `rest` is how many of its
     * asset revisions come back.
     */
    async function othersText(entry: TombstoneEntry, read: TombstoneRead): Promise<{ text: string; rest: number }> {
        const others = read.tombstones.filter((each) => each.tombstoneId !== entry.tombstoneId && each.photoId === entry.photoId);
        const down = new Set<string>();
        const parts: string[] = [];
        for (const other of others.filter((each) => each.revoked === null)) {
            const shared = entry.assetRevisions.filter((assetRevision) => other.assetRevisions.includes(assetRevision));
            if (shared.length === 0) continue;
            shared.forEach((assetRevision) => down.add(assetRevision));
            parts.push(` ${other.tombstoneId} still takes down ${shared.join(', ')}, so ${shared.length === 1 ? 'that stays' : 'those stay'} down.`);
        }
        const listed = new Set(entry.assetRevisions.map((assetRevision) => `assets/${entry.photoId}/${assetRevision}`));
        for (const other of others) {
            const gone = (await recordedFolders(root, other.collected)).reached.filter((folder) => listed.has(folder));
            if (gone.length === 0) continue;
            gone.forEach((folder) => down.add(folder.split('/')[2]));
            parts.push(` photos gc --apply deleted ${gone.join(', ')} for ${other.tombstoneId}, so ${gone.length === 1 ? 'it' : 'they'} ${isAre(gone.length)} gone for good: only a backup of the data root brings ${gone.length === 1 ? 'it' : 'them'} back.`);
        }
        return { text: parts.join(''), rest: entry.assetRevisions.filter((assetRevision) => !down.has(assetRevision)).length };
    }
}
