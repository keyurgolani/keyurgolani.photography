// @vitest-environment node
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { VARIANT_BYTES } from '../lib/catalog/__tests__/catalogFixtures';
import { publish } from '../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../lib/catalog/testing';
import nextConfig from '../next.config.mjs';
import { config, IMAGE_URL_NOT_ALLOWED, proxy } from '../proxy';
import { getImagePaths, libraryPaths } from '../utils/imageOptimizer';
import { resolvedPathname } from '../utils/publicDerivatives';

// The function /_next/image uses to check `url` against images.localPatterns. Next ships no types for it.
const { hasLocalMatch } = createRequire(import.meta.url)('next/dist/shared/lib/match-local-pattern') as {
    hasLocalMatch(patterns: unknown, url: string): boolean;
};

function respond(pathname: string, method = 'GET') {
    return proxy(new NextRequest(new URL(pathname, 'http://localhost:3000'), { method }));
}

const passes = async (pathname: string) => (await respond(pathname)).headers.get('x-middleware-next') === '1';

async function expectNotFound(pathname: string): Promise<void> {
    const response = await respond(pathname);
    expect(response.status, pathname).toBe(404);
    expect(response.headers.get('x-middleware-next'), pathname).toBeNull();
    expect(response.headers.get('cache-control'), pathname).toBe('no-store');
}

/** /_next/image for `url`, as next/image asks for it. */
const imageUrl = (url: string) => `/_next/image?url=${encodeURIComponent(url)}&w=400&q=75`;

/** The proxy answers /_next/image's own 400 for this url, with nothing cached. */
async function expectImageRefused(url: string): Promise<void> {
    const response = await respond(url);
    expect(response.status, url).toBe(400);
    expect(response.headers.get('x-middleware-next'), url).toBeNull();
    expect(response.headers.get('cache-control'), url).toBe('no-store');
    expect(await response.text(), url).toBe(IMAGE_URL_NOT_ALLOWED);
}

/**
 * /gallery, and its query, answer a bare 308 to /work for a read, with
 * nothing cached: a browser or Cloudflare that kept the 308 would loop
 * against an older release's /work 307 to /gallery after a rollback.
 */
async function expectGalleryMoved(): Promise<void> {
    for (const [pathname, method] of [['/gallery', 'GET'], ['/gallery', 'HEAD'], ['/gallery?photo=3', 'GET']] as const) {
        const response = await respond(pathname, method);
        expect(response.status, `${method} ${pathname}`).toBe(308);
        expect(response.headers.get('location'), `${method} ${pathname}`).toBe('http://localhost:3000/work');
        expect(response.headers.get('x-middleware-next'), `${method} ${pathname}`).toBeNull();
        expect(response.headers.get('cache-control'), `${method} ${pathname}`).toBe('no-store');
    }
}

const temps: string[] = [];
const catalogs: TestCatalog[] = [];

/** An empty data root, as a host has before the migration. */
function emptyRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-empty-'));
    temps.push(root);
    return root;
}

/** A test catalog's data root, published or not yet. */
async function testCatalog(seed: number): Promise<TestCatalog> {
    const catalog = await createTestCatalog({ variantBytes: VARIANT_BYTES, seed });
    catalogs.push(catalog);
    return catalog;
}

async function launch(root: string): Promise<void> {
    const result = await publish({ dataRoot: root, actor: 'test', confirmLaunch: true, logger: { log: () => undefined } });
    expect(result.outcome, result.message).toBe('PUBLISHED');
}

