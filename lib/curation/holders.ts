import { references, ReferenceScanError, type AssetReference } from '../catalog/references';

/**
 * Who still shows a photograph: the active revision, or a working-layer
 * series. The one rule both the curator's dismiss and the sink's reopen use,
 * so the two never drift apart. It takes no lock and writes nothing, so the
 * watcher may load it.
 */

export type Holders = { holders: string[] } | { unknown: ReferenceScanError };

/** The same holders by kind and ID, for the curator's page, which names a series by its title. */
export type HolderEntries = { entries: { kind: 'revision' | 'series'; id: string }[] } | { unknown: ReferenceScanError };

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
    const found = await photoHolderEntries(root, photoId, cache);
    if ('unknown' in found) return found;
    return { holders: found.entries.map((entry) => (entry.kind === 'revision' ? `the active revision ${entry.id}` : `the series ${entry.id}`)) };
}

/** photoHolders(), by kind and ID: one scan, one rule, so the page and the CLI never disagree about who holds a photograph. */
export async function photoHolderEntries(root: string, photoId: string, cache: ReferenceCache = {}): Promise<HolderEntries> {
    if (cache.list === undefined) {
        try {
            cache.list = await references(root);
        } catch (error) {
            if (!(error instanceof ReferenceScanError)) throw error;
            cache.list = error;
        }
    }
    if (cache.list instanceof ReferenceScanError) return { unknown: cache.list };
    const seen = new Set<string>();
    const entries: { kind: 'revision' | 'series'; id: string }[] = [];
    for (const entry of cache.list) {
        if (entry.photoId !== photoId || (entry.source !== 'active-revision' && entry.source !== 'working-layer-series')) continue;
        const kind = entry.source === 'active-revision' ? 'revision' : 'series';
        if (seen.has(`${kind}:${entry.holder}`)) continue;
        seen.add(`${kind}:${entry.holder}`);
        entries.push({ kind, id: entry.holder });
    }
    return { entries };
}
