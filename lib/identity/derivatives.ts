import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp, { type Metadata } from 'sharp';
import { assetDir } from '../media/path';
import { dataRootStatus, libraryRoot } from '../storage/config';
import { hasErrorCode, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, withoutAbsolutePaths } from '../storage/fsx';
import { LockTimeoutError, withLock } from '../storage/lock';
import { IntegrityError, MANIFEST_FILE, manifestFiles, publishDirectory, readDirectoryManifest, verifyDirectory, type DirectoryManifest } from '../storage/publish';
import { classifyDecodeFailure, failureCodeOf } from './failures';
import { assetRevisionOf, sha256, type Hasher } from './ids';
import { encodeLqip, encodeVariant, lqipDataUri, MAX_SOURCE_PIXELS, PROFILE_1, variantWidthFor } from './profile';
import { readRegistry, writeRegistry } from './registry';
import type { AssetManifest, DerivativeJob, ProfileEntry, Registry, VariantFile } from './types';
import { VARIANT_FORMATS, VARIANT_WIDTHS, type VariantFormat, type VariantWidth } from './variants';

/**
 * The derivative writer: one set per (photoId, assetRevision, profileId),
 * built from one read of the source. Freshness is never judged by time. A
 * set is checked against the bytes that made it: the source must hash to the
 * job's asset revision before anything is encoded, and a set already in
 * place is kept only if its manifest names the same photo, revision, and
 * profile, lists every variant the profile builds and no others, and every
 * file matches its size and SHA-256. The manifest is written last, so a set
 * without one was never finished. A build holds stagingLockName(<id>) for as
 * long as its `staging/<id>` folder exists, so a starting worker can remove
 * the folders of killed builds without touching a live one's. It also holds
 * assetLockName(<photoId>, <assetRevision>) from before that folder exists
 * through the publish, and `photos gc --set-aside` takes the same lock, so
 * "build a set for X" and "set X aside" never run at once.
 *
 * resolveAsset() and the manifest reader live in lib/media/manifest.ts, so
 * the web process can read sets without loading the encoder.
 */

type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

/** Test hooks. Each runs at its point in the build and may throw to simulate a fault there. */
export interface WriterFaults {
    /** After `<variant>.<format>` is encoded, before it is checked: return other bytes to stand in for a faulty encoder. */
    afterEncode?(name: string, data: Buffer): Buffer | void | Promise<Buffer | void>;
    /** After `<variant>.<format>` is written to staging. */
    afterVariant?(name: string): void | Promise<void>;
    /** After every variant validates, before manifest.json is written. */
    beforeManifest?(): void | Promise<void>;
    /** After the manifest, before the staging directory is renamed into place. */
    beforePublish?(): void | Promise<void>;
    /** After the set is in place, before the registry records it. A throw here is a crash: the set stays, the entry stays pending. */
    beforeRecord?(): void | Promise<void>;
    /** Writes each staging file, so a test can fail one with ENOSPC. */
    writeFile?(file: string, data: Uint8Array): Promise<void>;
}

export interface BuildOptions {
    /** The data root. Defaults to the configured one. */
    root?: string;
    /** The library. Defaults to libraryRoot(). */
    library?: string;
    hasher?: Hasher;
    clock?: () => number;
    idGen?: () => string;
    faults?: WriterFaults;
    lock?: { waitMs?: number; leaseMs?: number };
    logger?: Logger;
    /**
     * A6 (#17): retry a transient failure (one with no code, lib/identity/failures.ts)
     * after each of `delaysMs`, by leaving the entry pending with its next try,
     * then record `retries-exhausted`. Without it, as for a direct call, every
     * failure is recorded as failed, as before. The worker passes one.
     */
    retry?: { delaysMs: readonly number[] };
    /** The pixel cap, MAX_SOURCE_PIXELS by default. Tests lower it. */
    maxSourcePixels?: number;
}

export type BuildOutcome =
    /** Built now, or kept a valid set already in place (`reused`). */
    | { status: 'ready'; reused: boolean }
    /** Recorded as failed. `cause` is the error, an IntegrityError for a bad set in place. */
    | { status: 'failed'; error: string; cause?: unknown }
    /** Left pending. The source changed since the last pass, so run another, or the registry lock was busy. */
    | { status: 'pending'; reason: 'digest-mismatch' | 'source-changing' | 'locked' }
    /** A6: a transient failure, left pending for its retry number `retries`, due at `retryAt`. */
    | { status: 'pending'; reason: 'retrying'; retries: number; retryAt: string; error: string }
    /**
     * A6 review: reading the source failed while the library root itself
     * can't be read or is gone. Nothing is recorded, and the worker pauses
     * until a pass finds the library again.
     */
    | { status: 'pending'; reason: 'library-unavailable' }
    /** Nothing to do, and nothing changed. */
    | { status: 'skipped'; reason: 'data-root' | 'unknown' | 'reassigned' | 'not-pending' | 'source-missing' };

