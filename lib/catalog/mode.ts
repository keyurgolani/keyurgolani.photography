import fs from 'node:fs/promises';
import path from 'node:path';
import { hasErrorCode } from '../storage/fsx';
import { listActivations } from './repository';
import type { ActivePointer } from './types';
import { readActivePointer } from './working-layer';

/**
 * Whether a data root has published, as checkPublished() finds it. Since
 * #13's slice E nothing serves before the first activation, so this is what
 * tells "nothing published yet" from a catalog that can't be read, for
 * /api/ready and `photos status`.
 *
 * - `published`: `catalog/active/` holds a version, valid or not, or a
 *   committed activation exists, or this process saw either before.
 * - `unpublished`: neither, read cleanly; no data root configured, or no
 *   folder at its path, too.
 * - `unknown`: one of them couldn't be read, so nobody can tell.
 */
export type PublishState = 'published' | 'unpublished' | 'unknown';

/** What checkPublished() found, and for `unknown` a short, path-free name for what couldn't be read. */
export type PublishCheck = { state: Exclude<PublishState, 'unknown'> } | { state: 'unknown'; unreadable: string };

/**
 * Where the process keeps the data roots it has seen publish. The build
 * inlines this module separately into each server bundle, so a module-level
 * Set would give each its own memory, and one route could forget a launch
 * another remembers. One Set on globalThis, under a registered symbol every
 * copy finds, is the process's only memory.
 */
export const CUTOVER_KEY = Symbol.for('keyurgolani.photography.catalogCutover');

/** Data roots this process has seen publish, shared by every bundle. */
function cutOver(): Set<string> {
    const store = globalThis as typeof globalThis & { [CUTOVER_KEY]?: Set<string> };
    return (store[CUTOVER_KEY] ??= new Set<string>());
}

type Evidence = { found: boolean } | { unreadable: string };

/** A short, path-free name for an error. */
function errorName(error: unknown): string {
    if (typeof error === 'object' && error !== null && typeof (error as NodeJS.ErrnoException).code === 'string') return (error as NodeJS.ErrnoException).code as string;
    return error instanceof Error ? error.name : 'Error';
}

/**
 * One read of the active pointer through readActivePointer(): the newest
 * version in `catalog/active/`, null when the folder holds none, or what the
 * read threw.
 */
export type PointerRead = { pointer: ActivePointer | null } | { error: unknown };

/** Read the active pointer once. The public reader hands the result to checkPublished(), so a request reads it once. */
export async function readPointer(root: string): Promise<PointerRead> {
    try {
        return { pointer: await readActivePointer(root) };
    } catch (error) {
        return { error };
    }
}

/**
 * Whether a pointer read shows a publish. A file system error carries an
 * errno code and says nothing either way. readActivePointer() throws any
 * other error only when the folder holds a version that isn't a valid
 * pointer, such as a damaged one or one edited in place, and that shows a
 * publish too.
 */
function pointerEvidence(read: PointerRead): Evidence {
    if (!('error' in read)) return { found: read.pointer !== null };
    const { error } = read;
    if (typeof error !== 'object' || error === null || typeof (error as NodeJS.ErrnoException).code !== 'string') return { found: true };
    if (hasErrorCode(error, 'ENOENT')) return { found: false };
    return { unreadable: errorName(error) };
}

/**
 * True when something other than a folder sits at the root's path, or a
 * file sits where one of its parent folders should be (stat's ENOTDIR). No
 * catalog can live under a file, so that root is as missing as no path at
 * all, and reading under it throws ENOTDIR, which would otherwise read as
 * "can't tell". Any other stat error, and a folder, say nothing.
 */
async function isNotAFolder(root: string): Promise<boolean> {
    try {
        return !(await fs.stat(root)).isDirectory();
    } catch (error) {
        return hasErrorCode(error, 'ENOTDIR');
    }
}

async function hasCommittedActivation(root: string): Promise<Evidence> {
    try {
        return { found: (await listActivations(root)).some((activation) => activation.status === 'committed') };
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return { found: false };
        return { unreadable: errorName(error) };
    }
}

/**
 * Whether `root` has published. `unpublished` until the first activation,
 * and `published` once `catalog/active/` holds a version, valid or not, or a
 * committed activation exists. It then stays `published` for as long as the
 * process runs, even if both go away, so a launched site whose pointer
 * vanishes reports a pointer it can't read, never "nothing published yet".
 *
 * No data root, a missing path, and a file where the root's folder should be
 * hold no catalog, so they are `unpublished` (unless this process saw a
 * publish there).
 *
 * When either can't be read, nobody can tell whether the root published, so
 * the answer is `unknown`, with `unreadable` saying what failed. That answer
 * isn't remembered, so a transient error or a permission fixed later goes
 * back to what the files say. The CLI may call this; it reads only.
 *
 * `read` is the pointer read the caller made for this request, so the
 * pointer is read once. Without it, this call reads the pointer itself,
 * unless the process already remembers the publish.
 */
export async function checkPublished(root: string | null, read?: PointerRead): Promise<PublishCheck> {
    if (root === null) return { state: 'unpublished' };
    const resolved = path.resolve(/*turbopackIgnore: true*/ root);
    if (cutOver().has(resolved)) return { state: 'published' };
    if (await isNotAFolder(resolved)) return { state: 'unpublished' };
    const pointer = pointerEvidence(read ?? await readPointer(resolved));
    const committed = 'found' in pointer && pointer.found ? pointer : await hasCommittedActivation(resolved);
    if (('found' in pointer && pointer.found) || ('found' in committed && committed.found)) {
        cutOver().add(resolved);
        return { state: 'published' };
    }
    if ('unreadable' in pointer) return { state: 'unknown', unreadable: pointer.unreadable };
    if ('unreadable' in committed) return { state: 'unknown', unreadable: committed.unreadable };
    return { state: 'unpublished' };
}
