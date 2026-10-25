import fs from 'node:fs';
import path from 'node:path';
import {
    CorruptDocumentError,
    EditedInPlaceError,
    MisnamedVersionError,
    readVersionedDocument,
    StaleVersionError,
    writeVersionedDocument,
    type VersionedWriteHooks,
} from '../storage/document';
import { hasErrorCode, PRIVATE_DIR_MODE } from '../storage/fsx';
import { withLock, type LockContext } from '../storage/lock';
import { EVENT_ID_RE, parseEvent, type CurationEvent } from './events';

/**
 * Where curation records live: `curation/` in the data root. Each event is a
 * version folder (lib/storage/document.ts), `curation/events/<eventId>/`,
 * written with compare-and-swap on `version` under the cross-container
 * `curation` lock, so the watcher's sink and the curator's commands never
 * lose each other's writes. Folder names come only from event IDs checked
 * against EVENT_ID_RE, never from a source file name. The suggestion rules
 * are `curation/rules.json`, which only the owner writes.
 */

export const CURATION_LOCK = 'curation';
export const CURATION_LEASE_MS = 30_000;
export const CURATION_WAIT_MS = 10_000;

export function curationPaths(root: string) {
    const dir = path.join(root, 'curation');
    return { dir, events: path.join(dir, 'events'), rules: path.join(dir, 'rules.json') };
}

/** The version folder of one event. Throws for an ID that can't name one, so no other name ever becomes a path. */
export function eventDir(root: string, eventId: string): string {
    if (!EVENT_ID_RE.test(eventId)) throw new TypeError(`${JSON.stringify(eventId)} is not an event ID.`);
    return path.join(curationPaths(root).events, eventId);
}

/** An event that exists but can't be used. It names the event, never a path. */
export interface EventProblem {
    id: string;
    reason: 'unreadable' | 'invalid-json' | 'edited-in-place' | 'file-name' | 'unknown-schema-version' | 'invalid';
    message: string;
}

export class EventUnusableError extends Error {
    readonly problem: EventProblem;

    constructor(problem: EventProblem) {
        super(`The event ${problem.id} can't be used: ${problem.message}`);
        this.name = 'EventUnusableError';
        this.problem = problem;
    }
}

type Loaded = { event: CurationEvent } | { problem: EventProblem } | null;

async function load(root: string, id: string): Promise<Loaded> {
    const problem = (reason: EventProblem['reason'], message: string): Loaded => ({ problem: { id, reason, message } });
    let stored: Awaited<ReturnType<typeof readVersionedDocument>>;
    try {
        stored = await readVersionedDocument(eventDir(root, id));
    } catch (error) {
        if (error instanceof EditedInPlaceError) {
            return problem('edited-in-place', `v${error.version}.json was edited in place. Copy it to the next number while no command runs (cp -n v${error.version}.json v${error.version + 1}.json)`);
        }
        if (error instanceof MisnamedVersionError) return problem('file-name', 'a file in its folder looks like a version but is not named v<N>.json');
        if (error instanceof CorruptDocumentError) return problem('invalid-json', 'its newest version is not a JSON object');
        const code = (error as NodeJS.ErrnoException).code;
        return problem('unreadable', code ? `it can't be read (${code})` : "it can't be read");
    }
    if (stored === null) return null;
    const parsed = parseEvent(stored.value);
    if (!parsed.ok) return problem(parsed.reason, parsed.issues.join('; '));
    if (parsed.event.id !== id) return problem('file-name', `it holds ${parsed.event.id}`);
    return { event: parsed.event };
}

/** One event, or null when there is none. Throws EventUnusableError when it exists but can't be used. */
export async function readEvent(root: string, eventId: string): Promise<CurationEvent | null> {
    const loaded = await load(root, eventId);
    if (loaded === null) return null;
    if ('problem' in loaded) throw new EventUnusableError(loaded.problem);
    return loaded.event;
}

/** Every event, oldest observation first, and the folders that couldn't be read as one. A missing `curation/` is an empty inbox. */
export async function listEvents(root: string): Promise<{ events: CurationEvent[]; problems: EventProblem[] }> {
    let names: string[];
    try {
        names = await fs.promises.readdir(curationPaths(root).events);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return { events: [], problems: [] };
        throw error;
    }
    const events: CurationEvent[] = [];
    const problems: EventProblem[] = [];
    // Dot-files are OS metadata. Anything else not named as an event is left alone.
    for (const name of names.filter((entry) => EVENT_ID_RE.test(entry)).sort()) {
        const loaded = await load(root, name);
        if (loaded === null) continue;
        if ('problem' in loaded) problems.push(loaded.problem);
        else events.push(loaded.event);
    }
    events.sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : a.id < b.id ? -1 : 1));
    return { events, problems };
}

