import type { Metadata } from 'next';
import CuratorHeader from '../CuratorHeader';
import styles from '../curator.module.css';
import NewSeriesForm from './NewSeriesForm';
import SeriesList from './SeriesList';
import series from './series.module.css';
import { FeaturedForm, WorkOrderEditor } from './WorkOrder';
import { requireCurator } from '@/lib/curation/auth';
import { loadSeriesScreen } from '@/lib/curation/series-form';
import { NOTHING_PUBLIC } from '@/lib/curation/series-view';

/**
 * `/curation/series` (#150): every series in the working layer, and New
 * series (2a), then the Work order and the featured series (2b). It reads
 * per request, behind requireCurator(), and writes nothing; its forms post
 * to ./actions.ts, and each series' page is ./[seriesId]/page.tsx.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Curation series', robots: { index: false, follow: false } };

export default async function SeriesPage() {
    await requireCurator({ read: true });
    let screen: Awaited<ReturnType<typeof loadSeriesScreen>> | 'failed';
    try {
        screen = await loadSeriesScreen();
    } catch (error) {
        // A read error can name a host path, so the page says only that it failed. The server log keeps the rest.
        console.error('[curation] The series could not be read:', error);
        screen = 'failed';
    }
    return (
        <div className={styles.page}>
            <CuratorHeader active="series" publishHref="/curation/publish" />
            {screen === 'failed' || screen.state === 'not-ready' ? (
                <main className={styles.state}>
                    <h1>The series can&apos;t be read right now</h1>
                    <p>{screen === 'failed' ? "Something in the data root couldn't be read, so nothing is shown and nothing was written. The server log names what failed." : screen.message}</p>
                    <a className={styles.linkButton} href="/curation/series">
                        Try again
                    </a>
                </main>
            ) : (
                <main className={series.body}>
                    <h1>Series</h1>
                    <p className={series.lead}>Every series in the draft, in Work order and then by title. What you change here changes the draft. {NOTHING_PUBLIC}</p>
                    <div className={series.layout}>
                        <SeriesList rows={screen.rows} unreadable={screen.unreadable} />
                        <NewSeriesForm activeRevisionId={screen.activeRevisionId} />
                    </div>
                    {screen.work === null ? (
                        <p className={series.unreadable}>Work order and the featured series can&apos;t be read right now, so they can&apos;t be changed here. The server log names the problem.</p>
                    ) : (
                        <div className={series.layout}>
                            <WorkOrderEditor work={screen.work} activeRevisionId={screen.activeRevisionId} />
                            <FeaturedForm work={screen.work} activeRevisionId={screen.activeRevisionId} />
                        </div>
                    )}
                </main>
            )}
        </div>
    );
}
