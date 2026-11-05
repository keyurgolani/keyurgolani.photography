import { photoEntryName, type PhotoAlt } from '@/lib/a11y/photoName';
import type { SeriesFacts } from '@/lib/catalog/projections/series';

/** The suffix that keeps the cover's link name apart from its own sequence entry's (contract rule 2: names are unique). */
export const COVER_SUFFIX = 'series cover';

/** The cover link's name: its photograph's photoEntryName(), then COVER_SUFFIX. */
export function coverEntryName(input: Parameters<typeof photoEntryName>[0]): string {
    return `${photoEntryName(input)}, ${COVER_SUFFIX}`;
}

/** The projection's description as #1's alt union: described text, or decorative when there's none. */
export function altOf(description: string | null): PhotoAlt {
    return description === null ? { kind: 'decorative' } : { kind: 'described', text: description };
}

/** How many locations the facts show by name (#5). Any past it are counted, never listed. */
export const MAX_LOCATIONS = 3;

/** "Kyoto, Osaka, Nara", or the first MAX_LOCATIONS and how many more: "Kyoto, Osaka, Nara, and 2 more". */
export function locationsLabel(values: readonly string[]): string {
    const shown = values.slice(0, MAX_LOCATIONS).join(', ');
    const more = values.length - MAX_LOCATIONS;
    return more > 0 ? `${shown}, and ${more} more` : shown;
}

/** "2019 to 2023", or one year. */
export function yearsLabel(captured: NonNullable<SeriesFacts['captured']>): string {
    return captured.fromYear === captured.toYear ? String(captured.fromYear) : `${captured.fromYear} to ${captured.toYear}`;
}

/** Where the capture years came from, and how many entries carry a date when not all of them do. */
export function capturedSource(datedCount: number, total: number): string {
    return datedCount < total ? `From capture dates, ${datedCount} of ${total} dated` : 'From capture dates';
}
