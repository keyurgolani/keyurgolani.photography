// @vitest-environment node
import { createRequire } from 'node:module';
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config.mjs';
import { config, proxy } from '../proxy';
import { resolvedPathname } from '../utils/publicDerivatives';

// The function /_next/image uses to check `url` against images.localPatterns. Next ships no types for it.
const { hasLocalMatch } = createRequire(import.meta.url)('next/dist/shared/lib/match-local-pattern') as {
    hasLocalMatch(patterns: unknown, url: string): boolean;
};

function respond(pathname: string) {
    return proxy(new NextRequest(new URL(pathname, 'http://localhost:3000')));
}

const passes = (pathname: string) => respond(pathname).headers.get('x-middleware-next') === '1';

describe('proxy.ts on /assets/photos', () => {
    it.each([
        '/assets/photos/thumbnails/landscape.webp',
        '/assets/photos/medium/landscape.webp',
        '/assets/photos/optimized/landscape.webp',
        '/assets/photos/thumbnails-avif/landscape.avif',
        '/assets/photos/medium-avif/landscape.avif',
        '/assets/photos/optimized-avif/landscape.avif',
        '/assets/photos/lqip/landscape.txt',
        '/assets/photos/optimized/IMG%201234%20(edited).webp',
        '/assets/photos/optimized/caf%C3%A9.webp',
        '/assets/photos/optimized/50%25off.webp',
    ])('passes the legacy derivative %s', (pathname) => {
        expect(passes(pathname)).toBe(true);
    });

    it.each([
        ['a plain original', '/assets/photos/landscape.jpg'],
        ['an uppercase original', '/assets/photos/IMG_0001.JPG'],
        ['a PNG original', '/assets/photos/portrait.png'],
        ['a WebP original', '/assets/photos/square.webp'],
        ['an original with an encoded dot', '/assets/photos/landscape%2Ejpg'],
        ['an original with an encoded letter', '/assets/photos/%6Candscape.jpg'],
        ['an original behind an encoded slash', '/assets/photos%2Flandscape.jpg'],
        ['a nested original', '/assets/photos/series/x.jpg'],
        ['a nested original behind an encoded slash', '/assets/photos/series%2Fx.jpg'],
        ['a deeply nested original', '/assets/photos/2024/trip/day-1/x.jpeg'],
        ['a nested file in a derivative-named folder', '/assets/photos/series/thumbnails/x.webp'],
        ['a nested derivative', '/assets/photos/optimized/sub/x.webp'],
        ['the cache folder', '/assets/photos/cache/x.webp'],
        ['the dynamic cache', '/assets/photos/cache/dynamic/x-400-75.webp'],
        ['README.md', '/assets/photos/README.md'],
        ['.gitkeep', '/assets/photos/.gitkeep'],
        ['a write in progress', '/assets/photos/thumbnails/.landscape.4242.0a1b2c3d.tmp'],
        ['macOS metadata', '/assets/photos/thumbnails/._landscape.webp'],
        ['an original under a derivative folder', '/assets/photos/thumbnails/landscape.jpg'],
        ['AVIF in a WebP folder', '/assets/photos/thumbnails/landscape.avif'],
        ['WebP in an AVIF folder', '/assets/photos/thumbnails-avif/landscape.webp'],
        ['an image in the LQIP folder', '/assets/photos/lqip/landscape.webp'],
        ['an encoded traversal', '/assets/photos/optimized/..%2F..%2Flandscape.jpg'],
        ['an encoded dot-dot segment', '/assets/photos/optimized/%2e%2e/landscape.jpg'],
        ['a bare extension', '/assets/photos/optimized/.webp'],
        ['a trailing slash', '/assets/photos/optimized/landscape.webp/'],
        ['a folder', '/assets/photos/optimized/'],
        ['the root', '/assets/photos'],
        ['an original with a literal %', '/assets/photos/50%off.jpg'],
        // Next answers 500 for a path that doesn't decode, so the proxy 404s it first.
        ['a derivative path that does not decode', '/assets/photos/optimized/50%off.webp'],
        ['a capitalized prefix', '/Assets/photos/landscape.jpg'],
        ['a capitalized folder', '/assets/Photos/series/x.jpg'],
        ['an uppercase prefix', '/ASSETS/PHOTOS/landscape.jpg'],
        ['an encoded prefix letter', '/assets/photo%73/landscape.jpg'],
        ['a long s that folds to s', '/assets/photo%C5%BF/landscape.jpg'],
        ['a derivative under a capitalized prefix', '/Assets/photos/optimized/landscape.webp'],
        ['an encoded traversal from a sibling folder', '/assets/profile/..%2Fphotos%2Flandscape.jpg'],
        ['a lowercase encoded traversal from a sibling folder', '/assets/profile/..%2fphotos%2flandscape.jpg'],
        ['an encoded backslash traversal from a sibling folder', '/assets/profile/..%5Cphotos%5Clandscape.jpg'],
        ['an encoded traversal from another top-level folder', '/foo/..%2Fassets%2Fphotos%2Flandscape.jpg'],
        ["an encoded traversal from Next's static folder", '/_next/static/..%2F..%2Fassets/photos/landscape.jpg'],
        ['a dot-dot traversal from a sibling folder', '/assets/profile/../photos/landscape.jpg'],
        ['an encoded dot-dot segment in a sibling folder', '/assets/profile/%2e%2e/photos/landscape.jpg'],
        ['a nested original reached through a sibling folder', '/assets/profile/%2E%2E/photos/series/x.jpg'],
        ['an encoded slash outside /assets/photos', '/gallery%2Fx'],
    ])('404s %s', (_label, pathname) => {
        const response = respond(pathname);
        expect(response.status).toBe(404);
        expect(response.headers.get('x-middleware-next')).toBeNull();
        expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it.each([
        '/', '/gallery', '/about', '/api/photos', '/assets/profile/front.png', '/favicon.ico', '/assets/photosets/x.jpg',
        '/assets/photos/../profile/front.png', '/_next/static/chunks/%5Broot-of-the-server%5D__0a1b2c._.js',
    ])('passes %s, outside /assets/photos', (pathname) => {
        expect(passes(pathname)).toBe(true);
    });

    it('resolves a pathname the way next dev does before it looks for a file', () => {
        expect(resolvedPathname('/assets//photos/./optimized/../x.jpg')).toBe('/assets/photos/x.jpg');
        expect(resolvedPathname('/../../assets/photos')).toBe('/assets/photos');
        expect(resolvedPathname('/assets/profile/..%5Cphotos%5Cx.jpg')).toBe('/assets/photos/x.jpg');
        expect(resolvedPathname('/assets/photos/50%off.jpg')).toBe('/assets/photos/50%off.jpg');
    });

    it("runs on every request but Next's own assets, and on those too once they carry a percent sign", () => {
        const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });
        for (const url of [
            '/', '/gallery', '/api/photos', '/assets/photos', '/assets/photos/series/x.jpg', '/Assets/Photos/x.jpg', '/assets/profile/front.png',
            '/_next/static/..%2F..%2Fassets/photos/x.jpg', '/_next/static/chunks/%5Broot%5D.js', '/_next/image%2F..%2F..%2Fassets/photos/x.jpg',
        ]) {
            expect(matches(url), url).toBe(true);
        }
        for (const url of ['/_next/static/chunks/main.js', '/_next/image?url=%2Fassets%2Fphotos%2Fx.jpg&w=400&q=75']) {
            expect(matches(url), url).toBe(false);
        }
    });
});

