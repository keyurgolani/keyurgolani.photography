import Link from 'next/link';
import type { CSSProperties } from 'react';
import type { PublishedSeriesPage, SeriesFacts } from '@/lib/catalog/projections/series';
import SeriesPhoto from './SeriesPhoto';
import SeriesReturn from './SeriesReturn';
import SeriesSequence from './SeriesSequence';
import { coverSizes } from './seriesCopy';
import { altOf, capturedSource, coverEntryName, locationsLabel, yearsLabel } from './seriesLabels';
import { COVER_ID } from './returnPosition';
import styles from './SeriesPage.module.css';

export { ENTRY_SIZES, SEQUENCE_HEADING } from './seriesCopy';

export interface SeriesPageProps {
    page: PublishedSeriesPage;
}

/** Interface copy for the derived facts, apart from the authored text. */
export const FACTS_HEADING = 'From the published photographs';
export const ALL_WORK = 'All work';
/**
 * The top All work link's name (#5). Both links go to /work, and the contract's rule 2 gives every control a name of
 * its own, so the top one says where it goes. It starts with the visible words (WCAG 2.5.3), and the end one keeps
 * plain ALL_WORK.
 */
export const ALL_WORK_TOP_NAME = `${ALL_WORK}, back to the series list`;

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
                            {locationsLabel(facts.locations.values)}
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
 * reordering. An All work link sits above the title and another at the end,
 * so the way back is there at both ends of a long sequence. The sequence is
 * SeriesSequence, which shows the first page and appends the rest on Show
 * more (#6); every prop it takes comes from the projection's allowlist.
 * The cover and each entry link to their canonical Viewer URL. Entries carry
 * `id="photo-<photoId>"` and the cover `id="series-cover"`, so SeriesReturn
 * (whose props are the series path, slug, revision, and total) and #9 can
 * put focus back on the one that opened the Viewer. `main` carries the
 * revision the page came from (`data-catalog-revision`), as Work's list and
 * Home's main do, for #12's freshness checks; generateMetadata puts the same
 * one in a `catalog-revision` meta tag.
 */
export default function SeriesPage({ page }: SeriesPageProps) {
    const { total, cover } = page;
    return (
        <main className={styles.page} data-catalog-revision={page.catalogRevision}>
            <article aria-labelledby="series-title">
                <header className={styles.header}>
                    {/* A paragraph, not a nav: SiteNav is the page's one navigation landmark. */}
                    <p className={styles.back}>
                        <Link href={page.workHref} className={styles.allWork} aria-label={ALL_WORK_TOP_NAME}>
                            {ALL_WORK}
                        </Link>
                    </p>
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
                        {/* The cover opens its photograph's Viewer too. The ratio sizes the link to the photograph, so its ring fits it. */}
                        <Link
                            id={COVER_ID}
                            href={cover.href}
                            prefetch={false}
                            aria-label={coverEntryName({ title: cover.title, alt: altOf(cover.description), position: cover.position, total })}
                            className={styles.coverLink}
                            style={{ '--ratio': `${cover.image.width} / ${cover.image.height}` } as CSSProperties}
                            // The focus ring clears the cover's surround (--ring-room, SeriesPage.module.css).
                            data-ring-room=""
                        >
                            {/* alt="" inside the named link, and no fallback text, which would have to be part of the name (WCAG 2.5.3). */}
                            <SeriesPhoto
                                image={cover.image}
                                alt=""
                                sizes={coverSizes(cover.image)}
                                priority
                                focalPoint={cover.focalPoint}
                                crop={cover.crop}
                                intrinsic
                                frameClassName={styles.coverFrame}
                            />
                        </Link>
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

                {/* Outside the sequence section, which SeriesSequence renders. */}
                <SeriesReturn path={page.href} slug={page.slug} revisionId={page.catalogRevision} total={total} />

                <p className={styles.end}>
                    <Link href={page.workHref} className={styles.allWork}>
                        {ALL_WORK}
                    </Link>
                </p>
            </article>
        </main>
    );
}
