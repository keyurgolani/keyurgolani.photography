import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../storage/atomicWrite';
import { DATA_ROOT_FILE, DATA_ROOT_SCHEMA_VERSION, dataRootStatus, libraryRoot } from '../storage/config';
import { isRecord, readJsonFile, UnsupportedSchemaError } from '../storage/document';
import { hasErrorCode, PRIVATE_DIR_MODE, timestampOf } from '../storage/fsx';
import { LockTimeoutError, withLock } from '../storage/lock';
import { ASSET_REVISION_RE, PHOTO_ID_RE, type Hasher } from './ids';
import type { MigrationPlan, PlannedPhoto, PlannedSource } from './migration';
import { observeLibrary } from './pass';
import { currentProfileId } from './profile';
import { identityPaths, readRegistry, readStatCache, writeRegistry, writeStatCache } from './registry';
import { LibraryRootMissingError } from './scan';
import type { IdentityFact, Registry } from './types';

/**
 * `photos:migrate --apply --plan <file>`: commit a dry run's plan. Under the
 * registry lock it scans the library again and refuses unless the sources
 * and the registry are exactly as the dry run saw them, so the registry it
 * writes holds exactly the plan's photo IDs. It then writes `data-root.json`
 * if there is none, and last `applied-<ts>.json`, which maps each source path
 * and legacy URL to its photo. It builds no derivatives: the watcher's worker
 * does.
 *
 * The mapping is written last, so its presence means the plan was applied.
 * After a crash before it, the registry already holds the IDs, so a new dry
 * run reports nothing new, and applying that plan writes the rest.
 */

type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

export interface ApplyOptions {
    planPath: string;
    /** The scan's clock. */
    clock?: () => number;
    /** Stamps data-root.json and the mapping. Defaults to the scan's clock. */
    appliedAt?: () => number;
    /** Mints the fact IDs. */
    idGen?: () => string;
    hasher?: Hasher;
    /** The file whose presence means this runs in a container. */
    dockerenvPath?: string;
    /** `stat().dev` of a directory. */
    deviceOf?: (dir: string) => number;
    logger?: Logger;
}

export type ApplyResult =
    | { status: 'applied'; planId: string; photos: number; facts: number; mappingPath: string }
    | { status: 'already-applied'; planId: string; mappingPath: string };

/** `applied-<ts>.json`. */
export interface AppliedMapping {
    schemaVersion: 1;
    planId: string;
    appliedAt: string;
    /** Each bound source path. */
    paths: Record<string, { photoId: string; assetRevision: string }>;
    /** Each legacy URL that belongs to one photo. */
    urls: Record<string, { photoId: string; assetRevision: string }>;
    /** Legacy URLs two or more sources share, such as the derivatives of x.jpg and x.png, with the paths sharing them. */
    unmappable: Record<string, string[]>;
}

/** The apply can't go ahead. `exitCode` is 2 for a usage problem, such as a bad plan file, and 1 for anything else. */
export class ApplyRefusedError extends Error {
    constructor(message: string, readonly exitCode: 1 | 2 = 1) {
        super(message);
        this.name = 'ApplyRefusedError';
    }
}

/**
 * The URLs the legacy site served for a source, as getImagePaths() names
 * them: the original, and for a top-level file the derivatives named by its
 * base name. Nested files never had derivatives.
 */
export function legacyUrls(sourcePath: string): string[] {
    const original = `/assets/photos/${sourcePath}`;
    if (sourcePath.includes('/')) return [original];
    const base = path.posix.basename(sourcePath, path.posix.extname(sourcePath));
    return [
        original,
        `/assets/photos/thumbnails/${base}.webp`,
        `/assets/photos/medium/${base}.webp`,
        `/assets/photos/optimized/${base}.webp`,
        `/assets/photos/thumbnails-avif/${base}.avif`,
        `/assets/photos/medium-avif/${base}.avif`,
        `/assets/photos/optimized-avif/${base}.avif`,
        `/assets/photos/lqip/${base}.txt`,
    ];
}

/** Enough of the plan's shape to trust it. Returns why it isn't a plan, or null. */
function planProblem(value: unknown): string | null {
    if (!isRecord(value)) return 'it is not a JSON object';
    if (value.schemaVersion !== 1) return 'its schemaVersion is not 1';
    if (typeof value.planId !== 'string' || value.planId.length === 0) return 'it has no planId';
    if (typeof value.registryVersion !== 'number') return 'it has no registryVersion';
    if (!Array.isArray(value.sources) || !value.sources.every((source: unknown) => isRecord(source) && typeof source.path === 'string' && typeof source.size === 'number'
        && (source.assetRevision === null || (typeof source.assetRevision === 'string' && ASSET_REVISION_RE.test(source.assetRevision))))) {
        return 'its sources are malformed';
    }
    if (!Array.isArray(value.photos) || !value.photos.every((photo: unknown) => isRecord(photo) && typeof photo.photoId === 'string' && PHOTO_ID_RE.test(photo.photoId)
        && typeof photo.path === 'string' && typeof photo.assetRevision === 'string' && (photo.status === 'new' || photo.status === 'existing'))) {
        return 'its photos are malformed';
    }
    return null;
}

