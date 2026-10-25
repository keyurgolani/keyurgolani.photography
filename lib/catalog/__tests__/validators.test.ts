// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildId, catalogError, catalogETag, catalogJson, readBuildId } from '../validators';

const PHOTOS_URL = 'http://127.0.0.1/api/photos';
const request = (ifNoneMatch?: string) => new Request(PHOTOS_URL, ifNoneMatch === undefined ? {} : { headers: { 'If-None-Match': ifNoneMatch } });
const headersOf = (response: Response) => Object.fromEntries(response.headers);

afterEach(() => {
    vi.restoreAllMocks();
});

describe('catalogETag', () => {
    it('is weak, 22 base64url characters, and changes with the route, revision, or build', () => {
        const tag = catalogETag('/api/photos', 'rev_a', 'build-1');
        expect(tag).toMatch(/^W\/"[A-Za-z0-9_-]{22}"$/);
        expect(catalogETag('/api/photos', 'rev_a', 'build-1')).toBe(tag);
        const others = [catalogETag('/api/photos', 'rev_b', 'build-1'), catalogETag('/api/photos', 'rev_a', 'build-2'), catalogETag('/api/catalog/x', 'rev_a', 'build-1')];
        expect(new Set([tag, ...others]).size).toBe(4);
        // The parts are kept apart, so no split of one string collides with another.
        expect(catalogETag('/a', 'b,c', 'd')).not.toBe(catalogETag('/a', 'b', 'c,d'));
    });
});

describe('readBuildId and buildId', () => {
    it('reads .next/BUILD_ID trimmed, and null when missing or empty', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-id-'));
        try {
            expect(readBuildId(dir)).toBeNull();
            fs.mkdirSync(path.join(dir, '.next'));
            fs.writeFileSync(path.join(dir, '.next', 'BUILD_ID'), '\n');
            expect(readBuildId(dir)).toBeNull();
            fs.writeFileSync(path.join(dir, '.next', 'BUILD_ID'), 'abc123\n');
            expect(readBuildId(dir)).toBe('abc123');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('reads once per process, and without a file gives a random ID, not a shared constant', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-id-'));
        try {
            vi.spyOn(process, 'cwd').mockReturnValue(dir);
            vi.resetModules();
            const fresh = await import('../validators');
            const unbuilt = fresh.buildId();
            expect(unbuilt).toMatch(/^unbuilt-[0-9a-f-]{36}$/);
            vi.resetModules();
            expect((await import('../validators')).buildId()).not.toBe(unbuilt);

            fs.mkdirSync(path.join(dir, '.next'));
            fs.writeFileSync(path.join(dir, '.next', 'BUILD_ID'), 'first');
            vi.resetModules();
            const built = await import('../validators');
            expect(built.buildId()).toBe('first');
            fs.writeFileSync(path.join(dir, '.next', 'BUILD_ID'), 'second');
            expect(built.buildId()).toBe('first');
        } finally {
            vi.resetModules();
            fs.rmSync(dir, { recursive: true, force: true });
        }
        expect(buildId()).toBe(buildId());
    });
});

describe('catalogJson', () => {
    const body = [{ id: 0, src: '/media/x' }];
    const tag = catalogETag('/api/photos', 'rev_a', 'build-1');
    const options = { buildId: 'build-1', headers: { 'X-Catalog-Mode': 'catalog' } };

    it('answers 200 with the body, the weak tag, no-cache, and the revision, and no Last-Modified', async () => {
        const response = await catalogJson(request(), 'rev_a', () => body, options);
        expect(response.status).toBe(200);
        expect(headersOf(response)).toMatchObject({ etag: tag, 'cache-control': 'no-cache', 'x-catalog-revision': 'rev_a', 'x-catalog-mode': 'catalog' });
        expect(response.headers.has('last-modified')).toBe(false);
        expect(await response.json()).toEqual(body);
    });

    it('answers 304 for the current tag, strong or weak, alone, in a list, or *, without building the body', async () => {
        const opaque = tag.slice(2);
        for (const header of [tag, opaque, `"stale", ${tag}`, `W/"stale",${opaque}`, '*']) {
            const build = vi.fn(() => body);
            const response = await catalogJson(request(header), 'rev_a', build, options);
            expect(response.status, header).toBe(304);
            expect(build, header).not.toHaveBeenCalled();
            expect(await response.text()).toBe('');
            expect(headersOf(response)).toEqual({ etag: tag, 'cache-control': 'no-cache', 'x-catalog-revision': 'rev_a', 'x-catalog-mode': 'catalog' });
        }
    });

    it('answers 200 with the new tag for a stale or malformed one', async () => {
        const stale = catalogETag('/api/photos', 'rev_old', 'build-1');
        const oldBuild = catalogETag('/api/photos', 'rev_a', 'build-0');
        for (const header of [stale, oldBuild, `${stale}, ${oldBuild}`, tag.slice(3, -1), `${tag} junk`, '']) {
            const response = await catalogJson(request(header), 'rev_a', () => body, options);
            expect(response.status, header).toBe(200);
            expect(response.headers.get('etag')).toBe(tag);
            expect(await response.json()).toEqual(body);
        }
    });

    it('answers 500 with no-store and no ETag when the body throws, naming no path', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const failure = Object.assign(new Error('/private/data/catalog/revisions/x.json'), { code: 'EACCES' });
        const response = await catalogJson(request(), 'rev_a', () => {
            throw failure;
        }, options);
        expect(response.status).toBe(500);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.has('etag')).toBe(false);
        expect(response.headers.has('x-catalog-revision')).toBe(false);
        expect(await response.json()).toEqual({ reason: 'internal' });
        expect(logged.mock.calls.map((call) => String(call[0]))).toEqual([JSON.stringify({ event: 'catalog.response.failed', route: '/api/photos', error: 'EACCES' })]);
    });
});

describe('catalogError', () => {
    it('sends no-store and no ETag, whatever headers it is given', async () => {
        const response = catalogError(503, { reason: 'active-unreadable' }, { 'X-Catalog-Mode': 'catalog', 'Cache-Control': 'no-cache' });
        expect(response.status).toBe(503);
        expect(headersOf(response)).toMatchObject({ 'cache-control': 'no-store', 'x-catalog-mode': 'catalog' });
        expect(response.headers.has('etag')).toBe(false);
        expect(await response.json()).toEqual({ reason: 'active-unreadable' });
    });
});
