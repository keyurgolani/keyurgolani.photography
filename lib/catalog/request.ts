import { connection } from 'next/server';
import { cache } from 'react';

/**
 * Wrap a loader so each request runs it once. connection() comes first, so a
 * route reading the catalog renders per request and is never prerendered
 * from whatever the build machine had. React's cache() then shares the one
 * result between the layout, the page, and generateMetadata of that request,
 * so no render mixes two revisions. The only next/* importer in lib/catalog;
 * the CLI never imports it.
 */
export function forRequest<T>(load: () => Promise<T>): () => Promise<T> {
    const once = cache(load);
    return async function loadForRequest() {
        await connection();
        return once();
    };
}
