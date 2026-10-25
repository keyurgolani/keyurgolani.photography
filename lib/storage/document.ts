import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './canonical';
import { fsyncDirectory, hasErrorCode, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from './fsx';

/**
 * Versioned documents: one folder per document, one file per version.
 *
 * A compare-and-swap document (the identity registry, each authored record)
 * is a folder such as `identity/registry/`, holding `v1.json`, `v2.json`, and
 * so on. Its version is the highest number there, and a folder with none is
 * version 0. The API is three calls:
 *
 * - readVersionedDocument(dir) reads the newest version.
 * - writeVersionedDocument(dir, next, expected) commits version expected + 1,
 *   or throws StaleVersionError when the newest isn't `expected`.
 * - pruneVersions(dir) keeps the newest KEEP_VERSIONS. Each commit runs it.
 *
 * Commit. A writer stages its content in a temp file named for the version it
 * wants, `.v<M>.<pid>.<uuid>.tmp`, fsynced. Only then does it list the folder,
 * and it stops unless the newest is still `expected` (M - 1). Then it link()s
 * the temp to `v<M>.json`. link() never replaces a file, so of two writers at
 * one version only one gets through, and the other's EEXIST is
 * StaleVersionError. A temp that has gone (ENOENT, swept by a prune) is
 * StaleVersionError too. A write that returns has linked its version, and
 * nothing renames over a version once it exists, so every read that starts
 * afterward sees that version or a later one. There is no check after the
 * link, no claim to settle, and no clock: a writer paused anywhere either
 * commits its own number or fails, and never puts an old version back.
 *
 * Prune rule. pruneVersions() lists the folder and takes its newest, H. It
 * first removes the temps named for a version at or below H, and only then
 * the versions numbered H - keep or below. Temps above H stay, since a writer
 * may be committing H + 1. A crashed writer's temp goes at a later commit's
 * prune.
 *
 * Why a pruned number is never committed again. A link to `v<K>.json`
 * succeeds only while no `v<K>.json` exists. Say pruner P deleted an earlier
 * `v<K>.json`, from a listing whose newest was H > K. If the writer's temp
 * existed at P's listing, P swept it before deleting `v<K>.json`: a link
 * before the sweep finds `v<K>.json` (EEXIST), and one after it finds no temp
 * (ENOENT). If the temp was created after P's listing, the writer's own
 * listing comes later still and sees a newest of at least H, above K - 1, so
 * it stops before it links. This assumes a listing returns every name that
 * exists throughout it, which POSIX readdir() gives, and these folders hold a
 * handful of names.
 *
 * Readers. A reader lists the folder, opens the newest, and reads it. A
 * version it has open stays readable after a prune unlinks it. One pruned
 * between its listing and its open, which takes KEEP_VERSIONS more commits
 * and a prune in between, is ENOENT, and the reader lists again, up to
 * READ_ATTEMPTS times.
 *
 * Stamp. Every committed version carries `stamp: { version, sha256 }`: its
 * own number and the SHA-256 of its body without the stamp, as canonical JSON,
 * so formatting and key order don't count. Readers check the newest only:
 * - a stamp naming its own number with a matching hash is a normal version;
 * - a stamp that's missing or names another number is a hand-made version,
 *   such as `cp -n v3.json v4.json` and an edit of the copy. It reads as its
 *   file's number, after the caller's own validation, and the next write
 *   stamps its successor again;
 * - a stamp naming its own number with another hash was edited in place, and
 *   reading it throws EditedInPlaceError.
 *
 * Hand edits copy the newest version to the next number and edit the copy,
 * only while no command runs, and never edit a version in place
 * (docs/data-root.md).
 *
 * What's left: a writer that crashes right after its link leaves a version it
 * never acknowledged, and an in-place edit that also strips or rewrites the
 * stamp reads as hand-made.
 */

/** Every document in the data root carries these two fields. */
export interface VersionedDocument {
    schemaVersion: number;
    /** Compare-and-swap counter: the number of the version file it was read from. A document with none is version 0. */
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
    /** What's wrong, without the path. */
    readonly reason: string;

    constructor(file: string, reason: string) {
        super(`${file} is not a valid document: ${reason}`);
        this.name = 'CorruptDocumentError';
        this.file = file;
        this.reason = reason;
    }
}

/**
 * The newest version of a document no longer matches its stamp: it was
 * edited in place. Copying it to the next number makes it a hand-made version
 * that reads again, and the message says so.
 */
export class EditedInPlaceError extends CorruptDocumentError {
    readonly version: number;

    constructor(file: string, version: number) {
        super(
            file,
            'it was edited in place, so it no longer matches its stamp. Never edit a version in place. '
                + `To keep the edit, copy it to the next number while no command runs (cp -n v${version}.json v${version + 1}.json); otherwise restore it from a backup`,
        );
        this.name = 'EditedInPlaceError';
        this.version = version;
    }
}

/** A name in a version folder that looks like a version but isn't spelled as one, such as `V3.JSON` or `v03.json`. */
export class MisnamedVersionError extends CorruptDocumentError {
    constructor(file: string) {
        super(
            file,
            `${path.basename(file)} looks like a version, but versions are named v<N>.json in lower case, with no leading zeros and at most ${MAX_VERSION_DIGITS} digits. Rename it`,
        );
        this.name = 'MisnamedVersionError';
    }
}

/** A compare-and-swap write found another version on disk than the one it read. */
export class StaleVersionError extends Error {
    /** The document's folder. */
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

/** How many versions a prune keeps, the newest by number. */
export const KEEP_VERSIONS = 2;

/** How many times a reader lists a folder when the version it picked is pruned before it opens it. */
export const READ_ATTEMPTS = 5;

/** The most digits a version number has, so every one reads exactly (Number.MAX_SAFE_INTEGER has 16). */
export const MAX_VERSION_DIGITS = 15;
const MAX_VERSION = Number('9'.repeat(MAX_VERSION_DIGITS));
const VERSION_NAME = new RegExp(`^v([1-9]\\d{0,${MAX_VERSION_DIGITS - 1}})\\.json$`);
/**
 * Anything a person, or a disk that folds names, could mean as a version: in
 * another case, with leading zeros, or too long to read. `u` folds the way APFS
 * does, so `v2.jſon` (U+017F) counts too.
 */
const VERSION_LIKE = /^v\d+\.json$/iu;
const TEMP_NAME = /^\.v([1-9]\d*)\.\d+\.[0-9a-f-]+\.tmp$/;

/** `<dir>/v<version>.json`. */
export function versionFile(dir: string, version: number): string {
    return path.join(dir, `v${version}.json`);
}

interface Listing {
    /** Version numbers, highest first. */
    versions: number[];
    /** Temp names, with the version each one is for. */
    temps: { name: string; version: number }[];
}

/** List a version folder. A missing folder is an empty one. */
async function list(dir: string): Promise<Listing> {
    let names: string[];
    try {
        names = await fs.promises.readdir(dir);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return { versions: [], temps: [] };
        throw error;
    }
    const versions: number[] = [];
    const temps: Listing['temps'] = [];
    for (const name of names) {
        const version = VERSION_NAME.exec(name);
        if (version) {
            versions.push(Number(version[1]));
            continue;
        }
        // A case-insensitive disk would hand `V4.JSON` out as `v4.json` to a writer's link, so it can't be passed over.
        if (VERSION_LIKE.test(name)) throw new MisnamedVersionError(path.join(dir, name));
        const temp = TEMP_NAME.exec(name);
        if (temp) temps.push({ name, version: Number(temp[1]) });
        // Anything else, such as OS metadata, is left alone.
    }
    versions.sort((a, b) => b - a);
    return { versions, temps };
}

const newestOf = (listing: Listing) => listing.versions[0] ?? 0;

/** SHA-256 hex of a version's body: the parsed value without its stamp, as canonical JSON. */
function bodyHash(body: Record<string, unknown>): string {
    return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

/**
 * The exact text a write commits as `version`: the value, with `version` set
 * to that number and its stamp added, pretty-printed with a trailing newline.
 * Exported so test fixtures can lay versions down as a writer would.
 */
export function versionText(value: object, version: number): string {
    // Through JSON first, so the hash covers exactly what a reader parses. Any stamp the value came with is replaced.
    const body = JSON.parse(JSON.stringify({ ...value, version, stamp: undefined })) as Record<string, unknown>;
    return `${JSON.stringify({ ...body, stamp: { version, sha256: bodyHash(body) } }, null, 2)}\n`;
}

export interface StoredVersion {
    version: number;
    /** The document without its stamp, with `version` set to its file's number. */
    value: Record<string, unknown>;
    /** The version file it was read from. */
    file: string;
    /** True when its stamp is missing or names another number, as for a copy made by hand. */
    handMade: boolean;
}

export interface ReadVersionHooks {
    /** After a listing picks the newest, before it is opened. */
    afterList?(file: string): void | Promise<void>;
    /** After the newest is opened, before it is read. */
    afterOpen?(file: string): void | Promise<void>;
}

function checkStamp(file: string, version: number, parsed: Record<string, unknown>): { value: Record<string, unknown>; handMade: boolean } {
    const { stamp, ...body } = parsed;
    const own = isRecord(stamp) && stamp.version === version;
    if (own && stamp.sha256 !== bodyHash(body)) throw new EditedInPlaceError(file, version);
    return { value: { ...body, version }, handMade: !own };
}

/**
 * Read the newest version in `dir`, or null when it has none. Throws
 * CorruptDocumentError when it isn't a JSON object, EditedInPlaceError when
 * it was edited in place, and MisnamedVersionError for a name that looks like
 * a version but isn't spelled as one. The caller checks the schema.
 */
export async function readVersionedDocument(dir: string, { hooks }: { hooks?: ReadVersionHooks } = {}): Promise<StoredVersion | null> {
    for (let attempt = 1; ; attempt++) {
        const version = newestOf(await list(dir));
        if (version === 0) return null;
        const file = versionFile(dir, version);
        await hooks?.afterList?.(file);
        let handle: fs.promises.FileHandle;
        try {
            handle = await fs.promises.open(file, 'r');
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) throw error;
            // Pruned since the listing, so a newer version exists: look again.
            if (attempt < READ_ATTEMPTS) continue;
            throw new Error(`${dir} kept changing while it was read: its newest version was pruned ${READ_ATTEMPTS} times before it could be opened.`);
        }
        let text: string;
        try {
            await hooks?.afterOpen?.(file);
            text = await handle.readFile('utf8');
        } finally {
            await handle.close();
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch (error) {
            throw new CorruptDocumentError(file, error instanceof Error ? error.message : String(error));
        }
        if (!isRecord(parsed)) throw new CorruptDocumentError(file, 'expected a JSON object');
        return { version, file, ...checkStamp(file, version, parsed) };
    }
}

export interface VersionedWriteHooks {
    /** After the temp is staged and fsynced, before the folder is listed. */
    afterStage?(temp: string): void | Promise<void>;
    /** After the listing found the newest still at the expected version, before the link. */
    beforeLink?(temp: string): void | Promise<void>;
    /** After the link committed the version, before the folder fsync and the prune. Throw here to simulate a crash. */
    afterLink?(file: string): void | Promise<void>;
}

export interface VersionedWriteOptions {
    hooks?: VersionedWriteHooks;
    /** How many versions the prune after the commit keeps. */
    keep?: number;
}

/**
 * Commit `next` as version `expectedVersion + 1` of the document in `dir`,
 * only if its newest version is still `expectedVersion`. Throws
 * StaleVersionError otherwise and commits nothing. Callers hold the
 * document's lock, which only serializes their work: this is what stops a
 * writer that lost its lock, or never took it, from losing an update. `dir`
 * is created, readable by its owner only, and its parent must exist. A first
 * write (expectedVersion 0) fsyncs that parent too; callers that make the
 * levels above use ensureDirectory() with syncParent the same way. Returns
 * `next` at its new version.
 */
export async function writeVersionedDocument<T extends VersionedDocument>(
    dir: string,
    next: T,
    expectedVersion: number,
    { hooks, keep = KEEP_VERSIONS }: VersionedWriteOptions = {},
): Promise<T> {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new RangeError(`expectedVersion must be a non-negative integer, got ${expectedVersion}`);
    if (expectedVersion >= MAX_VERSION) throw new RangeError(`${dir} is at version ${expectedVersion}, the highest a version can be`);
    let created = false;
    try {
        await fs.promises.mkdir(dir, { mode: PRIVATE_DIR_MODE });
        created = true;
    } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) throw error;
    }
    const version = expectedVersion + 1;
    const file = versionFile(dir, version);
    const temp = path.join(dir, `.v${version}.${process.pid}.${randomUUID()}.tmp`);
    try {
        // Staged before the listing: a prune that could free this number either sees this temp and sweeps it before
        // it deletes anything, or ran before it, and then the listing below sees the newer version that prune kept.
        const handle = await fs.promises.open(temp, 'wx', PRIVATE_FILE_MODE);
        try {
            await handle.writeFile(versionText(next, version));
            await handle.sync();
        } finally {
            await handle.close();
        }
        await hooks?.afterStage?.(temp);
        const found = newestOf(await list(dir));
        if (found !== expectedVersion) throw new StaleVersionError(dir, expectedVersion, found);
        await hooks?.beforeLink?.(temp);
        try {
            await fs.promises.link(temp, file);
        } catch (error) {
            // EEXIST: another writer committed this version. ENOENT: a prune swept the temp, so one has.
            if (!hasErrorCode(error, 'EEXIST', 'ENOENT')) throw error;
            const now = await list(dir).then(newestOf, () => version);
            throw new StaleVersionError(dir, expectedVersion, Math.max(version, now));
        }
        await hooks?.afterLink?.(file);
        await fsyncDirectory(dir);
        // A first version survives a crash only with its folder's entry in the parent. Another writer may have made
        // the folder and then lost or crashed before it synced the parent, so a first write syncs it either way.
        if (created || expectedVersion === 0) await fsyncDirectory(path.dirname(dir));
    } finally {
        await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    }
    // Committed. A prune that fails leaves extra versions, which the next one removes.
    await pruneVersions(dir, { keep }).catch(() => undefined);
    return { ...next, version };
}

export interface PruneOptions {
    /** How many versions to keep, the newest by number. */
    keep?: number;
    hooks?: {
        /** After the temps are swept, before any version is deleted. */
        afterSweep?(): void | Promise<void>;
    };
}

/**
 * Apply the prune rule to `dir`: with H its newest version, remove the temps
 * named for H or below, then the versions numbered H - keep or below. Returns
 * the names it removed, temps first.
 */
export async function pruneVersions(dir: string, { keep = KEEP_VERSIONS, hooks }: PruneOptions = {}): Promise<string[]> {
    if (!Number.isInteger(keep) || keep < 1) throw new RangeError(`keep must be a positive integer, got ${keep}`);
    const listing = await list(dir);
    const newest = newestOf(listing);
    if (newest === 0) return [];
    const removed: string[] = [];
    const remove = async (name: string) => {
        try {
            await fs.promises.unlink(path.join(dir, name));
            removed.push(name);
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) throw error;
        }
    };
    // Temps first. A writer still holding one for a version at or below the newest can't commit it: its link finds
    // that version (EEXIST) or, once swept, no temp (ENOENT). Only then may a version number go free.
    for (const temp of listing.temps) if (temp.version <= newest) await remove(temp.name);
    await hooks?.afterSweep?.();
    for (const version of listing.versions) if (version <= newest - keep) await remove(`v${version}.json`);
    return removed;
}
