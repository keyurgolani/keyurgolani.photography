/**
 * Fake how the disk resolves names, whatever disk the tests run on: macOS
 * ignores case and Unicode form, and Linux matches names exactly. Each fake
 * spies on fs.existsSync and fs.lstatSync, which is how the pipeline asks
 * whether two spellings are one file. readdir still lists names as stored.
 * vi.restoreAllMocks() undoes them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';

/** A name as a case- and normalization-insensitive disk such as APFS compares it. Written out here rather than imported, so the tests don't check the code against itself. */
const fold = (name: string) => name.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().normalize('NFC');

function entries(dir: string): string[] {
    try {
        return fs.readdirSync(dir);
    } catch {
        return [];
    }
}

/** The stored entry a case-insensitive disk would resolve `target` to, if any. */
function looseMatch(target: string): string | undefined {
    const name = fold(path.basename(target));
    const match = entries(path.dirname(target)).find((entry) => fold(entry) === name);
    return match === undefined ? undefined : path.join(path.dirname(target), match);
}

/** Whether `target`'s folder stores its name exactly. */
const exactMatch = (target: string) => entries(path.dirname(target)).includes(path.basename(target));

function missing(target: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`ENOENT: no such file or directory, lstat '${target}'`), { code: 'ENOENT' });
}

/** Resolve names the way a case- and normalization-insensitive disk does. */
export function fakeCaseInsensitiveDisk(): void {
    const realExistsSync = fs.existsSync;
    const realLstatSync = fs.lstatSync;
    vi.spyOn(fs, 'existsSync').mockImplementation(((target: fs.PathLike) =>
        realExistsSync(target) || looseMatch(String(target)) !== undefined) as typeof fs.existsSync);
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) =>
        realLstatSync(realExistsSync(target) ? target : looseMatch(String(target)) ?? target, options)
    ) as unknown as typeof fs.lstatSync);
}

/** Resolve only names stored exactly, the way a case-sensitive disk such as ext4 does. */
export function fakeCaseSensitiveDisk(): void {
    const realExistsSync = fs.existsSync;
    const realLstatSync = fs.lstatSync;
    vi.spyOn(fs, 'existsSync').mockImplementation(((target: fs.PathLike) =>
        realExistsSync(target) && exactMatch(String(target))) as typeof fs.existsSync);
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
        if (exactMatch(String(target))) return realLstatSync(target, options);
        if (options?.throwIfNoEntry === false) return undefined;
        throw missing(String(target));
    }) as unknown as typeof fs.lstatSync);
}
