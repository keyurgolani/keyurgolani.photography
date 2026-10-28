// @vitest-environment node
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { VARIANT_BYTES } from '../lib/catalog/__tests__/catalogFixtures';
import { CUTOVER_KEY } from '../lib/catalog/mode';
import { publish } from '../lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '../lib/catalog/testing';
import { catalogPaths } from '../lib/catalog/working-layer';
import nextConfig from '../next.config.mjs';
import { config, IMAGE_URL_NOT_ALLOWED, proxy } from '../proxy';
import { baseNameOf, getImagePaths, libraryPaths } from '../utils/imageOptimizer';
import { resolvedPathname } from '../utils/publicDerivatives';

// The function /_next/image uses to check `url` against images.localPatterns. Next ships no types for it.
const { hasLocalMatch } = createRequire(import.meta.url)('next/dist/shared/lib/match-local-pattern') as {
    hasLocalMatch(patterns: unknown, url: string): boolean;
};

type Proxy = typeof proxy;

function respond(pathname: string, run: Proxy = proxy) {
    return run(new NextRequest(new URL(pathname, 'http://localhost:3000')));
}

const passes = async (pathname: string, run: Proxy = proxy) => (await respond(pathname, run)).headers.get('x-middleware-next') === '1';

async function expectNotFound(pathname: string, run: Proxy = proxy): Promise<void> {
    const response = await respond(pathname, run);
    expect(response.status, pathname).toBe(404);
    expect(response.headers.get('x-middleware-next'), pathname).toBeNull();
    expect(response.headers.get('cache-control'), pathname).toBe('no-store');
}

/** /_next/image for `url`, as next/image asks for it. */
const imageUrl = (url: string) => `/_next/image?url=${encodeURIComponent(url)}&w=400&q=75`;

/** The proxy answers /_next/image's own 400 for this url, with nothing cached. */
async function expectImageRefused(url: string, run: Proxy = proxy): Promise<void> {
    const response = await respond(url, run);
    expect(response.status, url).toBe(400);
    expect(response.headers.get('x-middleware-next'), url).toBeNull();
    expect(response.headers.get('cache-control'), url).toBe('no-store');
    expect(await response.text(), url).toBe(IMAGE_URL_NOT_ALLOWED);
}

/** A fresh copy of the proxy and the mode check behind it, as a newly started server has: no cutover remembered. */
async function freshProxy(): Promise<Proxy> {
    vi.resetModules();
    Reflect.deleteProperty(globalThis, CUTOVER_KEY);
    return (await import('../proxy')).proxy;
}

const temps: string[] = [];
const catalogs: TestCatalog[] = [];

/** An empty data root, as a host has before the migration: legacy mode. */
function legacyRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-legacy-'));
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

/** The legacy derivative paths the legacy pages load, directly and through /_next/image. */
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
];

/** Paths under /assets/photos, and encoded ones anywhere, that never serve in either mode. */
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

/** Paths outside /assets/photos, which pass in either mode. */
const OUTSIDE = [
    '/', '/gallery', '/about', '/api/photos', '/assets/sibling/x.png', '/favicon.ico', '/assets/photosets/x.jpg',
    '/assets/photos/../sibling/x.png', '/_next/static/chunks/%5Broot-of-the-server%5D__0a1b2c._.js',
];

describe('proxy.ts in legacy mode, before the launch', { timeout: 60_000 }, () => {
    beforeAll(() => {
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', legacyRoot());
    });

    it.each(DERIVATIVES)('passes the legacy derivative %s', async (pathname) => {
        expect(await passes(pathname)).toBe(true);
    });

    it.each(DERIVATIVES.filter((pathname) => !pathname.endsWith('.txt')))('passes /_next/image for the legacy derivative %s', async (pathname) => {
        expect(await passes(imageUrl(decodeURIComponent(pathname)))).toBe(true);
    });

    it.each(PRIVATE)('404s %s', async (_label, pathname) => {
        await expectNotFound(pathname);
    });

    it.each([
        ['a case-folded folder', '/assets/photos/Optimized/landscape.webp'],
        ['a case-folded prefix', '/Assets/Photos/optimized/landscape.webp'],
    ])('404s a derivative under %s, which only a case-insensitive disk would find', async (_label, pathname) => {
        await expectNotFound(pathname);
    });

    it.each(OUTSIDE)('passes %s, outside /assets/photos', async (pathname) => {
        expect(await passes(pathname)).toBe(true);
    });
});

