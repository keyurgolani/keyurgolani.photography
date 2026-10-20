import type { CandidateContent, RevisionContent, SeriesRecord } from './types';

/**
 * Order helpers for public readers. They read one compiled revision or
 * candidate, never the working layer, so positions count only published
 * members. The authored arrays are the order: nothing here sorts or
 * shuffles, and there is no option to. No fs, lock, writer, or Next code.
 */

type Compiled = { content: RevisionContent | CandidateContent };
type SeriesOf<T extends Compiled> = T['content']['series'][number];
type PhotoOf<T extends Compiled> = T['content']['photos'][number];

const photoIndexes = new WeakMap<object, Map<string, PhotoOf<Compiled>>>();

function photosById<T extends Compiled>(revision: T): Map<string, PhotoOf<T>> {
    let index = photoIndexes.get(revision.content);
    if (!index) {
        index = new Map(revision.content.photos.map((photo) => [photo.id, photo]));
        photoIndexes.set(revision.content, index);
    }
    return index as Map<string, PhotoOf<T>>;
}

/** Published series in Work order, as compile wrote them from `seriesOrder`. */
export function orderedSeries<T extends Compiled>(revision: T): SeriesOf<T>[] {
    return [...revision.content.series] as SeriesOf<T>[];
}

/** Featured series in `featuredSeriesIds` order. Home opens on the first. */
export function featuredSeries<T extends Compiled>(revision: T): SeriesOf<T>[] {
    const byId = new Map<string, SeriesOf<T>>(revision.content.series.map((series) => [series.id, series as SeriesOf<T>]));
    return revision.content.site.featuredSeriesIds.flatMap((seriesId) => byId.get(seriesId) ?? []);
}

/** A series' photos in `photoIds` order, or none for a series the revision doesn't hold. */
export function orderedPhotos<T extends Compiled>(revision: T, seriesId: string): PhotoOf<T>[] {
    const series = revision.content.series.find((entry) => entry.id === seriesId);
    if (!series) return [];
    const byId = photosById(revision);
    return series.photoIds.flatMap((photoId) => byId.get(photoId) ?? []);
}

export interface SequencePosition {
    index: number;
    total: number;
    /** Null at the start. Wrapping around is a UI choice. */
    previousPhotoId: string | null;
    /** Null at the end. */
    nextPhotoId: string | null;
}

/** Where a photo sits in a series, or null when it isn't a member. */
export function sequencePosition(series: Pick<SeriesRecord, 'photoIds'>, photoId: string): SequencePosition | null {
    const index = series.photoIds.indexOf(photoId);
    if (index === -1) return null;
    return {
        index,
        total: series.photoIds.length,
        previousPhotoId: series.photoIds[index - 1] ?? null,
        nextPhotoId: series.photoIds[index + 1] ?? null,
    };
}

export interface SeriesOrderRebase {
    seriesOrder: string[];
    /**
     * Set when the curator and the target both reordered published series,
     * differently. The curator's order stays, and #13's rebase records this
     * as a conflict that blocks publish.
     */
    conflict: { field: 'seriesOrder'; base: string[]; active: string[] } | null;
}

const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * Rebase the working layer's Work order onto a newly active revision.
 * Revisions don't carry `seriesOrder`, so this works from ID lists: `authored`
 * is the site record's `seriesOrder`, and `base` and `target` are the series
 * IDs in `content.series` of the revision the record was based on and of the
 * one becoming active.
 *
 * If the curator kept the base's order, the series the target publishes take
 * the target's order within the slots they already hold, and draft, hidden,
 * and unpublished series stay where they are. If the curator reordered, that
 * order stays, and it is a conflict when the target reordered too, some other
 * way.
 */
export function rebaseSeriesOrder({ authored, base, target }: { authored: readonly string[]; base: readonly string[]; target: readonly string[] }): SeriesOrderRebase {
    const inAuthored = new Set(authored);
    const inBase = new Set(base);
    const inTarget = new Set(target);
    // A repeated entry has two slots and one place in a revision. refs.series-order reports it, and the order stays as it is.
    const repeats = (list: readonly string[], set: Set<string>) => set.size !== list.length;
    if (repeats(authored, inAuthored) || repeats(base, inBase) || repeats(target, inTarget)) return { seriesOrder: [...authored], conflict: null };

    const curatorChanged = !sameOrder(authored.filter((id) => inBase.has(id)), base.filter((id) => inAuthored.has(id)));
    if (!curatorChanged) {
        const queue = target.filter((id) => inAuthored.has(id));
        let next = 0;
        return { seriesOrder: authored.map((id) => (inTarget.has(id) ? queue[next++] : id)), conflict: null };
    }

    const targetChanged = !sameOrder(target.filter((id) => inBase.has(id)), base.filter((id) => inTarget.has(id)));
    const agree = sameOrder(authored.filter((id) => inTarget.has(id)), target.filter((id) => inAuthored.has(id)));
    return {
        seriesOrder: [...authored],
        conflict: targetChanged && !agree ? { field: 'seriesOrder', base: [...base], active: [...target] } : null,
    };
}
