// @vitest-environment node
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCuratorSecrets, type TestCuratorSecrets } from '../test/helpers/curatorSecrets';
import { folderBytes } from '../test/helpers/folderBytes';
import { resetLoginForTests } from '../lib/curation/auth/login';
import { resetSessionsForTests } from '../lib/curation/auth/sessions';
import { createTestCatalog } from '../lib/catalog/testing';
import { readAuthoredRecord } from '../lib/catalog/working-layer';
import { IDLE_SERIES, type SeriesActionState } from '../lib/curation/series-view';
import { proxy } from '../proxy';

// #150's 2a: New series and a series' Save write the draft from the curator, so both are held to the curator's two
// gates, as the Inbox's Confirm and Archive are (__tests__/inboxResolutionBoundary.test.ts): a live session, and an
// Origin naming the curator's own host. Each is refused from a request with no session and from a cross-origin
// Origin, by proxy() as the request arrives and by requireCurator() in the server action itself, with a real form for
// a real series that every other check would let through, and nothing is written. With both gates passing, the same
// form writes, so each refusal is the gate's. __tests__/routeInventory.test.ts calls every curator action, these
// included, with each of the boundary's checks failing; this is the same refusal with a form that would work.

/** The request headers requireCurator() reads through next/headers. */
let requestHeaders = new Headers();
vi.mock('next/headers', () => ({ headers: async () => requestHeaders }));
// A finished action refreshes the page, which needs a Next request; there is none here.
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
const { createSeries, saveSeries } = await import('../app/curation/series/actions');

const CURATOR_HOST = '127.0.0.1:3001';
const CURATOR_ORIGIN = `http://${CURATOR_HOST}`;
/** A 42-hex server action ID, the shape Next sends in Next-Action. */
const ACTION_ID = '7f'.repeat(21);
const SERIES = 'ser_fixture-00';

let secrets: TestCuratorSecrets;
const cleanups: (() => void | Promise<void>)[] = [];

beforeAll(async () => {
    secrets = await makeCuratorSecrets();
});

afterAll(() => secrets.cleanup());

beforeEach(() => {
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

/** The two refusals the issue asks for, and the request every check lets through. */
const REQUESTS = {
    'no session': () => ({ host: CURATOR_HOST, origin: CURATOR_ORIGIN, 'next-action': ACTION_ID }),
    'a cross-origin Origin': () => ({ host: CURATOR_HOST, origin: 'https://attacker.example', 'next-action': ACTION_ID, cookie: secrets.cookie() }),
    allowed: () => ({ host: CURATOR_HOST, origin: CURATOR_ORIGIN, 'next-action': ACTION_ID, cookie: secrets.cookie() }),
} as const;

/** The proxy's answer for the screen's action post, as the browser sends it: the form as the body. */
function post(pathname: string, headers: Record<string, string>, form: FormData): Promise<Response> {
    return proxy(new NextRequest(new URL(pathname, CURATOR_ORIGIN), { method: 'POST', headers: new Headers(headers), body: form }));
}

/** How a server action ended: its answer, or what it threw. */
async function run(headers: Record<string, string>, action: (previous: SeriesActionState, form: FormData) => Promise<SeriesActionState>, form: FormData): Promise<unknown> {
    requestHeaders = new Headers(headers);
    try {
        return await action(IDLE_SERIES, form);
    } catch (error) {
        return error;
    }
}

const isNotFound = (error: unknown) => typeof error === 'object' && error !== null && 'digest' in error && String((error as { digest: unknown }).digest).startsWith('NEXT_HTTP_ERROR_FALLBACK;404');

function formOf(fields: Record<string, string>): FormData {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    return form;
}

/** A data root with one published series, served as the curator's. */
async function root(): Promise<string> {
    const catalog = await createTestCatalog({ seed: 1502, photos: 2, series: [{ id: SERIES, photos: 2, title: 'Harbor', visibility: 'published' }] });
    cleanups.push(() => catalog.cleanup());
    vi.stubEnv('PHOTOGRAPHY_DATA_DIR', catalog.root);
    return catalog.root;
}

describe('New series and Save at the curator boundary (#150)', { timeout: 60_000 }, () => {
    /** New series, from the Series screen. */
    async function creatable() {
        const dataRoot = await root();
        return { root: dataRoot, pathname: '/curation/series', form: () => formOf({ title: 'Night ferries' }), action: createSeries, kind: 'create' };
    }

    /** A rename, from the series' page, at the version it shows. */
    async function editable() {
        const dataRoot = await root();
        const record = (await readAuthoredRecord(dataRoot, 'series', SERIES))!;
        const fields = { seriesId: SERIES, version: String(record.version), title: 'Harbor at first light', statement: record.statement, shortStatement: record.shortStatement, visibility: record.visibility };
        return { root: dataRoot, pathname: `/curation/series/${SERIES}`, form: () => formOf(fields), action: saveSeries, kind: 'edit' };
    }

    const FORMS = { 'New series': creatable, 'a series edit': editable } as const;
    const written = (dataRoot: string) => folderBytes(path.join(dataRoot, 'authored'));

    for (const [label, make] of Object.entries(FORMS)) {
        it(`refuses ${label} from a request with no session, in proxy() with a 401 and in requireCurator(), writing nothing`, async () => {
            const item = await make();
            const before = written(item.root);
            expect((await post(item.pathname, REQUESTS['no session'](), item.form())).status).toBe(401);
            expect(isNotFound(await run(REQUESTS['no session'](), item.action, item.form()))).toBe(true);
            expect(written(item.root)).toEqual(before);
        });

        it(`refuses ${label} from a cross-origin Origin, with a live session, in proxy() with a 403 and in requireCurator(), writing nothing`, async () => {
            const item = await make();
            const before = written(item.root);
            expect((await post(item.pathname, REQUESTS['a cross-origin Origin'](), item.form())).status).toBe(403);
            expect(isNotFound(await run(REQUESTS['a cross-origin Origin'](), item.action, item.form()))).toBe(true);
            expect(written(item.root)).toEqual(before);
        });

        it(`lets the same ${label} form through once both gates pass, so the refusals above are the gates'`, async () => {
            const item = await make();
            const before = written(item.root);
            expect((await post(item.pathname, REQUESTS.allowed(), item.form())).headers.get('x-middleware-next')).toBe('1');
            expect(await run(REQUESTS.allowed(), item.action, item.form())).toMatchObject({ status: 'done', action: item.kind });
            expect(written(item.root)).not.toEqual(before);
        });
    }
});
