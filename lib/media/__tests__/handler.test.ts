// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { identityPaths } from '../../identity/registry';
import type { AssetManifest } from '../../identity/types';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../../identity/variants';
import { DATA_ROOT_FILE } from '../../storage/config';
import { MANIFEST_FILE } from '../../storage/publish';
import { mediaAccess } from '../access';
import { createMediaHandler, type MediaHandlerOptions } from '../handler';
import { assetDir, mediaFilePath } from '../path';
import type { AssetRef } from '../url';

const REF: AssetRef = {
    photoId: 'ph_00000000-0000-4000-8000-000000000001',
    assetRevision: `sha256-${'a'.repeat(64)}`,
    profileId: 'p_0123456789abcdef',
};
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function dataRoot(state: 'ready' | 'uninitialized' = 'ready'): TempDataRoot {
    const data = createTempDataRoot({ state });
    cleanups.push(() => data.cleanup());
    return data;
}

/** A derivative set for `ref` with random bytes in each file, and a manifest that lists them. Returns the files' bytes. */
function writeSet(root: string, ref: AssetRef = REF): Record<string, Buffer> {
    const dir = assetDir(ref, root);
    fs.mkdirSync(dir, { recursive: true });
    const files: Record<string, Buffer> = {};
    const variants = {} as AssetManifest['variants'];
    for (const width of VARIANT_WIDTHS) {
        variants[width] = {} as AssetManifest['variants'][typeof width];
        for (const format of VARIANT_FORMATS) {
            const data = randomBytes(64 + Number(width.slice(1)) / 10);
            files[`${width}.${format}`] = data;
            fs.writeFileSync(path.join(dir, `${width}.${format}`), data);
            variants[width][format] = { width: 300, height: 200, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
        }
    }
    const manifest: AssetManifest = { schemaVersion: 1, ...ref, variants, lqip: 'data:image/webp;base64,AAAA', createdAt: '2026-03-01T00:00:00.000Z' };
    fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest));
    return files;
}

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

function get(handler: ReturnType<typeof createMediaHandler>, params: Partial<Record<keyof AssetRef | 'variant', string>> = {}, headers: Record<string, string> = {}) {
    const segments = { ...REF, variant: 'w800.webp', ...params };
    const url = `http://localhost/media/${segments.photoId}/${segments.assetRevision}/${segments.profileId}/${segments.variant}`;
    return handler(new Request(url, { headers }), { params: Promise.resolve(segments) });
}

const handlerWith = (options: MediaHandlerOptions = {}) => createMediaHandler({ logger: quiet, ...options });
const allowAll = () => 'public' as const;

