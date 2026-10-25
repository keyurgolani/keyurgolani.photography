import type { Metadata } from 'next';
import CatalogHome from '@/components/home/CatalogHome';
import { requireCurator } from '@/lib/curation/auth';
import { previewMediaUrls } from '@/lib/catalog/preview-reader';
import { homeRouteOf } from '@/lib/catalog/projections/home';
import { openPreview, previewMetadata } from '../../preview';

/**
 * Home in the draft preview (#16): #4's projection and #2's CatalogHome on
 * the candidate, with the preview's routes. Home remounts on the draft ID,
 * so no screen mixes two drafts.
 */
export const dynamic = 'force-dynamic';

interface PreviewPageProps {
    params: Promise<{ draftId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
    await requireCurator({ read: true });
    return previewMetadata(null);
}

export default async function PreviewHome({ params }: PreviewPageProps) {
    await requireCurator({ read: true });
    const { routes, catalog } = await openPreview((await params).draftId);
    const route = homeRouteOf(catalog, routes);
    // An open preview is always a catalog that reads, so Home is the only answer.
    if (route.kind !== 'home') throw new TypeError(`homeRouteOf answered ${route.kind} for a draft`);
    return <CatalogHome home={previewMediaUrls(route.home, routes)} />;
}
