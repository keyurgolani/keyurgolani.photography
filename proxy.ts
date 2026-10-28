import fs from 'node:fs';
import { NextResponse, type NextRequest } from 'next/server';
import { catalogMode } from './lib/catalog/mode';
import {
    CURATOR_FRAME_POLICY,
    CURATOR_RESPONSE_HEADERS,
    evaluateCuratorRequest,
    isCurationEnabled,
    isCuratorPath,
    isLoginRequest,
    loginRedirectPath,
} from './lib/curation/auth/policy';
import { UNAVAILABLE_HEADERS, UNAVAILABLE_HTML } from './lib/curation/auth/unavailable';
import { dataRoot } from './lib/storage/config';
import { hasEncodedSeparator, isPublicDerivativePath, isUnderPhotos, resolvedPathname } from './utils/publicDerivatives';

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

/** Whether `root` is a folder that's there. Anything that stops the check counts as not there. */
async function isFolder(root: string): Promise<boolean> {
    try {
        return (await fs.promises.stat(/*turbopackIgnore: true*/ root)).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Whether the legacy derivatives still serve: only in legacy mode, before
 * the first catalog revision goes live. It's the check /api/ready reports,
 * made per request, so the launch publish closes them with no restart. That
 * check remembers a cutover for as long as the process runs, in every bundle
 * of it, and answers `catalog` while the data root can't be read, so this
 * fails closed. With no data root configured, or no folder at its path, they
 * don't serve either: the photo list answers 503 there already, so nothing
 * a visitor sees loads them. An existing root that isn't initialized yet,
 * empty included, is legacy mode and serves them.
 */
async function servesLegacy(): Promise<boolean> {
    const root = dataRoot();
    if (root === null) return false;
    // The mode first: a launched root swapped for a file or for nothing between the two reads is then
    // caught either way, by the folder check after a legacy answer, or by the mode latching catalog.
    return (await catalogMode(root)) === 'legacy' && (await isFolder(root));
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
 * the allowlist by now, and never on anything else the request sent. Next
 * sends it on as a relative one when it's the request's own origin.
 */
function toLogin(host: string, cookie: string | null): NextResponse {
    return new NextResponse(null, {
        status: 307,
        headers: { Location: new URL(loginRedirectPath(cookie), `http://${host}`).toString(), ...CURATOR_RESPONSE_HEADERS, ...CURATOR_FRAME_POLICY },
    });
}

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
 * - `/_next/image` is checked only for its `url`: unless the legacy
 *   derivatives serve, it refuses one that reaches /assets/photos with a 400
 *   before its own cache can answer. Otherwise it passes.
 * - With `CURATION_ENABLED=true`, every other path needs the curator's
 *   `Host` too (421 otherwise). Only `/_next/static`, outside the matcher,
 *   and `/_next/image` answer any `Host`, with the same bytes as on web.
 * - Every other path takes only GET, HEAD and OPTIONS. Nothing outside the
 *   curator prefixes mutates (the route-inventory test), so a POST there,
 *   such as a server action ID posted to `/`, gets a 404 before Next looks
 *   for the action.
 * - Under /assets/photos, original sources get a 404 at any depth. The
 *   legacy derivatives (top-level files in thumbnails, medium, and optimized
 *   as .webp, their -avif twins as .avif, and lqip as .txt) serve in legacy
 *   mode only, on a data root that's there, since the legacy pages load
 *   them. Once a catalog revision is live, photos serve only from the /media
 *   sets it holds, so everything under /assets/photos gets a 404.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
    const { pathname, searchParams } = request.nextUrl;
    // next dev decodes these into separators and resolves `..` before it looks for a file.
    if (hasEncodedSeparator(pathname)) return notFound();
    if (pathname === '/_next/image') {
        if (searchParams.getAll('url').some(reachesPhotos) && !(await servesLegacy())) return imageRefused();
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
            if (denial.reason === 'session' && !mutation && page && host) return toLogin(host.toLowerCase(), request.headers.get('cookie'));
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
            { host: request.headers.get('host'), origin: null, forwardedHost: request.headers.get('x-forwarded-host'), mutation: false, session: 'not-checked' },
            process.env,
            process.argv,
        );
        if (denial !== null) return curatorDenial(denial.status);
    }
    if (!READ_METHODS.has(method) && method !== 'OPTIONS') return notFound();
    if (!isUnderPhotos(pathname)) return NextResponse.next();
    if (isPublicDerivativePath(pathname) && (await servesLegacy())) return NextResponse.next();
    return notFound();
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