/** Whether this platform can make a FIFO: mkfifo runs and makes one in a temp folder. */
const canMkfifo = (() => {
    if (process.platform === 'win32') return false;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fifo-probe-'));
    try {
        execFileSync('mkfifo', [path.join(dir, 'probe')], { stdio: 'ignore' });
        return fs.lstatSync(path.join(dir, 'probe')).isFIFO();
    } catch {
        return false;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
})();

describe('the media route handler', () => {
    it('serves a variant with its type, length, ETag, nosniff, and a year of immutable caching', async () => {
        const data = dataRoot();
        const files = writeSet(data.root);
        const response = await get(handlerWith({ access: allowAll }));
        expect(response.status).toBe(200);
        expect(Object.fromEntries(response.headers)).toEqual({
            'cache-control': 'public, max-age=31536000, immutable',
            'content-length': String(files['w800.webp'].length),
            'content-type': 'image/webp',
            etag: `"${sha(files['w800.webp'])}"`,
            'x-content-type-options': 'nosniff',
        });
        expect(Buffer.from(await response.arrayBuffer()).equals(files['w800.webp'])).toBe(true);
        const avif = await get(handlerWith({ access: allowAll }), { variant: 'w1920.avif' });
        expect(avif.headers.get('content-type')).toBe('image/avif');
        expect(Buffer.from(await avif.arrayBuffer()).equals(files['w1920.avif'])).toBe(true);
    });

    it.each([
        ['the same tag', (tag: string) => tag, 304],
        ['a list holding it, weak', (tag: string) => `"nope", W/${tag}`, 304],
        ['*', () => '*', 304],
        ['another tag', () => '"nope"', 200],
    ])('answers If-None-Match with %s', async (_name, header, status) => {
        const data = dataRoot();
        const files = writeSet(data.root);
        const tag = `"${sha(files['w800.webp'])}"`;
        const response = await get(handlerWith({ access: allowAll }), {}, { 'if-none-match': header(tag) });
        expect(response.status).toBe(status);
        expect(response.headers.get('etag')).toBe(tag);
        expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
        if (status === 304) expect((await response.arrayBuffer()).byteLength).toBe(0);
    });

    it.each([
        ['a malformed photoId', { photoId: 'ph_1' }],
        ['a traversal in the photoId', { photoId: '..' }],
        ['a malformed revision', { assetRevision: 'sha256-zz' }],
        ['a malformed profile', { profileId: 'p_1' }],
        ['a variant no profile has', { variant: 'w500.webp' }],
        ['a format no profile has', { variant: 'w400.png' }],
        ['the manifest', { variant: MANIFEST_FILE }],
        ['an encoded traversal', { variant: '%2e%2e' }],
        ['a nested variant', { variant: 'w400.webp/..' }],
    ])('404s, uncached, %s, without asking the access policy', async (_name, params) => {
        const data = dataRoot();
        writeSet(data.root);
        const policy = vi.fn(allowAll);
        const response = await get(handlerWith({ access: policy }), params);
        expect(response.status).toBe(404);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(policy).not.toHaveBeenCalled();
    });

    it('404s a set without a manifest, and serves it once its manifest is written', async () => {
        const data = dataRoot();
        writeSet(data.root);
        const manifest = path.join(assetDir(REF, data.root), MANIFEST_FILE);
        const saved = fs.readFileSync(manifest);
        fs.rmSync(manifest);
        const handler = handlerWith({ access: allowAll });
        const missing = await get(handler);
        expect(missing.status).toBe(404);
        expect(missing.headers.get('cache-control')).toBe('no-store');
        fs.writeFileSync(manifest, saved);
        expect((await get(handler)).status).toBe(200);
    });

    it('keeps a manifest it found, so it reads each one once', async () => {
        const data = dataRoot();
        writeSet(data.root);
        const handler = handlerWith({ access: allowAll });
        expect((await get(handler)).status).toBe(200);
        fs.rmSync(path.join(assetDir(REF, data.root), MANIFEST_FILE));
        expect((await get(handler, { variant: 'w400.avif' })).status).toBe(200);
        expect((await get(handlerWith({ access: allowAll }))).status).toBe(404);
    });

    it('keeps only the most recent manifests it found', async () => {
        const data = dataRoot();
        const other: AssetRef = { ...REF, photoId: 'ph_00000000-0000-4000-8000-000000000002' };
        writeSet(data.root);
        writeSet(data.root, other);
        const handler = handlerWith({ access: allowAll, cacheSize: 1 });
        expect((await get(handler)).status).toBe(200);
        expect((await get(handler, { photoId: other.photoId })).status).toBe(200);
        fs.rmSync(path.join(assetDir(REF, data.root), MANIFEST_FILE));
        fs.rmSync(path.join(assetDir(other, data.root), MANIFEST_FILE));
        // REF's manifest made room for other's, so only other's is still known.
        expect((await get(handler)).status).toBe(404);
        expect((await get(handler, { photoId: other.photoId })).status).toBe(200);
    });

    it('stops serving, even sets it knows, once the data root is no longer ready', async () => {
        const data = dataRoot();
        writeSet(data.root);
        const handler = handlerWith({ access: allowAll });
        expect((await get(handler)).status).toBe(200);
        fs.rmSync(data.file(DATA_ROOT_FILE));
        const response = await get(handler);
        expect(response.status).toBe(404);
        expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it('404s, and forgets the manifest, when the file is gone', async () => {
        const data = dataRoot();
        writeSet(data.root);
        const handler = handlerWith({ access: allowAll });
        expect((await get(handler)).status).toBe(200);
        fs.rmSync(mediaFilePath(REF, 'w800', 'webp', data.root));
        const gone = await get(handler);
        expect(gone.status).toBe(404);
        expect(gone.headers.get('cache-control')).toBe('no-store');
        // Forgotten: with the manifest gone too, the next request reads the set afresh.
        fs.rmSync(path.join(assetDir(REF, data.root), MANIFEST_FILE));
        expect((await get(handler, { variant: 'w400.webp' })).status).toBe(404);
    });

    it("answers a conditional request with 404, not 304, once the file is gone, though it kept the set's manifest", async () => {
        const data = dataRoot();
        const files = writeSet(data.root);
        const handler = handlerWith({ access: allowAll });
        expect((await get(handler)).status).toBe(200);
        fs.rmSync(mediaFilePath(REF, 'w800', 'webp', data.root));

        const response = await get(handler, {}, { 'If-None-Match': `"${sha(files['w800.webp'])}"` });
        expect(response.status).toBe(404);
        expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it('404s a variant file that is a symlink, even to a copy of the listed bytes', async () => {
        // Made first, since the last temp data root made is the configured one
        const elsewhere = dataRoot();
        const data = dataRoot();
        const files = writeSet(data.root);
        const copy = elsewhere.file('w800.webp');
        fs.writeFileSync(copy, files['w800.webp']);
        const file = mediaFilePath(REF, 'w800', 'webp', data.root);
        fs.rmSync(file);
        fs.symlinkSync(copy, file);

        const response = await get(handlerWith({ access: allowAll }));
        expect(response.status).toBe(404);
        expect(response.headers.get('cache-control')).toBe('no-store');
        // The other files of the set are still served.
        expect((await get(handlerWith({ access: allowAll }), { variant: 'w400.webp' })).status).toBe(200);
    });

    it.each([
        ['set folder', (ref: AssetRef, root: string) => assetDir(ref, root)],
        ['photo folder', (ref: AssetRef, root: string) => path.join(root, 'assets', ref.photoId)],
    ])('404s a set reached through a symlinked %s, even to a complete set', async (_name, linked) => {
        const elsewhere = dataRoot();
        const data = dataRoot();
        writeSet(elsewhere.root);
        fs.mkdirSync(path.dirname(linked(REF, data.root)), { recursive: true });
        fs.symlinkSync(linked(REF, elsewhere.root), linked(REF, data.root));

        const response = await get(handlerWith({ access: allowAll }));
        expect(response.status).toBe(404);
        expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it.skipIf(!canMkfifo).each(['w800.webp', MANIFEST_FILE])('404s at once when %s is a FIFO, instead of waiting for a writer', async (name) => {
        const data = dataRoot();
        writeSet(data.root);
        const fifo = path.join(assetDir(REF, data.root), name);
        fs.rmSync(fifo);
        execFileSync('mkfifo', [fifo]);
        let timer: NodeJS.Timeout | undefined;
        try {
            const answered = await Promise.race([
                get(handlerWith({ access: allowAll })).then((response) => response.status),
                new Promise<'hung'>((resolve) => { timer = setTimeout(() => resolve('hung'), 2_000); }),
            ]);
            expect(answered).toBe(404);
        } finally {
            clearTimeout(timer);
            // Let an open still waiting on the FIFO finish, so no worker thread stays blocked.
            try {
                fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
            } catch {
                // No reader is waiting.
            }
        }
    });

    it('still serves a set when the data root itself is reached through a symlink', async () => {
        const data = dataRoot();
        const files = writeSet(data.root);
        const link = `${data.root}-link`;
        fs.symlinkSync(data.root, link);
        cleanups.push(async () => fs.rmSync(link, { force: true }));
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', link);

        const response = await get(handlerWith({ access: allowAll }));
        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer()).equals(files['w800.webp'])).toBe(true);
    });

    it("404s a file whose size doesn't match its manifest", async () => {
        const data = dataRoot();
        writeSet(data.root);
        fs.appendFileSync(mediaFilePath(REF, 'w800', 'webp', data.root), 'x');
        const warnings: string[] = [];
        const response = await get(handlerWith({ access: allowAll, logger: { ...quiet, warn: (line: string) => { warnings.push(line); } } }));
        expect(response.status).toBe(404);
        expect(warnings).toEqual([expect.stringContaining('w800.webp')]);
    });

    it.each([
        ['uninitialized', (data: TempDataRoot) => fs.rmSync(data.file(DATA_ROOT_FILE))],
        ['from a newer build', (data: TempDataRoot) => fs.writeFileSync(data.file(DATA_ROOT_FILE), JSON.stringify({ schemaVersion: 9, initializedAt: '2026-01-01T00:00:00.000Z' }))],
        ['unset', () => {
            vi.stubEnv('PHOTOGRAPHY_DATA_DIR', '');
            vi.stubEnv('NODE_ENV', 'production');
        }],
    ])('404s when the data root is %s', async (_name, change) => {
        const data = dataRoot();
        writeSet(data.root);
        change(data);
        const response = await get(handlerWith({ access: allowAll }));
        expect(response.status).toBe(404);
        expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it('serves a private set with private, no-store', async () => {
        const data = dataRoot();
        writeSet(data.root);
        const response = await get(handlerWith({ access: () => 'private' }));
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
    });

    it.each([['gone', 410], ['deny', 404]] as const)('answers %s with %i and no-store, without reading the set', async (access, status) => {
        const data = dataRoot();
        writeSet(data.root);
        const policy = vi.fn(() => access);
        const response = await get(handlerWith({ access: policy }));
        expect(response.status).toBe(status);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(policy).toHaveBeenCalledWith(REF, expect.any(Request));
    });

    it('never reads the registry or the library', async () => {
        const data = dataRoot();
        writeSet(data.root);
        fs.mkdirSync(identityPaths(data.root).dir, { recursive: true });
        fs.writeFileSync(identityPaths(data.root).registry, '{ not a registry');
        vi.stubEnv('PHOTOGRAPHY_LIBRARY_DIR', path.join(data.root, '..', 'no-library'));
        expect((await get(handlerWith({ access: allowAll }))).status).toBe(200);
    });
});

describe('mediaAccess', () => {
    const request = new Request('http://localhost/media/x');

    it.each([[undefined], [''], ['deny'], ['yes']])('denies with PHOTOGRAPHY_MEDIA_ACCESS=%s', (value) => {
        vi.stubEnv('PHOTOGRAPHY_MEDIA_ACCESS', value);
        expect(mediaAccess(REF, request)).toBe('deny');
    });

    it('makes every set public with PHOTOGRAPHY_MEDIA_ACCESS=all', () => {
        vi.stubEnv('PHOTOGRAPHY_MEDIA_ACCESS', 'all');
        expect(mediaAccess(REF, request)).toBe('public');
    });

    it.each([
        ['all', 200, 'every derivative set is public'],
        ['yes', 404, "isn't deny or all"],
    ])('the default policy warns once per handler about PHOTOGRAPHY_MEDIA_ACCESS=%s', async (value, status, warning) => {
        vi.stubEnv('PHOTOGRAPHY_MEDIA_ACCESS', value);
        const data = dataRoot();
        writeSet(data.root);
        const warnings: string[] = [];
        const handler = createMediaHandler({ logger: { ...quiet, warn: (line: string) => { warnings.push(line); } } });
        expect((await get(handler)).status).toBe(status);
        expect((await get(handler, { variant: 'w400.webp' })).status).toBe(status);
        expect(warnings).toEqual([expect.stringContaining(warning)]);
    });

    it('the default policy stays quiet under deny', async () => {
        vi.stubEnv('PHOTOGRAPHY_MEDIA_ACCESS', 'deny');
        const warnings: string[] = [];
        const handler = createMediaHandler({ logger: { ...quiet, warn: (line: string) => { warnings.push(line); } } });
        expect((await get(handler)).status).toBe(404);
        expect(warnings).toEqual([]);
    });
});

describe('app/media route', () => {
    it('runs on Node, dynamically, and denies by default', async () => {
        const route = await import('../../../app/media/[photoId]/[assetRevision]/[profileId]/[variant]/route');
        expect(route.runtime).toBe('nodejs');
        expect(route.dynamic).toBe('force-dynamic');
        const data = dataRoot();
        writeSet(data.root);
        vi.stubEnv('PHOTOGRAPHY_MEDIA_ACCESS', '');
        const response = await get(route.GET);
        expect(response.status).toBe(404);
        expect(response.headers.get('cache-control')).toBe('no-store');
    });
});
