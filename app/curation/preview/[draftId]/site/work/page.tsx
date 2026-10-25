import type { Metadata } from 'next';
import SiteNav from '@/components/site/SiteNav';
import SeriesCatalog from '@/components/work/SeriesCatalog';
import { requireCurator } from '@/lib/curation/auth';
import { previewMediaUrls } from '@/lib/catalog/preview-reader';
import { workRouteOf } from '@/lib/catalog/projections/work';
import { openPreview, previewMetadata } from '../../../preview';

/** Work in the draft preview (#16): #3's projection and SeriesCatalog on the candidate, with the preview's routes. */
export const dynamic = 'force-dynamic';

interface PreviewPageProps {
    params: Promise<{ draftId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
    await requireCurator({ read: true });
    return previewMetadata('Work');
}

export default async function PreviewWork({ params }: PreviewPageProps) {
    await requireCurator({ read: true });
    const { routes, catalog } = await openPreview((await params).draftId);
    const result = workRouteOf('work', catalog, routes);
    // An open preview is always a catalog that reads, so Work is the only answer.
    if (result.kind !== 'work') throw new TypeError(`workRouteOf answered ${result.kind} for a draft`);
    return (
        <>
            {/* Outside main, so the nav landmark isn't part of the page's content. */}
            <SiteNav />
            <SeriesCatalog work={previewMediaUrls(result.work, routes)} />
        </>
    );
}
