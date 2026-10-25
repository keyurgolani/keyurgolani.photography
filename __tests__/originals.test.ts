// @vitest-environment node
import { createRequire } from 'node:module';
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config.mjs';
import { config, proxy } from '../proxy';
import { baseNameOf, getImagePaths, libraryPaths } from '../utils/imageOptimizer';
import { resolvedPathname } from '../utils/privatePaths';

// The function /_next/image uses to check `url` against images.localPatterns. Next ships no types for it.
const { hasLocalMatch } = createRequire(import.meta.url)('next/dist/shared/lib/match-local-pattern') as {
    hasLocalMatch(patterns: unknown, url: string): boolean;
};

function respond(pathname: string) {
    return proxy(new NextRequest(new URL(pathname, 'http://localhost:3000')));
}

const passes = (pathname: string) => respond(pathname).headers.get('x-middleware-next') === '1';

function expectNotFound(pathname: string): void {
    const response = respond(pathname);
    expect(response.status, pathname).toBe(404);
    expect(response.headers.get('x-middleware-next'), pathname).toBeNull();
    expect(response.headers.get('cache-control'), pathname).toBe('no-store');
}

describe('proxy.ts on /assets/photos', () => {
    // The site serves photos only from /media, so the legacy basename URLs close too.
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
        '/assets/photos/Optimized/landscape.webp',
        '/Assets/Photos/optimized/landscape.webp',
    ])('404s the legacy derivative %s', (pathname) => {
        expectNotFound(pathname);
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
        ['a sharp s that folds to ss', '/a%C3%9Fets/photos/landscape.jpg'],
        ['a capital sharp s that folds to ss', '/a%E1%BA%9Eets/photos/landscape.jpg'],
        ['a capital sharp s in a nested path', '/a%E1%BA%9Eets/photos/series/x.jpg'],
        ['a prefix with a character that is neither a letter nor a digit', '/assets/pho%E2%80%8Ctos/landscape.jpg'],
        ['a prefix with punctuation in it', '/as.sets/photos/landscape.jpg'],
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
        expectNotFound(pathname);
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

describe('derivative URLs', () => {
    const outputs = [
        ['thumbnail', 'thumbnails', '.webp'],
        ['medium', 'medium', '.webp'],
        ['optimized', 'optimized', '.webp'],
        ['thumbnailAvif', 'thumbnails-avif', '.avif'],
        ['mediumAvif', 'medium-avif', '.avif'],
        ['optimizedAvif', 'optimized-avif', '.avif'],
        ['lqip', 'lqip', '.txt'],
    ] as const;

    it.each(['50%off.jpg', 'a#b.jpg', 'what?.png', 'IMG 1234 (edited).jpg', 'café.webp', '100% #2.jpg', 'a%2Fb.jpg', 'a%2fb.png', 'a%5Cb.jpg'])(
        'for %s, decode to the file on disk, and 404 at the proxy',
        (name) => {
            const urls = getImagePaths(name, libraryPaths(), new Map());
            const base = baseNameOf(name);
            for (const field of ['original', ...outputs.map(([output]) => output)] as const) expectNotFound(urls[field]);
            for (const [field, folder, extension] of outputs) {
                const url = urls[field];
                // Nothing in the name becomes a query or a fragment.
                expect(new URL(url, 'http://localhost').pathname, url).toBe(url);
                expect(resolvedPathname(url), url).toBe(`/assets/photos/${folder}/${base}${extension}`);
            }
        },
    );
});

describe('outputFileTracingExcludes', () => {
    it('keeps the default data root and the library out of .next/standalone for every route', () => {
        expect(nextConfig.outputFileTracingExcludes?.['*']).toEqual(expect.arrayContaining(['./portfolio-data/**/*', './public/assets/photos/**/*']));
    });
});

describe('images.localPatterns', () => {
    const allows = (url: string) => hasLocalMatch(nextConfig.images?.localPatterns, url);

    it('holds only the two exact portrait paths', () => {
        expect(nextConfig.images?.localPatterns).toEqual([
            { pathname: '/assets/profile/front.png', search: '' },
            { pathname: '/assets/profile/back.png', search: '' },
        ]);
    });

    it('refuses every legacy derivative, every original, and every other public file, so /_next/image answers 400 for one', () => {
        for (const url of [
            '/assets/photos/thumbnails/landscape.webp',
            '/assets/photos/medium/landscape.webp',
            '/assets/photos/optimized/landscape.webp',
            '/assets/photos/thumbnails-avif/landscape.avif',
            '/assets/photos/medium-avif/landscape.avif',
            '/assets/photos/optimized-avif/landscape.avif',
            '/assets/photos/optimized/IMG%201234%20(edited).webp',
            '/Assets/Photos/optimized/landscape.webp',
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

describe('images.localPatterns as Next loads them', () => {
    // At load, Next adds its own static media patterns to the list, for statically imported images.
    const { default: loadConfig } = createRequire(import.meta.url)('next/dist/server/config') as {
        default(phase: string, dir: string, options?: { silent?: boolean }): Promise<{ images: { localPatterns?: unknown } }>;
    };

    it('refuses an encoded path under /assets/photos at /_next/image', async () => {
        const loaded = await loadConfig('phase-production-server', process.cwd(), { silent: true });
        const patterns = loaded.images.localPatterns;
        expect(patterns).toEqual(expect.arrayContaining([
            { pathname: '/assets/profile/front.png', search: '' },
            { pathname: '/assets/profile/back.png', search: '' },
            { pathname: '/_next/static/media/**', search: '' },
        ]));
        // Loading it leaves the module's own list as written.
        expect(nextConfig.images?.localPatterns).toHaveLength(2);
        expect(hasLocalMatch(patterns, '/assets/profile/front.png')).toBe(true);
        for (const url of [
            '/assets/photos/optimized/landscape.webp',
            '/assets/photos/optimized/landscape%2Ewebp',
            '/assets%2Fphotos%2Foptimized%2Flandscape.webp',
            '/assets/photos/landscape.jpg',
        ]) {
            expect(hasLocalMatch(patterns, url), url).toBe(false);
        }
        // For a url under Next's own patterns, /_next/image fetches it internally, so the proxy
        // has to run on that fetch and refuse anything that encodes its way out of the folder.
        for (const url of [
            '/_next/static/media/..%2F..%2F..%2Fassets%2Fphotos%2Foptimized%2Flandscape.webp',
            '/_next/static/media/..%5C..%5C..%5Cassets%5Cphotos%5Coptimized%5Clandscape.webp',
            '/_next/static/immutable/media/..%2F..%2F..%2F..%2Fassets%2Fphotos%2Flandscape.jpg',
        ]) {
            expect(unstable_doesMiddlewareMatch({ config, url }), url).toBe(true);
            expectNotFound(url);
        }
    });
});
