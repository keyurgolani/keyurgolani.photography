import { NextResponse, type NextRequest } from 'next/server';
import { hasEncodedSeparator, isPublicDerivativePath, isUnderPhotos } from './utils/publicDerivatives';

function notFound(): NextResponse {
    return new NextResponse('Not Found', {
        status: 404,
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
    });
}

/**
 * Keeps original photos private. Under /assets/photos only the legacy
 * derivatives pass: top-level files in thumbnails, medium, and optimized
 * (.webp), their -avif twins (.avif), and lqip (.txt). Everything else,
 * including source files at any depth, gets a 404, and so does any path
 * that encodes a slash or a backslash. Other paths pass through.
 */
export function proxy(request: NextRequest): NextResponse {
    const { pathname } = request.nextUrl;
    // next dev decodes these into separators and resolves `..` before it looks for a file.
    if (hasEncodedSeparator(pathname)) return notFound();
    if (!isUnderPhotos(pathname) || isPublicDerivativePath(pathname)) return NextResponse.next();
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
    ],
};
