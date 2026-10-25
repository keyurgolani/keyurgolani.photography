import path from 'node:path';
import { dataRoot, dataRootStatus } from '../storage/config';
import {
    CorruptDocumentError,
    EditedInPlaceError,
    readVersionedDocument,
    StaleVersionError,
    VersionLimitError,
    writeVersionedDocument,
    type StoredVersion,
    type VersionedWriteHooks,
} from '../storage/document';
import { ensureDirectory, realpathLoose } from '../storage/fsx';
import { LockTimeoutError, withLock, type LockContext, type LockRecord } from '../storage/lock';
import { CATALOG_SCHEMA_VERSION, parseAuthoredRecord, type AuthoredKind, type SchemaIssue } from './schema';
import type {
    AuthoredPhoto,
    AuthoredPhotoInput,
    AuthoredRecord,
    AuthoredRecordInput,
    AuthoredSeries,
    AuthoredSeriesInput,
    AuthoredSite,
    AuthoredSiteInput,
} from './types';
import { rebaseStamps, stampWrite } from './review';
import { authoredPaths, authoredRecordDir, isRecordId, readActivePointer, readAuthoredRecord, recordFolderProblem } from './working-layer';

/**
 * The one writer of the authored working layer. The public reader, the
 * watcher, and anything else on a read path never import this module.
 */

export const AUTHORED_LOCK = 'authored';
export const AUTHORED_LEASE_MS = 10_000;
export const AUTHORED_WAIT_MS = 10_000;

export type AuthoredWriteErrorCode = 'VERSION_CONFLICT' | 'AUTHORED_LOCKED' | 'LOCK_NOT_HELD' | 'INVALID_RECORD' | 'DATA_ROOT_NOT_READY';

export class AuthoredWriteError extends Error {
    readonly code: AuthoredWriteErrorCode;
    readonly record: { kind: AuthoredKind; id: string };
    /** For VERSION_CONFLICT. */
    readonly expectedVersion?: number;
    readonly foundVersion?: number;
    /** For AUTHORED_LOCKED: the record of whoever holds the lock, when it could be read. */
    readonly holder?: LockRecord | null;
    /** For INVALID_RECORD: field paths and messages, never a file path. */
    readonly issues?: SchemaIssue[];

    constructor(
        code: AuthoredWriteErrorCode,
        record: { kind: AuthoredKind; id: string },
        message: string,
        details: { expectedVersion?: number; foundVersion?: number; holder?: LockRecord | null; issues?: SchemaIssue[] } = {},
    ) {
        super(message);
        this.name = 'AuthoredWriteError';
        this.code = code;
        this.record = record;
        Object.assign(this, details);
    }
}

export interface WriteAuthoredOptions {
    /** The version the caller read, or 0 for a record it is creating. */
    expectedVersion: number;
    /** A held `authored` lock on this data root to reuse instead of taking one. */
    lock?: LockContext;
    /** Defaults to dataRoot(). */
    root?: string;
    /** How long to wait for the lock when not reusing one. */
    waitMs?: number;
    /** Test hooks, passed to writeVersionedDocument(). */
    hooks?: VersionedWriteHooks;
    /**
     * What the curator reviewed before this write, for #16's staleness
     * model. The writer stamps every field the write changes with it, under
     * the same hold (lib/catalog/review.ts). Without it, the stamp names the
     * active revision at the write, the actor `cli`, and the time of the write.
     */
    review?: ReviewInputs;
}

/** The inputs a reviewed write passes for #16: what was reviewed, against which active revision, and by whom. */
export interface ReviewInputs {
    /** The active revision the curator reviewed against, null before the first activation. */
    baseRevisionId: string | null;
    /** `generated` for a write nobody reviewed, such as #14's auto-include policy. Defaults to curator. */
    origin?: 'curator' | 'generated';
    /** The inbox event and the version of it the curator reviewed, when the write settles one. */
    event?: { id: string; version: number };
    /** For a confirmed replacement: the asset revision the record pinned, the one it pins now, and the set's profile. */
    asset?: { from: string; to: string; profileId: string };
    actor: string;
    reviewedAt: string;
}

/** The fields the writer owns, as ManagedField names them. */
export const MANAGED_FIELDS = ['schemaVersion', 'version', 'baseRevisionId', 'baseSeriesOrder', 'review'] as const;

/** The actor a stamp names when the caller passes no review inputs: one of #13 slice D's commands. */
export const DEFAULT_REVIEW_ACTOR = 'cli';
const MANAGED = new Set<string>(MANAGED_FIELDS);