describe('proxy.ts in catalog mode, once a revision is live', { timeout: 60_000 }, () => {
    beforeAll(async () => {
        const catalog = await testCatalog(31);
        await launch(catalog.root);
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', catalog.root);
    });

    // The site serves photos only from /media, so the legacy basename URLs close too.
    it.each([
        ...DERIVATIVES,
        '/assets/photos/Optimized/landscape.webp',
        '/Assets/Photos/optimized/landscape.webp',
    ])('404s the legacy derivative %s', async (pathname) => {
        await expectNotFound(pathname);
    });

    it.each(PRIVATE)('404s %s', async (_label, pathname) => {
        await expectNotFound(pathname);
    });

    it.each(OUTSIDE)('passes %s, outside /assets/photos', async (pathname) => {
        expect(await passes(pathname)).toBe(true);
    });

    it('refuses every url under /assets/photos at /_next/image, before its cache can answer', async () => {
        for (const url of [
            '/assets/photos/thumbnails/landscape.webp',
            '/assets/photos/optimized/landscape.webp',
            '/assets/photos/optimized-avif/landscape.avif',
            '/assets/photos/optimized/IMG 1234 (edited).webp',
            '/assets/photos/landscape.jpg',
            '/assets/photos/optimized/landscape%2Ewebp',
            '/assets%2Fphotos%2Foptimized%2Flandscape.webp',
            '/Assets/Photos/optimized/landscape.webp',
            '/assets/sibling/../photos/optimized/landscape.webp',
            '\\assets\\photos\\optimized\\landscape.webp',
            '/_next/static/media/..%2F..%2F..%2Fassets%2Fphotos%2Foptimized%2Flandscape.webp',
            'http://localhost:3000/assets/photos/optimized/landscape.webp',
        ]) {
            await expectImageRefused(imageUrl(url));
        }
        // Every `url` counts, not only the first.
        await expectImageRefused(`/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Fa.png&url=${encodeURIComponent('/assets/photos/optimized/landscape.webp')}&w=400&q=75`);
    });

    it("passes /_next/image for a url outside /assets/photos, which Next's own patterns decide", async () => {
        expect(await passes(imageUrl('/_next/static/media/front.0a1b2c3d.png'))).toBe(true);
        expect(await passes('/_next/image?w=400&q=75')).toBe(true);
    });
});

