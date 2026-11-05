// @vitest-environment node
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetRef } from '../../media/url';
import { publish } from '../publish';
import { runPurge, runRevoke } from '../purge';
import { runGc } from '../retention';
import { rollback } from '../rollback';
import { createTestCatalog } from '../testing';
import { VARIANT_BYTES } from './catalogFixtures';
import { cleanupPurgeTemplates, purgeFixture, quiet } from './purgeFixtures';

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

afterAll(() => cleanupPurgeTemplates());

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

    // #181's A10: a purge from `tools` shows on web's next request, as 410 no-store, before and after GC, and a revoke undoes it.
    it('answers 410 no-store for a set a standing tombstone lists, before and after GC, and serves it again after a revoke', async () => {
        const built = await purgeFixture(410);
        cleanups.push(async () => built.cleanup());
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', built.root);
        const d: AssetRef = { photoId: built.d, assetRevision: built.first[built.d], profileId: built.profileId };
        const a: AssetRef = { photoId: built.a, assetRevision: built.first[built.a], profileId: built.profileId };
        expect((await get(d)).status).toBe(404);
        expect((await get(a)).status).toBe(200);

        // GC's grace runs from the later of createdAt and the tombstone file's ctime, so the clock starts now.
        const T0 = Date.now();
        const purged = await runPurge({ dataRoot: built.root, photoId: built.d, reason: 'model release withdrawn', actor: 'owner', yes: true, clock: () => T0, logger: quiet });
        expect(purged.outcome).toBe('PURGED');
        const gone = await get(d);
        expect(gone.status).toBe(410);
        expect(gone.headers.get('cache-control')).toBe('no-store');
        expect(await gone.text()).toBe('');
        // Every profile and variant of it, and nothing else.
        expect((await get({ ...d, profileId: `p_${'f'.repeat(16)}` })).status).toBe(410);
        expect((await get(a)).status).toBe(200);

        // Revoked: on the next request it answers as the live revision says, and a rollback to revision 1 brings it back.
        const revoked = await runRevoke({ dataRoot: built.root, tombstoneId: purged.tombstone?.tombstoneId ?? '', reason: 'released after all', actor: 'owner', yes: true, logger: quiet });
        expect(revoked.outcome).toBe('REVOKED');
        expect((await get(d)).status).toBe(404);
        const back = await rollback({ dataRoot: built.root, revisionId: built.revisions[1], expectedActiveRevisionId: built.revisions[3], actor: 'test', reason: 'bring it back', logger: quiet });
        expect(back.outcome).toBe('ROLLED_BACK');
        expect((await get(d)).status).toBe(200);
    });

    it('keeps answering 410 once GC has deleted the files', async () => {
        const built = await purgeFixture(410);
        cleanups.push(async () => built.cleanup());
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', built.root);
        const d: AssetRef = { photoId: built.d, assetRevision: built.first[built.d], profileId: built.profileId };
        // GC's grace runs from the later of createdAt and the tombstone file's ctime, so the clock starts now.
        const T0 = Date.now();
        expect((await runPurge({ dataRoot: built.root, photoId: built.d, reason: 'x', actor: 'owner', yes: true, clock: () => T0, logger: quiet })).outcome).toBe('PURGED');
        const later = () => T0 + 8 * 24 * 60 * 60 * 1000;
        const planned = await runGc({ dataRoot: built.root, clock: later, logger: quiet });
        const applied = await runGc({ dataRoot: built.root, clock: later, logger: quiet, apply: planned.plan?.digest });
        expect(applied.deleted).toEqual([`assets/${d.photoId}/${d.assetRevision}`]);
        const gone = await get(d);
        expect(gone.status).toBe(410);
        expect(gone.headers.get('cache-control')).toBe('no-store');
    });

    it('still 404s a malformed ref before it reads any tombstone', async () => {
        const response = await GET(new Request('http://localhost/media/x/y/z/w800.webp'), { params: Promise.resolve({ photoId: 'x', assetRevision: 'y', profileId: 'z', variant: 'w800.webp' }) });
        expect(response.status).toBe(404);
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