function withoutManaged(record: AuthoredRecordInput): Record<string, unknown> {
    return Object.fromEntries(Object.entries(record).filter(([key]) => !MANAGED.has(key)));
}

/** The base Work order a rebase merged the site record against, read before withoutManaged() strips it. */
function rebasedSeriesOrder(record: AuthoredRecordInput): unknown {
    const value = (record as { baseSeriesOrder?: unknown }).baseSeriesOrder;
    return value === undefined ? null : value;
}

/** The newest stored version of a record, or null. A version that can't be used is INVALID_RECORD, with how to fix it. */
async function readStored(dir: string, ref: { kind: AuthoredKind; id: string }): Promise<StoredVersion | null> {
    try {
        return await readVersionedDocument(dir);
    } catch (error) {
        if (error instanceof EditedInPlaceError) {
            const { version } = error;
            throw new AuthoredWriteError(
                'INVALID_RECORD',
                ref,
                `The stored ${ref.kind} record ${ref.id} was edited in place (v${version}.json). To keep the edit, copy it to the next number while no command runs (cp -n v${version}.json v${version + 1}.json), then write again.`,
            );
        }
        if (error instanceof CorruptDocumentError) {
            throw new AuthoredWriteError('INVALID_RECORD', ref, `The stored ${ref.kind} record ${ref.id} can't be read: ${error.reason}. Fix it by hand first.`);
        }
        throw error;
    }
}

/** The revision a series' cover photo record pins, or null when there is no cover or no readable record. */
async function coverAsset(root: string, record: { kind: string; cover?: { photoId: string } | null } | null): Promise<string | null> {
    if (record?.kind !== 'series' || !record.cover) return null;
    try {
        return (await readAuthoredRecord(root, 'photo', record.cover.photoId))?.assetRevision ?? null;
    } catch {
        return null;
    }
}