describe('the switch at the launch', { timeout: 60_000 }, () => {
    it('closes /assets/photos and /_next/image on the publish that goes live, with no restart', async () => {
        const catalog = await testCatalog(32);
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', catalog.root);
        const run = await freshProxy();
        const thumbnail = '/assets/photos/thumbnails/landscape.webp';
        // A data root with authored records but nothing live is still legacy.
        expect(await passes(thumbnail, run)).toBe(true);
        expect(await passes(imageUrl(thumbnail), run)).toBe(true);
        await expectNotFound('/assets/photos/landscape.jpg', run);

        await launch(catalog.root);
        await expectNotFound(thumbnail, run);
        await expectImageRefused(imageUrl(thumbnail), run);
        await expectNotFound('/assets/photos/landscape.jpg', run);
    });

    it('serves them again only from a data root restored from before the launch, once the server restarts', async () => {
        const catalog = await testCatalog(33);
        const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-backup-'));
        temps.push(backup);
        // The backup the cutover prompt makes just before --confirm-launch.
        fs.cpSync(catalog.root, path.join(backup, 'root'), { recursive: true });
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', catalog.root);
        const thumbnail = '/assets/photos/thumbnails/landscape.webp';
        const running = await freshProxy();
        await launch(catalog.root);
        await expectNotFound(thumbnail, running);

        // The restore swaps the backup in at the same path. A server still running remembers the cutover.
        const aside = `${catalog.root}-aside`;
        temps.push(aside);
        fs.renameSync(catalog.root, aside);
        fs.renameSync(path.join(backup, 'root'), catalog.root);
        await expectNotFound(thumbnail, running);
        await expectImageRefused(imageUrl(thumbnail), running);

        // Restarted on the restored root, it's legacy mode again.
        const restarted = await freshProxy();
        expect(await passes(thumbnail, restarted)).toBe(true);
        expect(await passes(imageUrl(thumbnail), restarted)).toBe(true);

        // A restart on the launched root stays closed: the committed activation shows the cutover.
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', aside);
        const again = await freshProxy();
        await expectNotFound(thumbnail, again);
        await expectImageRefused(imageUrl(thumbnail), again);
    });

    it("404s the derivatives while the data root's catalog can't be read, and serves them again once it can", async () => {
        const root = legacyRoot();
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', root);
        const run = await freshProxy();
        const thumbnail = '/assets/photos/thumbnails/landscape.webp';
        expect(await passes(thumbnail, run)).toBe(true);
        const active = catalogPaths(root).active;
        const readdir = fs.promises.readdir.bind(fs.promises);
        const failing = vi.spyOn(fs.promises, 'readdir').mockImplementation((async (dir: fs.PathLike, options?: unknown) => {
            if (String(dir) === active) throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
            return readdir(dir, options as never);
        }) as typeof fs.promises.readdir);
        try {
            await expectNotFound(thumbnail, run);
            await expectImageRefused(imageUrl(thumbnail), run);
        } finally {
            failing.mockRestore();
        }
        // Nothing showed a cutover, so nothing is remembered.
        expect(await passes(thumbnail, run)).toBe(true);
    });
});