/** Where builds stage, beside `assets/` so the publishing rename stays on one device. */
export function stagingRoot(root: string): string {
    return path.join(/*turbopackIgnore: true*/ root, 'staging');
}

/** The lock a build holds while `staging/<id>` exists. */
export function stagingLockName(id: string): string {
    return `build-${id}`;
}

/**
 * The lock a build holds for one asset revision, from before its staging
 * folder exists through the publish, and `photos gc --set-aside` holds for
 * the folder it moves (#181's A10 review, item 40a). Photo IDs hold `_`, which
 * a lock name can't, so it is a digest of the pair.
 */
export function assetLockName(photoId: string, assetRevision: string): string {
    return `asset-${createHash('sha256').update(`${photoId}\n${assetRevision}`).digest('hex').slice(0, 32)}`;
}

/** A name a build's staging folder can have: one that makes a valid lock name. #15's GC considers only these too. */
export const STAGING_ID = /^[a-z0-9-]+$/;

const iso = (ms: number) => new Date(ms).toISOString();
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A decoder's error, named by its code (lib/identity/failures.ts), so the recorded reason says whether a retry can help. */
class DecodeFailure extends Error {
    constructor(code: string, cause: unknown) {
        super(`${code}: ${errorText(cause)}`, { cause });
        this.name = 'DecodeFailure';
    }
}

/**
 * A6 review: the reason a build that threw records. An IntegrityError is
 * `corrupt-destination` (`integrity: ...`) only for the set's own folder,
 * `finalDir`; one for any other folder, such as staging checked before the
 * rename, names no code, so it retries.
 */
export function buildFailureText(error: unknown, finalDir: string): string {
    if (error instanceof IntegrityError) return `${error.dir === finalDir ? 'integrity' : 'staging check failed'}: ${error.problems.join('; ')}`;
    return errorText(error);
}

/** Whether the library root can still be listed: the difference between one unreadable file and an outage. */
async function libraryReadable(library: string): Promise<boolean> {
    try {
        await fs.promises.readdir(library);
        return true;
    } catch {
        return false;
    }
}

/** `step`, with a decoder's error rethrown as a DecodeFailure. An errno error is rethrown as it is. */
async function decoding<T>(step: () => Promise<T>): Promise<T> {
    try {
        return await step();
    } catch (error) {
        const code = classifyDecodeFailure(error);
        throw code === null ? error : new DecodeFailure(code, error);
    }
}

/**
 * Remove the staging folders that builds killed before publishing left, at
 * watcher start. A folder whose lock this takes belongs to no live build. A
 * build killed less than a lease ago still holds its lock, so a later start
 * removes its folder. Anything in `staging/` a build doesn't make is left
 * alone, and a folder that can't be removed is logged and left for the next
 * start. Returns the names removed.
 *
 * #181's A10 guard: it removes only direct children of `staging/`, follows
 * no symlink (an entry that is a symlink is unlinked as a link), and stays
 * inside `staging/` by dev:inode: `staging/` must be a real folder, and
 * right before each delete it must still be the folder first listed, by
 * dev and inode. `staging/` that is a symlink clears nothing.
 */
export async function removeAbandonedStaging(root: string, { leaseMs, logger = console, hooks = {} }: { leaseMs?: number; logger?: Logger; hooks?: { beforeClear?(name: string): void | Promise<void> } } = {}): Promise<string[]> {
    const dir = stagingRoot(root);
    let staging: fs.Stats;
    let entries: fs.Dirent[];
    try {
        staging = await fs.promises.lstat(dir);
        if (staging.isSymbolicLink() || !staging.isDirectory()) {
            logger.warn('[derivatives] staging/ is a symlink or not a folder, so nothing in it was removed.');
            return [];
        }
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return [];
        throw error;
    }
    const removed: string[] = [];
    for (const name of entries.filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && STAGING_ID.test(entry.name)).map((entry) => entry.name).sort()) {
        try {
            const cleared = await withLock(stagingLockName(name), { root, waitMs: 0, leaseMs }, async () => {
                await hooks.beforeClear?.(name);
                return clearStagingEntry(dir, name, staging);
            });
            if (cleared) removed.push(name);
        } catch (error) {
            // Held: a live build owns the folder, or one killed too recently to tell.
            if (error instanceof LockTimeoutError) continue;
            logger.warn(`[derivatives] Could not remove staging/${name}: ${errorText(error)}`);
        }
    }
    return removed;
}

