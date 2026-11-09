import { photoCountLabel } from '@/lib/catalog/labels';
import type { WorkCatalog } from '@/lib/catalog/projections/work';
import { coverSpan } from './coverSizes';
import WorkCoverImage from './WorkCoverImage';
import WorkEntryLink from './WorkEntryLink';
import styles from './SeriesCatalog.module.css';

/** The reference treatment's Work title (Gallery After Hours). Interface copy, not authored content. */
export const WORK_TITLE = 'Bodies of work';

export interface SeriesCatalogProps {
    work: WorkCatalog;
}

/**
 * Work: one entry per published series, in authored order. Each entry's one
 * link is its title, in the h2 (#171): the title alone names it, and the
 * short statement and the derived count, set apart from the authored copy,
 * describe it. The link's ::after stretches over the whole entry, cover and
 * copy, as its target and its ring, so a click or tap anywhere on the entry
 * opens the series. The link prefetches its series only when a visitor
 * points at it, focuses it or touches it (#6, B10): coming into view
 * prefetches nothing. Keyboard focus on it brings the whole entry into view,
 * cover included. All of it is visible without hover. The list carries the
 * revision its entries came from (`data-catalog-revision`), as Home's main and
 * the series page's main do, for #12's freshness checks; so does the empty
 * line. A server component: the cover ships the projection's cover fields to
 * the client, and the link its href, its title and its attributes.
 */
export default function SeriesCatalog({ work }: SeriesCatalogProps) {
    return (
        <main className={styles.page}>
            <header className={styles.header}>
                <h1 className={styles.title}>{WORK_TITLE}</h1>
            </header>
            {work.series.length === 0 ? (
                <p className={styles.empty} data-catalog-revision={work.catalogRevision}>
                    No series are published right now.
                </p>
            ) : (
                <ul className={styles.list} data-catalog-revision={work.catalogRevision}>
                    {work.series.map((series, index) => {
                        // By place, unique on the page, and nothing from the catalog in an id.
                        const statementId = `work-entry-${index + 1}-statement`;
                        const countId = `work-entry-${index + 1}-count`;
                        const describedBy = series.shortStatement !== null ? `${statementId} ${countId}` : countId;
                        return (
                            <li key={series.id} className={styles.item}>
                                <div className={styles.entry}>
                                    {/* The first two covers load at once, the first at high priority and the second at low,
                                        the rest as they near the viewport (#3). Keyed on the cover's file, so a refresh that brings a new cover
                                        clears a failure. Decorative, with alt="": the title names the link. */}
                                    <WorkCoverImage
                                        key={series.cover?.variants.w1200.webp.url ?? 'none'}
                                        cover={series.cover}
                                        loading={index === 0 ? 'lead' : index === 1 ? 'eager' : 'lazy'}
                                        span={coverSpan(index)}
                                    />
                                    <div className={styles.copy}>
                                        {/* The title link prefetches its series on a pointer, focus or touch only, never on coming into view,
                                            and keyboard focus brings the whole entry into view (B10). */}
                                        <h2 className={styles.seriesTitle}>
                                            <WorkEntryLink href={series.href} className={styles.link} aria-describedby={describedBy}>
                                                {series.title}
                                            </WorkEntryLink>
                                        </h2>
                                        {series.shortStatement !== null && (
                                            <p id={statementId} className={styles.statement}>
                                                {series.shortStatement}
                                            </p>
                                        )}
                                        <p id={countId} className={styles.count}>
                                            {photoCountLabel(series.derived.photoCount)}
                                        </p>
                                    </div>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
        </main>
    );
}