async function readPlan(planPath: string): Promise<MigrationPlan> {
    let value: unknown;
    try {
        value = await readJsonFile(planPath);
    } catch (error) {
        throw new ApplyRefusedError(`${planPath} is not a migration plan: ${(error as Error).message}`, 2);
    }
    if (value === null) throw new ApplyRefusedError(`There is no plan at ${planPath}.`, 2);
    const problem = planProblem(value);
    if (problem) throw new ApplyRefusedError(`${planPath} is not a migration plan: ${problem}.`, 2);
    return value as MigrationPlan;
}

/** The mapping already written for `planId`, if any. */
async function appliedMappingFor(root: string, planId: string): Promise<string | null> {
    const dir = identityPaths(root).migration;
    let names: string[];
    try {
        names = (await fs.promises.readdir(dir)).filter((name) => name.startsWith('applied-') && name.endsWith('.json')).sort();
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return null;
        throw error;
    }
    for (const name of names) {
        const file = path.join(dir, name);
        const mapping = await readJsonFile(file).catch(() => null);
        if (isRecord(mapping) && mapping.planId === planId) return file;
    }
    return null;
}

/** The first way the library differs from the plan's sources, or null. */
function sourceDrift(planned: readonly PlannedSource[], current: readonly PlannedSource[]): string | null {
    const before = new Map(planned.map((source) => [source.path, source]));
    const now = new Map(current.map((source) => [source.path, source]));
    const differences: string[] = [];
    for (const source of planned) if (!now.has(source.path)) differences.push(`${source.path} is gone since the dry run`);
    for (const source of current) {
        const was = before.get(source.path);
        if (!was) differences.push(`${source.path} is new since the dry run`);
        else if (was.size !== source.size || was.assetRevision !== source.assetRevision) differences.push(`${source.path} changed since the dry run`);
    }
    if (differences.length === 0) return null;
    differences.sort();
    return `${differences[0]}${differences.length > 1 ? `, and ${differences.length - 1} more` : ''}`;
}

