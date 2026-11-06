// Types only: the projection is server-only, and this module runs in the client's SeriesSequence too.
import type { SeriesChapter, SeriesEntry } from './projections/series';

/**
 * Entries per page of a series (#6): the server-rendered one and each
 * continuation, on the same edges, so the page `?photo=` renders (B5) is a
 * page Show more and Show earlier would reach. Within #6's approved bounds:
 * at most 100 photo records, and 100 KiB compressed for the first page,
 * 60 KiB for a continuation page; lib/perf's budget tests hold every page
 * to its two. Here, apart from the server-only projection, so the client
 * can name the range a control will load.
 */
export const SERIES_PAGE_SIZE = 100;

/** One run of entries under one heading: the photographs before the first chapter (`chapter: null`), then each chapter's. */
export interface SequenceSection {
    chapter: SeriesChapter | null;
    entries: SeriesEntry[];
}

/**
 * The sections of the entries loaded so far (#5's cut, for #6's pages), from
 * the one entry list at each chapter's start, so every entry appears once,
 * in order, and numbering runs across chapters. `entries` runs on without a
 * gap, from position 1 or, after a deep entry (B5), from the start of a
 * later page, as Show more appends and Show earlier prepends. A chapter
 * shows once one of its photographs has loaded: a chapter that starts past
 * the loaded entries isn't shown yet, and one that started before them heads
 * them from the first loaded one. The lead section (no chapter) holds what
 * comes before the first chapter, and appears only when some of it has
 * loaded.
 */
export function sequenceSections(entries: readonly SeriesEntry[], chapters: readonly SeriesChapter[]): SequenceSection[] {
    if (entries.length === 0) return [];
    const first = entries[0].position;
    const last = first + entries.length - 1;
    // Each chapter runs from its start to the next one's start, so it has loaded entries when it starts by `last` and its run reaches `first`.
    const shown = chapters.filter((chapter, index) => chapter.startPosition <= last && (chapters[index + 1]?.startPosition ?? Infinity) > first);
    const starts = shown.map((chapter) => Math.max(chapter.startPosition, first) - first);
    const sections: SequenceSection[] = [];
    const lead = entries.slice(0, starts[0] ?? entries.length);
    if (lead.length) sections.push({ chapter: null, entries: lead });
    shown.forEach((chapter, index) => {
        sections.push({ chapter, entries: entries.slice(starts[index], starts[index + 1]) });
    });
    return sections;
}
