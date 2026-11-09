import { redirectLocation } from '../site/redirect';

/**
 * The site's hrefs, from a serializable `{ basePath }`: `''` on the public
 * site, `/curation/preview/<draftId>/site` in #16's preview. No `server-only`,
 * and the one import (lib/site/redirect.ts) has none of its own, so client
 * code (components/site/SiteRoutes.tsx) builds the same hrefs from the same
 * `basePath` the server used. reader.ts re-exports it.
 */

/** #6's deep-entry parameter on a series URL (B5): `/work/<slug>?photo=<photoId>` opens the series on that photograph's page. */
export const PHOTO_PARAM = 'photo';

/**
 * #10's photo ID: `ph_` plus a lowercase UUID v4. The same pattern as
 * lib/identity/ids.ts's PHOTO_ID_RE, which client code can't import (it
 * pulls in node:crypto); seriesDeepEntry.test.ts holds the two together.
 */
const PHOTO_ID = /^ph_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The photo ID a `?photo=` value names, or null. Only one string that is a
 * photo ID as it stands counts: an absent, empty, or repeated parameter, or
 * anything else, is null. Nothing is folded, trimmed, or decoded again, so
 * whatever comes back is safe in an element ID, a path segment, or a query.
 */
export function photoParamOf(value: unknown): string | null {
    return typeof value === 'string' && PHOTO_ID.test(value) ? value : null;
}

/** Where a series link puts the visitor: on `focusPhotoId`'s entry, through `?photo=` (B5). */
export interface SeriesHrefOptions {
    focusPhotoId?: string | null;
}

export interface RouteBuilder {
    readonly basePath: string;
    homeHref(): string;
    workHref(): string;
    aboutHref(): string;
    /** The series page, or with `focusPhotoId` the page that holds that photograph, focused on it (`?photo=`). */
    seriesHref(slug: string, options?: SeriesHrefOptions): string;
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
        seriesHref: (slug, { focusPhotoId = null } = {}) => {
            const path = `${basePath}/work/${segment(slug)}`;
            const photoId = photoParamOf(focusPhotoId);
            return photoId === null ? path : redirectLocation(path, { [PHOTO_PARAM]: photoId });
        },
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
