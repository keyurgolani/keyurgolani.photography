import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, type AtomicWriteFaults } from './atomicWrite';
import { hasErrorCode, PRIVATE_FILE_MODE } from './fsx';

/** Every document in the data root carries these two fields. */
export interface VersionedDocument {
    schemaVersion: number;
    /** Compare-and-swap counter. A file that doesn't exist yet is version 0. */
    version: number;
}

/**
 * A document written by a newer or much older build. A future schemaVersion
 * makes the data root `unavailable`: the watcher runs only the legacy step,
 * the CLI exits nonzero, and nothing is rewritten.
 */
export class UnsupportedSchemaError extends Error {
    readonly file: string;
    readonly found: number;
    readonly current: number;
    readonly future: boolean;

    constructor(file: string, found: number, current: number) {
        const future = found > current;
        super(
            future
                ? `${file} has schemaVersion ${found}, newer than this build reads (${current}). Upgrade before touching the data root.`
                : `${file} has schemaVersion ${found}, which this build no longer reads (it reads ${current} and ${current - 1}).`,
        );
        this.name = 'UnsupportedSchemaError';
        this.file = file;
        this.found = found;
        this.current = current;
        this.future = future;
    }
}

export class CorruptDocumentError extends Error {
    readonly file: string;

    constructor(file: string, reason: string) {
        super(`${file} is not a valid document: ${reason}`);
        this.name = 'CorruptDocumentError';
        this.file = file;
    }
}

/** A compare-and-swap write found another version on disk than the one it read. */
export class StaleVersionError extends Error {
    readonly file: string;
    readonly expected: number;
    readonly found: number;

    constructor(file: string, expected: number, found: number) {
        super(`${file} is at version ${found}, but this write expected ${expected}. Someone else wrote it first.`);
        this.name = 'StaleVersionError';
        this.file = file;
        this.expected = expected;
        this.found = found;
    }
}

/** Parse a JSON file. Returns null when it doesn't exist and throws CorruptDocumentError when it isn't JSON. */
export async function readJsonFile(file: string): Promise<unknown | null> {
    let text: string;
    try {
        text = await fs.promises.readFile(file, 'utf8');
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return null;
        throw error;
    }
    try {
        return JSON.parse(text) as unknown;
    } catch (error) {
        throw new CorruptDocumentError(file, error instanceof Error ? error.message : String(error));
    }
}

/** A parsed JSON object: not null and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Check a parsed document's schemaVersion. Readers accept the current version
 * and the one before it, and report which one they got so the caller can
 * upgrade it. Anything newer or older throws UnsupportedSchemaError.
 */
export function checkSchemaVersion(file: string, value: unknown, current: number): 'current' | 'previous' {
    if (!isRecord(value)) throw new CorruptDocumentError(file, 'expected a JSON object');
    const found = value.schemaVersion;
    if (typeof found !== 'number' || !Number.isInteger(found) || found < 1) {
        throw new CorruptDocumentError(file, 'schemaVersion must be a positive integer');
    }
    if (found === current) return 'current';
    if (found === current - 1) return 'previous';
    throw new UnsupportedSchemaError(file, found, current);
}

/** The CAS version of a parsed document, or 0 for a missing one. */
export function versionOf(file: string, value: unknown | null): number {
    if (value === null) return 0;
    if (!isRecord(value) || !isCount(value.version)) throw new CorruptDocumentError(file, 'version must be a non-negative integer');
    return value.version;
}

/** A version claim this old was left by a writer that died between its claim and its rename. */
export const VERSION_CLAIM_STALE_MS = 60_000;

/** `<file>.claim-<version>`, held by the one writer that may store `version`, from its claim until its rename. */
export function versionClaimPath(file: string, version: number): string {
    return `${file}.claim-${version}`;
}

export interface VersionedWriteOptions {
    faults?: AtomicWriteFaults;
    /** Judges a claim's age. */
    clock?: () => number;
    /** Test hooks. */
    hooks?: {
        /** After the first version check, before the claim. */
        beforeClaim?(): void | Promise<void>;
        /** After a claim is judged stale, before it is moved aside. */
        beforeBreak?(claimPath: string): void | Promise<void>;
    };
}

/**
 * Which claim file this is. The mtime counts too, since a disk can give a
 * new file the inode of one just deleted, and a rename never changes it.
 */
interface FileId {
    ino: number;
    dev: number;
    mtimeMs: number;
}

const sameFile = (a: FileId, b: FileId) => a.ino === b.ino && a.dev === b.dev && a.mtimeMs === b.mtimeMs;

