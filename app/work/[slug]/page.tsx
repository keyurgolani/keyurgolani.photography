import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { cache } from 'react';
import SeriesPage from '@/components/series/SeriesPage';
import SiteNav from '@/components/site/SiteNav';
import { seriesPageFrom } from '@/lib/catalog/projections/series';
import { CatalogUnavailableError, getActiveCatalog, publicRoutes } from '@/lib/catalog/public-reader';
import { getSiteOrigin } from '@/lib/site/config';
import { siteOpenGraph } from '@/lib/site/metadata';

// Per request, never at build: the image builds with no data root, so a build-time read would freeze the series.
// Dynamic responses also go out uncacheable, so a 308 doesn't stick in a browser after a rollback.
// No loading.tsx here or above, and no Suspense around the lookup: a notFound() or redirect thrown after the
// shell streams turns into a 200, so both run before anything renders.
export const dynamic = 'force-dynamic';

interface SeriesRouteProps {
    params: Promise<{ slug: string }>;
}

/**
 * The page's one answer for `slug` in this request. getActiveCatalog() reads
 * one revision per request, and cache() shares the projection between the
 * page and generateMetadata, so the two never disagree.
 */
const seriesFor = cache((slug: string) => seriesPageFrom(getActiveCatalog, slug, publicRoutes));

/**
 * Share metadata from the published series record only. Every not-found,
 * redirect, legacy, and unavailable answer gets `{}`, so status, title, and
 * body match whichever case it was: #21's defaults and the not-found page's
 * title, with Next's noindex. URLs are paths that Next resolves against the
 * root layout's getMetadataBase(). Without a valid SITE_URL that base is
 * localhost, so the canonical link, og:url, and the share image are left out
 * instead.
 */
export async function generateMetadata({ params }: SeriesRouteProps): Promise<Metadata> {
    const result = await seriesFor((await params).slug);
    if (result.kind !== 'ok') return {};
    const { metadata } = result.page;
    const hasOrigin = getSiteOrigin() !== null;
    const share = hasOrigin ? metadata.shareImage : null;
    return {
        title: metadata.title,
        ...(metadata.description !== null && { description: metadata.description }),
        ...(hasOrigin && { alternates: { canonical: metadata.canonicalPath } }),
        // Next replaces openGraph whole, so the site's fields go first.
        openGraph: {
            ...siteOpenGraph,
            ...(hasOrigin && { url: metadata.canonicalPath }),
            ...(share && { images: [{ url: share.path, width: share.width, height: share.height, alt: share.alt }] }),
        },
    };
}

/**
 * A published series (#5). The canonical slug renders the series, a former
 * slug answers 308 to the canonical one, and everything else (malformed,
 * unknown, draft, hidden, removed, legacy mode) is the one public not-found.
 * While the catalog is unavailable it throws, so #21's error page answers
 * 500 with Try again, never a 404.
 */
export default async function SeriesRoute({ params }: SeriesRouteProps) {
    const result = await seriesFor((await params).slug);
    switch (result.kind) {
        case 'redirect':
            return permanentRedirect(result.location);
        case 'not-found':
            return notFound();
        case 'unavailable':
            throw new CatalogUnavailableError(result.reason);
        case 'ok':
            return (
                <>
                    {/* Outside main, so the nav landmark isn't part of the page's content. */}
                    <SiteNav />
                    <SeriesPage page={result.page} />
                </>
            );
    }
}
