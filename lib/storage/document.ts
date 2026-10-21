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

/** `<claim>.install`, the one name a claim is installed through. */
function installPathOf(claimPath: string): string {
    return `${claimPath}.install`;
}

export interface VersionedWriteOptions {
    /** `beforeRename` runs once the content is claimed, its install name taken and the version checked, before it moves into place. */
    faults?: AtomicWriteFaults;
    /** Judges the age of a claim and of an install name. */
    clock?: () => number;
    /** Test hooks. */
    hooks?: {
        /** After the first version check, before the claim. */
        beforeClaim?(): void | Promise<void>;
        /** After the claim and the check right after it, before the install name and the last check. */
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

/** Delete the claims, and the install names, for versions below `version`, which no write can still need. */
async function pruneClaims(file: string, version: number): Promise<void> {
    const prefix = `${path.basename(file)}.claim-`;
    for (const name of await fs.promises.readdir(path.dirname(file))) {
        if (!name.startsWith(prefix)) continue;
        const match = /^(\d+)(?:\.install)?$/.exec(name.slice(prefix.length));
        if (match && Number(match[1]) < version) await fs.promises.rm(path.join(path.dirname(file), name), { force: true });
    }
}

/**
 * Take a claim's install name by linking the claim to it, which never
 * replaces a file. `held` when another writer holds the name, and `gone` when
 * the claim has gone. A name left by a writer that died holding it goes once
 * it is VERSION_CLAIM_STALE_MS old, by the same rule as a claim.
 */
async function takeInstall(claimPath: string, now: number): Promise<'taken' | 'held' | 'gone'> {
    const installing = installPathOf(claimPath);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await fs.promises.link(claimPath, installing);
            return 'taken';
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) return 'gone';
            if (!hasErrorCode(error, 'EEXIST')) throw error;
        }
        let stat: fs.Stats;
        try {
            stat = await fs.promises.stat(installing);
        } catch (error) {
            // Let go between the link and the look
            if (hasErrorCode(error, 'ENOENT')) continue;
            throw error;
        }
        if (now - stat.ctimeMs < VERSION_CLAIM_STALE_MS) return 'held';
        await dropClaim(installing, stat);
    }
    return 'held';
}

/**
 * Settle a claim another writer holds on `version` when its writer is taken
 * for dead: the claim was linked more than VERSION_CLAIM_STALE_MS ago, by its
 * ctime, which the link sets, and the file is still at the version before.
 * Its content is complete, since a claim is linked only once its content is
 * fsynced, so it is installed, through its install name like any install. A
 * claim that isn't that version's document is removed instead, which frees
 * the version. Anything else is left as it is.
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
    } catch (error) {
        // Not a document, so nothing to install. A claim that can't be read is left alone.
        if (!(error instanceof CorruptDocumentError)) throw error;
    }
    // Something took its place since it was judged stale
    if (!sameId(await idOf(claimPath), stat)) return 'held';
    if (claimed !== version) {
        await dropClaim(claimPath, stat);
        return 'removed';
    }
    if ((await takeInstall(claimPath, now)) !== 'taken') return 'held';
    const installing = installPathOf(claimPath);
    const held = await idOf(installing);
    let holding = true;
    try {
        // No other writer installs the claim while this one holds its install name, so these checks hold until the rename.
        if (!sameId(held, stat) || versionOf(file, await readJsonFile(file)) !== version - 1) return 'held';
        try {
            await fs.promises.rename(installing, file);
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) throw error;
            // Taken for dead in turn, by a writer that took the name over to install the claim
            holding = false;
            return 'held';
        }
        holding = false;
        await fsyncDirectory(path.dirname(file));
    } finally {
        if (holding && held) await dropClaim(installing, held).catch(() => undefined);
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
 * read one version only the one whose link lands can store the next. A
 * writer whose link lands after the file has moved on lets it go and fails.
 *
 * A claim is installed only through its install name, `<claim>.install`. The
 * writer installing it links the claim there, which never replaces a file
 * either, checks the file is still at the version before, and renames the
 * name over the file. No other writer installs the claim while one holds the
 * name, so that check holds until the rename.
 *
 * Until its claim is installed no other writer gets past it. A writer that
 * died before it installed its claim leaves it, blocking the next version
 * until it is VERSION_CLAIM_STALE_MS old, and then the next writer installs
 * it. An install name left by a writer that died holding it goes by the same
 * rule. A writer that was only paused reports its write done once it finds
 * its content installed: right after its link, when the file is at its
 * version and is its content, and later, when the file is past what it read,
 * since only its claim can take the file there.
 *
 * Two gaps are left, both for a writer paused longer than
 * VERSION_CLAIM_STALE_MS. A writer paused right after its link, whose content
 * was installed and then replaced before it resumed, can't tell that from a
 * link that landed late, so it throws StaleVersionError though its content
 * was stored. And a writer paused between its last check and its rename can
 * still put its version back over a newer one, but only if another writer
 * holds the same install name again when it resumes, which takes a second
 * writer paused that long.
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
    const installing = installPathOf(claimPath);
    const written = { ...next, version };
    const temp = await stage(file, written);
    let id: FileId | null = null;
    let claimed = false;
    let holding = false;
    try {
        id = await idOf(temp);
        if (!id) throw new Error(`${temp} disappeared while it was staged.`);
        await hooks?.beforeClaim?.();
        claimed = await linkExclusive(temp, claimPath);
        // Another writer holds this version. One that died before installing it is settled for them, and an empty claim freed.
        if (!claimed && (await settleClaim(file, claimPath, version, clock(), hooks)) === 'removed') claimed = await linkExclusive(temp, claimPath);
        if (!claimed) throw new StaleVersionError(file, expectedVersion, Math.max(version, versionOf(file, await readJsonFile(file))));

        // Checked right after the link: a file that moved on means the link landed late, as for a writer that read long
        // ago, unless it is this writer's content at its version, installed by a writer that took this one for dead.
        const current = versionOf(file, await readJsonFile(file));
        if (current !== expectedVersion) {
            if (current === version && sameId(await idOf(file), id)) return written;
            throw new StaleVersionError(file, expectedVersion, current);
        }
        await hooks?.beforeInstall?.();
        const install = await takeInstall(claimPath, clock());
        holding = install === 'taken';
        // The last check, which holds until the rename once this writer holds the install name. Only this claim can take
        // the file past what this write read, so a file past that holds its content, installed by a writer that took this
        // one for dead, maybe with newer versions after it.
        const now = versionOf(file, await readJsonFile(file));
        if (now >= version) return written;
        if (now !== expectedVersion) throw new StaleVersionError(file, expectedVersion, now);
        if (install === 'held') {
            // A writer that took this one for dead holds the install name to install this claim, which stays for it.
            claimed = false;
            return written;
        }
        if (install === 'gone') throw new Error(`${claimPath} was removed before it was installed.`);
        await faults?.beforeRename?.(installing);
        try {
            await fs.promises.rename(installing, file);
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) throw error;
            // Taken for dead while it held the name: the writer that took the name over installs this claim, which stays for it.
            holding = false;
            claimed = false;
            return written;
        }
        holding = false;
        await faults?.afterRename?.();
        await fsyncDirectory(path.dirname(file));
        await pruneClaims(file, version + 1).catch(() => undefined);
        return written;
    } finally {
        // A write that fails while it runs lets its claim and its install name go. Only one whose process died leaves them,
        // for settleClaim().
        if (holding && id) await dropClaim(installing, id).catch(() => undefined);
        if (claimed && id) await dropClaim(claimPath, id).catch(() => undefined);
        await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    }
}
