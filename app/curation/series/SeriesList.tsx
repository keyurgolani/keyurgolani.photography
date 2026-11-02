import Link from 'next/link';
import series from './series.module.css';
import { photoCountLabel, seriesName, VISIBILITY_LABEL, type SeriesRow } from '@/lib/curation/series-view';

/**
 * The Series screen's list (#150's 2a): every series in the working layer,
 * in Work order and then by title, each by its title, linking to its page,
 * with its visibility, its photographs, and whether `photos carry-over`
 * brought it over at the launch. Never an ID. It reads nothing itself.
 */
export default function SeriesList({ rows, unreadable }: { rows: SeriesRow[]; unreadable: number }) {
    return (
        <div className={series.list}>
            {rows.length === 0 ? (
                <p className={series.empty}>No series yet. Make the first one with New series.</p>
            ) : (
                <ul className={series.rows} aria-label="Series">
                    {rows.map((row) => (
                        <li key={row.id} className={series.row}>
                            <Link href={row.href} className={series.rowLink}>
                                {seriesName(row.title)}
                            </Link>
                            <p className={series.rowMeta}>
                                <span className={series.tag} data-visibility={row.visibility}>
                                    {VISIBILITY_LABEL[row.visibility]}
                                </span>
                                <span>{photoCountLabel(row.photoCount)}</span>
                                {row.carriedOver ? <span>Carried over</span> : null}
                                {row.inWorkOrder ? null : <span>Not in Work order</span>}
                            </p>
                        </li>
                    ))}
                </ul>
            )}
            {unreadable > 0 ? (
                <p className={series.unreadable}>
                    {unreadable === 1 ? "1 series can't be read, so it isn't listed." : `${unreadable} series can't be read, so they aren't listed.`} The server log names {unreadable === 1 ? 'it' : 'them'}.
                </p>
            ) : null}
        </div>
    );
}
