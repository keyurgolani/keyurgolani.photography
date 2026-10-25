// @vitest-environment node
/**
 * `npm run test:prod` builds, then runs this against a copy of
 * .next/standalone. Plain `npm test` skips it unless RUN_PROD_TESTS=1, since
 * it needs that build.
 *
 * It serves the copy on a temp data root and library, publishes twice and
 * rolls back once from this process, and checks after each step that
 * /api/ready, /api/photos, and /media follow the active revision with the
 * same server process, and that the /api/photos ETag answers If-None-Match
 * with 304 only while the same revision and build are served. It then scans
 * the public JSON and pages for legacy and original paths, checks the cache
 * headers of /media, checks that a legacy derivative on disk 404s directly
 * and gets a 400 from /_next/image, and restarts the server, once
 * as it was and once with a new build ID. The copy is what lets it add a
 * legacy file and change the build ID without touching the build.
 *
 * Then, in a second server whose only request so far was /api/photos, it
 * damages and then removes the active pointer, and checks that /api/ready
 * and an active /media URL both still serve the revision that request
 * loaded, as `degraded`, so the routes share the reader's state, and that
 * /api/photos keeps that revision's ETag.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activateRevision, publish, type PublishResult } from '../../lib/catalog/publish';
import { CATALOG_LOCK } from '../../lib/catalog/repository';
import { createTestCatalog, type TestCatalog } from '../../lib/catalog/testing';
import { catalogETag, readBuildId } from '../../lib/catalog/validators';
import { writeAuthoredRecord } from '../../lib/catalog/working-layer-writer';
import { catalogPaths, readActivePointer, readWorkingLayer } from '../../lib/catalog/working-layer';
import { legacyUrls } from '../../lib/identity/legacyUrls';
import { mediaUrl } from '../../lib/media/url';
import { versionFile } from '../../lib/storage/document';
import { withLock } from '../../lib/storage/lock';

const STANDALONE = path.resolve(import.meta.dirname, '../../.next/standalone');
const IMMUTABLE = 'public, max-age=31536000, immutable';
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
            // Any answer means it listens. `/` reads no catalog, so no route has loaded one when this returns.
            await (await fetch(`${base}/`)).arrayBuffer();
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
    /** The base name of a catalog photo's source, which has a legacy derivative in the copy's public/. */
    let legacyBase = '';
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
        library = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-test-library-'));
        // A legacy derivative named after a catalog photo's source, where the image mounts the library.
        const source = Object.values(catalog.registry.photos)[0].source.path;
        legacyBase = path.posix.basename(source, path.posix.extname(source));
        const legacy = path.join(served, 'public/assets/photos/optimized', `${legacyBase}.webp`);
        fs.mkdirSync(path.dirname(legacy), { recursive: true });
        fs.writeFileSync(legacy, 'legacy bytes');
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

    async function published(): Promise<PublishResult> {
        const result = await publish({ dataRoot: catalog!.root, actor: 'test', confirmLaunch: true, logger: quiet });
        expect(result.outcome, result.message).toBe('PUBLISHED');
        return result;
    }

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

        // Before the first activation: legacy mode, and an empty library lists nothing, with no ETag.
        expect(await ready()).toEqual({ mode: 'legacy', state: 'ok', revisionId: null, revisionNumber: null, activatedAt: null });
        expect(await listed('legacy', 'legacy')).toEqual([]);
        for (const url of [...firstUrls, draftUrl]) await expectRefused(url);

        // The first publish lists and serves the published series only, and its tag gets 304.
        first = await published();
        expect(await ready()).toMatchObject({ mode: 'catalog', state: 'ok', revisionId: first.revisionId, revisionNumber: 1 });
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
        const legacyUrl = `/assets/photos/optimized/${encodeURIComponent(legacyBase)}.webp`;
        const legacy = await fetch(`${base}${legacyUrl}`);
        expect(legacy.status).toBe(404);
        expect(legacy.headers.get('cache-control')).toBe('no-store');
        await legacy.arrayBuffer();
        const optimized = await fetch(`${base}/_next/image?url=${encodeURIComponent(legacyUrl)}&w=400&q=75`);
        expect(optimized.status).toBe(400);
        // Refused by images.localPatterns, before Next reads the file.
        expect(await optimized.text()).toBe('"url" parameter is not allowed');

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
});
