/**
 * The sequence's sizes and interface copy, in a plain module, so the server
 * SeriesPage and the client SeriesSequence read the same values (a server
 * module importing a value from a 'use client' one gets a reference, not
 * the value).
 */

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
