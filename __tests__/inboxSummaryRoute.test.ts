// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCuratorSecrets, type TestCuratorSecrets } from '../test/helpers/curatorSecrets';
import { setDataDir } from '../test/helpers/tempDataRoot';
import { resetLoginForTests } from '../lib/curation/auth/login';
import { resetSessionsForTests } from '../lib/curation/auth/sessions';
import { eventIdOf, eventKey } from '../lib/curation/events';
import { createCurationSink } from '../lib/curation/sink';
import { createCurationFixture, type CurationFixture } from '../lib/curation/__tests__/curationFixtures';
import { proxy } from '../proxy';

// #14's A8: the Inbox's summary route, which its 60 s poll reads. It's a curator route like the media one: proxy()
// answers a request without a session with a 401, and requireCurator() runs first in the handler itself, before it
// reads the query or the data root. It answers no-store JSON that holds only what the Inbox page already shows, and
// takes GET and nothing else.

let requestHeaders = new Headers();
vi.mock('next/headers', () => ({ headers: async () => requestHeaders }));
const summaries = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../lib/curation/inbox', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/curation/inbox')>();
    return {
        ...actual,
        loadInboxSummary: (...args: Parameters<typeof actual.loadInboxSummary>) => {
            summaries.calls += 1;
            return actual.loadInboxSummary(...args);
        },
    };
});
const route = await import('../app/api/curation/inbox/summary/route');

const CURATOR_HOST = '127.0.0.1:3001';
const CURATOR_ORIGIN = `http://${CURATOR_HOST}`;
const URL_PATH = '/api/curation/inbox/summary';
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };

let secrets: TestCuratorSecrets;
const cleanups: (() => void | Promise<void>)[] = [];

beforeAll(async () => {
    secrets = await makeCuratorSecrets();
}, 60_000);

afterAll(() => secrets.cleanup());

beforeEach(() => {
    summaries.calls = 0;
    vi.stubEnv('CURATION_ENABLED', 'true');
    vi.stubEnv('HOSTNAME', '127.0.0.1');
    for (const name of ['CURATOR_TUNNEL_PORT', 'CURATOR_PUBLISH', 'CURATOR_HOST_PORT', 'CURATOR_EXTRA_HOSTS', 'CURATION_BIND_SCOPE']) vi.stubEnv(name, '');
    for (const [name, value] of Object.entries(secrets.env)) vi.stubEnv(name, value);
});

