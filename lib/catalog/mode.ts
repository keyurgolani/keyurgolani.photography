import fs from 'node:fs/promises';
import path from 'node:path';
import { hasErrorCode } from '../storage/fsx';
import { listActivations } from './repository';
import type { ActivePointer } from './types';
import { readActivePointer } from './working-layer';

export type CatalogMode = 'legacy' | 'catalog';

/** What catalogMode() found: the mode, and when it is `catalog` only because something couldn't be read, what failed. */
export interface ModeCheck {
    mode: CatalogMode;
    /** A short, path-free name for what couldn't be read. Set only for a `catalog` this process doesn't remember. */
    unreadable?: string;
}

/**
 * Where the process keeps the data roots it has seen cut over. The build
 * inlines this module separately into the proxy and into each server
 * bundle, so a module-level Set would give each its own memory, and the
 * proxy could forget a cutover /api/ready remembers. One Set on globalThis,
 * under a registered symbol every copy finds, is the process's only memory.
 */
export const CUTOVER_KEY = Symbol.for('keyurgolani.photography.catalogCutover');

/** Data roots this process has seen cut over, shared by every bundle. */
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

/** Read the active pointer once. The public reader hands the result to checkCatalogMode(), so a request reads it once. */
export async function readPointer(root: string): Promise<PointerRead> {
    try {
        return { pointer: await readActivePointer(root) };
    } catch (error) {
        return { error };
    }
}

/**
 * Whether a pointer read shows a cutover. A file system error carries an
 * errno code and says nothing either way. readActivePointer() throws any
 * other error only when the folder holds a version that isn't a valid
 * pointer, such as a damaged one or one edited in place, and that is a
 * cutover too.
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
 * "can't tell, so catalog". Any other stat error, and a folder, say nothing.
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
 * Where public reads come from, and why. `legacy` until the first
 * activation, and `catalog` once `catalog/active/` holds a version, valid or
 * not, or a committed activation exists. It then stays `catalog` for as long
 * as the process runs, even if both go away, so a public read never falls
 * back to the legacy library after the cutover.
 *
 * A file where the root's folder should be holds no catalog, so it is
 * `legacy`, as a missing root is (unless this process saw a cutover there).
 * The proxy refuses the legacy derivatives for both, since neither is a
 * folder, and the legacy pages find no photo list.
 *
 * When either can't be read, nobody can tell it isn't there, so this call
 * answers `catalog` too, with `unreadable` saying what failed. That answer
 * isn't remembered, so a transient error or a permission fixed later
 * doesn't keep a site that never published on catalog mode. The CLI may
 * call this; it reads only.
 *
 * `read` is the pointer read the caller made for this request, so the
 * pointer is read once. Without it, this call reads the pointer itself,
 * unless the process already remembers the cutover.
 */
export async function checkCatalogMode(root: string | null, read?: PointerRead): Promise<ModeCheck> {
    if (root === null) return { mode: 'legacy' };
    const resolved = path.resolve(/*turbopackIgnore: true*/ root);
    if (cutOver().has(resolved)) return { mode: 'catalog' };
    if (await isNotAFolder(resolved)) return { mode: 'legacy' };
    const pointer = pointerEvidence(read ?? await readPointer(resolved));
    const committed = 'found' in pointer && pointer.found ? pointer : await hasCommittedActivation(resolved);
    if (('found' in pointer && pointer.found) || ('found' in committed && committed.found)) {
        cutOver().add(resolved);
        return { mode: 'catalog' };
    }
    if ('unreadable' in pointer) return { mode: 'catalog', unreadable: pointer.unreadable };
    if ('unreadable' in committed) return { mode: 'catalog', unreadable: committed.unreadable };
    return { mode: 'legacy' };
}

/** checkCatalogMode()'s mode alone. */
export async function catalogMode(root: string | null): Promise<CatalogMode> {
    return (await checkCatalogMode(root)).mode;
}
