import { references, ReferenceScanError, type AssetReference } from '../catalog/references';

/**
 * Who still shows a photograph: the active revision, or a working-layer
 * series. The one rule both the curator's dismiss and the sink's reopen use,
 * so the two never drift apart. It takes no lock and writes nothing, so the
 * watcher may load it.
 */

export type Holders = { holders: string[] } | { unknown: ReferenceScanError };

/** A holder by kind and ID. */
type HolderEntry = { kind: 'revision' | 'series'; id: string };

/** The same holders by kind and ID, for the curator's page, which names a series by its title. */
export type HolderEntries = { entries: HolderEntry[] } | { unknown: ReferenceScanError };

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
    return { holders: found.entries.map(holderName) };
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
    return { entries: holderEntries(cache.list, photoId) };
}

/** The active revision and the working-layer series that list `photoId`, by kind and ID, each once. */
function holderEntries(list: readonly AssetReference[], photoId: string): HolderEntry[] {
    const seen = new Set<string>();
    const entries: HolderEntry[] = [];
    for (const entry of list) {
        if (entry.photoId !== photoId || (entry.source !== 'active-revision' && entry.source !== 'working-layer-series')) continue;
        const kind = entry.source === 'active-revision' ? 'revision' : 'series';
        if (seen.has(`${kind}:${entry.holder}`)) continue;
        seen.add(`${kind}:${entry.holder}`);
        entries.push({ kind, id: entry.holder });
    }
    return entries;
}

/** A holder as a note names it. */
function holderName(entry: HolderEntry): string {
    return entry.kind === 'revision' ? `the active revision ${entry.id}` : `the series ${entry.id}`;
}

/** What keeps a photo from being merged into another, which retires it. */
export interface MergeBlockers {
    /** The active revision and the working-layer series that show it, as photoHolders() names them. */
    shown: string[];
    /** The retained catalog revisions, besides the active one, that list it. A rollback to one needs its sets. */
    retained: string[];
    /** Whether the working layer holds a photo record for it, whose copy a merge would drop. */
    record: boolean;
}

/**
 * Everything that refers to `photoId` and that a merge would break, for
 * #17's bind, or `unknown` when references() can't tell. Unlike
 * photoHolders(), it counts retained revisions and photo records too.
 * Candidates are left out: the next publish compiles a new one. Any other
 * error is thrown.
 */
export async function mergeBlockers(root: string, photoId: string): Promise<MergeBlockers | { unknown: ReferenceScanError }> {
    let list: AssetReference[];
    try {
        list = await references(root);
    } catch (error) {
        if (!(error instanceof ReferenceScanError)) throw error;
        return { unknown: error };
    }
    const mine = list.filter((entry) => entry.photoId === photoId);
    const shown = mine
        .filter((entry) => entry.source === 'active-revision' || entry.source === 'working-layer-series')
        .map((entry) => (entry.source === 'active-revision' ? `the active revision ${entry.holder}` : `the series ${entry.holder}`));
    const retained = mine.filter((entry) => entry.source === 'revision').map((entry) => entry.holder);
    return { shown: [...new Set(shown)], retained: [...new Set(retained)].sort(), record: mine.some((entry) => entry.source === 'working-layer-photo') };
}
