import { headers } from 'next/headers';
import { connection } from 'next/server';
import { cache } from 'react';

/**
 * Wrap a loader so each request runs it once. connection() comes first, so a
 * route reading the catalog renders per request and is never prerendered
 * from whatever the build machine had. The one answer is then kept by the
 * request's headers object, which Next keeps for the whole request, so the
 * layout, the page, and generateMetadata share it, and no render mixes two
 * revisions.
 *
 * cache() alone isn't enough: its scope is one render. When a page throws,
 * Next renders the error page's head in a second render of the same request,
 * which would read the catalog again from disk. That read lands after the
 * error shell went out, so Next streams the page's title and meta tags into
 * the body, where a visitor without JavaScript keeps them (first on /work's
 * error page, then on the series and Viewer error pages). Kept by the
 * request, the answer is there at once. cache() still shares the load inside
 * a render.
 *
 * The only next/* importer in lib/catalog; the CLI never imports it.
 */
export function forRequest<T>(load: () => Promise<T>): () => Promise<T> {
    const once = cache(load);
    const answers = new WeakMap<object, Promise<T>>();
    return async function loadForRequest() {
        await connection();
        const request = await headers();
        let answer = answers.get(request);
        if (answer === undefined) {
            answer = once();
            answers.set(request, answer);
        }
        return answer;
    };
}
