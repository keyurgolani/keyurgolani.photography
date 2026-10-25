import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import StoryViewer from '@/components/viewer/StoryViewer';
import { viewerTitle } from '@/components/viewer/viewerLabels';
import { requireCurator } from '@/lib/curation/auth';
import { previewMediaUrls } from '@/lib/catalog/preview-reader';
import { DESCRIPTION_PENDING_COPY, viewerPhotoFrom } from '@/lib/catalog/projections/viewer';
import { openPreview, peekPreview, previewMetadata } from '../../../../../../preview';

/**
 * One photograph in the draft preview (#16): #7's projection and
 * StoryViewer on the candidate, in page mode, with Close, Previous, and
 * Next from the preview's routes. A photo whose description is pending
 * shows #7's pending copy. A former slug redirects inside the preview, with
 * a 307.
 */
export const dynamic = 'force-dynamic';

interface PreviewViewerProps {
    params: Promise<{ draftId: string; slug: string; photoId: string }>;
}

export async function generateMetadata({ params }: PreviewViewerProps): Promise<Metadata> {
    await requireCurator({ read: true });
    const { draftId, slug, photoId } = await params;
    const preview = await peekPreview(draftId);
    if (preview === null) return previewMetadata(null);
    const result = await viewerPhotoFrom(async () => preview.catalog, slug, photoId);
    if (result.kind !== 'ok') return previewMetadata(null);
    const { series, photo, position, total } = result.viewer;
    return previewMetadata(viewerTitle(photo.title, series.title, position, total));
}

export default async function PreviewViewer({ params }: PreviewViewerProps) {
    await requireCurator({ read: true });
    const { draftId, slug, photoId } = await params;
    const { routes, catalog } = await openPreview(draftId);
    const result = await viewerPhotoFrom(async () => catalog, slug, photoId);
    switch (result.kind) {
        case 'redirect':
            return redirect(routes.photoHref(result.slug, result.photoId));
        case 'not-found':
            return notFound();
        case 'unavailable':
            // An open preview always reads.
            throw new TypeError('viewerPhotoFrom answered unavailable for a draft');
        case 'ok': {
            const viewer = previewMediaUrls(result.viewer, routes);
            const step = (id: string | null) => (id === null ? null : routes.photoHref(viewer.series.slug, id));
            return (
                <StoryViewer
                    viewer={viewer}
                    closeHref={routes.seriesHref(viewer.series.slug)}
                    previousHref={step(viewer.previousPhotoId)}
                    nextHref={step(viewer.nextPhotoId)}
                    pendingCopy={viewer.photo.descriptionPending ? DESCRIPTION_PENDING_COPY : null}
                />
            );
        }
    }
}
