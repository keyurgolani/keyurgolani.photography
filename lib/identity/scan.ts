import fs from 'node:fs';
import path from 'node:path';
import { CACHE_FOLDER, DERIVATIVE_FOLDERS } from '../derivativeFolders.mjs';
import { hasErrorCode } from '../storage/fsx';

/** Extensions the pipeline reads, in any case. */
export const SOURCE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'] as const;

/** Image files the pipeline can't read yet. Each emits `processing-failed` with `unsupported-format`. */
export const UNSUPPORTED_EXTENSIONS = ['.heic', '.heif', '.tif', '.tiff', '.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf'] as const;

/** Root-level folders the legacy pipeline writes, skipped by exact name. Nested folders with these names are scanned. */
export const LEGACY_OUTPUT_DIRS: readonly string[] = [...Object.keys(DERIVATIVE_FOLDERS), CACHE_FOLDER];

export interface ScanEntry {
    /** Library-relative POSIX path, exactly as on disk. */
    path: string;
    /** NFC-normalized and case-folded `path`. Two present files sharing one are ambiguous. */
    key: string;
    kind: 'source' | 'unsupported';
    size: number;
    mtimeMs: number;
    /** Changes on rename and copy too, so a just-moved file waits like a just-written one. */
    ctimeMs: number;
    ino: number;
}

export interface LibraryScan {
    root: string;
    /** When the scan started, in epoch ms. */
    observedAt: number;
    /** Sorted by path. */
    entries: ScanEntry[];
    /** Folders that couldn't be listed. Photos bound under them count as unchanged. */
    unreadableDirs: string[];
}

export class LibraryRootMissingError extends Error {
    readonly root: string;

    constructor(root: string) {
        super(`Library root not found: ${root}`);
        this.name = 'LibraryRootMissingError';
        this.root = root;
    }
}

/** The key a library path binds by: NFC-normalized and case-folded. */
export function keyOf(relativePath: string): string {
    return relativePath.normalize('NFC').toLowerCase().normalize('NFC');
}

/** The library-relative folder of a path, '' at the root. */
export function folderOf(relativePath: string): string {
    const folder = path.posix.dirname(relativePath);
    return folder === '.' ? '' : folder;
}

/** True when `relativePath` is `dir` or inside it. '' is the library root. */
export function isUnder(relativePath: string, dir: string): boolean {
    return dir === '' || relativePath === dir || relativePath.startsWith(`${dir}/`);
}

function classify(name: string): ScanEntry['kind'] | null {
    const extension = path.extname(name).toLowerCase();
    if ((SOURCE_EXTENSIONS as readonly string[]).includes(extension)) return 'source';
    if ((UNSUPPORTED_EXTENSIONS as readonly string[]).includes(extension)) return 'unsupported';
    return null;
}

/**
 * Walk the library with lstat. Skips symlinks, dot-entries at any depth, and
 * the root-level legacy output folders. Throws LibraryRootMissingError when
 * the root is missing, so an unmounted library never reads as an empty one.
 */
export async function scanLibrary(root: string, { clock = Date.now }: { clock?: () => number } = {}): Promise<LibraryScan> {
    const observedAt = clock();
    try {
        if (!(await fs.promises.stat(root)).isDirectory()) throw new LibraryRootMissingError(root);
    } catch (error) {
        if (error instanceof LibraryRootMissingError || hasErrorCode(error, 'ENOENT', 'ENOTDIR')) throw new LibraryRootMissingError(root);
        throw error;
    }

    const entries: ScanEntry[] = [];
    const unreadableDirs: string[] = [];
    const pending: string[] = [''];
    while (pending.length > 0) {
        const relativeDir = pending.pop() as string;
        let names: string[];
        try {
            names = await fs.promises.readdir(path.join(root, relativeDir));
        } catch (error) {
            if (relativeDir === '') throw error;
            if (!hasErrorCode(error, 'ENOENT')) unreadableDirs.push(relativeDir);
            continue;
        }
        for (const name of names) {
            if (name.startsWith('.')) continue;
            if (relativeDir === '' && LEGACY_OUTPUT_DIRS.includes(name)) continue;
            const relativePath = relativeDir === '' ? name : `${relativeDir}/${name}`;
            let stat: fs.Stats;
            try {
                stat = await fs.promises.lstat(path.join(root, relativePath));
            } catch (error) {
                // Gone since the listing, or the folder can be listed but not searched.
                if (!hasErrorCode(error, 'ENOENT') && !unreadableDirs.includes(relativeDir)) unreadableDirs.push(relativeDir);
                continue;
            }
            if (stat.isSymbolicLink()) continue;
            if (stat.isDirectory()) {
                pending.push(relativePath);
                continue;
            }
            if (!stat.isFile()) continue;
            const kind = classify(name);
            if (!kind) continue;
            entries.push({
                path: relativePath,
                key: keyOf(relativePath),
                kind,
                size: stat.size,
                mtimeMs: stat.mtimeMs,
                ctimeMs: stat.ctimeMs,
                ino: stat.ino,
            });
        }
    }

    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    unreadableDirs.sort();
    return { root, observedAt, entries, unreadableDirs };
}
