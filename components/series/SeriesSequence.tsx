'use client';

import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import LoadingState from '@/components/site/LoadingState';
import { useSiteRoutes } from '@/components/site/siteRoutesContext';
import { photoEntryName } from '@/lib/a11y/photoName';
import type { SeriesChapter, SeriesEntry } from '@/lib/catalog/projections/series';
import { SERIES_PAGE_SIZE, sequenceSections } from '@/lib/catalog/series-sections';
import SeriesPhoto from './SeriesPhoto';
import { fetchSeriesPage, readSeriesPages, SERIES_RESTORED_EVENT, writeSeriesPages, type PageAnswer, type SeriesExtent } from './seriesContinuation';
import {
    addedLabel,
    END_OF_SERIES,
    ENTRY_SIZES,
    failedLabel,
    loadingLabel,
    OFFLINE,
    RELOAD_SERIES,
    SEQUENCE_HEADING,
    SERIES_UPDATED,
    SHOW_EARLIER,
    SHOW_MORE,
    showingLabel,
    START_OF_SERIES,
    tryAgainLabel,
} from './seriesCopy';
import { altOf } from './seriesLabels';
import styles from './SeriesPage.module.css';

const RELOAD_ID = 'series-reload';

export interface SeriesSequenceProps {
    /** The revision the page came from. Every page before or after it must come from the same one. */
    revisionId: string;
    slug: string;
    /** The series page itself, which the revision-changed notice reloads. */
    href: string;
    /** The server's page: from position 1, or the page `?photo=` named (B5). */
    entries: SeriesEntry[];
    /** Every member that resolves, for the "of N" in each entry's name. */
    total: number;
    /** The page before the server's page, or null when it starts at position 1. */
    prevHref: string | null;
    /** The page after the server's page, or null when it runs to the end. */
    nextHref: string | null;
    /** Every chapter of the sequence. Each shows once one of its photographs has loaded. */
    chapters: SeriesChapter[];
}

/** Show earlier loads the page before what's shown, Show more the page after. */
type Direction = 'earlier' | 'more';

/** What's on screen, and the pages either side of it, as the server named them. */
interface Loaded {
    entries: SeriesEntry[];
    prevHref: string | null;
    nextHref: string | null;
}

type OkAnswer = Extract<PageAnswer, { kind: 'ok' }>;

const firstOf = (entries: readonly SeriesEntry[]) => entries[0]?.position ?? 1;
const lastOf = (entries: readonly SeriesEntry[]) => entries.at(-1)?.position ?? 0;

/** The positions the next page in `direction` holds: pages sit on SERIES_PAGE_SIZE edges, the server's and every continuation alike. */
function rangeOf(direction: Direction, entries: readonly SeriesEntry[], total: number): { from: number; to: number } {
    if (direction === 'more') {
        const from = lastOf(entries) + 1;
        return { from, to: Math.min(from + SERIES_PAGE_SIZE - 1, total) };
    }
    const to = firstOf(entries) - 1;
    return { from: Math.max(to - SERIES_PAGE_SIZE + 1, 1), to };
}

/** Whether a page's response may move focus: from the control that asked, or from nothing (Safari leaves a clicked button unfocused). */
function focusIsFree(control: HTMLElement | null): boolean {
    const active = document.activeElement;
    return active === null || active === document.body || (control !== null && active === control);
}

/** Focus `id` without the browser's own scroll, then the least scroll that shows it. */
function focusById(id: string): void {
    const target = document.getElementById(id);
    if (target === null) return;
    target.focus({ preventScroll: true });
    const box = target.getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight) target.scrollIntoView({ block: 'nearest', behavior: 'instant' });
}

const failureText = (from: number, to: number) => (typeof navigator !== 'undefined' && navigator.onLine === false ? `${failedLabel(from, to)} ${OFFLINE}` : failedLabel(from, to));

/**
 * One run of the sequence as an ordered list that starts at its first
 * position, so numbering runs across chapters. Each entry is one link to its
 * Viewer URL, named by photoEntryName(), with the thumbnail and its visible
 * number inside it, and the title and description beside it, visible without
 * hover. `id="photo-<photoId>"` is what #5's Back and #9's Close return to.
 */
