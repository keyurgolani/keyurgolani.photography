// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VARIANT_BYTES } from '@/lib/catalog/__tests__/catalogFixtures';
import { publish } from '@/lib/catalog/publish';
import { createTestCatalog } from '@/lib/catalog/testing';
import { catalogPaths, readActivePointer } from '@/lib/catalog/working-layer';
import { versionFile } from '@/lib/storage/document';

// GET /api/ready (#13): which revision the site serves, or why it serves
// none. Since slice E there is no legacy mode behind it: a data root that has
// published nothing answers the same 503 as one that can't be read, with its
// own reason, and never lists the library.

vi.mock('next/server', async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    // Outside Next there is no request scope, and the route only needs it to wait.
    connection: vi.fn(async () => undefined),
}));

const { GET: ready } = await import('../api/ready/route');

const NO_REVISION = { revisionId: null, revisionNumber: null, activatedAt: null };
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

/** A test catalog as PHOTOGRAPHY_DATA_DIR, published unless `launch` is false. */
async function catalogRoot(seed: number, launch = true): Promise<{ root: string; revisionId: string | null }> {
    const catalog = await createTestCatalog({ variantBytes: VARIANT_BYTES, seed });
    cleanups.push(() => catalog.cleanup());
    vi.stubEnv('PHOTOGRAPHY_DATA_DIR', catalog.root);
    if (!launch) return { root: catalog.root, revisionId: null };
    const outcome = await publish({ dataRoot: catalog.root, actor: 'test', confirmLaunch: true, logger: { log: () => undefined } });
    if (outcome.outcome !== 'PUBLISHED') throw new Error(outcome.message);
    return { root: catalog.root, revisionId: outcome.revisionId as string };
}

/** Overwrite the newest version in the pointer's folder, the one readActivePointer() reads, with something that isn't JSON. */
async function damagePointer(root: string): Promise<void> {
    const pointer = await readActivePointer(root);
    if (!pointer) throw new Error('There is no active pointer to damage');
    fs.writeFileSync(versionFile(catalogPaths(root).active, pointer.version), 'not json');
}

async function expectNotPublished(): Promise<void> {
    const response = await ready();
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-catalog-mode')).toBe('catalog');
    expect(response.headers.has('x-catalog-revision')).toBe(false);
    expect(await response.json()).toEqual({ mode: 'catalog', state: 'unavailable', ...NO_REVISION, reason: 'not-published' });
}

describe('GET /api/ready', { timeout: 60_000 }, () => {
    it('answers 503 not-published with no data root, as in production with PHOTOGRAPHY_DATA_DIR unset', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', '');
        await expectNotPublished();
    });

    it('answers 503 not-published on an empty data root, and while nothing is at its path', async () => {
        const root = tempRoot();
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', root);
        await expectNotPublished();
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', path.join(root, 'missing'));
        await expectNotPublished();
    });

    it('answers 503 not-published on a data root with authored records and nothing published yet', async () => {
        await catalogRoot(14, false);
        await expectNotPublished();
    });

    it('names the active revision, then answers 200 as degraded once its pointer turns unreadable, naming no path', async () => {
        const { root, revisionId } = await catalogRoot(12);
        const ok = await ready();
        expect(ok.status).toBe(200);
        expect(ok.headers.get('cache-control')).toBe('no-store');
        expect(ok.headers.get('x-catalog-revision')).toBe(revisionId);
        const body = await ok.json();
        expect(body).toEqual({ mode: 'catalog', state: 'ok', revisionId, revisionNumber: 1, activatedAt: expect.any(String) });

        await damagePointer(root);
        const degraded = await ready();
        expect(degraded.status).toBe(200);
        const text = await degraded.text();
        expect(JSON.parse(text)).toEqual({ ...body, state: 'degraded' });
        expect(text).not.toContain(root);
    });

    it('answers 503 active-unreadable when its pointer is unreadable and no revision loaded before', async () => {
        const { root } = await catalogRoot(13);
        await damagePointer(root);
        const response = await ready();
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ mode: 'catalog', state: 'unavailable', ...NO_REVISION, reason: 'active-unreadable' });
    });
});
