import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tempPathFor, type AtomicWriteFaults } from './atomicWrite';
import { fsyncDirectory, hasErrorCode, PRIVATE_FILE_MODE } from './fsx';
import { MAX_LEASE_MS } from './lock';

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

/**
 * How old an uninstalled claim must be before another writer takes its
 * writer for dead and installs it. Above MAX_LEASE_MS, so a writer that still
 * holds its lock, however slowly it runs, is never taken for dead.
 */
export const VERSION_CLAIM_STALE_MS = MAX_LEASE_MS + 60_000;

/**
 * `<file>.claim-<version>`: the one writer that stores `version` links its
 * staged content here, and removes the link once that content is the file.
 */
export function versionClaimPath(file: string, version: number): string {
    return `${file}.claim-${version}`;
}

export interface VersionedWriteOptions {
    /** `beforeRename` runs once the content is claimed and checked, before it moves into place. */
    faults?: AtomicWriteFaults;
    /** Judges a claim's age. */
    clock?: () => number;
    /** Test hooks. */
    hooks?: {
        /** After the first version check, before the claim. */
        beforeClaim?(): void | Promise<void>;
        /** After the claim and its version check, before the last check and the rename. */
        beforeInstall?(): void | Promise<void>;
        /** After another writer's claim is judged abandoned, before it is installed. */
        beforeRollForward?(claimPath: string): void | Promise<void>;
    };
}

interface FileId {
    ino: number;
    dev: number;
}

async function idOf(file: string): Promise<FileId | null> {
    try {
        const { ino, dev } = await fs.promises.stat(file);
        return { ino, dev };
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return null;
        throw error;
    }
}

const sameId = (a: FileId | null, b: FileId | null) => a !== null && b !== null && a.ino === b.ino && a.dev === b.dev;

/** Stage `value` beside `file` as an fsynced temp file, readable by its owner only. */
async function stage(file: string, value: unknown): Promise<string> {
    const temp = tempPathFor(file);
    const handle = await fs.promises.open(temp, 'wx', PRIVATE_FILE_MODE);
    try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
        await handle.sync();
    } finally {
        await handle.close();
    }
    return temp;
}

/** link() `from` to `to`, which never replaces a file. False when `to` exists. */
async function linkExclusive(from: string, to: string): Promise<boolean> {
    try {
        await fs.promises.link(from, to);
        return true;
    } catch (error) {
        if (hasErrorCode(error, 'EEXIST')) return false;
        throw error;
    }
}

/** Remove `claimPath` only while it is still the file `id` names. */
async function dropClaim(claimPath: string, id: FileId): Promise<void> {
    const aside = `${claimPath}.${randomUUID()}`;
    try {
        await fs.promises.rename(claimPath, aside);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return;
        throw error;
    }
    if (!sameId(await idOf(aside), id)) await linkExclusive(aside, claimPath);
    await fs.promises.rm(aside, { force: true });
}

/** Delete the claims for versions below `version`, which no write can still need. */
async function pruneClaims(file: string, version: number): Promise<void> {
    const prefix = `${path.basename(file)}.claim-`;
    for (const name of await fs.promises.readdir(path.dirname(file))) {
        if (!name.startsWith(prefix)) continue;
        const claimed = Number(name.slice(prefix.length));
        if (Number.isInteger(claimed) && claimed < version) await fs.promises.rm(path.join(path.dirname(file), name), { force: true });
    }
}

/**
 * Settle a claim another writer holds on `version` when its writer is taken
 * for dead: the claim was linked more than VERSION_CLAIM_STALE_MS ago, by its
 * ctime, which the link sets, and the file is still at the version before.
 * Its content is complete, since a claim is linked only once its content is
 * fsynced, so it is installed. A claim that isn't that version's document is
 * removed instead, which frees the version. Anything else is left as it is.
 */