/** The photos a reconciled registry holds, in the plan's terms and order. */
function plannedPhotos(registry: Registry, before: Registry): PlannedPhoto[] {
    return Object.values(registry.photos)
        .map((photo): PlannedPhoto => ({
            photoId: photo.photoId,
            path: photo.source.path,
            assetRevision: photo.source.observedRevision,
            status: before.photos[photo.photoId] ? 'existing' : 'new',
            sourceHealth: photo.sourceHealth,
            ...(photo.duplicateOf ? { duplicateOf: photo.duplicateOf } : {}),
        }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function buildMapping(registry: Registry, planId: string, appliedAt: string): AppliedMapping {
    const paths: AppliedMapping['paths'] = {};
    const owners = new Map<string, string[]>();
    const bound = Object.values(registry.photos)
        // Archiving and merging unbind a photo, so present ones are exactly the bound ones.
        .filter((photo) => photo.source.present)
        .sort((a, b) => (a.source.path < b.source.path ? -1 : a.source.path > b.source.path ? 1 : 0));
    for (const photo of bound) {
        paths[photo.source.path] = { photoId: photo.photoId, assetRevision: photo.source.observedRevision };
        for (const url of legacyUrls(photo.source.path)) owners.set(url, [...(owners.get(url) ?? []), photo.source.path]);
    }
    const urls: AppliedMapping['urls'] = {};
    const unmappable: AppliedMapping['unmappable'] = {};
    for (const url of [...owners.keys()].sort()) {
        const sharing = owners.get(url) as string[];
        if (sharing.length === 1) urls[url] = paths[sharing[0]];
        else unmappable[url] = sharing;
    }
    return { schemaVersion: 1, planId, appliedAt, paths, urls, unmappable };
}

export async function migrateApply(options: ApplyOptions): Promise<ApplyResult> {
    const { clock = Date.now, logger = console, dockerenvPath = '/.dockerenv' } = options;
    const appliedAt = options.appliedAt ?? clock;
    const factIds = options.idGen ?? randomUUID;
    const deviceOf = options.deviceOf ?? ((dir: string) => fs.statSync(dir).dev);
    const plan = await readPlan(options.planPath);

    const status = dataRootStatus({ write: true });
    if (status.root === null || (status.state !== 'ready' && status.state !== 'uninitialized')) {
        throw new ApplyRefusedError(`The data root is ${status.state}${status.detail ? `: ${status.detail}` : ''}. Nothing was applied.`);
    }
    const root = status.root;
    const marker = path.join(root, DATA_ROOT_FILE);
    if (status.state === 'uninitialized' && fs.existsSync(marker)) {
        throw new ApplyRefusedError(`${status.detail}. Fix or remove ${marker} before applying, so no data root is taken over by mistake.`);
    }
    if (fs.existsSync(dockerenvPath) && deviceOf(root) === deviceOf('/')) {
        throw new ApplyRefusedError(`The data root ${root} is on the container's own filesystem, not a mounted volume, so the IDs would be lost with the container. Mount a volume at PHOTOGRAPHY_DATA_DIR and apply again.`);
    }

    try {
        return await withLock('registry', { root, waitMs: 0 }, async ({ signal }) => {
            const existing = await appliedMappingFor(root, plan.planId);
            if (existing) return { status: 'already-applied' as const, planId: plan.planId, mappingPath: existing };

            const before = await readRegistry(root);
            if (before.version !== plan.registryVersion) {
                throw new ApplyRefusedError(`The registry is at version ${before.version}, and the plan was made at version ${plan.registryVersion}. Run the dry run again and apply its plan.`);
            }

            // Mint exactly the plan's new IDs: reconcile mints new photos in path order, as the plan lists them.
            // A photo beyond them gets a throwaway ID, and the checks below refuse the apply.
            const newIds = plan.photos.filter((photo) => photo.status === 'new').map((photo) => photo.photoId.slice('ph_'.length));
            let next = 0;
            const planIds = () => (next < newIds.length ? newIds[next++] : randomUUID());
            const observed = await observeLibrary({
                root: libraryRoot(),
                registry: before,
                statCache: await readStatCache(root),
                deps: { clock, hasher: options.hasher, idGen: planIds, profileId: currentProfileId(), logger },
            });
            const sources: PlannedSource[] = observed.scan.entries.map((entry) => {
                const inspection = observed.inspections.get(entry.path);
                const readable = inspection?.kind === 'image' || inspection?.kind === 'unsupported';
                return { path: entry.path, size: entry.size, assetRevision: readable ? inspection.assetRevision : null };
            });
            const drift = sourceDrift(plan.sources, sources);
            if (drift) throw new ApplyRefusedError(`${drift}. Run the dry run again and apply its plan.`);
            const photos = plannedPhotos(observed.registry, before);
            if (JSON.stringify(photos) !== JSON.stringify(plan.photos)) {
                throw new ApplyRefusedError('Scanning the library again gives different photos than the plan. Run the dry run again and apply its plan.');
            }

            const facts: IdentityFact[] = observed.facts.map((draft) => ({ ...draft, factId: factIds() }));
            signal.throwIfAborted();
            const written = await writeRegistry(root, { ...observed.registry, pendingFacts: [...before.pendingFacts, ...facts] }, before.version);
            await writeStatCache(root, observed.statCache).catch((error: unknown) => {
                logger.warn(`[photos] Could not write the stat cache, so the next pass reads every file again: ${(error as Error).message}`);
            });
            const stamp = new Date(appliedAt()).toISOString();
            if (!fs.existsSync(marker)) await atomicWriteJson(marker, { schemaVersion: DATA_ROOT_SCHEMA_VERSION, initializedAt: stamp });
            const dir = identityPaths(root).migration;
            await fs.promises.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
            const mappingPath = path.join(dir, `applied-${timestampOf(stamp)}.json`);
            await atomicWriteJson(mappingPath, buildMapping(written, plan.planId, stamp));
            return { status: 'applied' as const, planId: plan.planId, photos: Object.keys(written.photos).length, facts: facts.length, mappingPath };
        });
    } catch (error) {
        if (error instanceof LockTimeoutError) {
            const holder = error.holder ? ` by pid ${error.holder.pid} on ${error.holder.hostname}` : '';
            throw new ApplyRefusedError(`The registry is busy (held${holder}). Stop the watcher, or wait for its pass to finish, and apply again.`);
        }
        if (error instanceof UnsupportedSchemaError) throw new ApplyRefusedError(`The registry comes from a newer build: ${error.message}. Nothing was applied.`);
        if (error instanceof LibraryRootMissingError) throw new ApplyRefusedError(`${error.message}. Check the mount or PHOTOGRAPHY_LIBRARY_DIR. Nothing was applied.`);
        throw error;
    }
}
