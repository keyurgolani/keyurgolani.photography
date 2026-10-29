'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import LoadingState from '@/components/site/LoadingState';
import { useSiteRoutes } from '@/components/site/siteRoutesContext';
import { photoEntryName } from '@/lib/a11y/photoName';
import type { SeriesChapter, SeriesEntry } from '@/lib/catalog/projections/series';
import { sequenceSections } from '@/lib/catalog/series-sections';
import SeriesPhoto from './SeriesPhoto';
import { fetchSeriesPage, readSeriesPages, SERIES_RESTORED_EVENT, writeSeriesPages, type PageAnswer } from './seriesContinuation';
import {
    allShownLabel,
    ENTRY_SIZES,
    LOADING_MORE,
    MORE_FAILED,
    RELOAD_SERIES,
    SEQUENCE_HEADING,
    SERIES_UPDATED,
    SHOW_MORE,
    showingLabel,
    TRY_AGAIN,
} from './seriesCopy';
import { altOf } from './seriesLabels';
import styles from './SeriesPage.module.css';

const RELOAD_ID = 'series-reload';

export interface SeriesSequenceProps {
    /** The revision the first page came from. Every page after it must come from the same one. */
    revisionId: string;
    slug: string;
    /** The series page itself, which the revision-changed notice reloads. */
    href: string;
    /** The first page, from position 1. */
    entries: SeriesEntry[];
    /** Every member that resolves, for the "of N" in each entry's name. */
    total: number;
    /** The second page's path, or null when the first page is the whole sequence. */
    nextHref: string | null;
    /** Every chapter of the sequence. Each shows once its first photograph has loaded. */
    chapters: SeriesChapter[];
}

