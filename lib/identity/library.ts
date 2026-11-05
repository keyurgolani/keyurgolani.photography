/**
 * A6 (#17): when the library counts as unavailable. A pass refuses a library
 * root that is missing, empty while the registry has present photos, or
 * unreadable, and changes nothing (lib/identity/pass.ts). A pass that gets
 * through but marks at least LIBRARY_UNAVAILABLE_BOUND bound sources and
 * over LIBRARY_UNAVAILABLE_SHARE of them missing looks like a mount that is
 * partly gone, such as a NAS share under the library: it still commits,
 * since the registry only records what it saw and nothing is taken down, but
 * the curation inbox holds those missing items behind one
 * `library-unavailable` item (lib/curation/library.ts). The thresholds are
 * the coordinator's (11-04, Decided 10).
 */

/** The fewest sources one pass must mark missing to count as the library going. */
export const LIBRARY_UNAVAILABLE_BOUND = 20;
/** The share of the bound sources they must be over. */
export const LIBRARY_UNAVAILABLE_SHARE = 0.1;

/** Why the library is unavailable. `mass-missing` is the curation inbox's, from one pass's facts. */
export type LibraryCause = 'missing' | 'empty' | 'unreadable' | 'mass-missing';

/** What the watcher's library hook hears after each pass: available when the pass got through, else why not. */
export type LibraryVerdict = { available: true } | { available: false; cause: Exclude<LibraryCause, 'mass-missing'>; detail?: string };

/** Whether `missing` of `bound` bound sources going in one pass is the library going: at least 20, and over 10%. */
export function massMissing(missing: number, bound: number): boolean {
    return bound > 0 && missing >= LIBRARY_UNAVAILABLE_BOUND && missing / bound > LIBRARY_UNAVAILABLE_SHARE;
}
