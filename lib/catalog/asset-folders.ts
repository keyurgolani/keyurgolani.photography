import fs from 'node:fs';
import path from 'node:path';
import { PROFILE_ID_RE } from '../identity/ids';
import { hasErrorCode } from '../storage/fsx';
import { manifestFiles, MANIFEST_FILE, readDirectoryManifest, type DirectoryManifest } from '../storage/publish';

/**
 * What an asset folder holds, read with lstat so nothing is followed through
 * a symlink: its bytes and newest change, and whether every file in it is one
 * a derivative build made. #181's A10 shares it between `photos gc`, which
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

/**
 * An asset revision folder judged by its manifests: `listed` when every entry
 * in it is a real profile folder holding a regular `manifest.json` for that
 * very set, and every other file in each is a regular file its manifest lists
 * at the size it lists, with the bytes of those listed files. Anything else
 * is `unexpected`, naming the first path that isn't the app's.
 */
export type ManifestContent = { listed: true; bytes: number } | { listed: false; unexpected: string };

const byName = (a: fs.Dirent, b: fs.Dirent) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * `assets/<photoId>/<assetRevision>/` as its manifests describe it. `relative`
 * is the folder's path relative to the data root, for naming what is
 * unexpected. Throws only for an I/O error.
 */
export async function manifestContent(dir: string, relative: string, photoId: string, assetRevision: string): Promise<ManifestContent> {
    const unexpected = (name: string): ManifestContent => ({ listed: false, unexpected: name });
    let bytes = 0;
    for (const profile of (await fs.promises.readdir(dir, { withFileTypes: true })).sort(byName)) {
        const setPath = `${relative}/${profile.name}`;
        if (!profile.isDirectory() || !PROFILE_ID_RE.test(profile.name)) return unexpected(setPath);
        const setDir = path.join(dir, profile.name);
        const manifestPath = `${setPath}/${MANIFEST_FILE}`;
        let manifest: DirectoryManifest | null;
        try {
            if (!(await fs.promises.lstat(path.join(setDir, MANIFEST_FILE))).isFile()) return unexpected(manifestPath);
            manifest = await readDirectoryManifest(setDir, { noFollow: true });
        } catch (error) {
            // Missing, not JSON, not a manifest, or swapped for a symlink: not a set a build finished. An I/O error stops the caller.
            if (hasErrorCode(error, 'ENOENT') || !(error as NodeJS.ErrnoException).code) return unexpected(manifestPath);
            throw error;
        }
        if (!manifest || manifest.photoId !== photoId || manifest.assetRevision !== assetRevision || manifest.profileId !== profile.name) return unexpected(manifestPath);
        let listed: Map<string, number>;
        try {
            listed = new Map(manifestFiles(manifest).map((file) => [file.name, file.bytes]));
        } catch {
            return unexpected(manifestPath);
        }
        for (const file of (await fs.promises.readdir(setDir, { withFileTypes: true })).sort(byName)) {
            if (file.name === MANIFEST_FILE) continue;
            const size = listed.get(file.name);
            if (size === undefined || !file.isFile()) return unexpected(`${setPath}/${file.name}`);
            const stat = await fs.promises.lstat(path.join(setDir, file.name));
            if (!stat.isFile() || stat.size !== size) return unexpected(`${setPath}/${file.name}`);
            bytes += stat.size;
        }
    }
    return { listed: true, bytes };
}
