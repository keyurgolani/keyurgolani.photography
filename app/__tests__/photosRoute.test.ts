// @vitest-environment node
/**
 * The /api/photos paths a real catalog can't reach: whatever the route
 * doesn't handle gets a 500 with `no-store`, no ETag, and a path-free log
 * line, in either mode. lib/catalog/__tests__/photosApi.test.ts covers the
 * route on real catalogs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reader = vi.hoisted(() => ({ getActiveCatalog: vi.fn() }));
const projections = vi.hoisted(() => ({ catalogPhotos: vi.fn(), legacyPhotos: vi.fn() }));

vi.mock('../../lib/catalog/public-reader', () => reader);
vi.mock('../../lib/catalog/photos-api', () => projections);

const { GET } = await import('../api/photos/route');

const request = (ifNoneMatch?: string) => new Request('http://127.0.0.1/api/photos', ifNoneMatch === undefined ? {} : { headers: { 'If-None-Match': ifNoneMatch } });
const failure = () => Object.assign(new Error('/private/data/catalog/active.json is unreadable'), { code: 'EIO' });
const CATALOG = { mode: 'catalog', state: 'ok', reader: {}, active: { revisionId: 'rev_a', revisionNumber: 1, activationId: 'act_a', activatedAt: null } };

let logged: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('PHOTOGRAPHY_DATA_DIR', '/nonexistent-data-root');
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    reader.getActiveCatalog.mockReset();
    projections.catalogPhotos.mockReset();
    projections.legacyPhotos.mockReset();
});

/** A 500 with no-store, no ETag or revision, the given mode header, a fixed body, and one log line naming no path. */
async function expectInternal(response: Response, mode: string | null): Promise<void> {
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.has('etag')).toBe(false);
    expect(response.headers.has('x-catalog-revision')).toBe(false);
    expect(response.headers.get('x-catalog-mode')).toBe(mode);
    expect(await response.json()).toEqual({ reason: 'internal' });
    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0][0]);
    expect(JSON.parse(line)).toMatchObject({ event: 'catalog.response.failed', route: '/api/photos' });
    expect(line).not.toContain('/private');
}

describe('GET /api/photos on an unhandled error', () => {
    it('answers 500 with no-store and no mode when reading the catalog throws, whatever If-None-Match says', async () => {
        for (const header of [undefined, '*']) {
            logged.mockClear();
            reader.getActiveCatalog.mockRejectedValueOnce(failure());
            await expectInternal(await GET(request(header)), null);
        }
        expect(JSON.parse(String(logged.mock.calls[0][0])).error).toBe('EIO');
    });

    it('answers 500 naming legacy mode when the legacy list throws', async () => {
        reader.getActiveCatalog.mockResolvedValueOnce({ mode: 'legacy' });
        projections.legacyPhotos.mockRejectedValueOnce(failure());
        await expectInternal(await GET(request()), 'legacy');
    });

    it('answers 500 naming catalog mode when the projection throws or JSON cannot encode it', async () => {
        reader.getActiveCatalog.mockResolvedValueOnce(CATALOG);
        projections.catalogPhotos.mockImplementationOnce(() => {
            throw failure();
        });
        await expectInternal(await GET(request()), 'catalog');

        logged.mockClear();
        reader.getActiveCatalog.mockResolvedValueOnce(CATALOG);
        projections.catalogPhotos.mockReturnValueOnce([{ id: BigInt(1) }]);
        await expectInternal(await GET(request()), 'catalog');
    });

    it('still answers 304 and 200 around it', async () => {
        reader.getActiveCatalog.mockResolvedValue(CATALOG);
        projections.catalogPhotos.mockReturnValue([]);
        const ok = await GET(request());
        expect(ok.status).toBe(200);
        expect((await GET(request(ok.headers.get('etag') as string))).status).toBe(304);
        expect(logged).not.toHaveBeenCalled();
    });
});
