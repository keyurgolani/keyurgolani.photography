// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveCatalog } from '@/lib/catalog/public-reader';
import { encodeSeriesCursor } from '@/lib/catalog/cursor';
import { createCatalogReader, type CatalogContent } from '@/lib/catalog/reader';
import { buildTestCatalog, type TestCatalogContent } from '@/lib/catalog/testing';

// #6's two continuation endpoints over HTTP: status, body, and cache
// headers for every answer, on a reader the tests serve as the active
// catalog. lib/catalog/__tests__/seriesContinuation.test.ts and home.test.ts
// cover what each page holds.

const state = vi.hoisted(() => ({ catalog: null as unknown, loads: 0, throws: null as Error | null }));

vi.mock('@/lib/catalog/public-reader', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/catalog/public-reader')>();
    return {
        ...actual,
        getActiveCatalog: async () => {
            state.loads += 1;
            if (state.throws) throw state.throws;
            return state.catalog;
        },
    };
});

const seriesRoute = await import('../api/catalog/series/[slug]/pages/[cursor]/route');
const homeRoute = await import('../api/catalog/home/photos/[photoId]/route');

const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LONG = Array.from({ length: 250 }, (_, n) => id(n + 1));
const FEATURED = Array.from({ length: 5 }, (_, n) => id(n + 301));
const DRAFT = [id(401)];
const REVISION_B = `rev_${'b'.repeat(64)}`;

let fixture: TestCatalogContent;
let logged: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
    fixture = await buildTestCatalog({
        seed: 67,
        photos: [...LONG, ...FEATURED, ...DRAFT].map((photoId) => ({ id: photoId })),
        series: [
            { id: 'ser_fixture-featured', slug: 'fixture-featured', photoIds: FEATURED },
            { id: 'ser_fixture-long', slug: 'fixture-long', slugAliases: ['old-fixture-long'], photoIds: LONG },
            { id: 'ser_fixture-draft', slug: 'fixture-draft', photoIds: DRAFT, visibility: 'draft' },
        ],
    });
}, 60_000);

beforeEach(() => {
    logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    state.catalog = served();
    state.loads = 0;
    state.throws = null;
});

afterEach(() => {
    vi.restoreAllMocks();
});

function served(revisionId = fixture.revisionId, content: CatalogContent = fixture.content, servedState: 'ok' | 'degraded' = 'ok'): ActiveCatalog {
    return {
        mode: 'catalog',
        state: servedState,
        reader: createCatalogReader(content, { revisionId, revisionNumber: 2 }),
        active: { revisionId, revisionNumber: 2, activationId: 'act_fixture', activatedAt: null },
    } as unknown as ActiveCatalog;
}

const cursor = (offset: number, seriesId = 'ser_fixture-long', revisionId = fixture.revisionId) => encodeSeriesCursor({ revisionId, seriesId, offset });

function seriesGET(slug: string, text: string, headers: Record<string, string> = {}): Promise<Response> {
    const request = new Request(`http://127.0.0.1/api/catalog/series/${slug}/pages/${text}`, { headers });
    return seriesRoute.GET(request, { params: Promise.resolve({ slug, cursor: text }) });
}

function homeGET(photoId: string, query: string, headers: Record<string, string> = {}): Promise<Response> {
    const request = new Request(`http://127.0.0.1/api/catalog/home/photos/${photoId}${query}`, { headers });
    return homeRoute.GET(request, { params: Promise.resolve({ photoId }) });
}

/** An error answer: the status, a fixed body, `no-store`, and no ETag, revision, or mode header. */
async function expectError(response: Response, status: number, body: unknown): Promise<void> {
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.has('etag')).toBe(false);
    expect(response.headers.has('x-catalog-revision')).toBe(false);
    expect(response.headers.has('x-catalog-mode')).toBe(false);
    expect(await response.json()).toEqual(body);
}

async function headersAndBody(response: Response) {
    return { status: response.status, headers: [...response.headers.entries()], body: await response.text() };
}

