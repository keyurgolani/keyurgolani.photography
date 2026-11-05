// The Viewer route's answer (#7), shared by the photo page and the intercepted route (#9), which each set their own
// segment config. Kept out of page.tsx, whose exports Next checks. The lookups and metadata are in viewerLookup.ts.
import { notFound, permanentRedirect } from 'next/navigation';
import StoryViewer from '@/components/viewer/StoryViewer';
import { DESCRIPTION_PENDING_COPY } from '@/lib/catalog/projections/viewer';
import { CatalogUnavailableError, publicRoutes } from '@/lib/catalog/public-reader';
import { redirectLocation } from '@/lib/site/redirect';
import { answerFor, type ViewerRouteProps } from './viewerLookup';

/**
 * One published photograph in its series (#7). The canonical URL renders the
 * Viewer; a former series slug, a letter-case variant, or a photo that moved
 * to another published series answers 308 to the canonical URL with the
 * query kept, built from the projection's slug and photo ID, never the
 * requested ones; and everything else (malformed, unknown, unpublished) is
 * the one public not-found. While the catalog is unavailable, nothing
 * published included, it throws, so #21's error page answers with Try again,
 * never a 404. No SiteNav: the Viewer's own header holds Close, which goes
 * to the series on this photograph's entry (`?photo=`).
 */
export async function ViewerRoute(props: ViewerRouteProps) {
    return viewerAnswer(props, { intercepted: false });
}

/**
 * The same answer through the intercepted route (interceptedFor): a photograph
 * moved out of the series is not-found, one under a renamed series renders.
 * A direct load or a refresh of the page itself keeps every 308 (#7, decided).
 */
export async function InterceptedViewerRoute(props: ViewerRouteProps) {
    return viewerAnswer(props, { intercepted: true });
}

async function viewerAnswer({ params, searchParams }: ViewerRouteProps, { intercepted }: { intercepted: boolean }) {
    const { slug, photoId } = await params;
    const result = await answerFor(slug, photoId, intercepted);
    switch (result.kind) {
        case 'redirect':
            return permanentRedirect(redirectLocation(publicRoutes.photoHref(result.slug, result.photoId), await searchParams));
        case 'not-found':
            return notFound();
        case 'unavailable':
            throw new CatalogUnavailableError(result.reason);
        case 'ok': {
            const { viewer } = result;
            const step = (id: string | null) => (id === null ? null : publicRoutes.photoHref(viewer.series.slug, id));
            return (
                <StoryViewer
                    viewer={viewer}
                    closeHref={publicRoutes.seriesHref(viewer.series.slug, { focusPhotoId: viewer.photo.id })}
                    previousHref={step(viewer.previousPhotoId)}
                    nextHref={step(viewer.nextPhotoId)}
                    pendingCopy={viewer.photo.descriptionPending ? DESCRIPTION_PENDING_COPY : null}
                />
            );
        }
    }
}
