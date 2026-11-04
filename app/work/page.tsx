import type { Metadata } from 'next';
import SiteNav from '@/components/site/SiteNav';
import SeriesCatalog from '@/components/work/SeriesCatalog';
import { workRouteOf } from '@/lib/catalog/projections/work';
import { CatalogUnavailableError, getActiveCatalog, publicRoutes } from '@/lib/catalog/public-reader';
import { getSiteOrigin } from '@/lib/site/config';

// Per request, never at build: the image builds with no data root, so a build-time read would freeze Work.
export const dynamic = 'force-dynamic';

/**
 * Work's own title, description, and canonical path (#3), through the root
 * layout's title template and metadataBase. It reads no catalog, so a read
 * failure keeps #21's error page and its status. Without a valid SITE_URL the
 * base is localhost, so the canonical link is left out, as on the series and
 * Viewer pages.
 */
export async function generateMetadata(): Promise<Metadata> {
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
    const result = workRouteOf(await getActiveCatalog(), publicRoutes);
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
