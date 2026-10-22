import fs from 'node:fs';
import path from 'node:path';
import { hasErrorCode } from '../storage/fsx';
import { listActivations } from './repository';
import { catalogPaths } from './working-layer';

export type CatalogMode = 'legacy' | 'catalog';

/** Data roots this process has seen cut over. */
const cutOver = new Set<string>();

async function exists(file: string): Promise<boolean> {
    try {
        await fs.promises.lstat(/*turbopackIgnore: true*/ file);
        return true;
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return false;
        // Something is there, or might be, so count it.
        return true;
    }
}

/** Whether a committed activation exists. One that can't be read counts, since nobody can tell it isn't one. */
async function hasCommittedActivation(root: string): Promise<boolean> {
    try {
        return (await listActivations(root)).some((activation) => activation.status === 'committed');
    } catch (error) {
        return !hasErrorCode(error, 'ENOENT');
    }
}

/**
 * Where public reads come from. `legacy` until the first activation, and
 * `catalog` once `catalog/active.json` or a committed activation exists. It
 * then stays `catalog` for as long as the process runs, even if both go
 * away, so a public read never falls back to the legacy library after the
 * cutover. Anything there that can't be read counts as cut over, for the
 * same reason. The CLI may call this; it reads only.
 */
export async function catalogMode(root: string | null): Promise<CatalogMode> {
    if (root === null) return 'legacy';
    const resolved = path.resolve(/*turbopackIgnore: true*/ root);
    if (cutOver.has(resolved)) return 'catalog';
    if (await exists(catalogPaths(resolved).active) || await hasCommittedActivation(resolved)) {
        cutOver.add(resolved);
        return 'catalog';
    }
    return 'legacy';
}
