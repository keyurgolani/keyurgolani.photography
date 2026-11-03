// Types only: the projection is server-only.
import type { HomeLoopSeries } from '@/lib/catalog/projections/home';

/** Home's featured series as one loop of photographs, as useHomePlayback moves through it. */
export interface HomeLoop {
    /** Every photograph in play order, starting on the opening one: each series from its opening photograph to its last, then its first up to the one before the opening, then the next series. */
    photoIds: readonly string[];
    /** The series each photograph plays in, by ID. */
    seriesOf: ReadonlyMap<string, HomeLoopSeries>;
}

/**
 * The loop of `series`, in the order the server put them: the one Home
 * opens on, then the rest. The server never puts a photograph in two of
 * them; if one ever came twice, it plays at its first place only, so the
 * slide stack never holds two slides for it.
 */
export function homeLoopOf(series: readonly HomeLoopSeries[]): HomeLoop {
    const photoIds: string[] = [];
    const seriesOf = new Map<string, HomeLoopSeries>();
    for (const entry of series) {
        const opening = Math.max(0, entry.photoIds.indexOf(entry.openingPhotoId));
        for (const photoId of [...entry.photoIds.slice(opening), ...entry.photoIds.slice(0, opening)]) {
            if (seriesOf.has(photoId)) continue;
            seriesOf.set(photoId, entry);
            photoIds.push(photoId);
        }
    }
    return { photoIds, seriesOf };
}
