import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import SeriesPage from '@/components/series/SeriesPage';
import SiteNav from '@/components/site/SiteNav';
import { requireCurator } from '@/lib/curation/auth';
import { previewMediaUrls } from '@/lib/catalog/preview-reader';
import { seriesPageFrom } from '@/lib/catalog/projections/series';
import { openPreview, peekPreview, previewMetadata } from '../../../../preview';

/**
 * One series in the draft preview (#16): #5's projection and SeriesPage on
 * the candidate, its first page and #6's Show more through the preview's
 * load-more mirror. A former slug redirects inside the preview, with a 307,
 * so no browser keeps a permanent redirect for a draft.
 */
export const dynamic = 'force-dynamic';

interface PreviewSeriesProps {
    params: Promise<{ draftId: string; slug: string }>;
}

export async function generateMetadata({ params }: PreviewSeriesProps): Promise<Metadata> {
    await requireCurator({ read: true });
    const { draftId, slug } = await params;
    const preview = await peekPreview(draftId);
    if (preview === null) return previewMetadata(null);
    const result = await seriesPageFrom(async () => preview.catalog, slug, preview.routes);
    return previewMetadata(result.kind === 'ok' ? result.page.metadata.title : null);
}

export default async function PreviewSeries({ params }: PreviewSeriesProps) {
    await requireCurator({ read: true });
    const { draftId, slug } = await params;
    const { routes, catalog } = await openPreview(draftId);
    const result = await seriesPageFrom(async () => catalog, slug, routes);
    switch (result.kind) {
        case 'redirect':
            return redirect(result.location);
        case 'not-found':
            return notFound();
        case 'unavailable':
            // An open preview always reads.
            throw new TypeError('seriesPageFrom answered unavailable for a draft');
        case 'ok':
            return (
                <>
                    {/* Outside main, so the nav landmark isn't part of the page's content. */}
                    <SiteNav />
                    <SeriesPage page={previewMediaUrls(result.page, routes)} />
                </>
            );
    }
}
