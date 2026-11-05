import { NextResponse, type NextRequest } from 'next/server';
import {
    CURATOR_FRAME_POLICY,
    CURATOR_RESPONSE_HEADERS,
    evaluateCuratorRequest,
    isCurationEnabled,
    isCuratorPath,
    isLoginRequest,
    loginRedirectPath,
    redirectScheme,
} from './lib/curation/auth/policy';
import { UNAVAILABLE_HEADERS, UNAVAILABLE_HTML } from './lib/curation/auth/unavailable';
import { hasEncodedSeparator, isUnderPhotos, resolvedPathname } from './utils/publicDerivatives';

/** The body Next's /_next/image sends for a `url` images.localPatterns doesn't allow. */
export const IMAGE_URL_NOT_ALLOWED = '"url" parameter is not allowed';

const PLAIN_TEXT = { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };

function notFound(): NextResponse {
    return new NextResponse('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store', ...PLAIN_TEXT } });
}

/** /_next/image's own answer for a url it doesn't allow, with nothing cached. */
function imageRefused(): NextResponse {
    return new NextResponse(IMAGE_URL_NOT_ALLOWED, { status: 400, headers: { 'Cache-Control': 'no-store', ...PLAIN_TEXT } });
}

/**
 * Where the legacy archive went. #13's slice E removed the legacy Gallery,
 * and /gallery answers a bare 308 to Work in every state, whatever the data
 * root holds, so a bookmark or a search result still lands on the photographs.
 */
export const GALLERY_PATH = '/gallery';
const GALLERY_TO = '/work';

/**
 * The 308 for /gallery. Next takes only an absolute Location from a proxy,
 * so it's built on the request's own origin, and Next sends it on as the
 * relative `/work`. Nothing from the query goes with it. It's `no-store`, so
 * neither a browser nor Cloudflare keeps it: a release before #13's slice E
 * sends /work back to /gallery with a 307 on a data root without the launch,
 * and a kept 308 would loop against that after a rollback.
 */
function galleryMoved(request: NextRequest): NextResponse {
    const response = NextResponse.redirect(new URL(GALLERY_TO, request.nextUrl.origin), 308);
    response.headers.set('Cache-Control', 'no-store');
    return response;
}

/**
 * Whether a /_next/image `url` reaches /assets/photos, the way the image
 * optimizer would fetch it. One that doesn't parse counts, the safe side.
 */
function reachesPhotos(url: string): boolean {
    let pathname: string;
    try {
        pathname = new URL(url, 'http://n').pathname;
    } catch {
        return true;
    }
    return hasEncodedSeparator(pathname) || isUnderPhotos(pathname);
}

const DENIAL_TEXT: Record<number, string> = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 421: 'Misdirected Request' };

/**
 * A refused curator request, with every curator response header. A 503,
 * the curator's setup incomplete, is the one fixed page in
 * lib/curation/auth/unavailable.ts, the same on every path and method.
 */
function curatorDenial(status: number): NextResponse {
    if (status === 503) return new NextResponse(UNAVAILABLE_HTML, { status, headers: UNAVAILABLE_HEADERS });
    return new NextResponse(DENIAL_TEXT[status], {
        status,
        headers: { ...CURATOR_RESPONSE_HEADERS, ...CURATOR_FRAME_POLICY, ...PLAIN_TEXT },
    });
}

/**
 * A curator page asked for without a session: on to the login page, with
 * every curator header, and `?ended=1` when the request sent a session
 * cookie that no longer counts (loginRedirectPath()). Next takes only an
 * absolute Location from a proxy, so it's built on `host`, which has passed
 * the allowlist by now, and on `scheme`, `https` only behind a TLS proxy on
 * a LAN-mode name (redirectScheme()), and never on anything else the request
 * sent. Next sends it on as a relative one when it's the request's own origin.
 */
function toLogin(host: string, scheme: 'http' | 'https', cookie: string | null): NextResponse {
    return new NextResponse(null, {
        status: 307,
        headers: { Location: new URL(loginRedirectPath(cookie), `${scheme}://${host}`).toString(), ...CURATOR_RESPONSE_HEADERS, ...CURATOR_FRAME_POLICY },
    });
}

/**
 * The series page and the Viewer: `/work/<slug>` and `/work/<slug>/photo/<photoId>`, one segment each, whatever their
 * case. Their 308s (#5, #7) follow the active revision, so a rollback can undo one.
 */
const SERIES_PAGE_RE = /^\/work\/[^/]+(?:\/photo\/[^/]+)?$/;

/**
 * Their Cache-Control, set here rather than left to force-dynamic, as /gallery's is: a later `revalidate` or PPR
 * would change Next's own header without a word, and a kept 308 would outlive the revision that sent it. Next keeps a
 * Cache-Control the proxy set (its page handler writes one only when none is there), on the 200 and the redirect
 * alike. It's the value Next gives a dynamic page, so a 200 reads as it did.
 */
export const SERIES_CACHE_CONTROL = 'private, no-cache, no-store, max-age=0, must-revalidate';

