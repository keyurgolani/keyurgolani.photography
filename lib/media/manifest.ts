import fs from 'node:fs';
import path from 'node:path';
import type { AssetManifest } from '../identity/types';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../identity/variants';
import { dataRootStatus } from '../storage/config';
import { hasErrorCode } from '../storage/fsx';
import { MANIFEST_FILE } from '../storage/publish';
import { assetDir, assetsRoot, isValidRef } from './path';
import type { AssetRef } from './url';

/**
 * Reading derivative sets. A set is ready when its `manifest.json` names
 * exactly the ref it sits under and every file it lists exists at its size.
 * The writer writes the manifest last, so a set without one was never
 * finished. Nothing here reads the registry or the library, and nothing
 * follows a symlink below the asset store: a set whose folder is reached
 * through one, or a file that is one, reads as missing. Nothing the writer
 * makes is a symlink, so one is something else put there.
 */

const MANIFEST_KEYS = new Set(['schemaVersion', 'photoId', 'assetRevision', 'profileId', 'variants', 'lqip', 'createdAt']);
const FILE_KEYS = new Set(['width', 'height', 'bytes', 'sha256']);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const LQIP_RE = /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isPositive = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0;
const hasOnly = (value: Record<string, unknown>, keys: Set<string>) => Object.keys(value).every((key) => keys.has(key));

/** `value` as the manifest of `ref`'s set, or null if it isn't exactly that. */
export function parseAssetManifest(value: unknown, ref: AssetRef): AssetManifest | null {
    if (!isObject(value) || !hasOnly(value, MANIFEST_KEYS)) return null;
    if (value.schemaVersion !== 1) return null;
    if (value.photoId !== ref.photoId || value.assetRevision !== ref.assetRevision || value.profileId !== ref.profileId) return null;
    if (typeof value.lqip !== 'string' || !LQIP_RE.test(value.lqip)) return null;
    if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) return null;
    const { variants } = value;
    if (!isObject(variants) || Object.keys(variants).length !== VARIANT_WIDTHS.length) return null;
    for (const width of VARIANT_WIDTHS) {
        const formats = variants[width];
        if (!isObject(formats) || Object.keys(formats).length !== VARIANT_FORMATS.length) return null;
        for (const format of VARIANT_FORMATS) {
            const file = formats[format];
            if (!isObject(file) || !hasOnly(file, FILE_KEYS)) return null;
            if (!isPositive(file.width) || !isPositive(file.height) || !isPositive(file.bytes)) return null;
            if (typeof file.sha256 !== 'string' || !SHA256_HEX.test(file.sha256)) return null;
        }
    }
    return value as unknown as AssetManifest;
}

/** Errors that mean a file isn't there to serve: gone, under a non-folder, or a symlink O_NOFOLLOW refused. */
export const NOT_SERVABLE = ['ENOENT', 'ENOTDIR', 'ELOOP'] as const;

/**
 * The folder of `ref`'s set, as its real path, when it exists and every
 * segment from the asset store down is a real folder, not a symlink. Null
 * otherwise. The data root and the store may be reached through symlinks.
 */
export async function containedAssetDir(ref: AssetRef, root: string): Promise<string | null> {
    let real: string;
    let store: string;
    try {
        [real, store] = await Promise.all([fs.promises.realpath(assetDir(ref, root)), fs.promises.realpath(assetsRoot(root))]);
    } catch (error) {
        if (hasErrorCode(error, ...NOT_SERVABLE)) return null;
        throw error;
    }
    return real === path.join(store, ref.photoId, ref.assetRevision, ref.profileId) ? real : null;
}

/**
 * Open a regular file for reading without following a symlink at its name.
 * Null when it isn't there to serve. O_NONBLOCK changes nothing for a regular
 * file, but keeps a FIFO from holding the open, and a worker thread, until
 * something writes to it; the FIFO then fails the regular-file check.
 */
export async function openRegularFile(file: string): Promise<{ handle: fs.promises.FileHandle; size: number } | null> {
    let handle: fs.promises.FileHandle;
    try {
        handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (error) {
        if (hasErrorCode(error, ...NOT_SERVABLE)) return null;
        throw error;
    }
    try {
        const stats = await handle.stat();
        if (stats.isFile()) return { handle, size: stats.size };
    } catch (error) {
        await handle.close();
        throw error;
    }
    await handle.close();
    return null;
}

/** The manifest, and the set's folder by its real path, or why there is none. */
type ManifestRead = { manifest: AssetManifest; dir: string } | { reason: 'missing' | 'invalid-manifest' };

async function readManifestFile(ref: AssetRef, root: string): Promise<ManifestRead> {
    const dir = await containedAssetDir(ref, root);
    if (dir === null) return { reason: 'missing' };
    const opened = await openRegularFile(path.join(/*turbopackIgnore: true*/ dir, MANIFEST_FILE));
    if (opened === null) return { reason: 'missing' };
    let text: string;
    try {
        text = await opened.handle.readFile('utf8');
    } finally {
        await opened.handle.close();
    }
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return { reason: 'invalid-manifest' };
    }
    const manifest = parseAssetManifest(value, ref);
    return manifest ? { manifest, dir } : { reason: 'invalid-manifest' };
}

/** The validated manifest of `ref`'s set, or null when it has none or it isn't valid. Doesn't check the files. */
export async function readAssetManifest(ref: AssetRef, { root }: { root?: string } = {}): Promise<AssetManifest | null> {
    if (!isValidRef(ref)) return null;
    const status = dataRootStatus(root === undefined ? {} : { root });
    if (status.state !== 'ready' || status.root === null) return null;
    const read = await readManifestFile(ref, status.root);
    return 'manifest' in read ? read.manifest : null;
}

export type ResolvedAsset =
    | { state: 'ready'; manifest: AssetManifest }
    | { state: 'unavailable'; reason: 'invalid-ref' | 'data-root' | 'missing' | 'invalid-manifest' | 'missing-file' };

/**
 * Whether `ref`'s derivative set can be served: a valid manifest for it, and
 * every listed file present at its listed size. Stats the files but doesn't
 * hash them. Reads the configured data root, or `root`.
 */
export async function resolveAsset(ref: AssetRef, { root }: { root?: string } = {}): Promise<ResolvedAsset> {
    if (!isValidRef(ref)) return { state: 'unavailable', reason: 'invalid-ref' };
    const status = dataRootStatus(root === undefined ? {} : { root });
    if (status.state !== 'ready' || status.root === null) return { state: 'unavailable', reason: 'data-root' };
    const read = await readManifestFile(ref, status.root);
    if (!('manifest' in read)) return { state: 'unavailable', reason: read.reason };
    for (const width of VARIANT_WIDTHS) {
        for (const format of VARIANT_FORMATS) {
            let stats: fs.Stats;
            try {
                // lstat, so a symlinked file counts as missing, as /media treats it
                stats = await fs.promises.lstat(path.join(/*turbopackIgnore: true*/ read.dir, `${width}.${format}`));
            } catch (error) {
                if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return { state: 'unavailable', reason: 'missing-file' };
                throw error;
            }
            if (!stats.isFile() || stats.size !== read.manifest.variants[width][format].bytes) return { state: 'unavailable', reason: 'missing-file' };
        }
    }
    return { state: 'ready', manifest: read.manifest };
}