describe('both endpoints', () => {
    it('render per request and set no revalidate', () => {
        for (const route of [seriesRoute, homeRoute]) {
            expect(route.dynamic).toBe('force-dynamic');
            expect('revalidate' in route).toBe(false);
        }
    });
});

describe('GET /api/catalog/series/[slug]/pages/[cursor]', () => {
    it('answers a page with no-cache, a weak revision ETag, and the revision', async () => {
        const response = await seriesGET('fixture-long', cursor(100));
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-cache');
        expect(response.headers.get('etag')).toMatch(/^W\/"[A-Za-z0-9_-]{22}"$/);
        expect(response.headers.get('x-catalog-revision')).toBe(fixture.revisionId);
        expect(response.headers.get('cache-control')).not.toMatch(/s-maxage|stale-while-revalidate|max-age/);
        const body = await response.json();
        expect(Object.keys(body).sort()).toEqual(['entries', 'nextHref', 'revisionId']);
        expect(body.revisionId).toBe(fixture.revisionId);
        expect(body.entries.map((entry: { position: number }) => entry.position)).toEqual(Array.from({ length: 100 }, (_, n) => n + 101));
        expect(body.nextHref).toBe(`/api/catalog/series/fixture-long/pages/${cursor(200)}`);
        const last = await (await seriesGET('fixture-long', cursor(200))).json();
        expect([last.entries.length, last.nextHref]).toEqual([50, null]);
    });

    it('answers 304 to its own ETag, and each page has its own', async () => {
        const two = (await seriesGET('fixture-long', cursor(100))).headers.get('etag') as string;
        const three = (await seriesGET('fixture-long', cursor(200))).headers.get('etag') as string;
        expect(two).not.toBe(three);
        const again = await seriesGET('fixture-long', cursor(100), { 'If-None-Match': two });
        expect(again.status).toBe(304);
        expect(again.headers.get('etag')).toBe(two);
        expect(await again.text()).toBe('');
    });

    it('answers 409 once another revision is served, and never serves the page from it', async () => {
        state.catalog = served(REVISION_B);
        for (const slug of ['fixture-long', 'fixture-unknown']) await expectError(await seriesGET(slug, cursor(100)), 409, { reason: 'revision-changed' });
    });

    it('answers 400 for a malformed cursor, another series\' cursor, and an offset out of range', async () => {
        for (const text of ['x', 'A'.repeat(257), cursor(100, 'ser_fixture-featured'), cursor(150), cursor(250), cursor(1000)]) {
            await expectError(await seriesGET('fixture-long', text), 400, { reason: 'bad-request' });
        }
    });

    it('reads no catalog for a malformed slug or cursor', async () => {
        await seriesGET('Fixture-Long', cursor(100));
        await seriesGET('fixture-long', 'not+base64url');
        expect(state.loads).toBe(0);
    });

    it('answers one identical 404 for every slug #5 doesn\'t serve, in catalog and legacy mode', async () => {
        const answers = [];
        for (const slug of ['fixture-unknown', 'fixture-draft', 'old-fixture-long', 'Fixture-Long']) answers.push(await headersAndBody(await seriesGET(slug, cursor(100))));
        state.catalog = { mode: 'legacy' };
        answers.push(await headersAndBody(await seriesGET('fixture-long', cursor(100))));
        expect(answers[0].status).toBe(404);
        expect(JSON.parse(answers[0].body)).toEqual({ reason: 'not-found' });
        for (const answer of answers) expect(answer).toEqual(answers[0]);
    });

    it('answers 503 with the reason while the catalog is unavailable', async () => {
        state.catalog = { mode: 'catalog', state: 'unavailable', reason: 'active-unreadable' };
        await expectError(await seriesGET('fixture-long', cursor(100)), 503, { reason: 'active-unreadable' });
    });

    it('serves a degraded catalog\'s last revision', async () => {
        state.catalog = served(fixture.revisionId, fixture.content, 'degraded');
        expect((await seriesGET('fixture-long', cursor(100))).status).toBe(200);
    });

    it('answers 500 with no-store and a path-free log line when reading the catalog throws', async () => {
        state.throws = Object.assign(new Error('/private/data/catalog/active.json is unreadable'), { code: 'EIO' });
        await expectError(await seriesGET('fixture-long', cursor(100)), 500, { reason: 'internal' });
        expect(logged).toHaveBeenCalledTimes(1);
        const line = String(logged.mock.calls[0][0]);
        expect(JSON.parse(line)).toEqual({ event: 'catalog.response.failed', route: '/api/catalog/series/[slug]/pages/[cursor]', error: 'EIO' });
        expect(line).not.toContain('/private');
    });
});

