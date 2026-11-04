// The Work covers' sizes, by their entry's span and their crop. Its own module, so the two components keep exporting
// components only (fast refresh).
import { ONE_RUNG_DOWN, photoSizes, type Fit, type PhotoBox } from '@/components/photoSizes';

export type CoverSpan = 'wide' | 'narrow';

/**
 * The column: the window less its two gutters, clamp(1rem, 3.3vw, 3rem) each
 * (styles/tokens.css). That's 2rem off under 485 px and 6.6vw off over it, a
 * little under the column from 1455 px, where the gutter stops at 3rem.
 */
const COLUMN_VW = 93.4;
const PHONE_BOX: PhotoBox[] = [
    { media: '(min-width: 485px)', vw: COLUMN_VW, ratio: 4 / 3 },
    { vw: 100, lessRem: 2, ratio: 4 / 3 },
];
/**
 * Above 768 px wide entries span 7 of the grid's 12 columns at 3:2, and
 * narrow ones 5 at 4:5 (SeriesCatalog.module.css): 7/12 or 5/12 of the
 * column, less 5/12 or 7/12 of a column gap. The gap is clamp(1rem, 2.5vw,
 * 2rem), plus two 12 px surrounds in Light and Bright, so at most 2.5vw and
 * 1.5rem there. Below 768 px every entry is the column wide, at 4:3. Black's
 * covers meet the screen's edge and are a little wider, which only asks for
 * a rung less.
 */
const GAP = { vw: 2.5, rem: 1.5 };
const BOXES: Record<CoverSpan, PhotoBox[]> = {
    wide: [{ media: '(min-width: 768px)', vw: (7 / 12) * COLUMN_VW - (5 / 12) * GAP.vw, lessRem: (5 / 12) * GAP.rem, ratio: 3 / 2 }, ...PHONE_BOX],
    narrow: [{ media: '(min-width: 768px)', vw: (5 / 12) * COLUMN_VW - (7 / 12) * GAP.vw, lessRem: (7 / 12) * GAP.rem, ratio: 4 / 5 }, ...PHONE_BOX],
};

/**
 * A cover's sizes by #6's size rule: its box for the span, and its own shape
 * and crop, at the one rung smaller rule 5 allows. Work shows several covers
 * at once, and on a 3x phone the rule's rung for a 3:2 cover is w1920, which
 * put Work's LCP behind v1.7.0's (#172).
 */
export function coverSizes(cover: { width: number; height: number; crop: Fit }, span: CoverSpan): string {
    return photoSizes(cover, cover.crop, BOXES[span], { scale: ONE_RUNG_DOWN });
}

/** The entry's span above 768 px, as SeriesCatalog.module.css sets it: the 1st and 4th of every four are wide. */
export function coverSpan(index: number): CoverSpan {
    return index % 4 === 0 || index % 4 === 3 ? 'wide' : 'narrow';
}
