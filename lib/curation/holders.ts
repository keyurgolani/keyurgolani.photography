import { references, ReferenceScanError, type AssetReference } from '../catalog/references';

/**
 * Who still shows a photograph: the active revision, or a working-layer
 * series. The one rule both the curator's dismiss and the sink's reopen use,
 * so the two never drift apart. It takes no lock and writes nothing, so the
 * watcher may load it.
 */

export type Holders = { holders: string[] } | { unknown: ReferenceScanError };

/** A references() scan, kept for one call site's lifetime. Undefined until the first use. */
export interface ReferenceCache {
    list?: AssetReference[] | ReferenceScanError;
}

/**
 * The holders of `photoId`, or `unknown` when references() can't tell, as
 * when any revision, candidate, or working-layer file can't be read. Callers
 * treat unknown as referenced. Any other error is thrown.
 */
export async function photoHolders(root: string, photoId: string, cache: ReferenceCache = {}): Promise<Holders> {
    if (cache.list === undefined) {
        try {
            cache.list = await references(root);
        } catch (error) {
            if (!(error instanceof ReferenceScanError)) throw error;
            cache.list = error;
        }
    }
    if (cache.list instanceof ReferenceScanError) return { unknown: cache.list };
    const holders = cache.list
        .filter((entry) => entry.photoId === photoId && (entry.source === 'active-revision' || entry.source === 'working-layer-series'))
        .map((entry) => (entry.source === 'active-revision' ? `the active revision ${entry.holder}` : `the series ${entry.holder}`));
    return { holders: [...new Set(holders)] };
}
