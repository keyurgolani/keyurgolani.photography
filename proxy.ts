import { NextResponse, type NextRequest } from 'next/server';
import { hasEncodedSeparator, isUnderPhotos } from './utils/privatePaths';

function notFound(): NextResponse {
    return new NextResponse('Not Found', {
        status: 404,
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
    });
}

/**
 * Keeps the photo library private. Everything under /assets/photos gets a
 * 404: original sources at any depth, and the legacy basename derivatives
 * too, since the site serves photos only from the /media sets the active
 * catalog revision holds. So does any path that encodes a slash or a
 * backslash. Other paths pass through.
 */
export function proxy(request: NextRequest): NextResponse {
    const { pathname } = request.nextUrl;
    // next dev decodes these into separators and resolves `..` before it looks for a file.
    if (hasEncodedSeparator(pathname) || isUnderPhotos(pathname)) return notFound();
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