describe('the data root the mode is read from', { timeout: 60_000 }, () => {
    const thumbnail = '/assets/photos/thumbnails/landscape.webp';
    const nodeEnv = process.env.NODE_ENV;

    afterEach(() => {
        vi.stubEnv('NODE_ENV', nodeEnv);
    });

    /** The legacy derivative and its /_next/image copy both serve, or both are refused. */
    async function expectServes(serves: boolean): Promise<void> {
        if (serves) {
            expect(await passes(thumbnail), thumbnail).toBe(true);
            expect(await passes(imageUrl(thumbnail)), thumbnail).toBe(true);
        } else {
            await expectNotFound(thumbnail);
            await expectImageRefused(imageUrl(thumbnail));
        }
        // An original never serves.
        await expectNotFound('/assets/photos/landscape.jpg');
    }

    it('refuses them with no data root, as in production with PHOTOGRAPHY_DATA_DIR unset, where the legacy pages answer 503', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', '');
        await expectServes(false);
    });

    it('refuses them while nothing is at the data root\'s path', async () => {
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', path.join(legacyRoot(), 'missing'));
        await expectServes(false);
    });

    it('refuses them while a file is at the data root\'s path', async () => {
        const file = path.join(legacyRoot(), 'data-root');
        fs.writeFileSync(file, '');
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', file);
        await expectServes(false);
    });

    it('serves them from an empty data root, as on a host before the migration and in the release smoke', async () => {
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', legacyRoot());
        await expectServes(true);
    });

    it('serves them from a data root with no data-root.json and no catalog revision yet', async () => {
        const root = legacyRoot();
        fs.mkdirSync(catalogPaths(root).active, { recursive: true });
        fs.mkdirSync(catalogPaths(root).activationsDir, { recursive: true });
        fs.writeFileSync(path.join(root, 'notes.txt'), 'not initialized');
        expect(fs.existsSync(path.join(root, 'data-root.json'))).toBe(false);
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', root);
        await expectServes(true);
    });

    it('refuses them while the data root can\'t be read, and serves them again once it can', async () => {
        const root = legacyRoot();
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', root);
        fs.chmodSync(root, 0o000);
        try {
            await expectServes(false);
        } finally {
            fs.chmodSync(root, 0o700);
        }
        await expectServes(true);
    });

    it('refuses them on a data root with a live catalog revision', async () => {
        const catalog = await testCatalog(35);
        await launch(catalog.root);
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', catalog.root);
        await expectServes(false);
    });

    it('refuses them while the data root\'s catalog is a file', async () => {
        const root = legacyRoot();
        fs.writeFileSync(catalogPaths(root).dir, '');
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', root);
        await expectServes(false);
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
    const outputs = [
        ['thumbnail', 'thumbnails', '.webp'],
        ['medium', 'medium', '.webp'],
        ['optimized', 'optimized', '.webp'],
        ['thumbnailAvif', 'thumbnails-avif', '.avif'],
        ['mediumAvif', 'medium-avif', '.avif'],
        ['optimizedAvif', 'optimized-avif', '.avif'],
        ['lqip', 'lqip', '.txt'],
    ] as const;
    const names = ['50%off.jpg', 'a#b.jpg', 'what?.png', 'IMG 1234 (edited).jpg', 'café.webp', '100% #2.jpg', 'a%2Fb.jpg', 'a%2fb.png', 'a%5Cb.jpg'];
    let legacy = '';
    let launched = '';

    beforeAll(async () => {
        legacy = legacyRoot();
        const catalog = await testCatalog(34);
        await launch(catalog.root);
        launched = catalog.root;
    }, 60_000);

    it.each(names)('for %s, decode to the file on disk, pass the proxy whole before the launch, and 404 after it', async (name) => {
        const urls = getImagePaths(name, libraryPaths(), new Map());
        const base = baseNameOf(name);
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', legacy);
        for (const [field, folder, extension] of outputs) {
            const url = urls[field];
            // Nothing in the name becomes a query or a fragment.
            expect(new URL(url, 'http://localhost').pathname, url).toBe(url);
            expect(resolvedPathname(url), url).toBe(`/assets/photos/${folder}/${base}${extension}`);
            expect(await passes(url), url).toBe(true);
        }
        await expectNotFound(urls.original);
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', launched);
        for (const field of ['original', ...outputs.map(([output]) => output)] as const) await expectNotFound(urls[field]);
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
            '/assets/sibling/..%2Fphotos%2Flandscape.jpg',
            '/vite.svg',
            '/favicon.ico',
        ]) {
            expect(allows(url), url).toBe(false);
        }
    });

    it('names nothing outside the derivative folders, so no other public file reaches /_next/image', () => {
        const patterns = (nextConfig.images?.localPatterns ?? []) as { pathname?: string; search?: string }[];
        expect(patterns.length).toBeGreaterThan(0);
        for (const pattern of patterns) {
            expect(pattern.pathname, JSON.stringify(pattern)).toMatch(/^\/assets\/photos\/[a-z-]+\/\*\.(webp|avif)$/);
            expect(pattern.search).toBe('');
        }
    });
});

describe('images.localPatterns as Next loads them', () => {
    // At load, Next adds its own static media patterns to the list, for statically imported images.
    const { default: loadConfig } = createRequire(import.meta.url)('next/dist/server/config') as {
        default(phase: string, dir: string, options?: { silent?: boolean }): Promise<{ images: { localPatterns?: unknown } }>;
    };

    it('refuses an original or an encoded path under /assets/photos at /_next/image', async () => {
        const loaded = await loadConfig('phase-production-server', process.cwd(), { silent: true });
        const patterns = loaded.images.localPatterns;
        expect(patterns).toEqual(expect.arrayContaining([
            ...(nextConfig.images?.localPatterns ?? []),
            { pathname: '/_next/static/media/**', search: '' },
        ]));
        // Loading it leaves the module's own list as written: the six image derivative folders.
        expect(nextConfig.images?.localPatterns).toHaveLength(6);
        for (const url of [
            '/assets/photos/optimized/landscape%2Ewebp',
            '/assets%2Fphotos%2Foptimized%2Flandscape.webp',
            '/assets/photos/landscape.jpg',
        ]) {
            expect(hasLocalMatch(patterns, url), url).toBe(false);
        }
        // For a url under Next's own patterns, /_next/image fetches it internally, so the proxy
        // has to run on that fetch and refuse anything that encodes its way out of the folder.
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', legacyRoot());
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
