/**
 * The Location of every series and Viewer redirect (#5, #7): the canonical
 * path the catalog gave, then the visitor's query, so a link with tracking or
 * a deep-link parameter (#6's `?photo=`) still means the same thing after the
 * 308. No imports and no `server-only`, so a client can build the same URL.
 */

/**
 * The longest Location a redirect keeps the query in. A query that would take
 * it past this is dropped whole, never cut: half a query can mean something
 * else, and some proxies and browsers refuse a long header.
 */
export const MAX_LOCATION_LENGTH = 2048;

/** A page's `searchParams` as Next hands them over. */
export type PageSearchParams = Record<string, string | string[] | undefined>;

/**
 * A same-origin absolute path with nothing after it: one `/`, then no second
 * `/` or `\` (either would read as protocol-relative to a browser), and no
 * `?`, `#`, `\`, space, or control character anywhere.
 */
const CANONICAL_PATH_RE = /^\/(?![/\\])[^?#\\\s]*$/;

function isCanonicalPath(path: string): boolean {
    if (!CANONICAL_PATH_RE.test(path)) return false;
    for (let index = 0; index < path.length; index++) {
        const code = path.charCodeAt(index);
        if (code < 0x20 || code === 0x7f) return false;
    }
    return true;
}

/**
 * `canonicalPath` with `query` after it. The path comes from the catalog,
 * never from the request: the route builder's encoded segments. The query is
 * every key and value the visitor sent, each value of a repeated key in its
 * order, re-encoded by URLSearchParams, so nothing in it can end the path,
 * open a fragment, or point at another origin. A path that isn't a
 * same-origin absolute path throws, so a bug can't send a visitor off the
 * site. Following the result never loops as long as the path is one the
 * route renders, which the projections check before they answer a redirect.
 * Past MAX_LOCATION_LENGTH it's the path alone.
 *
 * Re-encoding is lossy where the request was: Next has already decoded the
 * query, so invalid UTF-8 in it arrives as U+FFFD and goes out as `%EF%BF%BD`,
 * and `%20` comes back as `+`. That's accepted: a valid query means the same
 * after the 308, and an invalid one had no meaning to keep.
 */
export function redirectLocation(canonicalPath: string, query?: PageSearchParams | URLSearchParams): string {
    if (!isCanonicalPath(canonicalPath)) throw new TypeError(`A redirect needs a same-origin path, got ${JSON.stringify(canonicalPath)}`);
    const search = new URLSearchParams();
    if (query instanceof URLSearchParams) {
        for (const [key, value] of query) search.append(key, value);
    } else if (query) {
        for (const [key, value] of Object.entries(query)) {
            for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) search.append(key, item);
        }
    }
    const encoded = search.toString();
    if (encoded === '') return canonicalPath;
    const location = `${canonicalPath}?${encoded}`;
    return location.length > MAX_LOCATION_LENGTH ? canonicalPath : location;
}
