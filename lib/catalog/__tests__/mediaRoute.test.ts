// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetRef } from '../../media/url';
import { publish } from '../publish';
import { createTestCatalog } from '../testing';
import { VARIANT_BYTES } from './catalogFixtures';

vi.mock('next/server', async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    // Outside Next there is no request scope, and the route only needs it to wait.
    connection: vi.fn(async () => undefined),
}));

const { GET } = await import('../../../app/media/[photoId]/[assetRevision]/[profileId]/[variant]/route');

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function get(ref: AssetRef): Promise<Response> {
    const segments = { ...ref, variant: 'w800.webp' };
    const url = `http://localhost/media/${ref.photoId}/${ref.assetRevision}/${ref.profileId}/${segments.variant}`;
    return GET(new Request(url), { params: Promise.resolve(segments) });
}

describe('/media under the catalog', { timeout: 60_000 }, () => {
    it('serves a set only while the active revision holds the photo at that asset revision and profile', async () => {
        const catalog = await createTestCatalog({ variantBytes: VARIANT_BYTES, seed: 31 });
        cleanups.push(() => catalog.cleanup());
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', catalog.root);
        const [photo] = catalog.content.photos;
        const ref: AssetRef = { photoId: photo.id, assetRevision: photo.assetRevision, profileId: photo.profileId };

        // Its files are there, but nothing is public before the first activation.
        expect((await get(ref)).status).toBe(404);

        const published = await publish({ dataRoot: catalog.root, actor: 'test', confirmLaunch: true, logger: { log: () => undefined } });
        expect(published.outcome).toBe('PUBLISHED');
        const served = await get(ref);
        expect(served.status).toBe(200);
        expect(served.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

        for (const other of [{ ...ref, profileId: `p_${'f'.repeat(16)}` }, { ...ref, assetRevision: `sha256-${'f'.repeat(64)}` }]) {
            const refused = await get(other);
            expect(refused.status).toBe(404);
            expect(refused.headers.get('cache-control')).toBe('no-store');
        }
    });

    // #14's 14-2: the curator boundary grants no asset. Any curator-only
    // asset access comes through requireCurator() on curator routes, never
    // through /media, so the curator's own process 404s an unpublished set too.
    it('404s an unpublished set with the curator on and a curator Host and Origin', async () => {
        const catalog = await createTestCatalog({ variantBytes: VARIANT_BYTES, seed: 32 });
        cleanups.push(() => catalog.cleanup());
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', catalog.root);
        vi.stubEnv('CURATION_ENABLED', 'true');
        vi.stubEnv('HOSTNAME', '127.0.0.1');
        const [photo] = catalog.content.photos;
        const url = `http://127.0.0.1:3001/media/${photo.id}/${photo.assetRevision}/${photo.profileId}/w800.webp`;
        const segments = { photoId: photo.id, assetRevision: photo.assetRevision, profileId: photo.profileId, variant: 'w800.webp' };
        const response = await GET(new Request(url, { headers: { host: '127.0.0.1:3001', origin: 'http://127.0.0.1:3001' } }), { params: Promise.resolve(segments) });
        expect(response.status).toBe(404);
        expect(response.headers.get('cache-control')).toBe('no-store');
    });
});
