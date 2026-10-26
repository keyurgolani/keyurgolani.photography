import CatalogHome from '../components/home/CatalogHome';
import LegacyHome from '../components/home/LegacyHome';
import { LoaderPortraitProvider } from '../components/home/LoaderPortraitContext';
import { artist } from '../data/artist';
import { CatalogUnavailableError, getActiveCatalog, publicRoutes } from '../lib/catalog/public-reader';
import { homeRouteOf } from '../lib/catalog/projections/home';
import { aboutPortraitView } from '../lib/siteConfig/portraitVariants';

// A build-time render would keep serving the legacy Home past the cutover, so `/` renders per request.
export const dynamic = 'force-dynamic';

/**
 * `/` for the catalog as this request finds it. Legacy mode renders today's
 * Home. After the cutover it renders only from the served revision, and an
 * unavailable catalog throws to app/error.tsx, never back to the legacy Home.
 *
 * STAGE 1 PROTOTYPE: the loader shows About's portrait from the site config
 * folder, and `?loader=tilt` picks version (ii), the card tilt; anything else is (i).
 */
export default async function HomePage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {}) {
    const route = homeRouteOf(await getActiveCatalog(), publicRoutes);
    if (route.kind === 'unavailable') throw new CatalogUnavailableError(route.reason);
    const loader = { portrait: await aboutPortraitView(artist.profile.name), tilt: (await searchParams)?.loader === 'tilt' };
    return (
        <LoaderPortraitProvider value={loader}>
            {route.kind === 'legacy' ? <LegacyHome /> : <CatalogHome home={route.home} />}
        </LoaderPortraitProvider>
    );
}
