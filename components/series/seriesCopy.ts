/**
 * The sequence's sizes and interface copy, in a plain module, so the server
 * SeriesPage and the client SeriesSequence read the same values (a server
 * module importing a value from a 'use client' one gets a reference, not
 * the value).
 */

import { photoSizes, type PhotoBox } from '@/components/photoSizes';

/**
 * The cover's box: the column, the window less its two gutters, which are
 * clamp(1rem, 3.3vw, 3rem) each (styles/tokens.css), so 2rem off under 485 px
 * and 6.6vw off over it, and at most 82svh tall (SeriesPage.module.css).
 */
const COVER_BOXES: PhotoBox[] = [
    { media: '(min-width: 485px)', vw: 93.4, heightVh: 82 },
    { vw: 100, lessRem: 2, heightVh: 82 },
];

/**
 * The cover's sizes by #6's size rule: drawn at its own shape, it's shown
 * whole, so it asks for the column until the height cap makes the box
 * narrower than that, as it does for most photographs on a wide screen.
 * Without its dimensions, the column.
 */
export const coverSizes = (image: { width: number; height: number } | null) =>
    image === null ? '(min-width: 485px) 93.4vw, calc(100vw - 2rem)' : photoSizes(image, 'contain', COVER_BOXES);

/** Sequence thumbnails, about a fifth of the row on wide screens, a third on tablets, and half on phones. */
export const ENTRY_SIZES = '(min-width: 64rem) 20vw, (min-width: 40rem) 33vw, 50vw';
export const SEQUENCE_HEADING = 'Sequence';

/**
 * #6's continuation copy, final (B5). The buttons keep short names, apart
 * from Try again, which names the range it asks for again. Every state goes
 * through the one polite status line under the sequence, with the range it
 * added and whether it reached an end.
 */
export const SHOW_MORE = 'Show more photographs';
export const SHOW_EARLIER = 'Show earlier photographs';
export const SERIES_UPDATED = 'This series was updated.';
export const RELOAD_SERIES = 'Show the updated series';
export const OFFLINE = 'You appear to be offline.';

/** Counts as the site writes them, with a comma past a thousand, the same on the server and in every browser. */
const count = new Intl.NumberFormat('en-US');
const span = (from: number, to: number) => `photographs ${count.format(from)} to ${count.format(to)}`;

export const showingLabel = (from: number, to: number, total: number) => `Showing ${span(from, to)} of ${count.format(total)}.`;
export const addedLabel = (from: number, to: number, total: number) => `Added ${span(from, to)} of ${count.format(total)}.`;
export const START_OF_SERIES = 'Start of series.';
export const END_OF_SERIES = 'End of series.';
/** LoadingState's label while a page is on its way. */
export const loadingLabel = (from: number, to: number) => `Loading ${span(from, to)}`;
export const failedLabel = (from: number, to: number) => `Couldn’t load ${span(from, to)}.`;
export const tryAgainLabel = (from: number, to: number) => `Try again: ${span(from, to)}`;