async function ensureFolder(dir: string): Promise<void> {
    try {
        await fs.promises.mkdir(dir, { mode: PRIVATE_DIR_MODE });
    } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) throw error;
    }
}

/** An event that doesn't match the schema, so it is never written. */
export class InvalidEventError extends Error {
    constructor(eventId: string, issues: readonly string[]) {
        super(`The event ${eventId} is not valid: ${issues.join('; ')}`);
        this.name = 'InvalidEventError';
    }
}

/** The stored event moved since the caller read it. */
export class EventMovedError extends Error {
    readonly eventId: string;
    readonly expected: number;
    readonly found: number;

    constructor(eventId: string, expected: number, found: number) {
        super(`The event ${eventId} is at version ${found}, not ${expected}. Show it again and review it.`);
        this.name = 'EventMovedError';
        this.eventId = eventId;
        this.expected = expected;
        this.found = found;
    }
}

/**
 * Commit `event` as the next version of its folder, only while its newest
 * version is still `expectedVersion` (0 for a new event). Call it under the
 * curation lock. Throws EventMovedError when another writer got there first,
 * and writes nothing then.
 */
export async function writeEvent(root: string, event: CurationEvent, expectedVersion: number, hold: LockContext, hooks?: VersionedWriteHooks): Promise<CurationEvent> {
    if (hold.name !== CURATION_LOCK || hold.signal.aborted) throw new Error('An event is written only under a live hold on the curation lock.');
    const parsed = parseEvent({ ...event, version: expectedVersion + 1 });
    if (!parsed.ok) throw new InvalidEventError(String(event.id), parsed.issues);
    const paths = curationPaths(root);
    await ensureFolder(paths.dir);
    await ensureFolder(paths.events);
    try {
        return await writeVersionedDocument(eventDir(root, event.id), parsed.event, expectedVersion, { hooks });
    } catch (error) {
        if (error instanceof StaleVersionError) throw new EventMovedError(event.id, expectedVersion, error.found);
        throw error;
    }
}

/** Run `fn` holding the curation lock on `root`. */
export function withCurationLock<T>(root: string, options: { waitMs?: number; leaseMs?: number }, fn: (hold: LockContext) => Promise<T>): Promise<T> {
    return withLock(CURATION_LOCK, { root, waitMs: options.waitMs ?? CURATION_WAIT_MS, leaseMs: options.leaseMs ?? CURATION_LEASE_MS }, fn);
}

/** The most `curation/rules.json` may hold. */
export const RULES_MAX_BYTES = 256 * 1024;

/** `curation/rules.json` can't be used. The reason never names a path. */
export class RulesFileError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = 'RulesFileError';
    }
}

/**
 * `curation/rules.json` as parsed JSON, or null when there is none. The
 * watcher reads it inside the registry hold, so it is opened without
 * blocking and checked on the open handle first: anything but a regular
 * file of at most RULES_MAX_BYTES, such as a FIFO, a device, or a folder, is
 * a RulesFileError and is never read. So is a file that isn't JSON.
 */
export async function readRulesFile(root: string): Promise<unknown | null> {
    let handle: fs.promises.FileHandle;
    try {
        handle = await fs.promises.open(curationPaths(root).rules, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return null;
        throw new RulesFileError(`it can't be opened (${(error as NodeJS.ErrnoException).code ?? 'an I/O error'})`);
    }
    try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new RulesFileError('it is not a regular file');
        if (stat.size > RULES_MAX_BYTES) throw new RulesFileError(`it is ${stat.size} bytes, and the most is ${RULES_MAX_BYTES}`);
        const buffer = Buffer.alloc(stat.size);
        const { bytesRead } = stat.size === 0 ? { bytesRead: 0 } : await handle.read(buffer, 0, stat.size, 0);
        try {
            return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown;
        } catch {
            throw new RulesFileError('it is not valid JSON');
        }
    } finally {
        await handle.close();
    }
}
