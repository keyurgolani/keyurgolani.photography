import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROFILE_ID_RE } from '../identity/ids';
import { hasErrorCode } from '../storage/fsx';
import { manifestFiles, MANIFEST_FILE, readDirectoryManifest, type DirectoryManifest } from '../storage/publish';

/**
 * What an asset folder holds, read with lstat so nothing is followed through
 * a symlink: its bytes and newest change, and whether every file in it is one
 * a derivative build made, by name, size, sha256 and a single link. #181's A10 shares it between `photos gc`, which
 * deletes by it, and `photos purge`, which plans and revokes by it, so purge
 * imports no module that deletes. It only reads.
 */

/** Every file's size under `dir` and the newest change to it or anything in it, read with lstat, so no symlink is followed. */
export async function folderFacts(dir: string): Promise<{ bytes: number; newestMs: number }> {
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

/** A byte count for the owner: 38.2 MB. */
export function sizeText(bytes: number): string {
    if (bytes < 1_000) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
    const units = ['kB', 'MB', 'GB', 'TB'];
    let value = bytes / 1_000;
    let unit = 0;
    while (value >= 999.95 && unit < units.length - 1) {
        value /= 1_000;
        unit += 1;
    }
    return `${value.toFixed(1)} ${units[unit]}`;
}

/** One file of a set, as GC and revoke compare it: `<profileId>/<name>`, and its size. */
export interface SetFile {
    name: string;
    bytes: number;
}

/**
 * An asset revision folder judged by its manifests: `listed` when every entry
 * in it is a real profile folder holding a regular `manifest.json` for that
 * very set, and every other file in each is a regular file with one link
 * whose name, size and sha256 its manifest lists, with the bytes of those
 * listed files, and every file, the manifests included, by name and size.
 * Anything else is `unexpected`, naming the first path that isn't the app's.
 */
export type ManifestContent = { listed: true; bytes: number; files: SetFile[] } | { listed: false; unexpected: string };

const byName = (a: fs.Dirent, b: fs.Dirent) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * A listed file's bytes, read without following a symlink at its name or
 * blocking on a FIFO, or null when it isn't a regular file with exactly one
 * link and `bytes` bytes, as one a build wrote is. A second link means
 * someone else's name holds the same bytes, so it isn't GC's alone.
 */
async function soleFileDigest(file: string, bytes: number): Promise<string | null> {
    let handle: fs.promises.FileHandle;
    try {
        handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (error) {
        if (hasErrorCode(error, 'ELOOP', 'ENOENT')) return null;
        throw error;
    }
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== bytes) return null;
        return createHash('sha256').update(await handle.readFile()).digest('hex');
    } finally {
        await handle.close();
    }
}

/**
 * `assets/<photoId>/<assetRevision>/` as its manifests describe it. `relative`
 * is the folder's path relative to the data root, for naming what is
 * unexpected. Throws only for an I/O error.
 */
export async function manifestContent(dir: string, relative: string, photoId: string, assetRevision: string): Promise<ManifestContent> {
    const unexpected = (name: string): ManifestContent => ({ listed: false, unexpected: name });
    let bytes = 0;
    const files: SetFile[] = [];
    for (const profile of (await fs.promises.readdir(dir, { withFileTypes: true })).sort(byName)) {
        const setPath = `${relative}/${profile.name}`;
        if (!profile.isDirectory() || !PROFILE_ID_RE.test(profile.name)) return unexpected(setPath);
        const setDir = path.join(dir, profile.name);
        const manifestPath = `${setPath}/${MANIFEST_FILE}`;
        let manifest: DirectoryManifest | null;
        let manifestStat: fs.Stats;
        try {
            manifestStat = await fs.promises.lstat(path.join(setDir, MANIFEST_FILE));
            if (!manifestStat.isFile() || manifestStat.nlink !== 1) return unexpected(manifestPath);
            manifest = await readDirectoryManifest(setDir, { noFollow: true });
        } catch (error) {
            // Missing, not JSON, not a manifest, or swapped for a symlink: not a set a build finished. An I/O error stops the caller.
            if (hasErrorCode(error, 'ENOENT') || !(error as NodeJS.ErrnoException).code) return unexpected(manifestPath);
            throw error;
        }
        if (!manifest || manifest.photoId !== photoId || manifest.assetRevision !== assetRevision || manifest.profileId !== profile.name) return unexpected(manifestPath);
        let listed: Map<string, { bytes: number; sha256: string }>;
        try {
            listed = new Map(manifestFiles(manifest).map((file) => [file.name, { bytes: file.bytes, sha256: file.sha256 }]));
        } catch {
            return unexpected(manifestPath);
        }
        files.push({ name: `${profile.name}/${MANIFEST_FILE}`, bytes: manifestStat.size });
        for (const file of (await fs.promises.readdir(setDir, { withFileTypes: true })).sort(byName)) {
            if (file.name === MANIFEST_FILE) continue;
            const entry = listed.get(file.name);
            if (entry === undefined || !file.isFile()) return unexpected(`${setPath}/${file.name}`);
            // Its name, size and bytes: an owner's file with a derivative's name and size keeps the folder.
            if ((await soleFileDigest(path.join(setDir, file.name), entry.bytes)) !== entry.sha256) return unexpected(`${setPath}/${file.name}`);
            bytes += entry.bytes;
            files.push({ name: `${profile.name}/${file.name}`, bytes: entry.bytes });
        }
    }
    return { listed: true, bytes, files };
}
