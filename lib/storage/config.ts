import fs from 'node:fs';
import path from 'node:path';
import { hasErrorCode, isInside, realpathLoose } from './fsx';

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
 * - `unwritable`: exists but can't be written. Only reported when asked with `write`.
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

/** The photo library: PHOTOGRAPHY_LIBRARY_DIR, or public/assets/photos under the working directory. */
export function libraryRoot(): string {
    return path.resolve(process.env.PHOTOGRAPHY_LIBRARY_DIR || path.join(process.cwd(), 'public/assets/photos'));
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

function canAccess(target: string, mode: number): boolean {
    try {
        fs.accessSync(target, mode);
        return true;
    } catch {
        return false;
    }
}

type MarkerCheck = { kind: 'valid' } | { kind: 'absent' | 'invalid'; detail: string } | { kind: 'future' | 'unreadable'; detail: string };

function checkMarker(root: string): MarkerCheck {
    const file = path.join(root, DATA_ROOT_FILE);
    let text: string;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return { kind: 'absent', detail: `${DATA_ROOT_FILE} is missing` };
        return { kind: 'unreadable', detail: `${DATA_ROOT_FILE} can't be read: ${(error as Error).message}` };
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
 * Classify the data root. With `write`, a root this process can't write is
 * `unwritable`; without it, the check is read-only, which is all the web
 * process needs.
 */
export function dataRootStatus({ write = false }: { write?: boolean } = {}): DataRootStatus {
    const root = dataRoot();
    if (root === null) return { state: 'unset', root, detail: 'PHOTOGRAPHY_DATA_DIR is not set' };

    let stat: fs.Stats;
    try {
        stat = fs.statSync(root);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return { state: 'unavailable', root, cause: 'missing', detail: 'it does not exist' };
        return { state: 'unavailable', root, cause: 'not-readable', detail: `it can't be read: ${(error as Error).message}` };
    }
    if (!stat.isDirectory()) return { state: 'unavailable', root, cause: 'not-a-directory', detail: 'it is not a directory' };

    // Identity state includes curator-only facts such as GPS, so it must never sit where Next serves
    // files, and the library scan must never walk into it.
    const realRoot = realpathLoose(root);
    for (const served of [libraryRoot(), path.join(process.cwd(), 'public')]) {
        if (isInside(realRoot, realpathLoose(served))) {
            return { state: 'unavailable', root, cause: 'inside-served-folder', detail: `it is inside ${served}` };
        }
    }

    if (!canAccess(root, fs.constants.R_OK | fs.constants.X_OK)) {
        return { state: 'unavailable', root, cause: 'not-readable', detail: 'it is not readable' };
    }

    const marker = checkMarker(root);
    if (marker.kind === 'future') return { state: 'unavailable', root, cause: 'newer-schema', detail: marker.detail };
    if (marker.kind === 'unreadable') return { state: 'unavailable', root, cause: 'marker-unreadable', detail: marker.detail };
    if (write && !canAccess(root, fs.constants.W_OK)) return { state: 'unwritable', root, detail: 'it is not writable' };
    if (marker.kind !== 'valid') return { state: 'uninitialized', root, detail: marker.detail };
    return { state: 'ready', root };
}

export function dataRootState(options: { write?: boolean } = {}): DataRootState {
    return dataRootStatus(options).state;
}