async function commit(
    root: string,
    record: AuthoredRecordInput,
    ref: { kind: AuthoredKind; id: string },
    expectedVersion: number,
    hooks: VersionedWriteHooks | undefined,
    rebaseTo?: string,
    review?: ReviewInputs,
    published?: boolean,
): Promise<AuthoredRecord> {
    const dir = authoredRecordDir(root, ref.kind, ref.id);
    const folder = await recordFolderProblem(root, ref.kind, ref.id);
    if (folder !== null) throw new AuthoredWriteError('INVALID_RECORD', ref, `The ${ref.kind} record ${ref.id} can't be written: ${folder}.`);
    const stored = await readStored(dir, ref);
    let existing: AuthoredRecord | null = null;
    if (stored !== null) {
        const parsed = parseAuthoredRecord(ref.kind, stored.value);
        if (!parsed.ok) {
            const message = parsed.error.reason === 'unknown-schema-version'
                ? `The stored ${ref.kind} record ${ref.id} comes from a newer build, which this one can't read.`
                : `The stored ${ref.kind} record ${ref.id} can't be read. Fix it by hand first.`;
            throw new AuthoredWriteError('INVALID_RECORD', ref, message, { issues: parsed.error.issues });
        }
        existing = parsed.value;
        // As the reader does: a folder holding another record's versions is never extended as this one.
        if (ref.kind !== 'site' && (existing as AuthoredSeries | AuthoredPhoto).id !== ref.id) {
            const message = `its folder holds the record ${JSON.stringify((existing as AuthoredSeries | AuthoredPhoto).id)}`;
            throw new AuthoredWriteError('INVALID_RECORD', ref, `The ${ref.kind} record ${ref.id} can't be written: ${message}. Fix it by hand first.`, { issues: [{ path: 'id', message }] });
        }
    }

    const foundVersion = existing?.version ?? 0;
    if (foundVersion !== expectedVersion) {
        throw new AuthoredWriteError('VERSION_CONFLICT', ref, `The ${ref.kind} record ${ref.id} is at version ${foundVersion}, not ${expectedVersion}.`, { expectedVersion, foundVersion });
    }

    // An existing record keeps its base until a rebase moves it. A new one starts on the active revision.
    const active = rebaseTo === undefined && existing === null ? (await readActivePointer(root))?.revisionId ?? null : null;
    const baseRevisionId = rebaseTo ?? (existing ? existing.baseRevisionId : active);
    // What #16's stamps were reviewed against without review inputs: the active revision, read as a new record's base
    // is. An existing record's write never failed on the pointer before stamps, so one that can't be read gives its base.
    const reviewedAgainst = rebaseTo !== undefined || review
        ? review?.baseRevisionId ?? null
        : existing === null ? active : await readActivePointer(root).then((pointer) => pointer?.revisionId ?? null, () => existing.baseRevisionId);
    // The site record's base Work order moves with its base, so only a rebase sets it, from the record it merged.
    // Any other write keeps the stored value, and a new record's is unknown.
    const site = ref.kind === 'site'
        ? { baseSeriesOrder: rebaseTo !== undefined ? rebasedSeriesOrder(record) : (existing as AuthoredSite | null)?.baseSeriesOrder ?? null }
        : {};
    const next = { ...withoutManaged(record), schemaVersion: CATALOG_SCHEMA_VERSION, version: expectedVersion + 1, baseRevisionId, ...site };
    const unstamped = parseAuthoredRecord(ref.kind, next);
    if (!unstamped.ok) throw new AuthoredWriteError('INVALID_RECORD', ref, `The ${ref.kind} record ${ref.id} is not valid.`, { issues: unstamped.error.issues });
    // #16's stamps, under the same hold: a rebase keeps those of the fields it left alone, and any other write stamps
    // what it changed with what the curator reviewed, keeping the rest as they were.
    const stamps = rebaseTo !== undefined
        ? rebaseStamps(existing, unstamped.value, await coverAsset(root, existing), new Date().toISOString(), published ? rebaseTo : undefined)
        : stampWrite(existing, unstamped.value, {
            baseRevisionId: reviewedAgainst,
            ...(review?.origin ? { origin: review.origin } : {}),
            ...(review?.event ? { event: review.event } : {}),
            ...(review?.asset ? { asset: review.asset } : {}),
            actor: review?.actor ?? DEFAULT_REVIEW_ACTOR,
            reviewedAt: review?.reviewedAt ?? new Date().toISOString(),
        }, { next: await coverAsset(root, unstamped.value), existing: await coverAsset(root, existing) });
    const parsed = parseAuthoredRecord(ref.kind, stamps ? { ...unstamped.value, review: stamps } : unstamped.value);
    if (!parsed.ok) throw new AuthoredWriteError('INVALID_RECORD', ref, `The ${ref.kind} record ${ref.id} is not valid.`, { issues: parsed.error.issues });

    const paths = authoredPaths(root);
    // A first version survives a crash only with every folder above it synced, including ones another writer made.
    const syncParent = expectedVersion === 0;
    await ensureDirectory(paths.dir, { syncParent });
    if (ref.kind !== 'site') await ensureDirectory(path.dirname(dir), { syncParent });
    // The lock keeps writers apart only while it holds. One past its lease may still be between its read and its
    // commit, so the commit is a compare-and-swap too, and of two writers at one version only one gets through.
    try {
        return await writeVersionedDocument(dir, parsed.value, expectedVersion, { hooks });
    } catch (error) {
        if (error instanceof VersionLimitError) {
            throw new AuthoredWriteError('INVALID_RECORD', ref, `The stored ${ref.kind} record ${ref.id} is at version ${error.version}, the highest a version can be. Fix it by hand first.`);
        }
        if (!(error instanceof StaleVersionError)) throw error;
        throw new AuthoredWriteError('VERSION_CONFLICT', ref, `The ${ref.kind} record ${ref.id} is at version ${error.found}, not ${expectedVersion}.`, { expectedVersion, foundVersion: error.found });
    }
}

/**
 * Write one authored record with compare-and-swap on `version`. Takes
 * `withLock('authored', {leaseMs: 10_000})`, or reuses `lock` when the caller
 * already holds it. Fails with VERSION_CONFLICT unless the stored record is at
 * `expectedVersion` (0 for none), and commits it as the next version file in
 * the record's folder, as writeVersionedDocument() commits it, so of two
 * writers that read one version only one stores the next, even when one of
 * them lost the lock. A record edited in place is INVALID_RECORD. An
 * existing record keeps its `baseRevisionId`; a new one takes the active
 * revision, or null before the first activation. The site record keeps its
 * `baseSeriesOrder` the same way, and a new one starts at null (unknown).
 * Under the same hold it stamps #16's `review` on every field the write
 * changes, with `options.review` or the CLI's defaults, and keeps every
 * other field's stamp (lib/catalog/review.ts's stampWrite()).
 */
