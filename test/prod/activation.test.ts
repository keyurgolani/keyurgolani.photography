// @vitest-environment node
/**
 * `npm run test:prod` builds, then runs this against a copy of
 * .next/standalone. Plain `npm test` skips it unless RUN_PROD_TESTS=1, since
 * it needs that build.
 *
 * It serves the copy on a temp data root, with the library where the image
 * mounts it, at the copy's public/assets/photos. Before the launch it checks
 * that the legacy gallery lists a photo whose derivatives serve, directly and
 * through /_next/image. It then publishes twice and rolls back once from this
 * process, checks that the first publish closes those derivatives with no
 * restart, /_next/image's cached copy included, and checks after each step that
 * /api/ready, /api/photos, and /media follow the active revision with the
 * same server process, and that the /api/photos ETag answers If-None-Match
 * with 304 only while the same revision and build are served. It then scans
 * the public JSON and pages for legacy and original paths, checks the cache
 * headers of /media, checks that a legacy derivative on disk still 404s
 * directly and gets a 400 from /_next/image, and restarts the server, once
 * as it was and once with a new build ID. The copy is what lets it add a
 * legacy file and change the build ID without touching the build.
 *
 * Then, in a second server whose only request so far was /api/photos, it
 * damages and then removes the active pointer, and checks that /api/ready
 * and an active /media URL both still serve the revision that request
 * loaded, as `degraded`, so the routes share the reader's state, and that
 * /api/photos keeps that revision's ETag.
 *
 * Last, in a third server, it publishes, asks only /api/ready, and then moves
 * `catalog/` out of the data root. The legacy URLs stay closed, directly and
 * through /_next/image, so the proxy shares the cutover memory /api/ready's
 * route has, though the build gives each its own copy of the mode check.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activateRevision, publish, type PublishResult } from '../../lib/catalog/publish';
import { CATALOG_LOCK } from '../../lib/catalog/repository';
import { createTestCatalog, type TestCatalog } from '../../lib/catalog/testing';
import { catalogETag, readBuildId } from '../../lib/catalog/validators';
import { writeAuthoredRecord } from '../../lib/catalog/working-layer-writer';
import { catalogPaths, readActivePointer, readWorkingLayer } from '../../lib/catalog/working-layer';
import { DERIVATIVE_FOLDERS } from '../../lib/derivativeFolders.mjs';
import { legacyUrls } from '../../lib/identity/legacyUrls';
import { mediaUrl } from '../../lib/media/url';
import { versionFile } from '../../lib/storage/document';
import { withLock } from '../../lib/storage/lock';

const STANDALONE = path.resolve(import.meta.dirname, '../../.next/standalone');
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** What Next sends for a public file, so a cache that follows the origin keeps none. */
const PUBLIC_FILE = 'public, max-age=0';
/** What /_next/image sends for an optimized copy, from images.minimumCacheTTL: a shared cache may keep it a day. */
const OPTIMIZED_COPY = 'public, max-age=86400, must-revalidate';
/** /_next/image's body for a url it doesn't allow. */
const NOT_ALLOWED = '"url" parameter is not allowed';
const quiet = { log: () => undefined };
/** The pages a visitor loads, server-rendered per request. */
const PAGES = ['/', '/gallery', '/about'];

/** A port nothing on 127.0.0.1 listens on right now. */
async function freePort(): Promise<number> {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address() as net.AddressInfo;
    probe.close();
    await once(probe, 'close');
    return port;
}

interface Server {
    base: string;
    process: ChildProcess;
    output: () => string;
    stop: () => Promise<void>;
}

