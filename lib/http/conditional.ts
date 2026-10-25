/**
 * `If-None-Match` as RFC 9110 section 13.1.2 reads it: `*`, or a list of
 * entity tags, each strong (`"x"`) or weak (`W/"x"`), compared weakly, so
 * `W/"x"` and `"x"` match. A header that doesn't parse matches nothing, so
 * the client gets the full response rather than a wrong 304.
 */

export type IfNoneMatch = { any: true } | { any: false; tags: string[] };

/** One list element: an optional `W/`, then the quoted opaque tag, which may hold commas. */
const ENTITY_TAG = /(?:W\/)?("[\x21\x23-\x7E\x80-\xFF]*")[\t ]*/y;

/**
 * The header's opaque tags, quotes included, or `{ any: true }` for `*`.
 * Null when it is absent, empty, or malformed anywhere.
 */
export function parseIfNoneMatch(value: string | null | undefined): IfNoneMatch | null {
    if (value === null || value === undefined) return null;
    const text = value.trim();
    if (text === '*') return { any: true };
    const tags: string[] = [];
    let index = 0;
    while (index < text.length) {
        const char = text[index];
        // Empty list elements and the space around them are allowed.
        if (char === ',' || char === ' ' || char === '\t') {
            index += 1;
            continue;
        }
        ENTITY_TAG.lastIndex = index;
        const match = ENTITY_TAG.exec(text);
        if (match === null) return null;
        tags.push(match[1]);
        index = ENTITY_TAG.lastIndex;
        if (index < text.length && text[index] !== ',') return null;
    }
    return tags.length === 0 ? null : { any: false, tags };
}

/** The opaque part of an entity tag, quotes included, without any `W/`. */
export function opaqueTag(etag: string): string {
    return etag.startsWith('W/') ? etag.slice(2) : etag;
}

/**
 * Whether `header` names `etag` by weak comparison, or is `*`. Pass only
 * the tag of a representation that exists, since `*` matches any.
 */
export function ifNoneMatchHits(header: string | null | undefined, etag: string): boolean {
    const parsed = parseIfNoneMatch(header);
    if (parsed === null) return false;
    if (parsed.any) return true;
    const opaque = opaqueTag(etag);
    return parsed.tags.includes(opaque);
}
