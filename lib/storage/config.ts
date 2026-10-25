import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hasErrorCode, isInside, PRIVATE_FILE_MODE, realpathLoose } from './fsx';

/**
 * Root locations, resolved on every call so tests and tools can repoint them
 * through the environment without reloading modules.
 */

export const DATA_ROOT_FILE = 'data-root.json';
export const DATA_ROOT_SCHEMA_VERSION = 1;

/** `data-root.json`, written once by `photos:migrate --apply`. */
export interface DataRootMarker {
    schemaVersion: number;
    initializedAt: string;
}

/**
 * - `unset`: no PHOTOGRAPHY_DATA_DIR, and production has no default.
 * - `unavailable`: missing, not a readable directory, inside public/ or the
 *   library, or its `data-root.json` is unreadable or from a newer build.
 * - `unwritable`: exists but can't be written, or, asked with `versioned`,
 *   its filesystem can't hold the hard links every versioned write commits its
 *   version with, as on exFAT or FAT. Only reported when asked with `write`.
 * - `uninitialized`: usable, but has no valid `data-root.json`.
 * - `ready`: initialized and usable.
 */
export type DataRootState = 'unset' | 'unavailable' | 'unwritable' | 'uninitialized' | 'ready';

/** Why a data root is `unavailable`. */
export type DataRootUnavailableCause = 'missing' | 'not-a-directory' | 'inside-served-folder' | 'not-readable' | 'marker-unreadable' | 'newer-schema';

export interface DataRootStatus {
    state: DataRootState;
    /** The resolved data root, or null when unset. */
    root: string | null;
    /** Set when `unavailable`. */
    cause?: DataRootUnavailableCause;
    /** Why the state isn't `ready`, for logs and CLI output. Never sent to visitors. */
    detail?: string;
}

/**
 * The photo library: PHOTOGRAPHY_LIBRARY_DIR, or public/assets/photos under the working directory.
 *
 * The roots are found at run time, so the build must not trace them: the
 * ignore comments here and in dataRootStatus() keep Turbopack from copying
 * the whole project into .next/standalone.
 */
export function libraryRoot(): string {
    return path.resolve(/*turbopackIgnore: true*/ process.env.PHOTOGRAPHY_LIBRARY_DIR || path.join(process.cwd(), 'public/assets/photos'));
}

/**
 * The private data root: PHOTOGRAPHY_DATA_DIR, or portfolio-data under the
 * working directory outside production. Production has no default, so an
 * unconfigured server never invents one.
 */
export function dataRoot(): string | null {
    const configured = process.env.PHOTOGRAPHY_DATA_DIR;
    if (configured) return path.resolve(configured);
    if (process.env.NODE_ENV === 'production') return null;
    return path.join(process.cwd(), 'portfolio-data');
}

/**
 * The library or public/ folder `target` resolves inside, or null. Identity
 * state and migration reports name library paths, and the registry holds
 * curator-only facts such as GPS, so none of them may sit where Next serves
 * files or where the library scan would walk into them.
 */
export function servedFolderContaining(target: string): string | null {
    return servedFolderOf(target)?.folder ?? null;
}

/**
 * The served folder `target` resolves inside, with a name for messages. The
 * name carries no path, since the data-root detail reaches every command's
 * output and the logs.
 */
function servedFolderOf(target: string): { folder: string; name: string } | null {
    const realTarget = realpathLoose(target);
    const served = [
        { folder: libraryRoot(), name: 'the photo library' },
        { folder: path.join(process.cwd(), 'public'), name: 'the app\'s public folder' },
    ];
    return served.find(({ folder }) => isInside(realTarget, realpathLoose(folder))) ?? null;
}

function canAccess(target: string, mode: number): boolean {
    try {
        fs.accessSync(target, mode);
        return true;
    } catch {
        return false;
    }
}

// Data roots, by device and inode, that held a hard link in this process
const linkCapableRoots = new Set<string>();

/**
 * Why `root` can't take a versioned write, or null when it can. Each one
 * commits its version with link(), so this links a probe file there and
 * removes both names. A root that passes isn't probed again.
 */
function linkProblem(root: string, stat: fs.Stats): string | null {
    const key = `${stat.dev}:${stat.ino}`;
    if (linkCapableRoots.has(key)) return null;
    const probe = path.join(/*turbopackIgnore: true*/ root, `.link-probe-${process.pid}-${randomUUID()}`);
    try {
        fs.writeFileSync(probe, '', { flag: 'wx', mode: PRIVATE_FILE_MODE });
    } catch (error) {
        return `a file can't be created in it: ${(error as Error).message}`;
    }
    try {
        fs.linkSync(probe, `${probe}.link`);
        linkCapableRoots.add(key);
        return null;
    } catch (error) {
        return `its filesystem can't hold hard links, which every versioned write needs: ${(error as Error).message}`;
    } finally {
        fs.rmSync(`${probe}.link`, { force: true });
        fs.rmSync(probe, { force: true });
    }
}

