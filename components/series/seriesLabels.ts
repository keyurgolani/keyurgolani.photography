import type { PhotoAlt } from '@/lib/a11y/photoName';
import type { SeriesFacts } from '@/lib/catalog/projections/series';

/** The projection's description as #1's alt union: described text, or decorative when there's none. */
export function altOf(description: string | null): PhotoAlt {
    return description === null ? { kind: 'decorative' } : { kind: 'described', text: description };
}

/** "2019 to 2023", or one year. */
export function yearsLabel(captured: NonNullable<SeriesFacts['captured']>): string {
    return captured.fromYear === captured.toYear ? String(captured.fromYear) : `${captured.fromYear} to ${captured.toYear}`;
}

/** Where the capture years came from, and how many entries carry a date when not all of them do. */
export function capturedSource(datedCount: number, total: number): string {
    return datedCount < total ? `From capture dates, ${datedCount} of ${total} dated` : 'From capture dates';
}
