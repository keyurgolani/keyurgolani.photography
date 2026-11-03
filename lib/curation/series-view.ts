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

/**
 * #150's 2b: one photograph a series' page shows, in its sequence or offered to it. Named by its title, or its file's
 * name, never by its ID; the ID is only what the page's forms send back.
 */
export interface SequencePhoto {
    id: string;
    name: string;
    /** The curator-only route's w400 WebP of the set it pins, or null when no set is ready. */
    thumbnailUrl: string | null;
}

/** A photograph the page offers to add: the draft holds its photo record and its source is in the library. */
export interface AddablePhoto extends SequencePhoto {
    /** The title of a series that already holds it, or null when none does. */
    heldBy: string | null;
}

export interface SequenceChapter {
    id: string;
    title: string;
    startPhotoId: string;
}

/** A series' order, as its page shows it and its ordering forms change it, with the version they carry. */
export interface SeriesOrderView {
    version: number;
    published: boolean;
    photos: SequencePhoto[];
    /** A focal point from 0 to 1 across and down, as the record holds it. */
    cover: { photoId: string; focalPoint: { x: number; y: number } | null } | null;
    openingPhotoId: string | null;
    /** In the order they start. */
    chapters: SequenceChapter[];
    addable: AddablePhoto[];
}

/** One series in the Work order editor, by its title. */
export interface WorkSeries {
    id: string;
    title: string;
    visibility: SeriesVisibility;
}

/** The site record's Work order and featured series, as the Series screen changes them, with the version they carry. */
export interface WorkOrderView {
    /** 0 while there's no site record yet. */
    version: number;
    /** Every series the Work order lists that the screen can show, in its order. */
    order: WorkSeries[];
    /** Series the Work order doesn't list, by title. */
    offWork: WorkSeries[];
    /** Every series the screen can show, in Work order and then by title, for the featured choice. */
    all: WorkSeries[];
    /** The featured series' IDs, in their order: Home opens on the first one a publish holds. */
    featured: string[];
}

export type SeriesOrderKind = 'insert' | 'move' | 'remove' | 'cover' | 'opening' | 'chapter-add' | 'chapter-move' | 'chapter-remove';
export type WorkOrderKind = 'work-order' | 'featured';
export type OrderActionKind = SeriesOrderKind | WorkOrderKind;

/** The ordering forms' fields an answer can be about. */
export type OrderField = 'addPhoto' | 'position' | 'cover' | 'focal' | 'chapterTitle' | 'chapterStart';

export type OrderActionState =
    | { status: 'idle' }
    | {
          /** As SeriesActionState's: `stale` and `busy` wrote nothing, and the page refreshes or tries again. */
          status: 'done' | 'stale' | 'busy' | 'refused' | 'invalid' | 'failed';
          action: OrderActionKind;
          message: string;
          field?: OrderField;
          serial: number;
      };

export const IDLE_ORDER: OrderActionState = { status: 'idle' };

/** A photograph's place, as the page numbers it: from 1. */
export const placeLabel = (index: number, name: string) => `${index + 1}. ${name}`;
