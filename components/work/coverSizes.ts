// The Work covers' sizes, by their entry's span. Its own module, so the two
// components keep exporting components only (fast refresh).

export type CoverSpan = 'wide' | 'narrow';

/**
 * Above 768 px wide entries span 7 of the grid's 12 columns and narrow ones 5
 * (SeriesCatalog.module.css), about 58% and 42% of the window once the gaps
 * are taken out, rounded up. Below it every entry is full width.
 */
export const COVER_SIZES: Record<CoverSpan, string> = {
    wide: '(min-width: 768px) 59vw, 100vw',
    narrow: '(min-width: 768px) 42vw, 100vw',
};

/** The entry's span above 768 px, as SeriesCatalog.module.css sets it: the 1st and 4th of every four are wide. */
export function coverSpan(index: number): CoverSpan {
    return index % 4 === 0 || index % 4 === 3 ? 'wide' : 'narrow';
}