describe('GET /api/catalog/home/photos/[photoId]', () => {
    const revision = (value = fixture.revisionId) => `?revision=${value}`;

    it('answers the window around the photograph with no-cache, a weak revision ETag, and the revision', async () => {
        const response = await homeGET(FEATURED[0], revision());
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-cache');
        expect(response.headers.get('etag')).toMatch(/^W\/"[A-Za-z0-9_-]{22}"$/);
        expect(response.headers.get('x-catalog-revision')).toBe(fixture.revisionId);
        const body = await response.json();
        expect(body.revisionId).toBe(fixture.revisionId);
        expect(body.photos.map((photo: { id: string }) => photo.id)).toEqual([FEATURED[4], FEATURED[0], FEATURED[1]]);
    });

    it('answers 304 to its own ETag, and each photograph has its own', async () => {
        const first = (await homeGET(FEATURED[0], revision())).headers.get('etag') as string;
        expect((await homeGET(FEATURED[2], revision())).headers.get('etag')).not.toBe(first);
        expect((await homeGET(FEATURED[0], revision(), { 'If-None-Match': first })).status).toBe(304);
    });

    it('answers 409 when Home\'s revision isn\'t the one served', async () => {
        await expectError(await homeGET(FEATURED[0], revision(REVISION_B)), 409, { reason: 'revision-changed' });
    });

    it('answers 400 for no revision, two of them, or a malformed one, without reading the catalog', async () => {
        for (const query of ['', '?revision=', `?revision=${fixture.revisionId}&revision=${fixture.revisionId}`, '?revision=rev_a', `?rev=${fixture.revisionId}`]) {
            await expectError(await homeGET(FEATURED[0], query), 400, { reason: 'bad-request' });
        }
        expect(state.loads).toBe(0);
    });

    it('answers one identical 404 for a photograph the featured series doesn\'t hold, a malformed ID, and legacy mode', async () => {
        const answers = [];
        for (const photoId of [LONG[0], DRAFT[0], id(999), 'ph_x']) answers.push(await headersAndBody(await homeGET(photoId, revision())));
        state.catalog = { mode: 'legacy' };
        answers.push(await headersAndBody(await homeGET(FEATURED[0], revision())));
        expect(answers[0].status).toBe(404);
        expect(JSON.parse(answers[0].body)).toEqual({ reason: 'not-found' });
        for (const answer of answers) expect(answer).toEqual(answers[0]);
    });

    it('answers 503 while the catalog is unavailable, and 500 with a path-free log line when reading it throws', async () => {
        state.catalog = { mode: 'catalog', state: 'unavailable', reason: 'revision-unreadable' };
        await expectError(await homeGET(FEATURED[0], revision()), 503, { reason: 'revision-unreadable' });
        state.throws = Object.assign(new Error('/private/data is gone'), { code: 'ENOENT' });
        await expectError(await homeGET(FEATURED[0], revision()), 500, { reason: 'internal' });
        expect(JSON.parse(String(logged.mock.calls[0][0]))).toEqual({ event: 'catalog.response.failed', route: '/api/catalog/home/photos/[photoId]', error: 'ENOENT' });
    });
});
