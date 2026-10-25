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
     * What the rebase stores as the site record's `baseSeriesOrder`: the Work
     * order without the owner's pending changes, placed in the target's
     * order. It equals `seriesOrder` unless the owner has a move the target
     * doesn't publish, so the next rebase still sees that move as the
     * owner's. Null only when a repeated entry left nothing to decide and the
     * base was unknown.
     */
    baseSeriesOrder: string[] | null;
    /**
     * Set when the owner and the target both changed the order of the series
     * they share, differently. The owner's order stays, and #13's rebase
     * records this as a conflict that blocks publish.
     */
    conflict: { field: 'seriesOrder'; base: string[]; active: string[] } | null;
}

const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index]);

export interface SeriesOrderRebaseInput {
    /** The site record's `seriesOrder`. */
    authored: readonly string[];
    /**
     * The site record's `baseSeriesOrder`, or, for a rebase onto what a
     * publish just compiled, the `seriesOrder` it compiled from. Null when
     * unknown, which counts as an owner's change.
     */
    baseAuthored: readonly string[] | null;
    /** The series IDs in `content.series` of the revision the record was based on, or none when it can't be read. */
    base: readonly string[];
    /** The series IDs in `content.series` of the revision becoming active. */
    target: readonly string[];
}

/**
 * Rebase the working layer's Work order onto a newly active revision.
 * Revisions don't carry `seriesOrder`, so this works from ID lists.
 *
 * The owner changed the order when `authored` differs from `baseAuthored`
 * anywhere, draft and hidden slots included, or when `baseAuthored` is
 * unknown. If the owner didn't, the series the target publishes take the
 * target's order within the slots they already hold, and draft, hidden, and
 * unpublished series stay where they are. If the owner did, the owner's order
 * stays. It is a conflict when the target changed too (it reorders the base's
 * series or publishes one the base didn't) and the two orders of the series
 * they share differ.
 */
export function rebaseSeriesOrder({ authored, baseAuthored, base, target }: SeriesOrderRebaseInput): SeriesOrderRebase {
    const inAuthored = new Set(authored);
    const inBase = new Set(base);
    const inTarget = new Set(target);
    // A repeated entry has two slots and one place in a revision. refs.series-order reports it, and the order stays as it is.
    const repeats = (list: readonly string[]) => new Set(list).size !== list.length;
    if (repeats(authored) || repeats(base) || repeats(target)) {
        return { seriesOrder: [...authored], baseSeriesOrder: baseAuthored && !repeats(baseAuthored) ? [...baseAuthored] : null, conflict: null };
    }
    const known = baseAuthored && !repeats(baseAuthored) ? baseAuthored : null;

    /** `list` with the series the target publishes in the target's order, in the slots they hold. */
    const placed = (list: readonly string[]) => {
        const members = new Set(list);
        const queue = target.filter((id) => members.has(id));
        let next = 0;
        return list.map((id) => (inTarget.has(id) ? queue[next++] : id));
    };

    if (known !== null && sameOrder(authored, known)) {
        const seriesOrder = placed(authored);
        return { seriesOrder, baseSeriesOrder: [...seriesOrder], conflict: null };
    }

    const targetChanged = target.some((id) => !inBase.has(id)) || !sameOrder(target.filter((id) => inBase.has(id)), base.filter((id) => inTarget.has(id)));
    const agree = sameOrder(authored.filter((id) => inTarget.has(id)), target.filter((id) => inAuthored.has(id)));
    return {
        seriesOrder: [...authored],
        baseSeriesOrder: placed(known ?? authored),
        conflict: targetChanged && !agree ? { field: 'seriesOrder', base: [...base], active: [...target] } : null,
    };
}