describe('outputFileTracingExcludes', () => {
    it('keeps the default data root and the library out of .next/standalone for every route', () => {
        expect(nextConfig.outputFileTracingExcludes?.['*']).toEqual(expect.arrayContaining(['./portfolio-data/**/*', './public/assets/photos/**/*']));
    });
});

describe('images.localPatterns', () => {
    const allows = (url: string) => hasLocalMatch(nextConfig.images?.localPatterns, url);

    it('lets /_next/image optimize the legacy derivatives', () => {
        for (const url of [
            '/assets/photos/thumbnails/landscape.webp',
            '/assets/photos/medium/landscape.webp',
            '/assets/photos/optimized/landscape.webp',
            '/assets/photos/thumbnails-avif/landscape.avif',
            '/assets/photos/medium-avif/landscape.avif',
            '/assets/photos/optimized-avif/landscape.avif',
        ]) {
            expect(allows(url), url).toBe(true);
        }
    });

    it('refuses every original and every other public file, so /_next/image answers 400 for one', () => {
        for (const url of [
            '/assets/photos/series/x.jpg',
            '/assets/photos/landscape.jpg',
            '/assets/photos/portrait.png',
            '/assets/photos/square.webp',
            '/assets/photos/optimized/landscape.jpg',
            '/assets/photos/optimized/sub/landscape.webp',
            '/assets/photos/optimized/..%2Flandscape.jpg',
            '/assets/photos/lqip/landscape.txt',
            '/assets/photos/optimized/landscape.webp?v=2',
            '/public/assets/photos/landscape.jpg',
            '/assets/profile/..%2Fphotos%2Flandscape.jpg',
            '/favicon.ico',
        ]) {
            expect(allows(url), url).toBe(false);
        }
    });

    it('lets /_next/image optimize the two profile portraits by their exact paths only', () => {
        expect(allows('/assets/profile/front.png')).toBe(true);
        expect(allows('/assets/profile/back.png')).toBe(true);
        for (const url of [
            '/assets/profile/front.png?v=2',
            '/assets/profile/Front.png',
            '/assets/profile/side.png',
            '/assets/profile/front.png%2F..%2F..%2Fphotos%2Flandscape.jpg',
            '/assets/profile/front.png/../../photos/landscape.jpg',
            '/assets/profile/%2E%2E/photos/landscape.jpg',
        ]) {
            expect(allows(url), url).toBe(false);
        }
    });
});
