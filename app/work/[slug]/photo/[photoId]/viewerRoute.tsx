// The Viewer route's answer (#7), shared by the photo page and the intercepted route (#9), which each set their own
// segment config. Kept out of page.tsx, whose exports Next checks.
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { cache } from 'react';
import StoryViewer from '@/components/viewer/StoryViewer';
import { viewerTitle } from '@/components/viewer/viewerLabels';
import { DESCRIPTION_PENDING_COPY, viewerPhotoFrom } from '@/lib/catalog/projections/viewer';
import { CatalogUnavailableError, getActiveCatalog, publicRoutes } from '@/lib/catalog/public-reader';
import { getSiteOrigin } from '@/lib/site/config';
import { siteOpenGraph } from '@/lib/site/metadata';
import { redirectLocation, type PageSearchParams } from '@/lib/site/redirect';

interface ViewerRouteProps {
    params: Promise<{ slug: string; photoId: string }>;
    /** Read only for a redirect, which keeps the query. Optional, since generateMetadata and the tests don't pass it. */
    searchParams?: Promise<PageSearchParams>;
}

/**
 * The route's one answer for these params in this request. getActiveCatalog()
 * reads one revision per request, and cache() shares the projection between
 * the page and generateMetadata, so the two never disagree.
 */
const viewerFor = cache((slug: string, photoId: string) => viewerPhotoFrom(getActiveCatalog, slug, photoId));

/**
 * Share metadata from the published photo and its series only. Every
 * not-found, redirect, and unavailable answer gets `{}`, so title and
 * body match whichever case it was, with Next's noindex on the not-found
 * page. URLs are paths Next resolves against the root layout's
 * getMetadataBase(). Without a valid SITE_URL that base is localhost, so the
 * canonical link, og:url, and the share image are left out instead. A photo
 * with no usable set has no share image either, as on #5's series page. The
 * `catalog-revision` meta tag names the revision, as the series page's does.
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
        // The revision this photograph came from: <meta name="catalog-revision">, neither seen nor heard, for #12's freshness checks.
        other: { 'catalog-revision': result.viewer.catalogRevision },
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
 * Viewer; a former series slug, a letter-case variant, or a photo that moved
 * to another published series answers 308 to the canonical URL with the
 * query kept, built from the projection's slug and photo ID, never the
 * requested ones; and everything else (malformed, unknown, unpublished) is
 * the one public not-found. While the catalog is unavailable, nothing
 * published included, it throws, so #21's error page answers with Try again,
 * never a 404. No SiteNav: the Viewer's own header holds Close, which goes
 * to the series on this photograph's entry (`?photo=`, B5).
 */
export async function ViewerRoute(props: ViewerRouteProps) {
    return viewerAnswer(props, { intercepted: false });
}

/**
 * The same answer through the intercepted route (`@modal/(.)photo`), which
 * only a soft navigation inside the Viewer or from its series page reaches
 * (#9). There a redirect to another series' slug means the photograph moved
 * out of the series the visitor is in since the link was rendered, so it's
 * not-found, which that route's not-found shows as ViewerUnavailable inside
 * the shell (#178). A letter-case variant of the same slug still redirects.
 * A direct load or a refresh of the page itself keeps the 308 (#7, decided).
 */
export async function InterceptedViewerRoute(props: ViewerRouteProps) {
    return viewerAnswer(props, { intercepted: true });
}

async function viewerAnswer({ params, searchParams }: ViewerRouteProps, { intercepted }: { intercepted: boolean }) {
    const { slug, photoId } = await params;
    const result = await viewerFor(slug, photoId);
    if (intercepted && result.kind === 'redirect' && result.slug.toLowerCase() !== slug.toLowerCase()) return notFound();
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
