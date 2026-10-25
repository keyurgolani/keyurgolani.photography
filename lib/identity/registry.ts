import path from 'node:path';
import { atomicWriteJson } from '../storage/atomicWrite';
import {
    checkSchemaVersion,
    CorruptDocumentError,
    isRecord,
    readJsonFile,
    readVersionedDocument,
    writeVersionedDocument,
    type VersionedWriteHooks,
} from '../storage/document';
import { ensureDirectory } from '../storage/fsx';
import { ASSET_REVISION_RE, DECISION_ID_RE, PHOTO_ID_RE } from './ids';
import type { ImageInspection, UnsupportedInspection } from './inspect';
import { EXTRACTOR_VERSION } from './metadata';
import { emptyRegistry, REGISTRY_SCHEMA_VERSION, type Registry } from './types';

export const STAT_CACHE_SCHEMA_VERSION = 1;

/** Where identity state lives inside the data root. */
export function identityPaths(root: string) {
    const dir = path.join(root, 'identity');
    return {
        dir,
        /** A version folder: `v<N>.json`, one per version (lib/storage/document.ts). */
        registry: path.join(dir, 'registry'),
        statCache: path.join(dir, 'stat-cache.json'),
        decisions: path.join(dir, 'decisions'),
        migration: path.join(dir, 'migration'),
    };
}

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));

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
    if (value.decided !== undefined) {
        if (!isRecord(value.decided)) fail('decided must be an object');
        for (const [decisionId, recorded] of Object.entries(value.decided as Record<string, unknown>)) {
            if (!DECISION_ID_RE.test(decisionId)) fail('decided is keyed by something other than a decision ID');
            // Exactly the fields a pass writes, so a hand-edited entry can't carry anything a later pass would use.
            const ok = isRecord(recorded) && (
                (recorded.status === 'applied' && typeof recorded.detail === 'string' && hasOnlyKeys(recorded, ['status', 'detail'])) ||
                (recorded.status === 'rejected' && typeof recorded.reason === 'string' && hasOnlyKeys(recorded, ['status', 'reason'])));
            if (!ok) fail('decided holds a malformed entry');
        }
    }
}

/**
 * Read the newest version in `identity/registry/`, or an empty registry when
 * there is none. Throws UnsupportedSchemaError for one from a newer build,
 * which makes the data root unavailable, CorruptDocumentError for a malformed
 * one, and EditedInPlaceError, a CorruptDocumentError, for one edited in place.
 */
export async function readRegistry(root: string): Promise<Registry> {
    const stored = await readVersionedDocument(identityPaths(root).registry);
    if (stored === null) return emptyRegistry();
    checkSchemaVersion(stored.file, stored.value, REGISTRY_SCHEMA_VERSION);
    assertRegistry(stored.file, stored.value);
    return stored.value as unknown as Registry;
}

/** Compare-and-swap write of the registry's next version. The caller holds the registry lock. */
export async function writeRegistry(root: string, registry: Registry, expectedVersion: number, hooks?: VersionedWriteHooks): Promise<Registry> {
    // The first version survives a crash only with `identity/` in the root, which the stat cache may have made unsynced.
    await ensureDirectory(identityPaths(root).dir, { syncParent: expectedVersion === 0 });
    return writeVersionedDocument(identityPaths(root).registry, registry, expectedVersion, { hooks });
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
    await ensureDirectory(identityPaths(root).dir);
    await atomicWriteJson(identityPaths(root).statCache, cache);
}
