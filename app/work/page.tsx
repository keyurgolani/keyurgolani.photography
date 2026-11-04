import type { Metadata } from 'next';
import { cache } from 'react';
import SiteNav from '@/components/site/SiteNav';
import SeriesCatalog from '@/components/work/SeriesCatalog';
import { workRouteOf } from '@/lib/catalog/projections/work';
import { CatalogUnavailableError, getActiveCatalog, publicRoutes } from '@/lib/catalog/public-reader';
import { getSiteOrigin } from '@/lib/site/config';

// Per request, never at build: the image builds with no data root, so a build-time read would freeze Work.
export const dynamic = 'force-dynamic';

/**
 * The page's one answer in this request. getActiveCatalog() reads one
 * revision per request, and cache() shares the projection between the page
 * and generateMetadata, so the two never disagree.
 */
const workFor = cache(async () => workRouteOf(await getActiveCatalog(), publicRoutes));

/**
 * Work's own title, description, and canonical path (#3), through the root
 * layout's title template and metadataBase. While the catalog is unavailable
 * it gives `{}`, as the series pages do, so #21's error page keeps the site's
 * defaults with its 500. Without a valid SITE_URL the base is localhost, so
 * the canonical link is left out, as on the series and Viewer pages.
 */
export async function generateMetadata(): Promise<Metadata> {
    if ((await workFor()).kind !== 'work') return {};
    return {
        title: 'Work',
        description: 'Photographic series by Keyur Golani.',
        ...(getSiteOrigin() !== null && { alternates: { canonical: '/work' } }),
    };
}

/**
 * The series catalog (#3): the served revision's published series. With
 * nothing published, or a catalog that can't be read, it throws, so #21's
 * error page renders with its Try again.
 */
export default async function WorkPage() {
    const result = await workFor();
    switch (result.kind) {
        case 'unavailable':
            throw new CatalogUnavailableError(result.reason);
        case 'work':
            return (
                <>
                    {/* Outside main, so the nav landmark isn't part of the page's content. */}
                    <SiteNav />
                    <SeriesCatalog work={result.work} />
                </>
            );
    }
}