afterAll(async () => {
    vi.unstubAllEnvs();
    for (const catalog of catalogs.splice(0)) await catalog.cleanup();
    for (const root of temps.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** The legacy basename derivative paths the removed legacy pages loaded, directly and through /_next/image. */
const DERIVATIVES = [
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
];

/** Paths under /assets/photos, and encoded ones anywhere, that never serve. */
const PRIVATE: [string, string][] = [
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
        ['an encoded traversal from a sibling folder', '/assets/sibling/..%2Fphotos%2Flandscape.jpg'],
        ['a lowercase encoded traversal from a sibling folder', '/assets/sibling/..%2fphotos%2flandscape.jpg'],
        ['an encoded backslash traversal from a sibling folder', '/assets/sibling/..%5Cphotos%5Clandscape.jpg'],
        ['an encoded traversal from another top-level folder', '/foo/..%2Fassets%2Fphotos%2Flandscape.jpg'],
        ["an encoded traversal from Next's static folder", '/_next/static/..%2F..%2Fassets/photos/landscape.jpg'],
        ['a dot-dot traversal from a sibling folder', '/assets/sibling/../photos/landscape.jpg'],
        ['an encoded dot-dot segment in a sibling folder', '/assets/sibling/%2e%2e/photos/landscape.jpg'],
        ['a nested original reached through a sibling folder', '/assets/sibling/%2E%2E/photos/series/x.jpg'],
        ['an encoded slash outside /assets/photos', '/gallery%2Fx'],
];

/** Paths outside /assets/photos, which pass whatever the data root holds. /gallery is the one that moved. */
const OUTSIDE = [
    '/', '/work', '/about', '/api/photos', '/api/ready', '/assets/sibling/x.png', '/favicon.ico', '/assets/photosets/x.jpg',
    '/assets/photos/../sibling/x.png', '/galleryx', '/gallery/x', '/Gallery', '/_next/static/chunks/%5Broot-of-the-server%5D__0a1b2c._.js',
];

/** Every url under /assets/photos that /_next/image is refused, however it's spelled. */
const IMAGE_URLS = [
    ...DERIVATIVES.filter((pathname) => !pathname.endsWith('.txt')).map((pathname) => decodeURIComponent(pathname)),
    '/assets/photos/landscape.jpg',
    '/assets/photos/optimized/landscape%2Ewebp',
    '/assets%2Fphotos%2Foptimized%2Flandscape.webp',
    '/assets/sibling/../photos/optimized/landscape.webp',
    '\\assets\\photos\\optimized\\landscape.webp',
    '/_next/static/media/..%2F..%2F..%2Fassets%2Fphotos%2Foptimized%2Flandscape.webp',
    'http://localhost:3000/assets/photos/optimized/landscape.webp',
];

/**
 * The data roots a server can start on. Since #13's slice E the legacy
 * derivatives never serve, so each gives the same answers: there is no
 * mode to switch on, and nothing to fall back to.
 */
const STATES: [string, () => Promise<void>][] = [
    ['with no data root, as in production with PHOTOGRAPHY_DATA_DIR unset', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', '');
    }],
    ['on an empty data root, as on a host before the migration', async () => {
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', emptyRoot());
    }],
    ['while nothing is at the data root\'s path', async () => {
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', path.join(emptyRoot(), 'missing'));
    }],
    ['on a data root with authored records and nothing published yet', async () => {
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', (await testCatalog(32)).root);
    }],
    ['once a revision is live', async () => {
        const catalog = await testCatalog(31);
        await launch(catalog.root);
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', catalog.root);
    }],
];

describe.each(STATES)('proxy.ts %s', { timeout: 60_000 }, (_label, enter) => {
    const nodeEnv = process.env.NODE_ENV;

    beforeAll(async () => {
        await enter();
    });

    afterAll(() => {
        vi.stubEnv('NODE_ENV', nodeEnv);
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', '');
    });

    it.each(DERIVATIVES)('404s the legacy derivative %s', async (pathname) => {
        await expectNotFound(pathname);
    });

    it.each(PRIVATE)('404s %s', async (_label, pathname) => {
        await expectNotFound(pathname);
    });

    it.each(OUTSIDE)('passes %s, outside /assets/photos', async (pathname) => {
        expect(await passes(pathname)).toBe(true);
    });

    it('refuses every url under /assets/photos at /_next/image, before its cache can answer', async () => {
        for (const url of IMAGE_URLS) await expectImageRefused(imageUrl(url));
        // Every `url` counts, not only the first.
        await expectImageRefused(`/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Fa.png&url=${encodeURIComponent('/assets/photos/optimized/landscape.webp')}&w=400&q=75`);
    });

    it("passes /_next/image for a url outside /assets/photos, which Next's own patterns decide", async () => {
        expect(await passes(imageUrl('/_next/static/media/front.0a1b2c3d.png'))).toBe(true);
        expect(await passes('/_next/image?w=400&q=75')).toBe(true);
    });

    it('sends /gallery on to /work with a 308, and refuses any other method there', async () => {
        await expectGalleryMoved();
        for (const method of ['POST', 'PUT', 'DELETE']) expect((await respond('/gallery', method)).status, method).toBe(404);
    });
});

describe('proxy.ts and the data root', () => {
    it('answers /assets/photos, /_next/image and /gallery without reading it', async () => {
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', emptyRoot());
        const reads = [vi.spyOn(fs.promises, 'stat'), vi.spyOn(fs.promises, 'readdir'), vi.spyOn(fs.promises, 'readFile'), vi.spyOn(fs, 'statSync')];
        try {
            await expectNotFound('/assets/photos/thumbnails/landscape.webp');
            await expectImageRefused(imageUrl('/assets/photos/thumbnails/landscape.webp'));
            await expectGalleryMoved();
            for (const spy of reads) expect(spy).not.toHaveBeenCalled();
        } finally {
            for (const spy of reads) spy.mockRestore();
            vi.stubEnv('PHOTOGRAPHY_DATA_DIR', '');
        }
    });
});

describe('proxy.ts paths and matcher', () => {
    it('resolves a pathname the way next dev does before it looks for a file', () => {
        expect(resolvedPathname('/assets//photos/./optimized/../x.jpg')).toBe('/assets/photos/x.jpg');
        expect(resolvedPathname('/../../assets/photos')).toBe('/assets/photos');
        expect(resolvedPathname('/assets/sibling/..%5Cphotos%5Cx.jpg')).toBe('/assets/photos/x.jpg');
        expect(resolvedPathname('/assets/photos/50%off.jpg')).toBe('/assets/photos/50%off.jpg');
    });

    it("runs on every request but Next's static assets, on those too once they carry a percent sign, and on /_next/image", () => {
        const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });
        for (const url of [
            '/', '/gallery', '/api/photos', '/assets/photos', '/assets/photos/series/x.jpg', '/Assets/Photos/x.jpg', '/assets/sibling/x.png',
            '/_next/static/..%2F..%2Fassets/photos/x.jpg', '/_next/static/chunks/%5Broot%5D.js', '/_next/image%2F..%2F..%2Fassets/photos/x.jpg',
            '/_next/image?url=%2Fassets%2Fphotos%2Fx.jpg&w=400&q=75',
        ]) {
            expect(matches(url), url).toBe(true);
        }
        for (const url of ['/_next/static/chunks/main.js', '/_next/static/media/front.0a1b2c3d.png']) {
            expect(matches(url), url).toBe(false);
        }
    });
});

