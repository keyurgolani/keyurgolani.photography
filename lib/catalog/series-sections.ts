// Types only: the projection is server-only, and this module runs in the client's SeriesSequence too.
import type { SeriesChapter, SeriesEntry } from './projections/series';

/** One run of entries under one heading: the photographs before the first chapter (`chapter: null`), then each chapter's. */
export interface SequenceSection {
    chapter: SeriesChapter | null;
    entries: SeriesEntry[];
}

/**
 * The sections of the entries loaded so far (#5's cut, for #6's pages), from
 * the one entry list at each chapter's start, so every entry appears once,
 * in order, and numbering runs across chapters. `entries` starts at
 * position 1 and runs on without a gap, as the first page and each Show more
 * page append. A chapter that starts past the loaded entries isn't shown
 * yet; a chapter the last page ran into keeps growing as pages append. The
 * lead section appears only when the first chapter starts after the first
 * photograph, or there is no chapter yet.
 */
export function sequenceSections(entries: readonly SeriesEntry[], chapters: readonly SeriesChapter[]): SequenceSection[] {
    const shown = chapters.filter((chapter) => chapter.startPosition <= entries.length);
    const starts = shown.map((chapter) => chapter.startPosition - 1);
    const sections: SequenceSection[] = [];
    const lead = entries.slice(0, starts[0] ?? entries.length);
    if (lead.length) sections.push({ chapter: null, entries: lead });
    shown.forEach((chapter, index) => {
        sections.push({ chapter, entries: entries.slice(starts[index], starts[index + 1]) });
    });
    return sections;
}
