import SiteNav from '@/components/site/SiteNav';
import SeriesCatalog from '@/components/work/SeriesCatalog';
import { workRouteOf } from '@/lib/catalog/projections/work';
import { CatalogUnavailableError, getActiveCatalog, publicRoutes } from '@/lib/catalog/public-reader';

// Per request, never at build: the image builds with no data root, so a build-time read would freeze Work.
export const dynamic = 'force-dynamic';

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
