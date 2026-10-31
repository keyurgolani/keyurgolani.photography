import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * What a perf run may write, and how it cleans up (the 2026-10-31 disk fill, notes/photo-perf-scroll/disk-0704.md):
 * the run checks the disk before it starts, keeps its scratch in one temp folder of its own, and removes that folder
 * in place when it ends, passed or failed. Never a move to ~/.Trash, which is the same volume and frees nothing.
 */

/** The free space a perf run needs before it starts, in GB, unless PERF_DISK_MIN_GB says otherwise. */
export const DISK_MIN_GB = 20;

/** The free GB on the volume holding `dir`. */
export function freeGb(dir: string): number {
    const stats = fs.statfsSync(dir);
    return (stats.bavail * stats.bsize) / 2 ** 30;
}

/** Throws, naming the numbers, when the volume holding `dir` has less than the floor free. */
export function checkDiskFloor(dir: string, minGb = Number(process.env.PERF_DISK_MIN_GB ?? DISK_MIN_GB)): number {
    if (!Number.isFinite(minGb) || minGb < 0) throw new Error(`PERF_DISK_MIN_GB is a number of GB, not ${JSON.stringify(process.env.PERF_DISK_MIN_GB)}`);
    const free = freeGb(dir);
    if (free < minGb) throw new Error(`Only ${free.toFixed(1)} GB is free on the volume holding ${dir}; a perf run needs ${minGb} GB (PERF_DISK_MIN_GB). Nothing was started.`);
    return free;
}

/** A run's own temp folder, under the OS temp folder, named so removeRunTemp knows it. */
export function makeRunTemp(prefix: string): string {
    if (!/^[a-z][a-z0-9-]*-$/.test(prefix)) throw new Error(`A run temp prefix is lowercase and ends in "-", not ${JSON.stringify(prefix)}`);
    return fs.mkdtempSync(path.join(os.tmpdir(), `perf-run-${prefix}`));
}

/**
 * Removes a folder makeRunTemp made, in place, read-only parts included. Anything else is refused: a path outside the
 * OS temp folder, or not named by makeRunTemp. Missing is fine, so it can run in afterAll and in a `finally` alike.
 */
export function removeRunTemp(dir: string | undefined): void {
    if (!dir) return;
    const resolved = path.resolve(dir);
    const tmp = fs.realpathSync(os.tmpdir());
    // Resolved through its parent, so a folder already gone still compares with the temp folder's real path.
    const parent = path.dirname(resolved);
    const real = path.join(fs.existsSync(parent) ? fs.realpathSync(parent) : parent, path.basename(resolved));
    if (path.dirname(real) !== tmp || !path.basename(real).startsWith('perf-run-')) throw new Error(`Not a run's temp folder, so it stays: ${dir}`);
    if (!fs.existsSync(real)) return;
    // The read-only parts (a served tree, a scratch catalog) get their write bit back first, or nothing under them goes.
    for (const entry of fs.readdirSync(real, { recursive: true, withFileTypes: true })) {
        if (entry.isDirectory()) fs.chmodSync(path.join(entry.parentPath, entry.name), 0o700);
    }
    fs.chmodSync(real, 0o700);
    fs.rmSync(real, { recursive: true, force: true });
}

/** Marks a tree read-only, folders 0555 and files 0444, so a server that writes to it fails instead. */
export function makeReadOnly(dir: string): void {
    for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
        const file = path.join(entry.parentPath, entry.name);
        if (entry.isDirectory()) fs.chmodSync(file, 0o555);
        else if (entry.isFile()) fs.chmodSync(file, 0o444);
    }
    fs.chmodSync(dir, 0o555);
}

/** Whether `dir` is marked read-only (its own write bits are off). */
export function isReadOnly(dir: string): boolean {
    return (fs.statSync(dir).mode & 0o222) === 0;
}
