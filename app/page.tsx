import CatalogHome from '../components/home/CatalogHome';
import { artist } from '../data/artist';
import { homeStartPick } from '../lib/catalog/homePick';
import { CatalogUnavailableError, getActiveCatalog, publicRoutes } from '../lib/catalog/public-reader';
import { homeRouteOf } from '../lib/catalog/projections/home';
import { aboutPortraitView } from '../lib/siteConfig/portraitVariants';

// A build-time render would freeze Home at the data root the build saw, which is none, so `/` renders per request.
// That also reads About's portrait per request, so a swapped file shows in the intro and the badge without a build.
export const dynamic = 'force-dynamic';

/**
 * `/` for the catalog as this request finds it: rendered only from the
 * served revision. With nothing published, or a catalog that can't be read,
 * it throws to app/error.tsx, and never lists the library.
 * This render picks the featured series Home starts on, at random, so the
 * first photograph, its preload and hydration all agree, with no cookie or
 * stored state.
 * The intro and the badge show About's portrait from the site config folder,
 * the same files About serves, or none without a usable one.
 */
export default async function HomePage() {
    const route = homeRouteOf(await getActiveCatalog(), publicRoutes, homeStartPick());
    if (route.kind === 'unavailable') throw new CatalogUnavailableError(route.reason);
    const portrait = await aboutPortraitView(artist.profile.name);
    return <CatalogHome home={route.home} portrait={portrait} />;
}
