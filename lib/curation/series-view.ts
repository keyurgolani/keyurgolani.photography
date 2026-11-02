import { FIELD_LIMITS } from '../catalog/plain-text';

/**
 * #150's 2a: what the curator's Series screen and a series' page show, and
 * the answers their forms get back, in the page's words. Client-safe: the
 * screens import it, and lib/curation/series-form.ts reads the working layer
 * into it and runs the forms.
 */

export type SeriesVisibility = 'published' | 'draft' | 'hidden';

/** The order the page offers them in: what the series is for, then the two ways of keeping it back. */
export const VISIBILITIES: readonly SeriesVisibility[] = ['published', 'draft', 'hidden'];

export const VISIBILITY_LABEL: Record<SeriesVisibility, string> = { published: 'Published', draft: 'Draft', hidden: 'Hidden' };

/** What each visibility does at the next publish, beside its choice. */
export const VISIBILITY_HINT: Record<SeriesVisibility, string> = {
    published: 'On the site from the next publish, once it has photographs, a cover and a place in Work order.',
    draft: 'Not on the site yet. Use it while the series is being written.',
    hidden: 'Kept off the site, and off Work, at the next publish.',
};

/** One row of the Series screen. */
export interface SeriesRow {
    id: string;
    title: string;
    slug: string;
    visibility: SeriesVisibility;
    photoCount: number;
    /** `photos carry-over` made it at the launch, and its marker still stands. */
    carriedOver: boolean;
    /** The site record's Work order lists it. */
    inWorkOrder: boolean;
    href: string;
}

/** What a series' page shows and its form edits, with the version the form carries. */
export interface SeriesDetail {
    id: string;
    version: number;
    title: string;
    slug: string;
    statement: string;
    shortStatement: string;
    visibility: SeriesVisibility;
    photoCount: number;
    carriedOver: boolean;
    inWorkOrder: boolean;
}

export type SeriesActionKind = 'create' | 'edit';

/** The fields an answer can be about, as the forms name them. */
export type SeriesField = 'title' | 'slug' | 'statement' | 'shortStatement' | 'visibility';

export type SeriesActionState =
    | { status: 'idle' }
    | {
          /** `stale`: the series moved since the page loaded, and nothing was written. `busy`: another write held the authored lock. */
          status: 'done' | 'stale' | 'busy' | 'refused' | 'invalid' | 'failed';
          action: SeriesActionKind;
          /** The series the answer is about: the one made, for a New series that went through. */
          seriesId: string | null;
          message: string;
          /** The form field the answer is about, when it's about one, so the page shows it there. */
          field?: SeriesField;
          /** New series: where the series it made opens, and its title, for the link to it. */
          href?: string;
          title?: string;
          /** Counts up, so the page can tell one answer from the next. */
          serial: number;
      };

export const IDLE_SERIES: SeriesActionState = { status: 'idle' };

/** The import's caps on each field (lib/catalog/plain-text.ts), which `photos edit` holds the same text to. */
export const SERIES_LIMITS = { title: FIELD_LIMITS.title, statement: FIELD_LIMITS.statement, shortStatement: FIELD_LIMITS.shortStatement } as const;

/** How the page names a field in an answer. */
export const FIELD_LABEL: Record<'title' | 'statement' | 'shortStatement', string> = { title: 'The title', statement: 'The statement', shortStatement: 'The short statement' };

/** A series by its title, or as one with none yet. Never by its ID. */
export const seriesName = (title: string) => title.trim() || 'Untitled series';

export function photoCountLabel(count: number): string {
    if (count === 0) return 'No photographs';
    return count === 1 ? '1 photograph' : `${count} photographs`;
}

/** Every answer's last words: nothing on the site changes until a publish. */
export const NOTHING_PUBLIC = 'Nothing is public until you publish.';

export const DONE_ANSWER = {
    create: (title: string) => `Made ${seriesName(title)}, a draft. ${NOTHING_PUBLIC}`,
    edit: `Saved to the draft. ${NOTHING_PUBLIC}`,
} as const;

export const STALE_ANSWER = 'This series changed since the page loaded, so nothing was written. Refresh to see what it holds now, and edit it again.';

export const BUSY_ANSWER = 'Another change is being written right now, so nothing was written. Try again in a moment.';

/** The web address field's hint, which New series' field is described by. */
export const SLUG_HINT = 'The series’ address on the site, after /work/: lowercase letters and digits in words joined by hyphens. Leave it empty to make one from the title.';
