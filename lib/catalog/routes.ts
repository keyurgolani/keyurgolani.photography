/**
 * The site's hrefs, from a serializable `{ basePath }`: `''` on the public
 * site, `/curation/preview/<draftId>/site` in #16's preview. No imports and
 * no `server-only`, so client code (components/site/SiteRoutes.tsx) builds
 * the same hrefs from the same `basePath` the server used. reader.ts
 * re-exports it.
 */
export interface RouteBuilder {
    readonly basePath: string;
    homeHref(): string;
    workHref(): string;
    aboutHref(): string;
    seriesHref(slug: string): string;
    photoHref(slug: string, photoId: string): string;
    /** A catalog endpoint, `path` after `/api/catalog/`, such as `series/<slug>/pages/<cursor>`. */
    catalogApiHref(path: string): string;
    /** A `/media` path (#10) as this site serves it: unchanged publicly, under `basePath` in a preview. */
    mediaHref(path: string): string;
}

// Plain path segments only: a `basePath` such as `/\host` would read as protocol-relative to a browser.
const BASE_PATH_RE = /^(?:\/[A-Za-z0-9._~-]+)+$/;

export function createRouteBuilder({ basePath = '' }: { basePath?: string } = {}): RouteBuilder {
    if (basePath !== '' && !BASE_PATH_RE.test(basePath)) {
        throw new TypeError(`basePath must be '' or start with one / and not end with one, got ${JSON.stringify(basePath)}`);
    }
    const segment = encodeURIComponent;
    return {
        basePath,
        homeHref: () => basePath || '/',
        workHref: () => `${basePath}/work`,
        aboutHref: () => `${basePath}/about`,
        seriesHref: (slug) => `${basePath}/work/${segment(slug)}`,
        photoHref: (slug, photoId) => `${basePath}/work/${segment(slug)}/photo/${segment(photoId)}`,
        catalogApiHref: (path) => `${basePath}/api/catalog/${path}`,
        mediaHref: (path) => `${basePath}${path}`,
    };
}

/** `pathname` with `basePath` taken off the front, or null when it isn't under `basePath`. `''` returns it as is. */
export function stripBasePath(pathname: string, basePath: string): string | null {
    if (basePath === '') return pathname;
    if (pathname === basePath) return '/';
    return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : null;
}
