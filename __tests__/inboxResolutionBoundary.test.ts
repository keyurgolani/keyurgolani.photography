// @vitest-environment node
import fs from 'node:fs';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCuratorSecrets, type TestCuratorSecrets } from '../test/helpers/curatorSecrets';
import { resetLoginForTests } from '../lib/curation/auth/login';
import { resetSessionsForTests } from '../lib/curation/auth/sessions';
import type { CurationEvent } from '../lib/curation/events';
import { listEvents } from '../lib/curation/repository';
import { archiveMissing } from '../lib/curation/resolutions';
import { IDLE, type InboxActionState } from '../lib/curation/inbox-view';
import { createMissingWorld, removeMissingTemplate } from '../lib/curation/__tests__/missingWorld';
import { createWorld, makeImages, P_PATH, removeTemplate, treeBytes, type Images } from '../lib/curation/__tests__/replacementWorld';
import { proxy } from '../proxy';

// #118: Confirm and Archive write the draft from the inbox, and Archive is a takedown at the next publish, so both
// are held to the curator's two gates now that the curator can be on the home network (#137): a live session, and an
// Origin naming the curator's own host. Each is refused from a request with no session and from a cross-origin
// Origin, by proxy() as the request arrives and by requireCurator() in the server action itself, with a real form
// for a real item that every other check would let through, and nothing is written. With both gates passing, the
// same form writes, so each refusal is the gate's. __tests__/routeInventory.test.ts calls every curator action, these
// included, with each of the boundary's checks failing; this is the same refusal with a form that would work.
// #17's Restore and Release are held to the same two gates: Restore writes a restore decision for the watcher, and
// Release a confirm-missing on the item.

/** The request headers requireCurator() reads through next/headers. */
let requestHeaders = new Headers();
vi.mock('next/headers', () => ({ headers: async () => requestHeaders }));
// A finished action refreshes the page, which needs a Next request; there is none here.
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
const { archiveItem, confirmItem, releaseItem, restoreItem } = await import('../app/curation/inbox/actions');

const CURATOR_HOST = '127.0.0.1:3001';
const CURATOR_ORIGIN = `http://${CURATOR_HOST}`;
/** A 42-hex server action ID, the shape Next sends in Next-Action. */
const ACTION_ID = '7f'.repeat(21);

let secrets: TestCuratorSecrets;
let images: Images;
const cleanups: (() => void | Promise<void>)[] = [];

beforeAll(async () => {
    secrets = await makeCuratorSecrets();
    images = await makeImages();
}, 60_000);

afterAll(() => {
    secrets.cleanup();
    removeTemplate();
    removeMissingTemplate();
});

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

/** The two refusals the reviewer asked for, and the request every check lets through. */
const REQUESTS = {
    'no session': () => ({ host: CURATOR_HOST, origin: CURATOR_ORIGIN, 'next-action': ACTION_ID }),
    'a cross-origin Origin': () => ({ host: CURATOR_HOST, origin: 'https://attacker.example', 'next-action': ACTION_ID, cookie: secrets.cookie() }),
    allowed: () => ({ host: CURATOR_HOST, origin: CURATOR_ORIGIN, 'next-action': ACTION_ID, cookie: secrets.cookie() }),
} as const;

/** The proxy's answer for the inbox's action post, as the browser sends it: the form as the body. */
function post(headers: Record<string, string>, form: FormData): Response {
    return proxy(new NextRequest(new URL('/curation/inbox', CURATOR_ORIGIN), { method: 'POST', headers: new Headers(headers), body: form }));
}

/** How a server action ended: its answer, or what it threw. */
async function run(headers: Record<string, string>, action: (previous: InboxActionState, form: FormData) => Promise<InboxActionState>, form: FormData): Promise<unknown> {
    requestHeaders = new Headers(headers);
    try {
        return await action(IDLE, form);
    } catch (error) {
        return error;
    }
}

const isNotFound = (error: unknown) => typeof error === 'object' && error !== null && 'digest' in error && String((error as { digest: unknown }).digest).startsWith('NEXT_HTTP_ERROR_FALLBACK;404');

/** The page's form for `event`, as ItemActions sends it. */
function pageForm(event: CurationEvent, base: string, extra: Record<string, string> = {}): FormData {
    const form = new FormData();
    for (const [name, value] of Object.entries({ eventId: event.id, version: String(event.version), base, ...extra })) form.set(name, value);
    return form;
}