describe('derivative URLs', () => {
    const outputs = ['thumbnail', 'medium', 'optimized', 'thumbnailAvif', 'mediumAvif', 'optimizedAvif', 'lqip'] as const;
    const names = ['50%off.jpg', 'a#b.jpg', 'what?.png', 'IMG 1234 (edited).jpg', 'café.webp', '100% #2.jpg', 'a%2Fb.jpg', 'a%2fb.png', 'a%5Cb.jpg'];

    // A v1.6 watcher wrote the legacy sets at these URLs, and a library may still hold them. None of them serves.
    it.each(names)('for %s, 404 at every URL a v1.6 watcher wrote under /assets/photos', async (name) => {
        // Only the names matter: libraryPaths() joins them onto a library that is never read.
        vi.stubEnv('PHOTOGRAPHY_LIBRARY_DIR', path.join(path.sep, 'nowhere', 'library'));
        const urls = getImagePaths(name, libraryPaths(), new Map());
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', emptyRoot());
        try {
            for (const field of ['original', ...outputs] as const) await expectNotFound(urls[field]);
        } finally {
            vi.stubEnv('PHOTOGRAPHY_DATA_DIR', '');
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

    // Nothing renders through next/image any more: photos are /media sets ResponsivePhoto draws itself, and About's
    // portrait, which Home's intro shows too, comes from /about/portrait/. No public file is a static import.
    it('names nothing, so no public file reaches /_next/image', () => {
        expect(nextConfig.images?.localPatterns).toEqual([]);
        for (const url of [
            '/assets/photos/thumbnails/landscape.webp',
            '/assets/photos/optimized/landscape.webp',
            '/assets/photos/optimized-avif/landscape.avif',
            '/assets/photos/landscape.jpg',
            '/assets/photos/series/x.jpg',
            '/assets/profile/portrait.jpg',
            '/about/portrait/t/w400.webp',
            '/media/ph_x/ar_x/pr_x/w400.webp',
            '/vite.svg',
            '/favicon.ico',
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

    it("holds only Next's own static media, and refuses every path under /assets/photos at /_next/image", async () => {
        const loaded = await loadConfig('phase-production-server', process.cwd(), { silent: true });
        const patterns = loaded.images.localPatterns;
        expect(patterns).toEqual(expect.arrayContaining([{ pathname: '/_next/static/media/**', search: '' }]));
        for (const pattern of patterns as { pathname: string }[]) expect(pattern.pathname, JSON.stringify(pattern)).toMatch(/^\/_next\/static\//);
        // Loading it leaves the module's own list as written.
        expect(nextConfig.images?.localPatterns).toEqual([]);
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
            await expectNotFound(url);
        }
    });
});
