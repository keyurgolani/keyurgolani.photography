// The Viewer route's lookups and metadata (#7), shared by the photo page and the intercepted route (#9). No JSX, so
// its plain exports sit beside the route components in viewerRoute.tsx without breaking Fast Refresh.
import type { Metadata } from 'next';
import { cache } from 'react';
import { viewerTitle } from '@/components/viewer/viewerLabels';
import { viewerPhotoFrom } from '@/lib/catalog/projections/viewer';
import { getActiveCatalog, publicRoutes } from '@/lib/catalog/public-reader';
import { getSiteOrigin } from '@/lib/site/config';
import { siteOpenGraph } from '@/lib/site/metadata';
import type { PageSearchParams } from '@/lib/site/redirect';

export interface ViewerRouteProps {
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
 * The answer through the intercepted route (`@modal/(.)photo`), which only a
 * soft navigation inside the Viewer or from its series page reaches (#9).
 * Next takes the slug there from the visitor's own URL (the `Next-Url`
 * header), so it's the series the visitor is in (#178):
 * - `moved`, the photograph is in another series now: not-found, which that
 *   route's not-found shows as ViewerUnavailable inside the shell;
 * - `alias`, a former slug of the series that holds it (a rename): the
 *   photograph itself, from its canonical slug. A 308 would be followed under
 *   the same header and come straight back here. The shell moves the address
 *   to the canonical URL;
 * - `case`, a letter-case variant: the 308, as on the page.
 */
const interceptedFor = cache(async (slug: string, photoId: string) => {
    const result = await viewerFor(slug, photoId);
    if (result.kind !== 'redirect' || result.reason === 'case') return result;
    if (result.reason === 'moved') return { kind: 'not-found' as const };
    return viewerFor(result.slug, result.photoId);
});

export const answerFor = (slug: string, photoId: string, intercepted: boolean) => (intercepted ? interceptedFor(slug, photoId) : viewerFor(slug, photoId));

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
export async function generateMetadata(props: ViewerRouteProps): Promise<Metadata> {
    return metadataFor(props, false);
}

/** The intercepted route's metadata: the same, for the answer it gives (interceptedFor). */
export async function generateInterceptedMetadata(props: ViewerRouteProps): Promise<Metadata> {
    return metadataFor(props, true);
}

async function metadataFor({ params }: ViewerRouteProps, intercepted: boolean): Promise<Metadata> {
    const { slug, photoId } = await params;
    const result = await answerFor(slug, photoId, intercepted);
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
