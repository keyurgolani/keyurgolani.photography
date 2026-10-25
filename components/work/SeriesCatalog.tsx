import Link from 'next/link';
import { photoCountLabel, type WorkCatalog } from '@/lib/catalog/projections/work';
import WorkCoverImage from './WorkCoverImage';
import styles from './SeriesCatalog.module.css';

/** The reference treatment's Work title (Gallery After Hours). Interface copy, not authored content. */
export const WORK_TITLE = 'Bodies of work';

export interface SeriesCatalogProps {
    work: WorkCatalog;
}

/**
 * Work: one entry per published series, in authored order. Each entry is one
 * link to the series page, with the cover, the authored title and short
 * statement, and the derived count set apart from the authored copy, all
 * visible without hover. A server component: only the cover ships props to
 * the client, and those are the projection's cover fields.
 */
export default function SeriesCatalog({ work }: SeriesCatalogProps) {
    return (
        <main className={styles.page}>
            <header className={styles.header}>
                <h1 className={styles.title}>{WORK_TITLE}</h1>
            </header>
            {work.series.length === 0 ? (
                <p className={styles.empty}>No series are published yet.</p>
            ) : (
                <ul className={styles.list}>
                    {work.series.map((series, index) => (
                        <li key={series.id} className={styles.item}>
                            <Link href={series.href} className={styles.entry}>
                                {/* The first cover loads at once, the rest as they near the viewport. */}
                                <WorkCoverImage cover={series.cover} eager={index === 0} />
                                <div className={styles.copy}>
                                    <h2 className={styles.seriesTitle}>{series.title}</h2>
                                    {series.shortStatement !== null && <p className={styles.statement}>{series.shortStatement}</p>}
                                    <p className={styles.count}>{photoCountLabel(series.derived.photoCount)}</p>
                                </div>
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
        </main>
    );
}
