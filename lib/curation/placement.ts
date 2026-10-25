import { references, ReferenceScanError, type AssetReference } from '../catalog/references';
import type { AuthoredSeries } from '../catalog/types';
import { readAuthoredSeries } from '../catalog/working-layer';
import { settledByPlacement, settlesByPlacement, type CurationEvent } from './events';

/**
 * Where each photograph is placed, for the inbox's judgment count: the
 * active revision, and every working-layer series whose sequence holds it.
 * The CLI's `curation list` and `show` use placedItems(), and so must any
 * other view of the inbox, so the counts never drift apart. It takes no lock
 * and writes nothing.
 */

/** One photograph's placement. */
export interface Placement {
    /** `the active revision <revisionId>`, then `the series <seriesId>` for each series holding it, by ID. */
    holders: string[];
    /** The asset revisions those holders pin: the active revision's, and the photo record's when a series holds it. */
    assetRevisions: Set<string>;
}

/** Placements by photo ID. A photo with no entry has no holder. */
export type PlacementIndex = Map<string, Placement>;

/**
 * Every placement, in one pass over references() and one over the series
 * records. Only a series' sequence (`photoIds`) places a photo: a cover,
 * opening, or chapter start outside it doesn't, since validate refuses that
 * series. Pure, so a test can feed it.
 */
export function buildPlacementIndex(list: readonly AssetReference[], series: readonly Pick<AuthoredSeries, 'id' | 'photoIds'>[]): PlacementIndex {
    const index: PlacementIndex = new Map();
    const placement = (photoId: string): Placement => {
        let found = index.get(photoId);
        if (!found) index.set(photoId, (found = { holders: [], assetRevisions: new Set() }));
        return found;
    };
    const pinned = new Map<string, string>();
    for (const entry of list) {
        if (entry.source === 'working-layer-photo' && entry.assetRevision !== null) pinned.set(entry.photoId, entry.assetRevision);
        if (entry.source !== 'active-revision') continue;
        const found = placement(entry.photoId);
        const holder = `the active revision ${entry.holder}`;
        if (!found.holders.includes(holder)) found.holders.push(holder);
        if (entry.assetRevision !== null) found.assetRevisions.add(entry.assetRevision);
    }
    for (const record of [...series].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
        for (const photoId of new Set(record.photoIds)) {
            const found = placement(photoId);
            found.holders.push(`the series ${record.id}`);
            const pin = pinned.get(photoId);
            if (pin !== undefined) found.assetRevisions.add(pin);
        }
    }
    return index;
}

/**
 * Every placement in the data root, or `unknown` when references() can't
 * tell, as when any revision, candidate, or working-layer file can't be
 * read. Callers treat unknown as placed nowhere. Any other error is thrown.
 */
export async function placementIndex(root: string): Promise<PlacementIndex | { unknown: ReferenceScanError }> {
    try {
        const list = await references(root);
        const { series, problems } = await readAuthoredSeries(root);
        // references() read the same records a moment ago, so only a write in between gets here.
        const [problem] = problems;
        if (problem) return { unknown: new ReferenceScanError(`authored/series/${problem.id}`, problem.reason, problem.issues[0]?.message ?? 'it changed while it was read') };
        return buildPlacementIndex(list, series);
    } catch (error) {
        if (error instanceof ReferenceScanError) return { unknown: error };
        throw error;
    }
}

export interface ItemPlacements {
    /** Items settled by placement (settledByPlacement()), each with what holds its photo. */
    placed: Map<string, string>;
    /** Why nothing could be settled, or null. */
    unknown: ReferenceScanError | null;
}

/**
 * The items among `events` settled by placement, from one placementIndex(),
 * read only when an item could settle. When it can't tell, none settles, so
 * each still counts.
 */
export async function placedItems(root: string, events: readonly CurationEvent[]): Promise<ItemPlacements> {
    const placed = new Map<string, string>();
    if (!events.some(settlesByPlacement)) return { placed, unknown: null };
    const index = await placementIndex(root);
    if ('unknown' in index) return { placed, unknown: index.unknown };
    for (const event of events) {
        const found = event.photoId === null ? undefined : index.get(event.photoId);
        if (found && settledByPlacement(event, found)) placed.set(event.id, `its photo is in ${found.holders.join(' and ')}`);
    }
    return { placed, unknown: null };
}