/** Serve the standalone copy at `cwd` on 127.0.0.1 with only these temp roots, and wait until it answers. */
async function startServer(cwd: string, dataRoot: string, library: string): Promise<Server> {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    // Only the temp roots, whatever this shell points PHOTOGRAPHY_* at.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PHOTOGRAPHY_')));
    const child = spawn(process.execPath, ['server.js'], {
        cwd,
        env: { ...env, NODE_ENV: 'production', PORT: String(port), HOSTNAME: '127.0.0.1', PHOTOGRAPHY_DATA_DIR: dataRoot, PHOTOGRAPHY_LIBRARY_DIR: library },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => (output += chunk));
    child.stderr?.on('data', (chunk) => (output += chunk));
    const stop = async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit');
        child.kill();
        await exited;
    };
    const deadline = Date.now() + 60_000;
    for (;;) {
        if (child.exitCode !== null) throw new Error(`The server exited with ${child.exitCode}:\n${output}`);
        try {
            // Any answer means it listens. /api/health reads no catalog (`/` does now), so no route has loaded one when this returns.
            await (await fetch(`${base}/api/health`)).arrayBuffer();
            break;
        } catch {
            // Not listening yet.
        }
        if (Date.now() > deadline) {
            await stop();
            throw new Error(`The server did not answer within 60 s:\n${output}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { base, process: child, output: () => output, stop };
}

/** The `Vary` header's field names, lower case. */
const varyOf = (response: Response) => (response.headers.get('vary') ?? '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);

describe.skipIf(process.env.RUN_PROD_TESTS !== '1')('the standalone build', () => {
    let catalog: TestCatalog | undefined;
    let library: string | undefined;
    /** The copy of .next/standalone the server runs from. */
    let served: string | undefined;
    /** The server the first three tests use. */
    let server: Server | undefined;
    let base = '';
    /** The base name of a catalog photo's source, whose seven legacy derivatives are in the copy's public/. */
    let legacyBase = '';
    /** That photo's legacy URLs: the original, then the derivatives in DERIVATIVE_FOLDERS order. */
    let legacy: string[] = [];
    /** The /_next/image URL the legacy gallery loaded that photo's thumbnail through, before the launch. */
    let optimizedThumbnail = '';
    /** Set by the first test, for the ones after it. */
    let first: PublishResult | undefined;
    const extra: (() => Promise<void>)[] = [];

    async function start(): Promise<void> {
        server = await startServer(served!, catalog!.root, library!);
        base = server.base;
    }

    async function stop(): Promise<void> {
        await server?.stop();
    }

    beforeAll(async () => {
        if (!fs.existsSync(path.join(STANDALONE, 'server.js'))) {
            throw new Error('There is no .next/standalone/server.js. Run npm run test:prod, which builds first.');
        }
        served = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-test-standalone-'));
        fs.cpSync(STANDALONE, served, { recursive: true, verbatimSymlinks: true });
        catalog = await createTestCatalog({ withAssets: true, photos: 3, series: [{ photos: 2 }, { photos: 1, visibility: 'draft' }], seed: 47 });
        // The library where the image mounts it, so the server serves what legacy mode lists.
        library = path.join(served, 'public/assets/photos');
        // All seven legacy derivatives of a catalog photo's source, so the legacy gallery lists it. Next serves only
        // the public/ files present when it starts, so they're written first.
        const source = Object.values(catalog.registry.photos)[0].source.path;
        legacyBase = path.posix.basename(source, path.posix.extname(source));
        legacy = legacyUrls(source);
        const picture = sharp({ create: { width: 64, height: 48, channels: 3, background: '#7a8899' } });
        const bytes = { '.webp': await picture.clone().webp().toBuffer(), '.avif': await picture.clone().avif().toBuffer() };
        for (const [folder, extension] of Object.entries(DERIVATIVE_FOLDERS)) {
            const file = path.join(library, folder, `${legacyBase}${extension}`);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, extension === '.txt' ? `data:image/webp;base64,${bytes['.webp'].toString('base64')}` : bytes[extension as '.webp' | '.avif']);
        }
        await start();
    }, 180_000);

    afterAll(async () => {
        await stop();
        for (const cleanup of extra.splice(0).reverse()) await cleanup();
        await catalog?.cleanup();
        if (library) fs.rmSync(library, { recursive: true, force: true });
        if (served) fs.rmSync(served, { recursive: true, force: true });
    });

    async function ready(at = base): Promise<Record<string, unknown>> {
        const response = await fetch(`${at}/api/ready`);
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        return (await response.json()) as Record<string, unknown>;
    }

    /** GET /api/photos, with If-None-Match when given a tag. */
    function photos(ifNoneMatch?: string, at = base): Promise<Response> {
        return fetch(`${at}/api/photos`, ifNoneMatch === undefined ? {} : { headers: { 'If-None-Match': ifNoneMatch } });
    }

    /** The tag this server must send for `revisionId`: the route, the revision, and the copy's BUILD_ID. */
    function expectedTag(revisionId: string): string {
        const build = readBuildId(served);
        expect(build, 'the copy has a .next/BUILD_ID').not.toBeNull();
        return catalogETag('/api/photos', revisionId, build!);
    }

    /** The `medium` URL of each listed photo, in list order, after checking the mode and revision headers. */
    async function listed(mode: 'legacy' | 'catalog', revision: string, at = base): Promise<string[]> {
        const response = await photos(undefined, at);
        expect(response.status).toBe(200);
        expect(response.headers.get('x-catalog-mode')).toBe(mode);
        expect(response.headers.get('x-catalog-revision')).toBe(revision);
        expect(response.headers.get('cache-control')).toBe('no-cache');
        expect(response.headers.has('last-modified')).toBe(false);
        if (mode === 'legacy') expect(response.headers.has('etag')).toBe(false);
        else expect(response.headers.get('etag')).toBe(expectedTag(revision));
        return ((await response.json()) as { medium: string }[]).map((item) => item.medium);
    }

    /** A request with `tag` gets 304, empty, with the 200's ETag, Cache-Control, and X-Catalog-Revision. */
    async function expectNotModified(tag: string, revisionId: string, at = base): Promise<void> {
        for (const header of [tag, `W/"stale", ${tag.slice(2)}`]) {
            const response = await photos(header, at);
            expect(response.status, header).toBe(304);
            expect(await response.text()).toBe('');
            expect(response.headers.get('etag')).toBe(tag);
            expect(response.headers.get('cache-control')).toBe('no-cache');
            expect(response.headers.get('x-catalog-revision')).toBe(revisionId);
        }
    }

    /** A request with a stale `tag` gets 200 and the tag of `revisionId`, which it returns. */
    async function expectModified(tag: string, revisionId: string): Promise<string> {
        const response = await photos(tag);
        expect(response.status).toBe(200);
        const fresh = response.headers.get('etag') as string;
        expect(fresh).not.toBe(tag);
        expect(fresh).toBe(expectedTag(revisionId));
        expect(response.headers.get('x-catalog-revision')).toBe(revisionId);
        await response.arrayBuffer();
        return fresh;
    }

    async function expectServed(url: string, at = base): Promise<void> {
        const response = await fetch(`${at}${url}`);
        expect(response.status, url).toBe(200);
        expect(response.headers.get('cache-control')).toBe(IMMUTABLE);
        expect(response.headers.get('content-type')).toBe('image/webp');
        // The format is in the URL, so nothing is negotiated.
        expect(varyOf(response)).not.toContain('accept');
        await response.arrayBuffer();
    }

    async function expectRefused(url: string): Promise<void> {
        const response = await fetch(`${base}${url}`);
        expect(response.status, url).toBe(404);
        expect(response.headers.get('cache-control')).toBe('no-store');
        await response.arrayBuffer();
    }

    /** A legacy URL is closed: a 404 directly, and /_next/image's own 400, with nothing cached. */
    async function expectContained(url: string, at = base): Promise<void> {
        const direct = await fetch(`${at}${url}`);
        expect(direct.status, url).toBe(404);
        expect(direct.headers.get('cache-control'), url).toBe('no-store');
        await direct.arrayBuffer();
        const optimized = await fetch(`${at}/_next/image?url=${encodeURIComponent(url)}&w=400&q=75`);
        expect(optimized.status, url).toBe(400);
        expect(optimized.headers.get('cache-control'), url).toBe('no-store');
        expect(await optimized.text(), url).toBe(NOT_ALLOWED);
    }

    async function published(): Promise<PublishResult> {
        const result = await publish({ dataRoot: catalog!.root, actor: 'test', confirmLaunch: true, logger: quiet });
        expect(result.outcome, result.message).toBe('PUBLISHED');
        return result;
    }

    it('serves the legacy gallery before the launch: its photo, each derivative, and /_next/image', async () => {
        expect(await ready()).toEqual({ mode: 'legacy', state: 'ok', revisionId: null, revisionNumber: null, activatedAt: null });
        const response = await photos();
        expect(response.status).toBe(200);
        const items = (await response.json()) as Record<string, string>[];
        expect(items.map((item) => item.thumbnail)).toEqual([legacy[1]]);
        const [, thumbnail, medium, optimized, thumbnailAvif, mediumAvif, optimizedAvif] = legacy;
        expect(items[0]).toMatchObject({ src: optimized, thumbnail, medium, optimized, thumbnailAvif, mediumAvif, optimizedAvif });

        const gallery = await fetch(`${base}/gallery`);
        expect(gallery.status).toBe(200);
        expect(gallery.headers.get('content-type')).toContain('text/html');
        await gallery.arrayBuffer();

        // Each derivative, as the Lightbox and the LQIP read them. A cache that follows the origin keeps none.
        for (const url of legacy.slice(1)) {
            const derivative = await fetch(`${base}${url}`);
            expect(derivative.status, url).toBe(200);
            expect(derivative.headers.get('cache-control'), url).toBe(PUBLIC_FILE);
            await derivative.arrayBuffer();
        }
        // The original never serves.
        await expectRefused(legacy[0]);

        // The gallery's tiles load through /_next/image. The second request is a hit in Next's image cache.
        optimizedThumbnail = `/_next/image?url=${encodeURIComponent(thumbnail)}&w=400&q=75`;
        for (const expected of ['MISS', 'HIT']) {
            const tile = await fetch(`${base}${optimizedThumbnail}`);
            expect(tile.status).toBe(200);
            expect(tile.headers.get('content-type')).toMatch(/^image\//);
            expect(tile.headers.get('cache-control')).toBe(OPTIMIZED_COPY);
            expect(tile.headers.get('x-nextjs-cache')).toBe(expected);
            await tile.arrayBuffer();
        }
    }, 60_000);

    it('follows each activation and a rollback without a restart, with a new ETag for each', async () => {
        const root = catalog!.root;
        const pid = server!.process.pid;
        const [shown, draft] = catalog!.series;
        const urlOf = (photoId: string) => {
            const photo = catalog!.photos.find((entry) => entry.id === photoId)!;
            return mediaUrl({ photoId, assetRevision: photo.assetRevision!, profileId: catalog!.profileId }, 'w800', 'webp');
        };
        const firstUrls = shown.photoIds.map(urlOf);
        const draftUrl = urlOf(draft.photoIds[0]);

        // Before the first activation: legacy mode, listing the photo with legacy derivatives, with no ETag.
        expect(optimizedThumbnail, 'the first test loaded the legacy gallery').not.toBe('');
        expect(await ready()).toEqual({ mode: 'legacy', state: 'ok', revisionId: null, revisionNumber: null, activatedAt: null });
        expect(await listed('legacy', 'legacy')).toEqual([legacy[2]]);
        for (const url of [...firstUrls, draftUrl]) await expectRefused(url);

        // The first publish lists and serves the published series only, and its tag gets 304.
        first = await published();
        expect(await ready()).toMatchObject({ mode: 'catalog', state: 'ok', revisionId: first.revisionId, revisionNumber: 1 });
        // The launch closes every legacy URL in the same process, and /_next/image refuses before its cache answers.
        for (const url of legacy) await expectContained(url);
        const tile = await fetch(`${base}${optimizedThumbnail}`);
        expect(tile.status).toBe(400);
        expect(await tile.text()).toBe(NOT_ALLOWED);
        expect(await listed('catalog', first.revisionId!)).toEqual(firstUrls);
        const firstTag = expectedTag(first.revisionId!);
        await expectNotModified(firstTag, first.revisionId!);
        for (const url of firstUrls) await expectServed(url);
        await expectRefused(draftUrl);

        // Publishing the draft series adds its photo, and the first tag gets 200 with a new one.
        const layer = await readWorkingLayer(root);
        const record = layer.series.find((entry) => entry.id === draft.id)!;
        await writeAuthoredRecord({ ...structuredClone(record), visibility: 'published' }, { expectedVersion: record.version, root });
        const second = await published();
        expect(await ready()).toMatchObject({ mode: 'catalog', state: 'ok', revisionId: second.revisionId, revisionNumber: 2 });
        const secondTag = await expectModified(firstTag, second.revisionId!);
        await expectNotModified(secondTag, second.revisionId!);
        expect(await listed('catalog', second.revisionId!)).toEqual([...firstUrls, draftUrl]);
        await expectServed(draftUrl);

        // This process rolling back to the first revision takes it away again, and the second tag gets 200.
        const rollback = await withLock(CATALOG_LOCK, { root }, (lock) => activateRevision({
            lock,
            revisionId: first!.revisionId!,
            expectedActiveRevisionId: second.revisionId!,
            kind: 'rollback',
            actor: 'test',
            reason: 'rollback',
        }));
        expect(rollback.outcome, rollback.message).toBe('ACTIVATED');
        expect(await ready()).toEqual({
            mode: 'catalog',
            state: 'ok',
            revisionId: first.revisionId,
            revisionNumber: 1,
            activatedAt: rollback.activation!.committedAt,
        });
        // The first revision on the same build: the same tag as before, so it gets 304 again.
        expect(await expectModified(secondTag, first.revisionId!)).toBe(firstTag);
        await expectNotModified(firstTag, first.revisionId!);
        expect(await listed('catalog', first.revisionId!)).toEqual(firstUrls);
        for (const url of firstUrls) await expectServed(url);
        await expectRefused(draftUrl);

        expect(server!.process.exitCode).toBeNull();
        expect(server!.process.pid).toBe(pid);
    }, 120_000);

    it('names no legacy derivative or original path in public JSON or pages, and serves no legacy derivative', async () => {
        expect(first, 'the first test published').toBeDefined();
        const forbidden = ['/assets/photos/', '%2Fassets%2Fphotos', '\\/assets\\/photos'];
        for (const photo of Object.values(catalog!.registry.photos)) {
            const source = photo.source.path;
            forbidden.push(source, path.posix.basename(source, path.posix.extname(source)), ...legacyUrls(source));
        }
        const bodies: [string, string][] = [];
        for (const url of ['/api/photos', '/api/ready', ...PAGES]) {
            const response = await fetch(`${base}${url}`);
            expect(response.status, url).toBe(200);
            bodies.push([url, await response.text()]);
        }
        const items = JSON.parse(bodies[0][1]) as Record<string, unknown>[];
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
            for (const field of ['src', 'thumbnail', 'medium', 'optimized', 'thumbnailAvif', 'mediumAvif', 'optimizedAvif']) {
                expect(String(item[field]), field).toMatch(/^\/media\//);
            }
        }
        for (const [url, text] of bodies) {
            for (const needle of forbidden) expect(text.includes(needle), `${url} names ${needle}`).toBe(false);
        }

        // A legacy basename derivative on disk 404s with nothing cached, and /_next/image refuses it.
        await expectContained(`/assets/photos/optimized/${encodeURIComponent(legacyBase)}.webp`);

        // /api/image is gone.
        const image = await fetch(`${base}/api/image?src=${encodeURIComponent(`${legacyBase}.jpg`)}&w=800`);
        expect(image.status).toBe(404);
        await image.arrayBuffer();
    }, 60_000);

    it('keeps the ETag across a restart, and changes it with a new build ID', async () => {
        expect(first, 'the first test published').toBeDefined();
        const revisionId = first!.revisionId!;
        const tag = expectedTag(revisionId);

        await stop();
        await start();
        expect(await listed('catalog', revisionId)).toHaveLength(2);
        await expectNotModified(tag, revisionId);
        // A server started after the launch keeps the legacy URLs closed: the committed activation shows the cutover.
        for (const url of legacy) await expectContained(url);

        // A deploy: the same revision on a new build.
        await stop();
        const buildFile = path.join(served!, '.next', 'BUILD_ID');
        fs.writeFileSync(buildFile, `${readBuildId(served)}-next`);
        await start();
        const fresh = await expectModified(tag, revisionId);
        await expectNotModified(fresh, revisionId);
    }, 180_000);

    it('serves the revision /api/photos loaded from /api/ready and /media once the pointer is damaged, then gone', async () => {
        const damaged = await createTestCatalog({ withAssets: true, photos: 2, series: [{ photos: 2 }], seed: 53 });
        extra.push(() => damaged.cleanup());
        const result = await publish({ dataRoot: damaged.root, actor: 'test', confirmLaunch: true, logger: quiet });
        expect(result.outcome, result.message).toBe('PUBLISHED');
        const [series] = damaged.series;
        const photo = damaged.photos.find((entry) => entry.id === series.photoIds[0])!;
        const url = mediaUrl({ photoId: photo.id, assetRevision: photo.assetRevision!, profileId: damaged.profileId }, 'w800', 'webp');

        // A server started after the publish, whose only catalog read is one /api/photos request.
        const started = await startServer(served!, damaged.root, library!);
        extra.push(started.stop);
        expect(await listed('catalog', result.revisionId!, started.base)).toContain(url);
        const tag = expectedTag(result.revisionId!);

        // Damage the newest pointer version, the one readActivePointer() reads.
        const pointer = await readActivePointer(damaged.root);
        const file = versionFile(catalogPaths(damaged.root).active, pointer!.version);
        fs.writeFileSync(file, 'not json');
        const degraded = { mode: 'catalog', state: 'degraded', revisionId: result.revisionId, revisionNumber: 1 };
        expect(await ready(started.base), started.output()).toMatchObject(degraded);
        await expectServed(url, started.base);
        // Degraded still serves that revision, so its tag still gets 304.
        await expectNotModified(tag, result.revisionId!, started.base);

        // With the pointer folder gone, it keeps serving the revision it loaded. The committed activation is still
        // there, so this shows the last loaded revision is kept, not that the cutover is remembered without it.
        // The unit tests cover that ("remembers a cutover it saw").
        fs.rmSync(catalogPaths(damaged.root).active, { recursive: true });
        expect(await ready(started.base), started.output()).toMatchObject(degraded);
        await expectServed(url, started.base);
        expect(await listed('catalog', result.revisionId!, started.base)).toContain(url);
        await expectNotModified(tag, result.revisionId!, started.base);
        expect(started.output()).not.toContain(damaged.root);
    }, 120_000);

    it('keeps the legacy URLs closed once only /api/ready saw the launch, with catalog/ then moved aside', async () => {
        const launched = await createTestCatalog({ withAssets: true, photos: 2, series: [{ photos: 2 }], seed: 59 });
        extra.push(() => launched.cleanup());
        const thumbnail = legacy[1];
        const started = await startServer(served!, launched.root, library!);
        extra.push(started.stop);

        // Legacy mode: the thumbnail serves, and its /_next/image copy is in the image cache by the second request.
        expect(await ready(started.base)).toMatchObject({ mode: 'legacy' });
        const direct = await fetch(`${started.base}${thumbnail}`);
        expect(direct.status).toBe(200);
        await direct.arrayBuffer();
        for (let request = 0; request < 2; request += 1) {
            const tile = await fetch(`${started.base}/_next/image?url=${encodeURIComponent(thumbnail)}&w=400&q=75`);
            expect(tile.status).toBe(200);
            if (request === 1) expect(tile.headers.get('x-nextjs-cache')).toMatch(/^(HIT|STALE)$/);
            await tile.arrayBuffer();
        }

        // The launch, seen by /api/ready alone: no legacy URL is asked for until catalog/ is gone.
        const result = await publish({ dataRoot: launched.root, actor: 'test', confirmLaunch: true, logger: quiet });
        expect(result.outcome, result.message).toBe('PUBLISHED');
        expect(await ready(started.base)).toMatchObject({ mode: 'catalog', revisionId: result.revisionId, revisionNumber: 1 });
        const catalogDir = catalogPaths(launched.root).dir;
        fs.renameSync(catalogDir, `${catalogDir}-aside`);
        // /api/ready's route still remembers the cutover.
        const after = await fetch(`${started.base}/api/ready`);
        expect(((await after.json()) as { mode: string }).mode, started.output()).toBe('catalog');
        await expectContained(thumbnail, started.base);
        for (const url of legacy) await expectContained(url, started.base);
        expect(started.process.exitCode).toBeNull();
    }, 120_000);
});