type Status = 'idle' | 'loading' | 'restoring' | 'error' | 'stale' | 'end';

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
                        aria-label={photoEntryName({ alt: altOf(entry.description), position: entry.position, total })}
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
 * The series' authored sequence (#5), in pages (#6). The first page comes
 * from the server; Show more appends each next one from
 * `/api/catalog/series/<slug>/pages/<cursor>`, following only the paths the
 * server sent, so authored order, positions, and chapters hold as pages
 * arrive.
 *
 * - Focus and scroll: pages append below what's rendered, above the
 *   control, so the view doesn't move, and focus stays on the control while
 *   it loads. The control goes away only at the end, or when the series
 *   changed; if it had focus, focus moves to the first new entry, or to the
 *   reload link, never to the page.
 * - States: loading (the control stays, `aria-disabled`, with
 *   LoadingState), error with Try again (what's loaded stays usable), end,
 *   and revision changed (409, or a 400 or 404 only a new revision
 *   explains), which stops appending and links to the current series.
 * - Cancellation: every request aborts on unmount, which covers leaving the
 *   series and the key change when its revision or slug changes. A load in
 *   flight while #9's modal Viewer is open keeps going, since the page stays
 *   mounted under it and still wants the result.
 * - Back: each append records the loaded extent in the series' own history
 *   entry (held until it's current again if #9's modal Viewer is open). A
 *   fresh mount on Back with an extent for this revision and series loads
 *   the same pages again, with the section `aria-busy`, then fires
 *   SERIES_RESTORED_EVENT on it, so #5's return can find a photograph past
 *   the first page.
 */
export default function SeriesSequence({ revisionId, slug, href, entries: firstPage, total, nextHref, chapters }: SeriesSequenceProps) {
    const [entries, setEntries] = useState(firstPage);
    const [status, setStatus] = useState<Status>(nextHref === null ? 'end' : 'idle');
    const [restoresEnded, setRestoresEnded] = useState(0);
    const section = useRef<HTMLElement>(null);
    const button = useRef<HTMLButtonElement>(null);
    const loaded = useRef(firstPage);
    const next = useRef(nextHref);
    const busy = useRef(false);
    const focusAfter = useRef<string | null>(null);
    const controllers = useRef(new Set<AbortController>());
    // The continuation endpoint as this site serves it: the public one, or a preview's mirror (#16).
    const pagesPath = useSiteRoutes().catalogApiHref('series/');

    /** An extent that arrived while another entry was current (#9's modal Viewer), for the series entry once it's back. */
    const unwritten = useRef<number | null>(null);

    useEffect(() => {
        const active = controllers.current;
        return () => {
            for (const controller of active) controller.abort();
            active.clear();
        };
    }, []);

    const recordExtent = useCallback(
        (count: number) => {
            unwritten.current = writeSeriesPages({ revisionId, slug, loaded: count }, href) ? null : count;
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

    /** Add a page when it continues the sequence. A page that doesn't (a repeat, a gap) is dropped. */
    const append = useCallback(
        (answer: Extract<PageAnswer, { kind: 'ok' }>): boolean => {
            const current = loaded.current;
            if (answer.entries[0].position !== current.length + 1) return false;
            const grown = [...current, ...answer.entries];
            loaded.current = grown;
            next.current = answer.nextHref;
            setEntries(grown);
            recordExtent(grown.length);
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
                // Aborted: the sequence is gone, or its revision or series changed.
                return null;
            } finally {
                controllers.current.delete(controller);
            }
        },
        [revisionId, pagesPath],
    );

    const showMore = useCallback(async () => {
        const pageHref = next.current;
        if (pageHref === null || busy.current) return;
        busy.current = true;
        setStatus('loading');
        const answer = await request(pageHref);
        busy.current = false;
        if (answer === null) return;
        const hadFocus = document.activeElement === button.current;
        if (answer.kind === 'ok' && append(answer)) {
            if (answer.nextHref !== null) return setStatus('idle');
            if (hadFocus) focusAfter.current = `photo-${answer.entries[0].photoId}`;
            return setStatus('end');
        }
        if (answer.kind === 'stale') {
            if (hadFocus) focusAfter.current = RELOAD_ID;
            return setStatus('stale');
        }
        setStatus('error');
    }, [append, request]);

    // Back: load the pages this history entry had, for this revision and series only.
    useEffect(() => {
        const target = readSeriesPages(window.history.state, revisionId, slug, total);
        if (target === null || target <= loaded.current.length || next.current === null) return;
        let cancelled = false;
        busy.current = true;
        setStatus('restoring');
        void (async () => {
            let final: Status = 'idle';
            while (loaded.current.length < target && next.current !== null) {
                const answer = await request(next.current);
                if (answer === null || cancelled) return;
                if (answer.kind === 'ok' && append(answer)) continue;
                final = answer.kind === 'stale' ? 'stale' : 'error';
                break;
            }
            if (final === 'idle' && next.current === null) final = 'end';
            busy.current = false;
            setStatus(final);
            setRestoresEnded((count) => count + 1);
        })();
        return () => {
            cancelled = true;
            busy.current = false;
        };
    }, [revisionId, slug, total, append, request]);

    // After the restore's last page is in the DOM, so #5's return finds its photograph.
    useEffect(() => {
        if (restoresEnded > 0) section.current?.dispatchEvent(new CustomEvent(SERIES_RESTORED_EVENT, { bubbles: true }));
    }, [restoresEnded]);

    useEffect(() => {
        const id = focusAfter.current;
        if (id === null) return;
        focusAfter.current = null;
        document.getElementById(id)?.focus();
    }, [status, entries]);

    const sections = sequenceSections(entries, chapters);
    const waiting = status === 'loading' || status === 'restoring';
    const message =
        status === 'idle' ? showingLabel(entries.length, total)
            : status === 'error' ? MORE_FAILED
                : status === 'end' ? allShownLabel(total)
                    : status === 'stale' ? SERIES_UPDATED
                        : '';

    return (
        <section ref={section} className={styles.sequence} aria-labelledby="series-sequence" aria-busy={status === 'restoring' ? true : undefined}>
            <h2 id="series-sequence" className={styles.sequenceHeading}>
                {SEQUENCE_HEADING}
            </h2>
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

            {/* Only a series longer than one page has the control. */}
            {nextHref !== null && (
                <div className={styles.more} data-continuation={status}>
                    {waiting && (
                        <div className={styles.moreLoading}>
                            <LoadingState label={LOADING_MORE} />
                        </div>
                    )}
                    <p role="status" className={styles.moreStatus}>
                        {message}
                    </p>
                    {(status === 'idle' || status === 'error' || waiting) && (
                        <button
                            ref={button}
                            type="button"
                            className={styles.moreButton}
                            // Not `disabled` while it loads, so it keeps focus; a second press does nothing.
                            aria-disabled={waiting ? true : undefined}
                            onClick={() => void showMore()}
                        >
                            {status === 'error' ? TRY_AGAIN : SHOW_MORE}
                        </button>
                    )}
                    {status === 'stale' && (
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