export function writeAuthoredRecord(record: AuthoredSiteInput, options: WriteAuthoredOptions): Promise<AuthoredSite>;
export function writeAuthoredRecord(record: AuthoredSeriesInput, options: WriteAuthoredOptions): Promise<AuthoredSeries>;
export function writeAuthoredRecord(record: AuthoredPhotoInput, options: WriteAuthoredOptions): Promise<AuthoredPhoto>;
export async function writeAuthoredRecord(record: AuthoredRecordInput, options: WriteAuthoredOptions): Promise<AuthoredRecord> {
    const { expectedVersion, lock, waitMs = AUTHORED_WAIT_MS, hooks } = options;
    const kind = record.kind as AuthoredKind;
    const id = kind === 'site' ? 'site' : String((record as { id?: unknown }).id);
    const ref = { kind, id };
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new RangeError(`expectedVersion must be a non-negative integer, got ${expectedVersion}`);
    if (!['site', 'series', 'photo'].includes(kind)) {
        throw new AuthoredWriteError('INVALID_RECORD', ref, `Unknown record kind ${JSON.stringify(kind)}.`, { issues: [{ path: 'kind', message: 'must be site, series, or photo' }] });
    }
    if (!isRecordId(kind, id)) {
        throw new AuthoredWriteError('INVALID_RECORD', ref, `${JSON.stringify(id)} can't name a ${kind} record.`, { issues: [{ path: 'id', message: `is not a valid ${kind} ID` }] });
    }

    const named = options.root ?? dataRoot();
    if (named === null) throw new AuthoredWriteError('DATA_ROOT_NOT_READY', ref, 'PHOTOGRAPHY_DATA_DIR is not set.');
    const root = path.resolve(named);
    const status = dataRootStatus({ versioned: true, root });
    if (status.state !== 'ready') {
        throw new AuthoredWriteError('DATA_ROOT_NOT_READY', ref, `The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}.`);
    }

    if (lock) {
        if (lock.name !== AUTHORED_LOCK || realpathLoose(lock.root) !== realpathLoose(root) || lock.signal.aborted) {
            throw new AuthoredWriteError('LOCK_NOT_HELD', ref, 'The lock passed in is not a live hold on this data root\'s authored lock.');
        }
        return commit(root, record, ref, expectedVersion, hooks, undefined, options.review);
    }
    try {
        return await withLock(AUTHORED_LOCK, { root, leaseMs: AUTHORED_LEASE_MS, waitMs }, async ({ signal }) => {
            signal.throwIfAborted();
            return commit(root, record, ref, expectedVersion, hooks, undefined, options.review);
        });
    } catch (error) {
        if (error instanceof LockTimeoutError) throw new AuthoredWriteError('AUTHORED_LOCKED', ref, error.message, { holder: error.holder });
        throw error;
    }
}

export interface WriteRebasedOptions {
    /** The version the rebase read. */
    expectedVersion: number;
    /** The authored lock the rebase holds. Required: a rebase never writes without it. */
    lock: LockContext;
    /** The revision the record is now based on. */
    baseRevisionId: string;
    /** That revision was published from this working layer, so #16's stamps move their base to it too (rebaseStamps()). */
    published?: boolean;
    hooks?: VersionedWriteHooks;
}

/**
 * Write a record that rebaseWorkingLayer() merged onto `baseRevisionId`. The
 * only write that moves an existing record's base. It checks `version` the
 * way writeAuthoredRecord() does, under the caller's authored hold. For the
 * site record it also stores the `baseSeriesOrder` the rebase merged against,
 * the one write that sets that field. It reviews nothing: it keeps #16's
 * stamps of the fields it left alone and drops those of the fields it moved
 * (rebaseStamps()).
 */
export function writeRebasedRecord(record: AuthoredSiteInput, options: WriteRebasedOptions): Promise<AuthoredSite>;
export function writeRebasedRecord(record: AuthoredSeriesInput, options: WriteRebasedOptions): Promise<AuthoredSeries>;
export function writeRebasedRecord(record: AuthoredPhotoInput, options: WriteRebasedOptions): Promise<AuthoredPhoto>;
export async function writeRebasedRecord(record: AuthoredRecordInput, options: WriteRebasedOptions): Promise<AuthoredRecord> {
    const { expectedVersion, lock, baseRevisionId, hooks, published } = options;
    const kind = record.kind as AuthoredKind;
    const id = kind === 'site' ? 'site' : String((record as { id?: unknown }).id);
    const ref = { kind, id };
    if (lock.name !== AUTHORED_LOCK || lock.signal.aborted) {
        throw new AuthoredWriteError('LOCK_NOT_HELD', ref, 'A rebase writes only under a live hold on the authored lock.');
    }
    return commit(path.resolve(lock.root), record, ref, expectedVersion, hooks, baseRevisionId, undefined, published);
}
