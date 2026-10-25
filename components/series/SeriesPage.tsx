import Link from 'next/link';
import { photoEntryName, photoImageAlt } from '@/lib/a11y/photoName';
import type { PublishedSeriesPage, SeriesEntry, SeriesFacts, SeriesSection } from '@/lib/catalog/projections/series';
import SeriesPhoto from './SeriesPhoto';
import { altOf, capturedSource, yearsLabel } from './seriesLabels';
import styles from './SeriesPage.module.css';

export interface SeriesPageProps {
    page: PublishedSeriesPage;
    /** seriesSections(page), cut on the server. */
    sections: SeriesSection[];
}

/** The cover fills the content column, the viewport less its gutters. */
export const COVER_SIZES = '100vw';
/** Sequence thumbnails, about a fifth of the row on wide screens, a third on tablets, and half on phones. */
export const ENTRY_SIZES = '(min-width: 64rem) 20vw, (min-width: 40rem) 33vw, 50vw';

/** Interface copy for the derived facts, apart from the authored text. */
export const FACTS_HEADING = 'From the published photographs';
export const SEQUENCE_HEADING = 'Sequence';
export const ALL_WORK = 'All work';

/** The derived facts, each with where it came from, so none reads as authored copy. */
function Facts({ facts, total }: { facts: SeriesFacts; total: number }) {
    const captured = facts.captured;
    return (
        <section className={styles.facts} aria-labelledby="series-facts">
            <h2 id="series-facts" className={styles.factsHeading}>
                {FACTS_HEADING}
            </h2>
            <dl className={styles.factList}>
                <div className={styles.fact}>
                    <dt>Photographs</dt>
                    <dd data-source={facts.photoCount.source}>
                        {facts.photoCount.value}
                        <span className={styles.source}>Counted from the published sequence</span>
                    </dd>
                </div>
                {captured !== null && (
                    <div className={styles.fact}>
                        <dt>Captured</dt>
                        <dd data-source={captured.source}>
                            {yearsLabel(captured)}
                            <span className={styles.source}>
                                {capturedSource(captured.datedCount, total)}
                            </span>
                        </dd>
                    </div>
                )}
                {facts.locations !== null && (
                    <div className={styles.fact}>
                        <dt>{facts.locations.values.length === 1 ? 'Location' : 'Locations'}</dt>
                        <dd data-source={facts.locations.source}>
                            {facts.locations.values.join(', ')}
                            <span className={styles.source}>From the photograph records</span>
                        </dd>
                    </div>
                )}
            </dl>
        </section>
    );
}

/**
 * One run of the sequence as an ordered list that starts at its first
 * position, so numbering runs across chapters. Each entry is one link to its
 * Viewer URL, named by photoEntryName(), with the thumbnail and its visible
 * number inside it, and the title and description beside it, visible without
 * hover.
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
                    >
                        <SeriesPhoto
                            image={entry.image}
                            alt=""
                            sizes={ENTRY_SIZES}
                            frameClassName={styles.thumbFrame}
                            crop="contain"
                        />
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
 * A published series in Gallery After Hours (#5): the title, the authored
 * statement, the cover as the one decisive photograph, the derived facts set
 * apart, then the authored sequence, cut into its chapters without
 * reordering, and an All work link at its end. A server component: the only
 * client props are each photograph's image set, its alt, and its fallback
 * label, all from the projection's allowlist. Each entry links to its
 * canonical Viewer URL and carries `id="photo-<photoId>"`, so #5 PR 2 and #9
 * can return focus to it.
 */
export default function SeriesPage({ page, sections }: SeriesPageProps) {
    const total = page.entries.length;
    const cover = page.cover;
    const coverEntry = cover ? page.entries[cover.position - 1] : undefined;
    return (
        <main className={styles.page}>
            <article aria-labelledby="series-title">
                <header className={styles.header}>
                    <h1 id="series-title" className={styles.title}>
                        {page.authored.title}
                    </h1>
                    {page.authored.statement.length > 0 && (
                        <div className={styles.statement}>
                            {page.authored.statement.map((paragraph, index) => (
                                <p key={index}>{paragraph}</p>
                            ))}
                        </div>
                    )}
                    <Facts facts={page.facts} total={total} />
                </header>

                {cover && (
                    <figure className={styles.stage}>
                        <SeriesPhoto
                            image={cover.image}
                            alt={photoImageAlt({ alt: altOf(coverEntry?.description ?? null), position: cover.position, total })}
                            sizes={COVER_SIZES}
                            priority
                            focalPoint={cover.focalPoint}
                            crop={cover.crop}
                            intrinsic
                            fallbackLabel="Photograph unavailable"
                            frameClassName={styles.coverFrame}
                        />
                        <figcaption className={styles.stageNote}>
                            Photograph {cover.position} of {total}
                        </figcaption>
                    </figure>
                )}

                <section className={styles.sequence} aria-labelledby="series-sequence">
                    <h2 id="series-sequence" className={styles.sequenceHeading}>
                        {SEQUENCE_HEADING}
                    </h2>
                    {sections.map((section, index) => {
                        if (section.chapter === null) return <EntryList key="lead" entries={section.entries} total={total} />;
                        const headingId = `series-chapter-${index}`;
                        return (
                            <section key={section.chapter.id} className={styles.chapter} aria-labelledby={headingId}>
                                <h3 id={headingId} className={styles.chapterTitle}>
                                    {section.chapter.title}
                                </h3>
                                <EntryList entries={section.entries} total={total} />
                            </section>
                        );
                    })}
                </section>

                <p className={styles.end}>
                    <Link href={page.workHref} className={styles.allWork}>
                        {ALL_WORK}
                    </Link>
                </p>
            </article>
        </main>
    );
}