/** Create a claim with O_EXCL. Null when another writer holds it. */
async function tryClaim(claimPath: string): Promise<FileId | null> {
    let handle: fs.promises.FileHandle;
    try {
        handle = await fs.promises.open(claimPath, 'wx', PRIVATE_FILE_MODE);
    } catch (error) {
        if (hasErrorCode(error, 'EEXIST')) return null;
        throw error;
    }
    try {
        const { ino, dev, mtimeMs } = await handle.stat();
        return { ino, dev, mtimeMs };
    } finally {
        await handle.close();
    }
}

/**
 * Delete the claim at `claimPath` only if it is still the file `id` names.
 * Deleting by path could delete a claim that took its place, so this moves it
 * to a unique name, checks what moved, and deletes only that. Anything else
 * is linked back. Returns whether the claim `id` names is gone.
 */
async function removeClaim(claimPath: string, id: FileId): Promise<boolean> {
    const aside = `${claimPath}.${randomUUID()}`;
    try {
        await fs.promises.rename(claimPath, aside);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return true;
        throw error;
    }
    const moved = await fs.promises.stat(aside);
    if (!sameFile(moved, id)) {
        try {
            await fs.promises.link(aside, claimPath);
        } catch (error) {
            if (!hasErrorCode(error, 'EEXIST')) throw error;
        }
        await fs.promises.rm(aside, { force: true });
        return false;
    }
    await fs.promises.rm(aside, { force: true });
    return true;
}

/** Break a claim older than VERSION_CLAIM_STALE_MS. Returns whether its path is free to claim. */
async function breakStaleClaim(claimPath: string, now: number, hooks: VersionedWriteOptions['hooks']): Promise<boolean> {
    let stat: fs.Stats;
    try {
        stat = await fs.promises.stat(claimPath);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return true; // Let go since the create failed
        throw error;
    }
    if (now - stat.mtimeMs < VERSION_CLAIM_STALE_MS) return false;
    await hooks?.beforeBreak?.(claimPath);
    return removeClaim(claimPath, stat);
}

/** Delete claims for versions below `version`, which a crash after its rename left and no write can still hold. */
async function pruneClaims(file: string, version: number): Promise<void> {
    const prefix = `${path.basename(file)}.claim-`;
    for (const name of await fs.promises.readdir(path.dirname(file))) {
        if (!name.startsWith(prefix)) continue;
        const claimed = Number(name.slice(prefix.length));
        if (Number.isInteger(claimed) && claimed < version) await fs.promises.rm(path.join(path.dirname(file), name), { force: true });
    }
}

/**
 * Write `next` only if the file is still at `expectedVersion`, storing it as
 * `expectedVersion + 1`. Throws StaleVersionError otherwise and leaves the
 * file alone. Callers hold the document's lock, so this catches writers that
 * lost their lock or never took it.
 *
 * Reading the version and then renaming isn't atomic, so the writer first
 * claims the version it stores with an exclusive create of
 * versionClaimPath(), checks the version again, renames, and lets the claim
 * go. Of two writers at one version, only the one holding the claim gets to
 * the rename. A claim older than VERSION_CLAIM_STALE_MS is one a writer left
 * when it died, and the next writer breaks it.
 */
export async function writeVersionedDocument<T extends VersionedDocument>(
    file: string,
    next: T,
    expectedVersion: number,
    { faults, clock = Date.now, hooks }: VersionedWriteOptions = {},
): Promise<T> {
    const found = versionOf(file, await readJsonFile(file));
    if (found !== expectedVersion) throw new StaleVersionError(file, expectedVersion, found);
    await hooks?.beforeClaim?.();

    const version = expectedVersion + 1;
    const claimPath = versionClaimPath(file, version);
    let claim = await tryClaim(claimPath);
    if (!claim && (await breakStaleClaim(claimPath, clock(), hooks))) claim = await tryClaim(claimPath);
    // Another writer holds the claim and is storing this version now.
    if (!claim) throw new StaleVersionError(file, expectedVersion, version);
    try {
        // A writer that read this version before another one moved the file on can still win the claim once that one let it go.
        const current = versionOf(file, await readJsonFile(file));
        if (current !== expectedVersion) throw new StaleVersionError(file, expectedVersion, current);
        const written = { ...next, version };
        await atomicWriteJson(file, written, { faults });
        await pruneClaims(file, version).catch(() => undefined);
        return written;
    } finally {
        // A claim that can't be removed here goes stale, and the next writer breaks it.
        await removeClaim(claimPath, claim).catch(() => undefined);
    }
}