function EntryList({ entries, total }: { entries: SeriesEntry[]; total: number }) {
    return (
        <ol className={styles.entries} start={entries[0]?.position ?? 1}>
            {entries.map((entry) => (
                <li key={entry.photoId} className={styles.item}>
                    <Link
                        id={`photo-${entry.photoId}`}
                        href={entry.href}
                        prefetch={false}
                        aria-label={photoEntryName({ title: entry.title, alt: altOf(entry.description), position: entry.position, total })}
                        className={styles.entry}
                        // The focus ring clears the thumbnail's surround (--ring-room, SeriesPage.module.css).
                        data-ring-room=""
                    >
                        <SeriesPhoto image={entry.image} alt="" sizes={ENTRY_SIZES} frameClassName={styles.thumbFrame} crop="contain" />
                        {/* Unpadded, so the visible number is part of the link's name (WCAG 2.5.3). */}
                        <span className={styles.position} data-position="">
                            {entry.position}
                        </span>
                    </Link>
                    {(entry.title !== null || entry.description !== null) && (
                        <p className={styles.caption}>
                            {entry.title !== null && <span className={styles.entryTitle}>{entry.title}</span>}
                            {entry.description !== null && <span className={styles.description}>{entry.description}</span>}
                        </p>
                    )}
                </li>
            ))}
        </ol>
    );
}

/**
 * The series' authored sequence (#5), in pages (#6). The server renders one
 * page, the first or, for `?photo=` (B5), the one that holds that
 * photograph. Show more appends each next page and Show earlier prepends
 * each one before it, from `/api/catalog/series/<slug>/pages/<cursor>`,
 * following only the paths the server sent (each response's `nextHref` for
 * Show more, its `prevHref` for Show earlier), so authored order,
 * positions, and chapters hold as pages arrive.
 *
 * - Focus and scroll: Show more's page goes below what's rendered, above
 *   the control, so the view doesn't move. Show earlier's goes above, and
 *   the old first entry is put back at the offset it had in the view,
 *   measured, not left to CSS scroll anchoring. Focus stays on the control
 *   while its page loads, then moves to the new entry nearest the old ones:
 *   the first new one after Show more, the last after Show earlier. It moves
 *   only from that control or from nothing, never from where the visitor
 *   went. When the series changed, it moves to the reload link.
 * - States, in the one polite status line under the sequence: what's shown,
 *   each added range and whether it reached the start or the end, loading
 *   (the control `aria-disabled`, with LoadingState naming the range), error
 *   with "Try again: photographs N to M" (what's loaded stays usable, and
 *   it says so when the browser is offline), and revision changed (409, or
 *   a 400 or 404 only a new revision explains), which stops loading and
 *   links to the current series. One request at a time, from either control.
 * - Cancellation: every request aborts on unmount, which covers leaving the
 *   series and the key change when its revision, slug, or server page
 *   changes. A load in flight while #9's modal Viewer is open keeps going,
 *   since the page stays mounted under it and still wants the result.
 * - Back: each page recorded the loaded extent, first and last position, in
 *   the series' own history entry (held until it's current again if #9's
 *   modal Viewer is open). A fresh mount with an extent for this revision
 *   and series loads the same pages again on either side of the server's
 *   page, with the section `aria-busy`, then fires SERIES_RESTORED_EVENT on
 *   it, so #5's return can find a photograph outside the server's page.
 */