/**
 * Why a read failed, by its error code. A system error's message names the
 * full path, and these details reach every command's output and the logs.
 */
function failure(error: unknown): string {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return typeof code === 'string' ? code : 'an unexpected error';
}

type MarkerCheck = { kind: 'valid' } | { kind: 'absent' | 'invalid'; detail: string } | { kind: 'future' | 'unreadable'; detail: string };

function checkMarker(root: string): MarkerCheck {
    const file = path.join(root, DATA_ROOT_FILE);
    let text: string;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return { kind: 'absent', detail: `${DATA_ROOT_FILE} is missing` };
        return { kind: 'unreadable', detail: `${DATA_ROOT_FILE} can't be read (${failure(error)})` };
    }
    let marker: unknown;
    try {
        marker = JSON.parse(text);
    } catch {
        return { kind: 'invalid', detail: `${DATA_ROOT_FILE} is not valid JSON` };
    }
    if (typeof marker !== 'object' || marker === null || Array.isArray(marker)) {
        return { kind: 'invalid', detail: `${DATA_ROOT_FILE} is not a JSON object` };
    }
    const { schemaVersion, initializedAt } = marker as Partial<Record<keyof DataRootMarker, unknown>>;
    if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
        return { kind: 'invalid', detail: `${DATA_ROOT_FILE} has no valid schemaVersion` };
    }
    if (schemaVersion > DATA_ROOT_SCHEMA_VERSION) {
        return { kind: 'future', detail: `${DATA_ROOT_FILE} has schemaVersion ${schemaVersion}, newer than this build reads (${DATA_ROOT_SCHEMA_VERSION})` };
    }
    if (schemaVersion < DATA_ROOT_SCHEMA_VERSION - 1) {
        return { kind: 'invalid', detail: `${DATA_ROOT_FILE} has schemaVersion ${schemaVersion}, which this build no longer reads` };
    }
    if (typeof initializedAt !== 'string' || Number.isNaN(Date.parse(initializedAt))) {
        return { kind: 'invalid', detail: `${DATA_ROOT_FILE} has no valid initializedAt` };
    }
    return { kind: 'valid' };
}

/**
 * Classify the data root, or `root` when a caller names one. With `write`, a
 * root this process can't write is `unwritable`; without it, the check is
 * read-only, which is all the web process needs. `versioned`, for callers
 * that write versioned documents, implies `write` and also links a probe file
 * in the root, so a filesystem that can't hold hard links is `unwritable` too. Nothing else
 * writes there, so a caller that writes elsewhere, as `photos:migrate
 * --dry-run --out` does, leaves the data root untouched.
 */
export function dataRootStatus(
    { write = false, versioned = false, root: named }: { write?: boolean; versioned?: boolean; root?: string } = {},
): DataRootStatus {
    const root = named === undefined ? dataRoot() : path.resolve(/*turbopackIgnore: true*/ named);
    if (root === null) return { state: 'unset', root, detail: 'PHOTOGRAPHY_DATA_DIR is not set' };

    let stat: fs.Stats;
    try {
        stat = fs.statSync(/*turbopackIgnore: true*/ root);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return { state: 'unavailable', root, cause: 'missing', detail: 'it does not exist' };
        return { state: 'unavailable', root, cause: 'not-readable', detail: `it can't be read (${failure(error)})` };
    }
    if (!stat.isDirectory()) return { state: 'unavailable', root, cause: 'not-a-directory', detail: 'it is not a directory' };

    const served = servedFolderOf(root);
    if (served !== null) return { state: 'unavailable', root, cause: 'inside-served-folder', detail: `it is inside ${served.name}` };

    if (!canAccess(root, fs.constants.R_OK | fs.constants.X_OK)) {
        return { state: 'unavailable', root, cause: 'not-readable', detail: 'it is not readable' };
    }

    const marker = checkMarker(root);
    if (marker.kind === 'future') return { state: 'unavailable', root, cause: 'newer-schema', detail: marker.detail };
    if (marker.kind === 'unreadable') return { state: 'unavailable', root, cause: 'marker-unreadable', detail: marker.detail };
    if (write || versioned) {
        if (!canAccess(root, fs.constants.W_OK)) return { state: 'unwritable', root, detail: 'it is not writable' };
        const problem = versioned ? linkProblem(root, stat) : null;
        if (problem !== null) return { state: 'unwritable', root, detail: problem };
    }
    if (marker.kind !== 'valid') return { state: 'uninitialized', root, detail: marker.detail };
    return { state: 'ready', root };
}

export function dataRootState(options: { write?: boolean; versioned?: boolean } = {}): DataRootState {
    return dataRootStatus(options).state;
}
