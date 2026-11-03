import type { MetadataRoute } from 'next';
import { connection } from 'next/server';
import { getActiveCatalog, publicRoutes } from '@/lib/catalog/public-reader';
import { getMetadataBase } from '@/lib/site/config';

// Per request, never at build: the image builds with no data root, and SITE_URL is read when the server starts.
export const dynamic = 'force-dynamic';

/**
 * The visitor routes the site serves now, on SITE_URL's origin: Home, then
 * Work and each published series in Work order with a revision served, then
 * About. While the catalog is unavailable, nothing published included, it
 * lists Home and About only, rather than failing.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
    await connection();
    const base = getMetadataBase();
    const catalog = await getActiveCatalog();
    const middle = catalog.state === 'unavailable' ? [] : [publicRoutes.workHref(), ...catalog.reader.getWorkSummaries(publicRoutes).series.map((series) => series.href)];
    return [publicRoutes.homeHref(), ...middle, publicRoutes.aboutHref()].map((path) => ({ url: new URL(path, base).toString() }));
}
