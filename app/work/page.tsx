import { permanentRedirect, redirect } from 'next/navigation';
import SiteNav from '@/components/site/SiteNav';
import SeriesCatalog from '@/components/work/SeriesCatalog';
import { workRouteOf } from '@/lib/catalog/projections/work';
import { CatalogUnavailableError, getActiveCatalog, publicRoutes } from '@/lib/catalog/public-reader';

// Per request, never at build: the image builds with no data root, so a build-time read would freeze Work.
// No loading.tsx here or above, so the 307 below stays a real redirect, not a refresh inside a 200.
export const dynamic = 'force-dynamic';

/**
 * The series catalog (#3). Before the cutover it answers 307 to the legacy
 * /gallery. With a revision served it renders that revision's published
 * series. While the catalog is unavailable it throws, so #21's error page
 * renders with its Try again.
 */
export default async function WorkPage() {
    const result = workRouteOf('work', await getActiveCatalog(), publicRoutes);
    switch (result.kind) {
        case 'redirect':
            return result.status === 308 ? permanentRedirect(result.location) : redirect(result.location);
        case 'unavailable':
            throw new CatalogUnavailableError(result.reason);
        case 'legacy-gallery':
            // Only /gallery answers this.
            throw new TypeError('workRouteOf(work) answered legacy-gallery');
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
