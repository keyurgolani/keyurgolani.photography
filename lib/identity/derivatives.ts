import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp, { type Metadata } from 'sharp';
import { assetDir } from '../media/path';
import { dataRootStatus, libraryRoot } from '../storage/config';
import { hasErrorCode, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from '../storage/fsx';
import { LockTimeoutError, withLock } from '../storage/lock';
import { IntegrityError, MANIFEST_FILE, publishDirectory, verifyDirectory } from '../storage/publish';
import { assetRevisionOf, sha256, type Hasher } from './ids';
import { PROFILE_1 } from './profile';
import { readRegistry, writeRegistry } from './registry';
import type { AssetManifest, DerivativeJob, ProfileEntry, VariantFile } from './types';
import { VARIANT_FORMATS, VARIANT_WIDTHS, type VariantFormat, type VariantWidth } from './variants';

/**
 * The derivative writer: one set per (photoId, assetRevision, profileId),
 * built from one read of the source. Freshness is never judged by time. A
 * set is checked against the bytes that made it: the source must hash to the
 * job's asset revision before anything is encoded, and a set already in
 * place is kept only if its manifest names the same photo, revision, and
 * profile and every file matches its size and SHA-256. The manifest is
 * written last, so a set without one was never finished.
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
}

export type BuildOutcome =
    /** Built now, or kept a valid set already in place (`reused`). */
    | { status: 'ready'; reused: boolean }
    /** Recorded as failed. `cause` is the error, an IntegrityError for a bad set in place. */
    | { status: 'failed'; error: string; cause?: unknown }
    /** Left pending. The source changed since the last pass, so run another, or the registry lock was busy. */
    | { status: 'pending'; reason: 'digest-mismatch' | 'source-changing' | 'locked' }
    /** Nothing to do, and nothing changed. */
    | { status: 'skipped'; reason: 'data-root' | 'unknown' | 'reassigned' | 'not-pending' | 'source-missing' };

/** Where builds stage, beside `assets/` so the publishing rename stays on one device. */
export function stagingRoot(root: string): string {
    return path.join(root, 'staging');
}

const iso = (ms: number) => new Date(ms).toISOString();
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Encode one variant the way profile 1 says: upright, inside the width, never enlarged, no metadata. */
async function encode(source: Buffer, width: VariantWidth, format: VariantFormat): Promise<Buffer> {
    const recipe = PROFILE_1.variants[width];
    const resized = sharp(source).autoOrient().resize(recipe.width, undefined, PROFILE_1.resize);
    return (format === 'avif' ? resized.avif(recipe.avif) : resized.webp(recipe.webp)).toBuffer();
}

async function lqipOf(source: Buffer): Promise<string> {
    const { size, fit, webp } = PROFILE_1.lqip;
    const data = await sharp(source).autoOrient().resize(size, size, { fit }).webp(webp).toBuffer();
    return `data:image/webp;base64,${data.toString('base64')}`;
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

/** Record the build's result under the registry lock, if the entry is still the pending one this build was for. */
async function record(root: string, job: DerivativeJob, entry: (current: ProfileEntry) => ProfileEntry, options: BuildOptions): Promise<void> {
    await withLock('registry', { root, waitMs: options.lock?.waitMs, leaseMs: options.lock?.leaseMs }, async ({ signal }) => {
        const registry = await readRegistry(root);
        const revision = registry.photos[job.photoId]?.revisions[job.assetRevision];
        const current = revision?.profiles[job.profileId];
        if (!revision || revision.reassignedTo || !current || current.state !== 'pending') return;
        revision.profiles[job.profileId] = entry(current);
        signal.throwIfAborted();
        await writeRegistry(root, { ...registry, updatedAt: iso((options.clock ?? Date.now)()) }, registry.version);
    });
}

/**
 * Build the derivative set for one pending registry entry, and record it.
 * Skips encoding when a valid set is already in place, which also makes a
 * restart after a crash between publishing and recording mark it ready.
 * Fails with `source-superseded` when the bound path holds another revision
 * now, and leaves the entry pending when the source no longer hashes to the
 * job's revision. Any failure before publishing removes the staging
 * directory and records `failed`, changing nothing else.
 */
export async function buildDerivativeSet(job: DerivativeJob, options: BuildOptions = {}): Promise<BuildOutcome> {
    const { hasher = sha256, clock = Date.now, idGen = randomUUID, faults = {}, logger = console } = options;
    const status = dataRootStatus(options.root === undefined ? { write: true } : { write: true, root: options.root });
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
    const recordFailed = async (error: string, cause?: unknown): Promise<BuildOutcome> => {
        logger.warn(`[derivatives] ${job.photoId} ${job.assetRevision} ${job.profileId} failed: ${error}`);
        try {
            await record(root, job, (current) => ({ state: 'failed', attempts: current.attempts + 1, error }), options);
        } catch (lockError) {
            if (lockError instanceof LockTimeoutError) return { status: 'pending', reason: 'locked' };
            throw lockError;
        }
        return { status: 'failed', error, ...(cause === undefined ? {} : { cause }) };
    };

    // A set already in place is kept if it matches, and never overwritten if it doesn't.
    const finalDir = assetDir(job, root);
    if (fs.existsSync(finalDir)) {
        const problems = await verifyDirectory(finalDir, job);
        if (problems.length === 0) return recordReady(true);
        const integrity = new IntegrityError(finalDir, problems);
        return recordFailed(`integrity: ${problems.join('; ')}`, integrity);
    }

    // Build only from the bytes the job names, read once and checked by digest, never by timestamps.
    if (!photo.source.present) return { status: 'skipped', reason: 'source-missing' };
    if (photo.source.observedRevision !== job.assetRevision) return recordFailed('source-superseded');
    let source: Buffer;
    try {
        source = await fs.promises.readFile(path.join(options.library ?? libraryRoot(), photo.source.path));
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return { status: 'pending', reason: 'source-changing' };
        return recordFailed(`source unreadable: ${errorText(error)}`, error);
    }
    if (assetRevisionOf(source, hasher) !== job.assetRevision) return { status: 'pending', reason: 'digest-mismatch' };
    if (revision.width === null) return recordFailed('undecodable');
    const orientedWidth = revision.width;

    const staging = path.join(stagingRoot(root), idGen());
    const writeFile = faults.writeFile ?? ((file: string, data: Uint8Array) => fs.promises.writeFile(file, data, { mode: PRIVATE_FILE_MODE, flag: 'wx' }));
    try {
        await fs.promises.mkdir(staging, { recursive: true, mode: PRIVATE_DIR_MODE });
        const variants = {} as Record<VariantWidth, Record<VariantFormat, VariantFile>>;
        for (const width of VARIANT_WIDTHS) {
            variants[width] = {} as Record<VariantFormat, VariantFile>;
            for (const format of VARIANT_FORMATS) {
                const name = `${width}.${format}`;
                const encoded = await encode(source, width, format);
                const data = (await faults.afterEncode?.(name, encoded)) ?? encoded;
                const size = await validated(name, data, format, Math.min(PROFILE_1.variants[width].width, orientedWidth));
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
            lqip: await lqipOf(source),
            createdAt: iso(clock()),
        };
        await faults.beforeManifest?.();
        await writeFile(path.join(staging, MANIFEST_FILE), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
        await faults.beforePublish?.();
        await publishDirectory(staging, finalDir);
    } catch (error) {
        await fs.promises.rm(staging, { recursive: true, force: true });
        return recordFailed(error instanceof IntegrityError ? `integrity: ${error.problems.join('; ')}` : errorText(error), error);
    }
    return recordReady(false);
}
