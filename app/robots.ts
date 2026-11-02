import type { MetadataRoute } from 'next';
import { connection } from 'next/server';
import { getMetadataBase } from '@/lib/site/config';

// Per request, so the sitemap line follows the SITE_URL the server starts with.
export const dynamic = 'force-dynamic';

/**
 * Every crawler may read the site but its API. Cloudflare prepends its own
 * managed content signals to this file, and the owner sets those there, so
 * this adds none to contradict them. The curator isn't named: the public
 * site answers 404 for it.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
    await connection();
    return {
        rules: [{ userAgent: '*', allow: '/', disallow: '/api/' }],
        sitemap: new URL('/sitemap.xml', getMetadataBase()).toString(),
    };
}