export default function SeriesSequence({ revisionId, slug, href, entries: serverPage, total, prevHref, nextHref, chapters }: SeriesSequenceProps) {
    const [view, setView] = useState<Loaded>({ entries: serverPage, prevHref, nextHref });
    const [loading, setLoading] = useState<Direction | null>(null);
    const [restoring, setRestoring] = useState<SeriesExtent | null>(null);
    const [failed, setFailed] = useState<Direction | null>(null);
    const [stale, setStale] = useState(false);
    const [message, setMessage] = useState(() => showingLabel(firstOf(serverPage), lastOf(serverPage), total));
    const [restoresEnded, setRestoresEnded] = useState(0);
    const section = useRef<HTMLElement>(null);
    const buttons = useRef<Record<Direction, HTMLButtonElement | null>>({ earlier: null, more: null });
    const loaded = useRef<Loaded>(view);
    const busy = useRef(false);
    const focusAfter = useRef<string | null>(null);
    /** The old first entry and its top in the view before a page went in above it. */
    const anchor = useRef<{ id: string; top: number } | null>(null);
    const controllers = useRef(new Set<AbortController>());
    // The continuation endpoint as this site serves it: the public one, or a preview's mirror (#16).
    const pagesPath = useSiteRoutes().catalogApiHref('series/');

    /** An extent that arrived while another entry was current (#9's modal Viewer), for the series entry once it's back. */
    const unwritten = useRef<SeriesExtent | null>(null);

    useEffect(() => {
        const active = controllers.current;
        return () => {
            for (const controller of active) controller.abort();
            active.clear();
        };
    }, []);

    const recordExtent = useCallback(
        (extent: SeriesExtent) => {
            unwritten.current = writeSeriesPages({ revisionId, slug, first: extent.first, loaded: extent.last }, href) ? null : extent;
        },
        [revisionId, slug, href],
    );

    // Closing the modal Viewer is a Back to the series entry: write what arrived while it was open.
    useEffect(() => {
        const onPopState = () => {
            if (unwritten.current !== null) recordExtent(unwritten.current);
        };
        window.addEventListener('popstate', onPopState);
        return () => window.removeEventListener('popstate', onPopState);
    }, [recordExtent]);

    /**
     * Put a page in when it continues the sequence on its side: Show more's
     * has to start right after the last entry, Show earlier's end right
     * before the first. A page that doesn't (a repeat, a gap) is dropped.
     * Each side takes only its own next path from the answer.
     */
    const place = useCallback(
        (direction: Direction, answer: OkAnswer): boolean => {
            const current = loaded.current;
            let next: Loaded;
            if (direction === 'more') {
                if (answer.entries[0].position !== lastOf(current.entries) + 1) return false;
                next = { ...current, entries: [...current.entries, ...answer.entries], nextHref: answer.nextHref };
            } else {
                if (lastOf(answer.entries) !== firstOf(current.entries) - 1) return false;
                const old = document.getElementById(`photo-${current.entries[0].photoId}`);
                anchor.current = old === null ? null : { id: old.id, top: old.getBoundingClientRect().top };
                next = { ...current, entries: [...answer.entries, ...current.entries], prevHref: answer.prevHref };
            }
            loaded.current = next;
            setView(next);
            recordExtent({ first: firstOf(next.entries), last: lastOf(next.entries) });
            return true;
        },
        [recordExtent],
    );

    const request = useCallback(
        async (pageHref: string): Promise<PageAnswer | null> => {
            const controller = new AbortController();
            controllers.current.add(controller);
            try {
                return await fetchSeriesPage(pageHref, revisionId, controller.signal, pagesPath);
            } catch {
                // Aborted: the sequence is gone, or its revision, series, or server page changed.
                return null;
            } finally {
                controllers.current.delete(controller);
            }
        },
        [revisionId, pagesPath],
    );

    const load = useCallback(
        async (direction: Direction) => {
            const pageHref = direction === 'more' ? loaded.current.nextHref : loaded.current.prevHref;
            if (pageHref === null || busy.current) return;
            const { from, to } = rangeOf(direction, loaded.current.entries, total);
            busy.current = true;
            setLoading(direction);
            const answer = await request(pageHref);
            busy.current = false;
            if (answer === null) return;
            setLoading(null);
            const mayFocus = focusIsFree(buttons.current[direction]);
            if (answer.kind === 'ok' && place(direction, answer)) {
                setFailed(null);
                const reached = direction === 'more' ? (answer.nextHref === null ? END_OF_SERIES : null) : (answer.prevHref === null ? START_OF_SERIES : null);
                setMessage(reached === null ? addedLabel(from, to, total) : `${addedLabel(from, to, total)} ${reached}`);
                if (mayFocus) focusAfter.current = `photo-${(direction === 'more' ? answer.entries[0] : answer.entries.at(-1))?.photoId}`;
                return;
            }
            if (answer.kind === 'stale') {
                if (mayFocus) focusAfter.current = RELOAD_ID;
                setFailed(null);
                setMessage(SERIES_UPDATED);
                return setStale(true);
            }
            setFailed(direction);
            setMessage(failureText(from, to));
        },
        [place, request, total],
    );

    // Back: load the pages this history entry had, on either side of the server's page, for this revision and series only.
    useEffect(() => {
        const target = readSeriesPages(window.history.state, revisionId, slug, total);
        const shown = loaded.current.entries;
        if (target === null) return;
        const wants = (direction: Direction) =>
            direction === 'earlier' ? target.first < firstOf(loaded.current.entries) && loaded.current.prevHref !== null : target.last > lastOf(loaded.current.entries) && loaded.current.nextHref !== null;
        if (target.first >= firstOf(shown) && target.last <= lastOf(shown)) return;
        if (!wants('earlier') && !wants('more')) return;
        let cancelled = false;
        busy.current = true;
        setRestoring(target);
        void (async () => {
            let stop: { direction: Direction; kind: 'stale' | 'error' } | null = null;
            for (const direction of ['earlier', 'more'] as const) {
                while (stop === null && wants(direction)) {
                    const { from, to } = rangeOf(direction, loaded.current.entries, total);
                    const pageHref = (direction === 'more' ? loaded.current.nextHref : loaded.current.prevHref) as string;
                    const answer = await request(pageHref);
                    if (answer === null || cancelled) return;
                    if (answer.kind === 'ok' && place(direction, answer)) continue;
                    stop = { direction, kind: answer.kind === 'stale' ? 'stale' : 'error' };
                    if (stop.kind === 'error') setMessage(failureText(from, to));
                }
            }
            busy.current = false;
            setRestoring(null);
            if (stop?.kind === 'stale') {
                setMessage(SERIES_UPDATED);
                setStale(true);
            } else if (stop?.kind === 'error') {
                setFailed(stop.direction);
            } else {
                setMessage(showingLabel(firstOf(loaded.current.entries), lastOf(loaded.current.entries), total));
            }
            setRestoresEnded((count) => count + 1);
        })();
        return () => {
            cancelled = true;
            busy.current = false;
        };
    }, [revisionId, slug, total, place, request]);

    // After the restore's last page is in the DOM, so #5's return finds its photograph.
    useEffect(() => {
        if (restoresEnded > 0) section.current?.dispatchEvent(new CustomEvent(SERIES_RESTORED_EVENT, { bubbles: true }));
    }, [restoresEnded]);

    // A page went in above: put the old first entry back where it was in the view, before the browser paints.
    useLayoutEffect(() => {
        const held = anchor.current;
        if (held === null) return;
        anchor.current = null;
        const old = document.getElementById(held.id);
        if (old === null) return;
        const moved = old.getBoundingClientRect().top - held.top;
        if (moved !== 0) window.scrollBy({ top: moved, left: 0, behavior: 'instant' });
    }, [view]);

    useEffect(() => {
        const id = focusAfter.current;
        if (id === null) return;
        focusAfter.current = null;
        focusById(id);
    }, [view, stale]);

    const { entries } = view;
    const sections = sequenceSections(entries, chapters);
    const waiting = loading !== null || restoring !== null;
    const more = rangeOf('more', entries, total);
    const earlier = rangeOf('earlier', entries, total);
    const hasMore = view.nextHref !== null && !stale;
    const hasEarlier = view.prevHref !== null && !stale;
    const moreState = stale ? 'stale' : restoring ? 'restoring' : loading === 'more' ? 'loading' : failed === 'more' ? 'error' : hasMore ? 'idle' : 'end';
    const earlierState = restoring ? 'restoring' : loading === 'earlier' ? 'loading' : failed === 'earlier' ? 'error' : 'idle';

    return (
        <section ref={section} className={styles.sequence} aria-labelledby="series-sequence" aria-busy={restoring ? true : undefined}>
            <h2 id="series-sequence" className={styles.sequenceHeading}>
                {SEQUENCE_HEADING}
            </h2>

            {/* Only after a deep entry (B5) does the sequence start past position 1. */}
            {hasEarlier && (
                <div className={styles.earlier} data-continuation-earlier={earlierState}>
                    {loading === 'earlier' && (
                        <div className={styles.moreLoading}>
                            <LoadingState label={loadingLabel(earlier.from, earlier.to)} />
                        </div>
                    )}
                    <button
                        ref={(node) => {
                            buttons.current.earlier = node;
                        }}
                        type="button"
                        className={styles.moreButton}
                        // Not `disabled` while it loads, so it keeps focus; a press then does nothing.
                        aria-disabled={waiting ? true : undefined}
                        onClick={() => void load('earlier')}
                    >
                        {failed === 'earlier' ? tryAgainLabel(earlier.from, earlier.to) : SHOW_EARLIER}
                    </button>
                </div>
            )}

            {sections.map((part, index) => {
                if (part.chapter === null) return <EntryList key="lead" entries={part.entries} total={total} />;
                const headingId = `series-chapter-${index}`;
                return (
                    <section key={part.chapter.id} className={styles.chapter} aria-labelledby={headingId}>
                        <h3 id={headingId} className={styles.chapterTitle}>
                            {part.chapter.title}
                        </h3>
                        <EntryList entries={part.entries} total={total} />
                    </section>
                );
            })}

            {/* Only a series longer than one page has the controls. */}
            {(nextHref !== null || prevHref !== null) && (
                <div className={styles.more} data-continuation={moreState}>
                    {(loading === 'more' || restoring !== null) && (
                        <div className={styles.moreLoading}>
                            <LoadingState label={restoring ? loadingLabel(restoring.first, restoring.last) : loadingLabel(more.from, more.to)} />
                        </div>
                    )}
                    <p role="status" className={styles.moreStatus}>
                        {message}
                    </p>
                    {hasMore && (
                        <button
                            ref={(node) => {
                                buttons.current.more = node;
                            }}
                            type="button"
                            className={styles.moreButton}
                            // Not `disabled` while it loads, so it keeps focus; a press then does nothing.
                            aria-disabled={waiting ? true : undefined}
                            onClick={() => void load('more')}
                        >
                            {failed === 'more' ? tryAgainLabel(more.from, more.to) : SHOW_MORE}
                        </button>
                    )}
                    {stale && (
                        // A full load, so the page and every page after it come from the revision now served.
                        <a id={RELOAD_ID} href={href} className={styles.allWork}>
                            {RELOAD_SERIES}
                        </a>
                    )}
                </div>
            )}
        </section>
    );
}
