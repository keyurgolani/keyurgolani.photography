import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import CuratorHeader from '../../CuratorHeader';
import styles from '../../curator.module.css';
import SeriesEditForm from '../SeriesEditForm';
import series from '../series.module.css';
import { requireCurator } from '@/lib/curation/auth';
import { loadSeriesDetail } from '@/lib/curation/series-form';
import { photoCountLabel, seriesName, VISIBILITY_LABEL } from '@/lib/curation/series-view';

/**
 * `/curation/series/<seriesId>` (#150's 2a): one series' title, statements
 * and visibility, as `photos edit` would open them. It reads per request,
 * behind requireCurator(), and writes nothing; Save posts to ../actions.ts
 * with the version this page showed. The order, the cover and the chapters
 * are 2b's, so they aren't here.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Curation series', robots: { index: false, follow: false } };

interface SeriesDetailPageProps {
    params: Promise<{ seriesId: string }>;
}

export default async function SeriesDetailPage({ params }: SeriesDetailPageProps) {
    await requireCurator({ read: true });
    const { seriesId } = await params;
    let loaded: Awaited<ReturnType<typeof loadSeriesDetail>> | 'failed';
    try {
        loaded = await loadSeriesDetail(seriesId);
    } catch (error) {
        // A read error can name a host path, so the page says only that it failed. The server log keeps the rest.
        console.error('[curation] A series could not be read:', error);
        loaded = 'failed';
    }
    if (loaded !== 'failed' && loaded.state === 'not-found') notFound();
    return (
        <div className={styles.page}>
            <CuratorHeader active="series" publishHref="/curation/publish" />
            {loaded === 'failed' || loaded.state === 'not-ready' ? (
                <main className={styles.state}>
                    <h1>This series can&apos;t be read right now</h1>
                    <p>{loaded === 'failed' ? "Something in the data root couldn't be read, so nothing is shown and nothing was written. The server log names what failed." : loaded.message}</p>
                    <a className={styles.linkButton} href={`/curation/series/${seriesId}`}>
                        Try again
                    </a>
                </main>
            ) : (
                <main className={`${series.body} ${series.detail}`}>
                    <Link href="/curation/series" className={series.back}>
                        <ArrowLeft size={16} aria-hidden="true" />
                        All series
                    </Link>
                    <h1>{seriesName(loaded.detail.title)}</h1>
                    <dl className={series.facts}>
                        <div>
                            <dt>Web address</dt>
                            <dd>/work/{loaded.detail.slug}</dd>
                        </div>
                        <div>
                            <dt>Visibility in the draft</dt>
                            <dd>{VISIBILITY_LABEL[loaded.detail.visibility]}</dd>
                        </div>
                        <div>
                            <dt>Photographs</dt>
                            <dd>{photoCountLabel(loaded.detail.photoCount)}</dd>
                        </div>
                        <div>
                            <dt>Work order</dt>
                            <dd>{loaded.detail.inWorkOrder ? 'Listed' : 'Not listed'}</dd>
                        </div>
                    </dl>
                    <SeriesEditForm detail={loaded.detail} />
                </main>
            )}
        </div>
    );
}