/**
 * Remove one direct child of `staging/`, checked in the same tick as its
 * delete: `staging/` is still the folder `staging` describes, by dev and
 * inode and no symlink, and the entry is a symlink, unlinked as a link, or a
 * real folder on `staging/`'s own device, removed without following any
 * link in it. Anything else is left. Throws when `staging/` changed. Returns whether it removed it.
 */
async function clearStagingEntry(dir: string, name: string, staging: fs.Stats): Promise<boolean> {
    const now = fs.lstatSync(dir);
    if (now.isSymbolicLink() || now.dev !== staging.dev || now.ino !== staging.ino) throw new Error('staging/ is no longer the folder that was listed, so nothing more was removed');
    const target = path.join(dir, name);
    const entry = fs.lstatSync(target);
    // A direct child lives on staging/'s own device: one on another is a mount, which the clear never reaches into.
    if (entry.dev !== staging.dev) throw new Error(`staging/${name} is on another device than staging/, so it was left`);
    if (entry.isSymbolicLink()) {
        await fs.promises.unlink(target);
        return true;
    }
    if (!entry.isDirectory()) return false;
    // rm() unlinks a symlink inside the folder rather than following it.
    await fs.promises.rm(target, { recursive: true, force: true });
    return true;
}

/** The files a build writes, by name. */
const VARIANT_FILES = VARIANT_WIDTHS.flatMap((width) => VARIANT_FORMATS.map((format) => `${width}.${format}`));

/** How a set's file list differs from what a build writes. Empty when they match. */
function variantDifferences(manifest: DirectoryManifest | null): string[] {
    if (!manifest) return ['no manifest'];
    const listed = new Set(manifestFiles(manifest).map((file) => file.name));
    return [
        ...VARIANT_FILES.filter((name) => !listed.has(name)).map((name) => `lists no ${name}, which the profile builds`),
        ...[...listed].filter((name) => !VARIANT_FILES.includes(name)).sort().map((name) => `lists ${name}, which the profile doesn't build`),
    ];
}

async function lqipOf(source: Buffer, limitInputPixels: number): Promise<string> {
    return lqipDataUri(await decoding(() => encodeLqip(source, { limitInputPixels })));
}

/** Decode an encoded file and check it is what the profile promised. Returns its dimensions. */
async function validated(name: string, data: Buffer, format: VariantFormat, expectedWidth: number): Promise<{ width: number; height: number }> {
    if (data.length === 0) throw new Error(`${name} is empty`);
    let metadata: Metadata;
    try {
        metadata = await sharp(data).metadata();
    } catch (error) {
        throw new Error(`${name} doesn't decode: ${errorText(error)}`);
    }
    if (metadata.format !== (format === 'avif' ? 'heif' : 'webp')) throw new Error(`${name} decodes as ${metadata.format}`);
    if (metadata.width !== expectedWidth || !metadata.height) throw new Error(`${name} is ${metadata.width}x${metadata.height}, expected ${expectedWidth} wide`);
    if (metadata.exif || metadata.xmp || metadata.iptc) throw new Error(`${name} carries metadata`);
    return { width: metadata.width, height: metadata.height };
}

/**
 * Record the build's result under the registry lock, if the entry is still
 * the pending one this build was for and `still`, given the registry as it
 * is now, holds. Returns false when `still` doesn't, recording nothing.
 */
async function record(
    root: string,
    job: DerivativeJob,
    entry: (current: ProfileEntry) => ProfileEntry,
    options: BuildOptions,
    still: (registry: Registry) => boolean = () => true,
): Promise<boolean> {
    return withLock('registry', { root, waitMs: options.lock?.waitMs, leaseMs: options.lock?.leaseMs }, async ({ signal }) => {
        const registry = await readRegistry(root);
        const revision = registry.photos[job.photoId]?.revisions[job.assetRevision];
        const current = revision?.profiles[job.profileId];
        if (!revision || revision.reassignedTo || !current || current.state !== 'pending') return true;
        if (!still(registry)) return false;
        revision.profiles[job.profileId] = entry(current);
        signal.throwIfAborted();
        await writeRegistry(root, { ...registry, updatedAt: iso((options.clock ?? Date.now)()) }, registry.version);
        return true;
    });
}

