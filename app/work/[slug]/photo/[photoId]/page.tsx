import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { cache } from 'react';
import StoryViewer from '@/components/viewer/StoryViewer';
import { viewerTitle } from '@/components/viewer/viewerLabels';
import { DESCRIPTION_PENDING_COPY, viewerPhotoFrom } from '@/lib/catalog/projections/viewer';
import { CatalogUnavailableError, getActiveCatalog, publicRoutes } from '@/lib/catalog/public-reader';
import { getSiteOrigin } from '@/lib/site/config';
import { siteOpenGraph } from '@/lib/site/metadata';

// Per request, never at build: the image builds with no data root, so a build-time read would freeze the photograph.
// No generateStaticParams or revalidate, no loading.tsx here or above, and no Suspense around the lookup: a notFound()
// or redirect thrown after the shell streams turns into a 200, so both run before anything renders.
export const dynamic = 'force-dynamic';

interface ViewerRouteProps {
    params: Promise<{ slug: string; photoId: string }>;
}

/**
 * The route's one answer for these params in this request. getActiveCatalog()
 * reads one revision per request, and cache() shares the projection between
 * the page and generateMetadata, so the two never disagree.
 */
const viewerFor = cache((slug: string, photoId: string) => viewerPhotoFrom(getActiveCatalog, slug, photoId));

/**
 * Share metadata from the published photo and its series only. Every
 * not-found, redirect, legacy, and unavailable answer gets `{}`, so title and
 * body match whichever case it was, with Next's noindex on the not-found
 * page. URLs are paths Next resolves against the root layout's
 * getMetadataBase(). Without a valid SITE_URL that base is localhost, so the
 * canonical link, og:url, and the share image are left out instead. A photo
 * with no usable set has no share image either, as on #5's series page.
 */
export async function generateMetadata({ params }: ViewerRouteProps): Promise<Metadata> {
    const { slug, photoId } = await params;
    const result = await viewerFor(slug, photoId);
    if (result.kind !== 'ok') return {};
    const { series, photo, position, total } = result.viewer;
    const hasOrigin = getSiteOrigin() !== null;
    const canonical = publicRoutes.photoHref(series.slug, photo.id);
    // The 1200 px WebP, a published `/media` variant whose path carries the asset revision.
    const share = photo.shareImage;
    const description = photo.caption ?? photo.description;
    return {
        title: viewerTitle(photo.title, series.title, position, total),
        ...(description !== null && { description }),
        ...(hasOrigin && { alternates: { canonical } }),
        // Next replaces openGraph whole, so the site's fields go first.
        openGraph: {
            ...siteOpenGraph,
            ...(hasOrigin && { url: canonical }),
            ...(hasOrigin && share && { images: [{ url: share.url, width: share.width, height: share.height, ...(photo.alt !== '' && { alt: photo.alt }) }] }),
        },
    };
}

/**
 * One published photograph in its series (#7). The canonical URL renders the
 * Viewer, a former series slug answers 308 to the canonical URL, and
 * everything else (malformed, unknown, unpublished, outside that series,
 * legacy mode) is the one public not-found. While the catalog is unavailable
 * it throws, so #21's error page answers with Try again, never a 404. No
 * SiteNav: the Viewer's own header holds Close.
 */
export default async function ViewerRoute({ params }: ViewerRouteProps) {
    const { slug, photoId } = await params;
    const result = await viewerFor(slug, photoId);
    switch (result.kind) {
        case 'redirect':
            return permanentRedirect(publicRoutes.photoHref(result.slug, result.photoId));
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
                    closeHref={publicRoutes.seriesHref(viewer.series.slug)}
                    previousHref={step(viewer.previousPhotoId)}
                    nextHref={step(viewer.nextPhotoId)}
                    pendingCopy={viewer.photo.descriptionPending ? DESCRIPTION_PENDING_COPY : null}
                />
            );
        }
    }
}
