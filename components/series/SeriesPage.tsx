import Link from 'next/link';
import { photoImageAlt } from '@/lib/a11y/photoName';
import type { PublishedSeriesPage, SeriesFacts } from '@/lib/catalog/projections/series';
import SeriesPhoto from './SeriesPhoto';
import SeriesSequence from './SeriesSequence';
import { altOf, capturedSource, yearsLabel } from './seriesLabels';
import styles from './SeriesPage.module.css';

export { ENTRY_SIZES, SEQUENCE_HEADING } from './seriesCopy';

export interface SeriesPageProps {
    page: PublishedSeriesPage;
}

/** The cover fills the content column, the viewport less its gutters. */
export const COVER_SIZES = '100vw';

/** Interface copy for the derived facts, apart from the authored text. */
export const FACTS_HEADING = 'From the published photographs';
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
 * A published series in Gallery After Hours (#5): the title, the authored
 * statement, the cover as the one decisive photograph, the derived facts set
 * apart, then the authored sequence, cut into its chapters without
 * reordering, and an All work link at its end. The sequence is
 * SeriesSequence, which shows the first page and appends the rest on Show
 * more (#6); every prop it takes comes from the projection's allowlist.
 * Each entry links to its canonical Viewer URL and carries
 * `id="photo-<photoId>"`, so #5 PR 2 and #9 can return focus to it.
 */
export default function SeriesPage({ page }: SeriesPageProps) {
    const { total, cover } = page;
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
                            alt={photoImageAlt({ alt: altOf(cover.description), position: cover.position, total })}
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

                {/* Keyed by revision and series, so a new revision's page starts its own sequence and drops the old one's pages. */}
                <SeriesSequence
                    key={`${page.catalogRevision}:${page.slug}`}
                    revisionId={page.catalogRevision}
                    slug={page.slug}
                    href={page.href}
                    entries={page.entries}
                    total={total}
                    nextHref={page.nextHref}
                    chapters={page.chapters}
                />

                <p className={styles.end}>
                    <Link href={page.workHref} className={styles.allWork}>
                        {ALL_WORK}
                    </Link>
                </p>
            </article>
        </main>
    );
}
