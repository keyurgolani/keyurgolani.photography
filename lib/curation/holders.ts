import { knownGood } from '../catalog/history';
import { references, ReferenceScanError, type AssetReference } from '../catalog/references';
import { listActivations } from '../catalog/repository';
import { readActivePointer } from '../catalog/working-layer';

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
    return { holders: holderNames(cache.list, photoId) };
}

/** The active revision and the working-layer series that list `photoId`, named for a note, each once. */
function holderNames(list: readonly AssetReference[], photoId: string): string[] {
    const holders = list
        .filter((entry) => entry.photoId === photoId && (entry.source === 'active-revision' || entry.source === 'working-layer-series'))
        .map((entry) => (entry.source === 'active-revision' ? `the active revision ${entry.holder}` : `the series ${entry.holder}`));
    return [...new Set(holders)];
}

/** What keeps a photo from being merged into another, which retires it. */
export interface MergeBlockers {
    /** The active revision and the working-layer series that show it, as photoHolders() names them. */
    shown: string[];
    /** The active revision's ID, when it lists the photo. */
    active: string | null;
    /** The working-layer series that list it, by ID. */
    series: string[];
    /**
     * The other revisions photos rollback can go back to (knownGood(), as
     * planRollback() reads it) that list it. A revision a crashed publish
     * wrote but never activated isn't one.
     */
    retained: string[];
    /** Whether the working layer holds a photo record for it. */
    record: boolean;
}

/**
 * Everything that refers to `photoId` and that a merge would break, for
 * #17's bind, or `unknown` when references() can't tell. Unlike
 * photoHolders(), it counts rollback targets and photo records too.
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
    const good = knownGood(await listActivations(root), await readActivePointer(root));
    const mine = list.filter((entry) => entry.photoId === photoId);
    const active = mine.find((entry) => entry.source === 'active-revision')?.holder ?? null;
    const series = [...new Set(mine.filter((entry) => entry.source === 'working-layer-series').map((entry) => entry.holder))];
    const retained = [...new Set(mine.filter((entry) => entry.source === 'revision' && good.has(entry.holder)).map((entry) => entry.holder))].sort();
    return { shown: holderNames(list, photoId), active, series, retained, record: mine.some((entry) => entry.source === 'working-layer-photo') };
}
