import fs from 'node:fs';
import path from 'node:path';
import { hasErrorCode } from '../storage/fsx';
import { listActivations } from './repository';
import { catalogPaths } from './working-layer';

export type CatalogMode = 'legacy' | 'catalog';

/** What catalogMode() found: the mode, and when it is `catalog` only because something couldn't be read, what failed. */
export interface ModeCheck {
    mode: CatalogMode;
    /** A short, path-free name for what couldn't be read. Set only for a `catalog` this process doesn't remember. */
    unreadable?: string;
}

/** Data roots this process has seen cut over. */
const cutOver = new Set<string>();

type Evidence = { found: boolean } | { unreadable: string };

/** A short, path-free name for an error. */
function errorName(error: unknown): string {
    if (typeof error === 'object' && error !== null && typeof (error as NodeJS.ErrnoException).code === 'string') return (error as NodeJS.ErrnoException).code as string;
    return error instanceof Error ? error.name : 'Error';
}

async function exists(file: string): Promise<Evidence> {
    try {
        await fs.promises.lstat(/*turbopackIgnore: true*/ file);
        return { found: true };
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return { found: false };
        return { unreadable: errorName(error) };
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
 * activation, and `catalog` once `catalog/active.json` or a committed
 * activation exists. It then stays `catalog` for as long as the process
 * runs, even if both go away, so a public read never falls back to the
 * legacy library after the cutover.
 *
 * When either can't be read, nobody can tell it isn't there, so this call
 * answers `catalog` too, with `unreadable` saying what failed. That answer
 * isn't remembered, so a transient error or a permission fixed later
 * doesn't keep a site that never published on catalog mode. The CLI may
 * call this; it reads only.
 */
export async function checkCatalogMode(root: string | null): Promise<ModeCheck> {
    if (root === null) return { mode: 'legacy' };
    const resolved = path.resolve(/*turbopackIgnore: true*/ root);
    if (cutOver.has(resolved)) return { mode: 'catalog' };
    const pointer = await exists(catalogPaths(resolved).active);
    const committed = 'found' in pointer && pointer.found ? pointer : await hasCommittedActivation(resolved);
    if (('found' in pointer && pointer.found) || ('found' in committed && committed.found)) {
        cutOver.add(resolved);
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