describe('Confirm, Archive, Restore and Release at the curator boundary (#118, #17)', { timeout: 60_000 }, () => {
    /** A replacement whose new derivatives are built, so Confirm would go through. */
    async function confirmable() {
        const w = await createWorld(images);
        cleanups.push(() => w.cleanup());
        await w.build(w.job(w.b));
        const event = await w.event();
        return { root: w.root, form: () => pageForm(event, w.revisionId, { intent: 'confirm' }), action: confirmItem };
    }

    /** A missing source with a reason and its second step, so Archive would go through. */
    async function archivable() {
        const w = await createMissingWorld(images);
        cleanups.push(() => w.cleanup());
        fs.rmSync(w.lib.file(P_PATH));
        await w.pass();
        const event = await w.event(w.missingId);
        return { root: w.root, form: () => pageForm(event, w.revisionId, { intent: 'archive', reason: 'Gone for good.', confirmed: 'yes' }), action: archiveItem };
    }

    /** P's file out of the world's own temp library, as archivable() takes it. */
    const takeP = (w: Awaited<ReturnType<typeof createMissingWorld>>) => fs.rmSync(w.lib.file(P_PATH));

    /** #17: P archived, then its bytes back at another path, so Restore on that new photograph would go through. */
    async function restorable() {
        const w = await createMissingWorld(images);
        cleanups.push(() => w.cleanup());
        takeP(w);
        await w.pass();
        const missing = await w.event(w.missingId);
        expect(await archiveMissing({ root: w.root, eventId: missing.id, expectedVersion: missing.version, expectedBase: w.revisionId, actor: 'curator:test' })).toMatchObject({ ok: true });
        await w.pass();
        fs.mkdirSync(w.lib.file('returned'));
        fs.writeFileSync(w.lib.file('returned/landscape.jpg'), images.original);
        await w.pass();
        const event = (await listEvents(w.root)).events.find((entry) => entry.type === 'new' && entry.derivedFacts.sourcePath === 'returned/landscape.jpg') as CurationEvent;
        return { root: w.root, form: () => pageForm(event, w.revisionId, { intent: 'restore' }), action: restoreItem };
    }

    /** #17: a missing source, so Release, confirm-missing, would go through. */
    async function releasable() {
        const w = await createMissingWorld(images);
        cleanups.push(() => w.cleanup());
        takeP(w);
        await w.pass();
        const event = await w.event(w.missingId);
        return { root: w.root, form: () => pageForm(event, w.revisionId, { intent: 'release', reason: 'Gone for good.' }), action: releaseItem };
    }

    const ITEMS = { Confirm: confirmable, Archive: archivable, Restore: restorable, Release: releasable } as const;

    for (const [label, make] of Object.entries(ITEMS)) {
        it(`refuses ${label} from a request with no session, in proxy() with a 401 and in requireCurator(), writing nothing`, async () => {
            const item = await make();
            const before = treeBytes(item.root);
            expect((await post(REQUESTS['no session'](), item.form())).status).toBe(401);
            expect(isNotFound(await run(REQUESTS['no session'](), item.action, item.form()))).toBe(true);
            expect(treeBytes(item.root)).toEqual(before);
        });

        it(`refuses ${label} from a cross-origin Origin, with a live session, in proxy() with a 403 and in requireCurator(), writing nothing`, async () => {
            const item = await make();
            const before = treeBytes(item.root);
            expect((await post(REQUESTS['a cross-origin Origin'](), item.form())).status).toBe(403);
            expect(isNotFound(await run(REQUESTS['a cross-origin Origin'](), item.action, item.form()))).toBe(true);
            expect(treeBytes(item.root)).toEqual(before);
        });

        it(`lets the same ${label} form through once both gates pass, so the refusals above are the gates'`, async () => {
            const item = await make();
            const before = treeBytes(item.root);
            expect((await post(REQUESTS.allowed(), item.form())).headers.get('x-middleware-next')).toBe('1');
            expect(await run(REQUESTS.allowed(), item.action, item.form())).toMatchObject({ status: 'done', action: label.toLowerCase() });
            expect(treeBytes(item.root)).not.toEqual(before);
        });
    }
});