afterEach(async () => {
    vi.unstubAllEnvs();
    requestHeaders = new Headers();
    resetSessionsForTests();
    resetLoginForTests();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function served(): Promise<{ f: CurationFixture; id: string }> {
    const f = await createCurationFixture({ fresh: 1 });
    cleanups.push(() => f.cleanup());
    cleanups.push(setDataDir(f.root));
    const fact = f.fact('new', f.fresh[0]);
    await createCurationSink({ root: f.root, logger: quiet })([fact]);
    return { f, id: eventIdOf(eventKey('new', fact)) };
}

const signedIn = () => ({ host: CURATOR_HOST, cookie: secrets.cookie() });

/** The handler's answer, or what it threw: requireCurator() throws Next's redirect or not-found. */
async function get(query: string, headers: Record<string, string>): Promise<Response | unknown> {
    requestHeaders = new Headers(headers);
    try {
        return await route.GET(new Request(`${CURATOR_ORIGIN}${URL_PATH}${query}`, { headers }));
    } catch (error) {
        return error;
    }
}

const digest = (error: unknown) => (typeof error === 'object' && error !== null && 'digest' in error ? String((error as { digest: unknown }).digest) : '');

describe('GET /api/curation/inbox/summary', () => {
    it('is refused by proxy() with a 401 without a session, and by requireCurator() before it reads anything', async () => {
        await served();
        const response = proxy(new NextRequest(new URL(URL_PATH, CURATOR_ORIGIN), { headers: new Headers({ host: CURATOR_HOST }) }));
        expect(response.status).toBe(401);
        // No session: the read redirects to the login page. A foreign Host: a 404. Neither reads the inbox.
        expect(digest(await get('', { host: CURATOR_HOST }))).toMatch(/^NEXT_REDIRECT;replace;\/curation\/login/);
        expect(digest(await get('', { host: 'rebound.example:3001', cookie: secrets.cookie() }))).toMatch(/^NEXT_HTTP_ERROR_FALLBACK;404/);
        // A bad query from a stranger is still the stranger's refusal, not a 400 that says the route exists.
        expect(digest(await get('?item=../../etc', { host: CURATOR_HOST }))).toMatch(/^NEXT_REDIRECT/);
        expect(summaries.calls).toBe(0);
    });

    it('answers the counts, the watcher and the open item as no-store JSON, with no path and nothing the page does not show', async () => {
        const { f, id } = await served();
        const response = (await get(`?item=${id}`, signedIn())) as Response;
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toMatch(/no-store/);
        expect(response.headers.get('content-type')).toMatch(/^application\/json/);
        const body = (await response.json()) as Record<string, unknown>;
        expect(Object.keys(body).sort()).toEqual(['arrived', 'cursor', 'item', 'needsJudgment', 'placed', 'readAt', 'state', 'total', 'unplaced', 'unreadable', 'waiting', 'watcher']);
        expect(body).toMatchObject({ state: 'ready', needsJudgment: 1, total: 1, item: { id, version: 1, status: 'open' }, watcher: { state: 'missing' } });
        const text = JSON.stringify(body);
        for (const leak of [f.root, path.sep === '/' ? '/Users/' : 'C:\\', 'trips/', f.fresh[0], 'sha256-', 'GPS']) expect(text).not.toContain(leak);
    });

    it('takes only an item ID in the query, and answers anything else with a no-store 400 before it reads', async () => {
        await served();
        for (const query of ['?item=evt_nope', '?item=../../etc/passwd', `?item=evt_${'a'.repeat(24)}&item=evt_${'b'.repeat(24)}`, '?status=open', '?item=', `?item=evt_${'a'.repeat(24)}&x=1`, '?since=', '?since=-1', '?since=1.5', '?since=01', '?since=2026-02-01T00:00:00.000Z', '?since=1&since=2', `?since=${'9'.repeat(17)}`]) {
            const response = (await get(query, signedIn())) as Response;
            expect(response.status, query).toBe(400);
            expect(response.headers.get('cache-control')).toMatch(/no-store/);
            expect(await response.json()).toEqual({ error: 'bad-query' });
        }
        expect(summaries.calls).toBe(0);
        expect(((await get('', signedIn())) as Response).status).toBe(200);
    });

    it('counts arrivals after a cursor it issued, and refuses one it did not with a no-store 400 (4a)', async () => {
        const { f } = await served();
        const first = (await ((await get('', signedIn())) as Response).json()) as { cursor: number; arrived: null };
        expect(first).toMatchObject({ cursor: 1, arrived: null });
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('processing-failed', null, { reason: 'unsupported-format', path: 'trips/second.heic' })]);
        const again = (await get(`?since=${first.cursor}`, signedIn())) as Response;
        expect(again.status).toBe(200);
        expect(await again.json()).toMatchObject({ cursor: 2, arrived: 1 });
        for (const since of [first.cursor + 5, 999_999]) {
            const forged = (await get(`?since=${since}`, signedIn())) as Response;
            expect(forged.status).toBe(400);
            expect(forged.headers.get('cache-control')).toMatch(/no-store/);
            expect(await forged.json()).toEqual({ error: 'bad-cursor' });
        }
    });

    it('says not-ready, with no path, when the data root is not set up', async () => {
        const { f } = await served();
        cleanups.push(setDataDir(`${f.root}-gone`));
        const response = (await get('', signedIn())) as Response;
        expect(response.status).toBe(503);
        expect(response.headers.get('cache-control')).toMatch(/no-store/);
        expect(JSON.stringify(await response.json())).not.toContain(f.root);
    });

    it('exports GET alone, so Next answers every other method with a 405, and calls requireCurator() first', () => {
        expect(Object.keys(route).filter((name) => /^[A-Z]+$/.test(name))).toEqual(['GET']);
        expect(route.dynamic).toBe('force-dynamic');
        const source = fs.readFileSync(path.join(__dirname, '../app/api/curation/inbox/summary/route.ts'), 'utf8');
        const body = source.slice(source.indexOf('export async function GET'));
        expect(body.indexOf('await requireCurator({ read: true })')).toBeGreaterThan(0);
        expect(body.indexOf('await requireCurator({ read: true })')).toBeLessThan(body.indexOf('searchParams'));
    });
});