async function settleClaim(file: string, claimPath: string, version: number, now: number, hooks: VersionedWriteOptions['hooks']): Promise<'held' | 'installed' | 'removed'> {
    let stat: fs.Stats;
    try {
        stat = await fs.promises.stat(claimPath);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return 'removed';
        throw error;
    }
    if (now - stat.ctimeMs < VERSION_CLAIM_STALE_MS) return 'held';
    await hooks?.beforeRollForward?.(claimPath);
    let claimed: number | null = null;
    try {
        claimed = versionOf(claimPath, await readJsonFile(claimPath));
    } catch {
        // Not a document, so nothing to install
    }
    // Something took its place since it was judged stale
    if (!sameId(await idOf(claimPath), stat)) return 'held';
    if (claimed !== version) {
        await dropClaim(claimPath, stat);
        return 'removed';
    }
    if (versionOf(file, await readJsonFile(file)) !== version - 1) return 'held';
    const staged = tempPathFor(file);
    if (!(await linkExclusive(claimPath, staged))) return 'held';
    try {
        await fs.promises.rename(staged, file);
        await fsyncDirectory(path.dirname(file));
    } finally {
        await fs.promises.rm(staged, { force: true }).catch(() => undefined);
    }
    await pruneClaims(file, version + 1).catch(() => undefined);
    return 'installed';
}

/**
 * Write `next` only if the file is still at `expectedVersion`, storing it as
 * `expectedVersion + 1`. Throws StaleVersionError otherwise and leaves the
 * file alone. Callers hold the document's lock, and this is what stops a
 * writer that lost its lock, or never took it, from losing an update.
 *
 * The content is staged first and claimed by link()ing it to
 * versionClaimPath(), which never replaces a file, so of the writers that
 * read one version only the one whose link lands can store the next. That
 * writer checks the version again and renames its content over the file. A
 * writer whose link lands after the file has moved on lets it go and fails.
 *
 * Until a claim is installed no other writer gets past it, so the file never
 * goes back to an older version while the claim's writer runs. A writer that
 * died between its link and its rename leaves a claim that blocks the next
 * version until it is VERSION_CLAIM_STALE_MS old. Then the next writer
 * installs it, and the claim's writer, if it was only paused, finds the file
 * past what it read and reports its write done, since only its content could
 * have taken the file there. The one gap left is a writer paused for longer
 * than that between its last check and its rename: it can still put its
 * version back over a newer one.
 */
export async function writeVersionedDocument<T extends VersionedDocument>(
    file: string,
    next: T,
    expectedVersion: number,
    { faults, clock = Date.now, hooks }: VersionedWriteOptions = {},
): Promise<T> {
    const found = versionOf(file, await readJsonFile(file));
    if (found !== expectedVersion) throw new StaleVersionError(file, expectedVersion, found);

    const version = expectedVersion + 1;
    const claimPath = versionClaimPath(file, version);
    const written = { ...next, version };
    const temp = await stage(file, written);
    let id: FileId | null = null;
    let claimed = false;
    try {
        id = await idOf(temp);
        if (!id) throw new Error(`${temp} disappeared while it was staged.`);
        await hooks?.beforeClaim?.();
        claimed = await linkExclusive(temp, claimPath);
        // Another writer holds this version. One that died before installing it is settled for them, and an empty claim freed.
        if (!claimed && (await settleClaim(file, claimPath, version, clock(), hooks)) === 'removed') claimed = await linkExclusive(temp, claimPath);
        if (!claimed) throw new StaleVersionError(file, expectedVersion, Math.max(version, versionOf(file, await readJsonFile(file))));

        // Checked right after the link: a file that moved on means the link landed late, as for a writer that read long ago.
        const current = versionOf(file, await readJsonFile(file));
        if (current !== expectedVersion) throw new StaleVersionError(file, expectedVersion, current);
        await hooks?.beforeInstall?.();
        // No writer can store this version but through this claim, so a file past what this write read holds its content,
        // installed by a writer that took this one for dead, maybe with newer versions after it.
        const now = versionOf(file, await readJsonFile(file));
        if (now >= version) return written;
        if (now !== expectedVersion) throw new StaleVersionError(file, expectedVersion, now);
        await faults?.beforeRename?.(temp);
        await fs.promises.rename(temp, file);
        await faults?.afterRename?.();
        await fsyncDirectory(path.dirname(file));
        await pruneClaims(file, version + 1).catch(() => undefined);
        return written;
    } finally {
        // A write that fails while it runs lets its claim go. Only one whose process died leaves it, for settleClaim().
        if (claimed && id) await dropClaim(claimPath, id).catch(() => undefined);
        await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    }
}
