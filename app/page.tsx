import CatalogHome from '../components/home/CatalogHome';
import LegacyHome from '../components/home/LegacyHome';
import { artist } from '../data/artist';
import { CatalogUnavailableError, getActiveCatalog, publicRoutes } from '../lib/catalog/public-reader';
import { homeRouteOf } from '../lib/catalog/projections/home';
import { aboutPortraitView } from '../lib/siteConfig/portraitVariants';

// A build-time render would keep serving the legacy Home past the cutover, so `/` renders per request.
// That also reads About's portrait per request, so a swapped file shows in the intro and the badge without a build.
export const dynamic = 'force-dynamic';

/**
 * `/` for the catalog as this request finds it. Legacy mode renders today's
 * Home. After the cutover it renders only from the served revision, and an
 * unavailable catalog throws to app/error.tsx, never back to the legacy Home.
 * Either way the intro and the badge show About's portrait from the site
 * config folder, the same files About serves, or none without a usable one.
 */
export default async function HomePage() {
    const route = homeRouteOf(await getActiveCatalog(), publicRoutes);
    if (route.kind === 'unavailable') throw new CatalogUnavailableError(route.reason);
    const portrait = await aboutPortraitView(artist.profile.name);
    if (route.kind === 'legacy') return <LegacyHome portrait={portrait} />;
    return <CatalogHome home={route.home} portrait={portrait} />;
}
