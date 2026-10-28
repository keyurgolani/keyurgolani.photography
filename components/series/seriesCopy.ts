/**
 * The sequence's sizes and interface copy, in a plain module, so the server
 * SeriesPage and the client SeriesSequence read the same values (a server
 * module importing a value from a 'use client' one gets a reference, not
 * the value).
 */

import { heightCappedSizes } from '@/components/photoSizes';

/**
 * The cover's sizes: the column (100vw less gutters), until the stylesheet's
 * 82svh height cap makes the box narrower than that, as it does for most
 * photographs on a wide screen (#6). Without its dimensions, the column.
 */
export const coverSizes = (image: { width: number; height: number } | null) =>
    image === null ? '100vw' : heightCappedSizes(image.width, image.height, 82, [{ vw: 100 }]);

/** Sequence thumbnails, about a fifth of the row on wide screens, a third on tablets, and half on phones. */
export const ENTRY_SIZES = '(min-width: 64rem) 20vw, (min-width: 40rem) 33vw, 50vw';
export const SEQUENCE_HEADING = 'Sequence';

/** #6's continuation copy. Provisional: the exact state strings are deferred. */
export const SHOW_MORE = 'Show more photographs';
export const TRY_AGAIN = 'Try again';
export const LOADING_MORE = 'Loading photographs';
export const MORE_FAILED = 'More photographs couldn’t load.';
export const SERIES_UPDATED = 'This series was updated.';
export const RELOAD_SERIES = 'Load the current series';
export const showingLabel = (shown: number, total: number) => `Showing ${shown} of ${total} photographs.`;
export const allShownLabel = (total: number) => `All ${total} photographs shown.`;
