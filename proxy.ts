import { NextResponse, type NextRequest } from 'next/server';
import { decodePathname, isPublicDerivativePath, isUnderPhotos } from './utils/publicDerivatives';

/**
 * Keeps original photos private. Under /assets/photos only the legacy
 * derivatives pass: top-level files in thumbnails, medium, and optimized
 * (.webp), their -avif twins (.avif), and lqip (.txt). Everything else,
 * including source files at any depth, gets a 404. Other paths pass through.
 */
export function proxy(request: NextRequest): NextResponse {
    const { pathname } = request.nextUrl;
    if (!isUnderPhotos(decodePathname(pathname)) || isPublicDerivativePath(pathname)) return NextResponse.next();
    return new NextResponse('Not Found', {
        status: 404,
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
    });
}

export const config = {
    // Wider than /assets/photos/:path*, which is case-sensitive: on a case-insensitive
    // disk, next dev would serve /Assets/photos/x.jpg straight from the library.
    matcher: ['/((?!_next/static/|_next/image).*)'],
};
