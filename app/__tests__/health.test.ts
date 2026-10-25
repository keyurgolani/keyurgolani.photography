// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDataRoot, type TempDataRoot } from '../../test/helpers/tempDataRoot';
import { DATA_ROOT_FILE } from '../../lib/storage/config';
import { dynamic, GET, runtime } from '../api/health/route';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function dataRoot(state: 'ready' | 'uninitialized' | 'missing'): TempDataRoot {
    const data = createTempDataRoot({ state });
    cleanups.push(() => data.cleanup());
    return data;
}

async function health(): Promise<{ status: number; cacheControl: string | null; text: string; body: unknown }> {
    const response = GET();
    const text = await response.text();
    return { status: response.status, cacheControl: response.headers.get('cache-control'), text, body: JSON.parse(text) };
}

describe('GET /api/health', () => {
    it('answers 200 with only ok and the data root state, for every state, and never caches', async () => {
        const ready = dataRoot('ready');
        expect(await health()).toMatchObject({ status: 200, cacheControl: 'no-store', body: { ok: true, dataRoot: 'ready' } });

        dataRoot('uninitialized');
        expect((await health()).body).toEqual({ ok: true, dataRoot: 'uninitialized' });

        dataRoot('missing');
        expect((await health()).body).toEqual({ ok: true, dataRoot: 'unavailable' });

        fs.writeFileSync(path.join(ready.root, DATA_ROOT_FILE), JSON.stringify({ schemaVersion: 99, initializedAt: '2026-01-01T00:00:00.000Z' }));
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', ready.root);
        expect((await health()).body).toEqual({ ok: true, dataRoot: 'unavailable' });

        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', '');
        expect(await health()).toMatchObject({ status: 200, body: { ok: true, dataRoot: 'unset' } });
    });

    it('names no path, even for a data root it cannot use', async () => {
        for (const state of ['ready', 'missing'] as const) {
            const data = dataRoot(state);
            const { text } = await health();
            expect(text, state).not.toContain(data.root);
            expect(text, state).not.toContain(path.basename(path.dirname(data.root)));
            expect(Object.keys(JSON.parse(text) as object).sort(), state).toEqual(['dataRoot', 'ok']);
        }
    });

    it('reads data-root.json and nothing else in the data root', async () => {
        const data = dataRoot('ready');
        fs.mkdirSync(data.file('identity', 'registry'), { recursive: true });
        fs.writeFileSync(data.file('identity', 'registry', 'v1.json'), '{ not json');
        fs.mkdirSync(data.file('status'));
        fs.writeFileSync(data.file('status', 'watcher.json'), '{ not json');
        const reads = vi.spyOn(fs, 'readFileSync');
        const asyncReads = vi.spyOn(fs.promises, 'readFile');
        const listings = vi.spyOn(fs, 'readdirSync');

        expect((await health()).body).toEqual({ ok: true, dataRoot: 'ready' });
        expect(reads.mock.calls.map(([file]) => file)).toEqual([data.file(DATA_ROOT_FILE)]);
        expect(asyncReads).not.toHaveBeenCalled();
        expect(listings).not.toHaveBeenCalled();
    });

    it("doesn't check whether the data root is writable, since the web process never writes it", async () => {
        const data = dataRoot('ready');
        const access = vi.spyOn(fs, 'accessSync');
        expect((await health()).body).toEqual({ ok: true, dataRoot: 'ready' });
        expect(access.mock.calls.every(([, mode]) => ((mode ?? fs.constants.F_OK) & fs.constants.W_OK) === 0)).toBe(true);
        expect(access.mock.calls.map(([target]) => target)).toContain(data.root);
    });

    it('still answers 200 when the state check throws, as it does once the working directory is gone', async () => {
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', '');
        vi.spyOn(process, 'cwd').mockImplementation(() => {
            throw Object.assign(new Error('ENOENT: no such file or directory, uv_cwd'), { code: 'ENOENT' });
        });
        expect(await health()).toMatchObject({ status: 200, body: { ok: true, dataRoot: 'unavailable' } });
    });

    it('runs on Node at every request', () => {
        expect(runtime).toBe('nodejs');
        expect(dynamic).toBe('force-dynamic');
    });
});