/** Methods that only read. Anything else can reach a server action or a mutating handler. */
const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * Keeps original photos private, the curator behind its boundary, and every
 * other path read-only.
 *
 * - Any path that encodes a slash or a backslash gets a 404.
 * - `/curation/**` and `/api/curation/**` get a 404 while `CURATION_ENABLED`
 *   isn't exactly `true`, read on every request. With it on, they pass only
 *   the checks in lib/curation/auth/policy.ts (the bind and the secret
 *   files, `Host`, `Origin` on a mutation, and a live session), and each
 *   page, handler and action runs requireCurator() again. Without a session,
 *   a page, or its RSC payload, is sent to `/curation/login`, and a route
 *   handler or a server action gets 401. Only a read of `/curation/login` and
 *   a POST to `/api/curation/login` skip the session.
 * - `/_next/image` is checked only for its `url`: it refuses one that
 *   reaches /assets/photos with a 400 before its own cache can answer.
 *   Otherwise it passes, for images.localPatterns to decide.
 * - With `CURATION_ENABLED=true`, every other path needs the curator's
 *   `Host` too (421 otherwise). Only `/_next/static`, outside the matcher,
 *   and `/_next/image` answer any `Host`, with the same bytes as on web.
 * - Every other path takes only GET, HEAD and OPTIONS. Nothing outside the
 *   curator prefixes mutates (the route-inventory test), so a POST there,
 *   such as a server action ID posted to `/`, gets a 404 before Next looks
 *   for the action.
 * - `/gallery` gets a 308 to `/work` (galleryMoved()), behind the two checks
 *   above, so the curator process answers it only on the curator's `Host`.
 * - The series and Viewer pages pass with SERIES_CACHE_CONTROL, so their
 *   308s are never stored.
 * - Everything under /assets/photos gets a 404, at any depth: the original
 *   sources, and the legacy basename derivatives the watcher writes until
 *   the second PR of #13's slice E stops them. Photos serve only from the
 *   /media sets the served revision holds. None of this reads the data root.
 */
export function proxy(request: NextRequest): NextResponse {
    const { pathname, searchParams } = request.nextUrl;
    // next dev decodes these into separators and resolves `..` before it looks for a file.
    if (hasEncodedSeparator(pathname)) return notFound();
    if (pathname === '/_next/image') {
        if (searchParams.getAll('url').some(reachesPhotos)) return imageRefused();
        return NextResponse.next();
    }
    const method = request.method.toUpperCase();
    if (isCuratorPath(pathname)) {
        const action = request.headers.has('next-action');
        const mutation = !READ_METHODS.has(method) || action;
        const denial = evaluateCuratorRequest(
            {
                host: request.headers.get('host'),
                origin: request.headers.get('origin'),
                forwardedHost: request.headers.get('x-forwarded-host'),
                forwardedProto: request.headers.get('x-forwarded-proto'),
                mutation,
                session: isLoginRequest(pathname, method, action) ? 'not-checked' : { cookie: request.headers.get('cookie') },
            },
            process.env,
            process.argv,
        );
        if (denial !== null) {
            // Next hides the RSC headers from the proxy, so a page's RSC fetch is sent to the login like the page itself.
            const page = !resolvedPathname(pathname).toLowerCase().startsWith('/api');
            const host = request.headers.get('host');
            if (denial.reason === 'session' && !mutation && page && host) {
                const scheme = redirectScheme({ host, forwardedProto: request.headers.get('x-forwarded-proto') }, process.env);
                return toLogin(host.toLowerCase(), scheme, request.headers.get('cookie'));
            }
            return curatorDenial(denial.status);
        }
        const response = NextResponse.next();
        for (const [name, value] of Object.entries(CURATOR_RESPONSE_HEADERS)) response.headers.set(name, value);
        return response;
    }
    // On the curator process, the public paths answer only the curator's
    // Host too, so nothing it serves differs by Host from what the tunnel sees.
    if (isCurationEnabled(process.env)) {
        const denial = evaluateCuratorRequest(
            {
                host: request.headers.get('host'),
                origin: null,
                forwardedHost: request.headers.get('x-forwarded-host'),
                forwardedProto: request.headers.get('x-forwarded-proto'),
                mutation: false,
                session: 'not-checked',
            },
            process.env,
            process.argv,
        );
        if (denial !== null) return curatorDenial(denial.status);
    }
    if (!READ_METHODS.has(method) && method !== 'OPTIONS') return notFound();
    if (pathname === GALLERY_PATH && READ_METHODS.has(method)) return galleryMoved(request);
    if (isUnderPhotos(pathname)) return notFound();
    if (SERIES_PAGE_RE.test(pathname) && READ_METHODS.has(method)) {
        const response = NextResponse.next();
        response.headers.set('Cache-Control', SERIES_CACHE_CONTROL);
        return response;
    }
    return NextResponse.next();
}

export const config = {
    matcher: [
        // Wider than /assets/photos/:path*, which is case-sensitive: on a case-insensitive
        // disk, next dev would serve /Assets/photos/x.jpg straight from the library.
        '/((?!_next/static/|_next/image).*)',
        // Next's own paths too, once they carry a percent sign, since next dev
        // resolves an encoded `..` in them before it looks for a file.
        '/_next/(.*%.*)',
        // The image optimizer, which serves from its own cache before it fetches the url.
        '/_next/image',
    ],
};
