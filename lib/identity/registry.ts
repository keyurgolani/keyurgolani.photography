import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, type AtomicWriteFaults } from '../storage/atomicWrite';
import { checkSchemaVersion, CorruptDocumentError, isRecord, readJsonFile, writeVersionedDocument } from '../storage/document';
import { hasErrorCode, PRIVATE_DIR_MODE } from '../storage/fsx';
import { ASSET_REVISION_RE, PHOTO_ID_RE } from './ids';
import type { ImageInspection, UnsupportedInspection } from './inspect';
import { EXTRACTOR_VERSION } from './metadata';
import { emptyRegistry, REGISTRY_SCHEMA_VERSION, type Registry } from './types';

export const STAT_CACHE_SCHEMA_VERSION = 1;

/**
 * Where identity state lives inside the data root. The root is found at run
 * time, so the ignore comments keep Turbopack from tracing this folder into
 * .next/standalone.
 */
export function identityPaths(root: string) {
    const dir = path.join(/*turbopackIgnore: true*/ root, 'identity');
    return {
        dir,
        registry: path.join(/*turbopackIgnore: true*/ dir, 'registry.json'),
        statCache: path.join(/*turbopackIgnore: true*/ dir, 'stat-cache.json'),
        decisions: path.join(/*turbopackIgnore: true*/ dir, 'decisions'),
        migration: path.join(/*turbopackIgnore: true*/ dir, 'migration'),
    };
}

const HEALTH = new Set(['present', 'missing', 'ambiguous', 'archived']);

/** Enough structure to trust the registry's shape. Throws CorruptDocumentError naming the first problem. */
function assertRegistry(file: string, value: Record<string, unknown>): asserts value is Record<string, unknown> & Registry {
    const fail = (reason: string): never => {
        throw new CorruptDocumentError(file, reason);
    };
    if (!Number.isInteger(value.version) || (value.version as number) < 0) fail('version must be a non-negative integer');
    if (value.updatedAt !== null && typeof value.updatedAt !== 'string') fail('updatedAt must be a string or null');
    if (!isRecord(value.photos)) fail('photos must be an object');
    if (!Array.isArray(value.holds)) fail('holds must be an array');
    if (!Array.isArray(value.pendingFacts)) fail('pendingFacts must be an array');
    for (const [photoId, photo] of Object.entries(value.photos as Record<string, unknown>)) {
        if (!PHOTO_ID_RE.test(photoId) || !isRecord(photo) || photo.photoId !== photoId) fail(`photo ${photoId} is malformed`);
        const record = photo as Record<string, unknown>;
        const source = record.source;
        if (!isRecord(source) || typeof source.path !== 'string' || typeof source.key !== 'string' ||
            typeof source.present !== 'boolean' || typeof source.observedRevision !== 'string') {
            fail(`photo ${photoId} has a malformed source`);
        }
        if (!HEALTH.has(record.sourceHealth as string)) fail(`photo ${photoId} has an unknown sourceHealth`);
        if (!isRecord(record.revisions)) fail(`photo ${photoId} has malformed revisions`);
        for (const [assetRevision, revision] of Object.entries(record.revisions as Record<string, unknown>)) {
            if (!ASSET_REVISION_RE.test(assetRevision) || !isRecord(revision) || revision.assetRevision !== assetRevision ||
                !isRecord(revision.profiles)) {
                fail(`photo ${photoId} has a malformed revision ${assetRevision}`);
            }
        }
    }
    for (const held of value.holds as unknown[]) {
        if (!isRecord(held) || typeof held.path !== 'string' || typeof held.assetRevision !== 'string' || !Array.isArray(held.candidates)) {
            fail('holds holds a malformed entry');
        }
    }
    for (const pending of value.pendingFacts as unknown[]) {
        if (!isRecord(pending) || typeof pending.factId !== 'string' || typeof pending.type !== 'string') fail('pendingFacts holds a malformed fact');
    }
}

/**
 * Read `identity/registry.json`, or an empty registry when there is none.
 * Throws UnsupportedSchemaError for one from a newer build, which makes the
 * data root unavailable, and CorruptDocumentError for a malformed one.
 */
export async function readRegistry(root: string): Promise<Registry> {
    const file = identityPaths(root).registry;
    const value = await readJsonFile(file);
    if (value === null) return emptyRegistry();
    checkSchemaVersion(file, value, REGISTRY_SCHEMA_VERSION);
    assertRegistry(file, value as Record<string, unknown>);
    return value as unknown as Registry;
}

async function ensureIdentityDir(root: string): Promise<void> {
    try {
        await fs.promises.mkdir(/*turbopackIgnore: true*/ identityPaths(root).dir, { mode: PRIVATE_DIR_MODE });
    } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) throw error;
    }
}

/** Compare-and-swap write of the registry. The caller holds the registry lock. */
export async function writeRegistry(root: string, registry: Registry, expectedVersion: number, faults?: AtomicWriteFaults): Promise<Registry> {
    await ensureIdentityDir(root);
    return writeVersionedDocument(identityPaths(root).registry, registry, expectedVersion, { faults });
}

export interface StatCacheEntry {
    size: number;
    mtimeMs: number;
    /** Also compared, so an in-place edit that keeps the size and restores the mtime is still read again. */
    ctimeMs: number;
    ino: number;
    inspection: ImageInspection | UnsupportedInspection;
    /** Keys of failure facts already emitted for this version of the file, so they aren't repeated every pass. */
    emitted: string[];
}

/** `identity/stat-cache.json`. Disposable: losing it only means files are read again. */
export interface StatCache {
    schemaVersion: number;
    version: number;
    entries: Record<string, StatCacheEntry>;
}

export function emptyStatCache(): StatCache {
    return { schemaVersion: STAT_CACHE_SCHEMA_VERSION, version: 0, entries: {} };
}

/** Read the stat cache. Anything unreadable, malformed, or from another schema or extractor reads as empty. */
export async function readStatCache(root: string): Promise<StatCache> {
    let value: unknown;
    try {
        value = await readJsonFile(identityPaths(root).statCache);
    } catch {
        return emptyStatCache();
    }
    if (!isRecord(value) || value.schemaVersion !== STAT_CACHE_SCHEMA_VERSION || !isRecord(value.entries)) return emptyStatCache();
    const entries: Record<string, StatCacheEntry> = {};
    for (const [relativePath, entry] of Object.entries(value.entries)) {
        if (!isRecord(entry) || !isRecord(entry.inspection) || !Array.isArray(entry.emitted)) continue;
        const inspection = entry.inspection as unknown as StatCacheEntry['inspection'];
        if (inspection.kind === 'image' && inspection.derived?.extractorVersion !== EXTRACTOR_VERSION) continue;
        entries[relativePath] = entry as unknown as StatCacheEntry;
    }
    return { schemaVersion: STAT_CACHE_SCHEMA_VERSION, version: Number.isInteger(value.version) ? (value.version as number) : 0, entries };
}

export async function writeStatCache(root: string, cache: StatCache): Promise<void> {
    await ensureIdentityDir(root);
    await atomicWriteJson(identityPaths(root).statCache, cache);
}
