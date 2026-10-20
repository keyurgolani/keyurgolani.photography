import fs from 'node:fs';
import { atomicWriteJson, type AtomicWriteFaults } from './atomicWrite';
import { hasErrorCode } from './fsx';

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

function isRecord(value: unknown): value is Record<string, unknown> {
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
 * Write `next` only if the file is still at `expectedVersion`, storing it as
 * `expectedVersion + 1`. Throws StaleVersionError otherwise and leaves the
 * file alone. Callers hold the document's lock, so this catches writers that
 * lost their lock or never took it.
 */
export async function writeVersionedDocument<T extends VersionedDocument>(
    file: string,
    next: T,
    expectedVersion: number,
    { faults }: { faults?: AtomicWriteFaults } = {},
): Promise<T> {
    const found = versionOf(file, await readJsonFile(file));
    if (found !== expectedVersion) throw new StaleVersionError(file, expectedVersion, found);
    const written = { ...next, version: expectedVersion + 1 };
    await atomicWriteJson(file, written, { faults });
    return written;
}
