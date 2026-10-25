import CatalogHome from '../components/home/CatalogHome';
import LegacyHome from '../components/home/LegacyHome';
import { CatalogUnavailableError, getActiveCatalog, publicRoutes } from '../lib/catalog/public-reader';
import { homeRouteOf } from '../lib/catalog/projections/home';

// A build-time render would keep serving the legacy Home past the cutover, so `/` renders per request.
export const dynamic = 'force-dynamic';

/**
 * `/` for the catalog as this request finds it. Legacy mode renders today's
 * Home. After the cutover it renders only from the served revision, and an
 * unavailable catalog throws to app/error.tsx, never back to the legacy Home.
 */
export default async function HomePage() {
    const route = homeRouteOf(await getActiveCatalog(), publicRoutes);
    if (route.kind === 'legacy') return <LegacyHome />;
    if (route.kind === 'unavailable') throw new CatalogUnavailableError(route.reason);
    return <CatalogHome home={route.home} />;
}
