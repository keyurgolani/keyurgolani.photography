import { NextResponse, type NextRequest } from 'next/server';
import {
    CURATOR_FRAME_POLICY,
    CURATOR_RESPONSE_HEADERS,
    evaluateCuratorRequest,
    isCurationEnabled,
    isCuratorPath,
    isLoginRequest,
    LOGIN_PAGE,
} from './lib/curation/auth/policy';
import { hasEncodedSeparator, isUnderPhotos, resolvedPathname } from './utils/privatePaths';

const PLAIN_TEXT = { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };

function notFound(): NextResponse {
    return new NextResponse('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store', ...PLAIN_TEXT } });
}

const DENIAL_TEXT: Record<number, string> = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 421: 'Misdirected Request', 503: 'Service Unavailable' };

/** A refused curator request, with every curator response header. */
function curatorDenial(status: number): NextResponse {
    return new NextResponse(DENIAL_TEXT[status], {
        status,
        headers: { ...CURATOR_RESPONSE_HEADERS, ...CURATOR_FRAME_POLICY, ...PLAIN_TEXT },
    });
}

/**
 * A curator page asked for without a session: on to the login page, with
 * every curator header. Next takes only an absolute Location from a proxy,
 * so it's built on `host`, which has passed the allowlist by now, and never
 * on anything else the request sent. Next sends it on as a relative one when
 * it's the request's own origin.
 */
function toLogin(host: string): NextResponse {
    return new NextResponse(null, {
        status: 307,
        headers: { Location: new URL(LOGIN_PAGE, `http://${host}`).toString(), ...CURATOR_RESPONSE_HEADERS, ...CURATOR_FRAME_POLICY },
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
 * - With `CURATION_ENABLED=true`, every other path needs the curator's
 *   `Host` too (421 otherwise). Only `/_next/static` and `/_next/image`,
 *   outside the matcher, answer any `Host`, with the same bytes as on web.
 * - Every other path takes only GET, HEAD and OPTIONS. Nothing outside the
 *   curator prefixes mutates (the route-inventory test), so a POST there,
 *   such as a server action ID posted to `/`, gets a 404 before Next looks
 *   for the action.
 * - Everything under /assets/photos gets a 404: original sources at any
 *   depth, and the legacy basename derivatives too, since the site serves
 *   photos only from the /media sets the active catalog revision holds.
 */
export function proxy(request: NextRequest): NextResponse {
    const { pathname } = request.nextUrl;
    // next dev decodes these into separators and resolves `..` before it looks for a file.
    if (hasEncodedSeparator(pathname)) return notFound();
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
            if (denial.reason === 'session' && !mutation && page && host) return toLogin(host.toLowerCase());
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
    if (isUnderPhotos(pathname)) return notFound();
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
    ],
};