/**
 * Build the derivative set for one pending registry entry, and record it.
 * Skips encoding when a valid set is already in place, which also makes a
 * restart after a crash between publishing and recording mark it ready.
 * Fails with `source-superseded` when the bound path holds another revision
 * now, as the registry says under its lock, and leaves the entry pending when
 * the source no longer hashes to the job's revision. Any failure before publishing removes the staging
 * directory and records `failed`, changing nothing else.
 */
export async function buildDerivativeSet(job: DerivativeJob, options: BuildOptions = {}): Promise<BuildOutcome> {
    const { hasher = sha256, clock = Date.now, idGen = randomUUID, faults = {}, logger = console } = options;
    const status = dataRootStatus(options.root === undefined ? { versioned: true } : { versioned: true, root: options.root });
    if (status.state !== 'ready' || status.root === null) return { status: 'skipped', reason: 'data-root' };
    const root = status.root;

    const registry = await readRegistry(root);
    const photo = registry.photos[job.photoId];
    const revision = photo?.revisions[job.assetRevision];
    if (!photo || !revision) return { status: 'skipped', reason: 'unknown' };
    if (revision.reassignedTo) return { status: 'skipped', reason: 'reassigned' };
    if (revision.profiles[job.profileId]?.state !== 'pending') return { status: 'skipped', reason: 'not-pending' };

    const recordReady = async (reused: boolean): Promise<BuildOutcome> => {
        await faults.beforeRecord?.();
        try {
            await record(root, job, (current) => ({ state: 'ready', attempts: current.attempts + 1, readyAt: iso(clock()) }), options);
        } catch (error) {
            // The set is in place, so the next build finds it and records it.
            if (error instanceof LockTimeoutError) return { status: 'pending', reason: 'locked' };
            throw error;
        }
        return { status: 'ready', reused };
    };
    const library = options.library ?? libraryRoot();
    // The reason goes into the registry and `photos identity status`, so it names files relative to the library or the data root, never where they live on the host.
    const recordFailed = async (reason: string, cause?: unknown, still?: (current: Registry) => boolean): Promise<BuildOutcome> => {
        const error = withoutAbsolutePaths(reason, [library, root]);
        const delays = options.retry?.delaysMs;
        // What the entry became, decided under the lock from the retries it already had.
        let written: ProfileEntry | null = null;
        const next = (current: ProfileEntry): ProfileEntry => {
            const attempts = current.attempts + 1;
            // The requeue an io-error already had (A6 review) stays with the entry, so it isn't given again.
            const requeued = current.requeuedFor === undefined ? {} : { requeuedFor: current.requeuedFor };
            if (delays === undefined || failureCodeOf(error) !== null) {
                written = { state: 'failed', attempts, error, ...requeued };
            } else {
                const retries = current.retries ?? 0;
                written = retries < delays.length
                    ? { state: 'pending', attempts, error, retries: retries + 1, retryAt: iso(clock() + delays[retries]), ...requeued }
                    : { state: 'failed', attempts, error: `retries-exhausted: ${error}`, ...requeued };
            }
            return written;
        };
        try {
            if (!await record(root, job, next, options, still)) {
                return { status: 'pending', reason: 'source-changing' };
            }
        } catch (lockError) {
            if (lockError instanceof LockTimeoutError) return { status: 'pending', reason: 'locked' };
            throw lockError;
        }
        const entry = written as ProfileEntry | null;
        if (entry?.state === 'pending' && entry.retries !== undefined && entry.retryAt !== undefined) {
            logger.warn(`[derivatives] ${job.photoId} ${job.assetRevision} ${job.profileId} failed, and retries at ${entry.retryAt} (retry ${entry.retries} of ${delays?.length ?? 0}): ${error}`);
            return { status: 'pending', reason: 'retrying', retries: entry.retries, retryAt: entry.retryAt, error };
        }
        const recorded = entry?.error ?? error;
        logger.warn(`[derivatives] ${job.photoId} ${job.assetRevision} ${job.profileId} failed: ${recorded}`);
        return { status: 'failed', error: recorded, ...(cause === undefined ? {} : { cause }) };
    };

    // A set already in place is kept if it matches, and never overwritten if it doesn't.
    const finalDir = assetDir(job, root);
    if (fs.existsSync(finalDir)) {
        const problems = await verifyDirectory(finalDir, job);
        // Checking out against its own manifest isn't enough: it has to list what this profile builds.
        if (problems.length === 0) problems.push(...variantDifferences(await readDirectoryManifest(finalDir)));
        if (problems.length === 0) return recordReady(true);
        const integrity = new IntegrityError(finalDir, problems);
        return recordFailed(`integrity: ${problems.join('; ')}`, integrity);
    }

    // Build only from the bytes the job names, read once and checked by digest, never by timestamps.
    if (!photo.source.present) return { status: 'skipped', reason: 'source-missing' };
    if (photo.source.observedRevision !== job.assetRevision) {
        // Read without the lock, so a pass may have brought the revision back since, as a revert does. Checked again under it.
        return recordFailed('source-superseded', undefined, (current) => current.photos[job.photoId]?.source.observedRevision !== job.assetRevision);
    }
    let source: Buffer;
    try {
        source = await fs.promises.readFile(path.join(library, photo.source.path));
    } catch (error) {
        // A6 review: an outage, not this file. Record nothing, so no set fails for a share that dropped out.
        if (!await libraryReadable(library)) return { status: 'pending', reason: 'library-unavailable' };
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return { status: 'pending', reason: 'source-changing' };
        return recordFailed(`source unreadable: ${errorText(error)}`, error);
    }
    if (assetRevisionOf(source, hasher) !== job.assetRevision) return { status: 'pending', reason: 'digest-mismatch' };
    if (revision.width === null || revision.height === null) return recordFailed('undecodable');
    const { width: orientedWidth, height: orientedHeight } = revision;
    // A6: the pixel cap, from #10's recorded size before anything is decoded, and Sharp's own as it decodes.
    const maxPixels = options.maxSourcePixels ?? MAX_SOURCE_PIXELS;
    if (orientedWidth * orientedHeight > maxPixels) return recordFailed(`too-large: ${orientedWidth}x${orientedHeight} is over the ${maxPixels}-pixel cap`);

    const id = idGen();
    const staging = path.join(stagingRoot(root), id);
    const writeFile = faults.writeFile ?? ((file: string, data: Uint8Array) => fs.promises.writeFile(file, data, { mode: PRIVATE_FILE_MODE, flag: 'wx' }));
    // The asset's lock, then the folder's: --set-aside can't move this asset while the build stages or publishes it.
    let assetLocked = false;
    try {
        await withLock(assetLockName(job.photoId, job.assetRevision), { root, waitMs: 0, leaseMs: options.lock?.leaseMs }, async (assetLock) => {
            assetLocked = true;
            // Taken before the folder exists and let go only once it is published or removed.
            await withLock(stagingLockName(id), { root, waitMs: 0, leaseMs: options.lock?.leaseMs }, async ({ signal }) => {
                try {
                    await fs.promises.mkdir(staging, { recursive: true, mode: PRIVATE_DIR_MODE });
                    const variants = {} as Record<VariantWidth, Record<VariantFormat, VariantFile>>;
                    for (const width of VARIANT_WIDTHS) {
                        variants[width] = {} as Record<VariantFormat, VariantFile>;
                        for (const format of VARIANT_FORMATS) {
                            const name = `${width}.${format}`;
                            const encoded = await decoding(() => encodeVariant(source, width, format, { limitInputPixels: maxPixels }));
                            const data = (await faults.afterEncode?.(name, encoded)) ?? encoded;
                            const size = await validated(name, data, format, variantWidthFor(orientedWidth, orientedHeight, PROFILE_1.variants[width].width));
                            await writeFile(path.join(staging, name), data);
                            variants[width][format] = { ...size, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
                            await faults.afterVariant?.(name);
                        }
                    }
                    const manifest: AssetManifest = {
                        schemaVersion: 1,
                        photoId: job.photoId,
                        assetRevision: job.assetRevision,
                        profileId: job.profileId,
                        variants,
                        lqip: await lqipOf(source, maxPixels),
                        createdAt: iso(clock()),
                    };
                    await faults.beforeManifest?.();
                    await writeFile(path.join(staging, MANIFEST_FILE), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
                    await faults.beforePublish?.();
                    // A build that stalled past its lease may have lost the folder to a starting worker, or the asset to --set-aside.
                    signal.throwIfAborted();
                    assetLock.signal.throwIfAborted();
                    await publishDirectory(staging, finalDir);
                } catch (error) {
                    await fs.promises.rm(staging, { recursive: true, force: true });
                    throw error;
                }
            });
        });
    } catch (error) {
        // Another command holds the asset: --set-aside, most likely. The entry stays pending for the next pass.
        if (!assetLocked && error instanceof LockTimeoutError) return { status: 'pending', reason: 'locked' };
        return recordFailed(buildFailureText(error, finalDir), error);
    }
    return recordReady(false);
}
