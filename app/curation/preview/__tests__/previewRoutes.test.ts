// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { NextRequest } from 'next/server';
import { isValidElement, type ReactElement } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { VARIANT_BYTES } from '@/lib/catalog/__tests__/catalogFixtures';
import { encodeSeriesCursor } from '@/lib/catalog/cursor';
import { currentDraftId, previewBasePath, previewReaderStateForTests, resetPreviewReaderForTests } from '@/lib/catalog/preview-reader';
import { publish } from '@/lib/catalog/publish';
import { createTestCatalog, type TestCatalog } from '@/lib/catalog/testing';
import { readWorkingLayer } from '@/lib/catalog/working-layer';
import { writeAuthoredRecord } from '@/lib/catalog/working-layer-writer';
import { resetLoginForTests } from '@/lib/curation/auth/login';
import { deleteSession, resetSessionsForTests, SESSION_COOKIE, sessionFromCookies } from '@/lib/curation/auth/sessions';
import { makeCuratorSecrets, type TestCuratorSecrets } from '@/test/helpers/curatorSecrets';
import { proxy } from '@/proxy';
import { resetAboutPortraitReader } from '@/lib/siteConfig/aboutPortrait';
import { SITE_CONFIG_ENV } from '@/lib/siteConfig/dir';
import { resetPortraitVariants } from '@/lib/siteConfig/portraitVariants';

// #16's preview routes, called the way Next calls them, with next/headers
// giving the request's headers: every page, layout, generateMetadata and
// handler refuses an anonymous request before any draft lookup, with the
// same answer for a draft that exists and one that doesn't; a malformed
// draft ID is a 404 that reads nothing under the data root; a signed-in
// curator sees the draft under the preview path; logout revokes. The public
// reader is never called. Test values only.

let requestHeaders = new Headers();
vi.mock('next/headers', () => ({ headers: async () => requestHeaders }));

vi.mock('@/lib/catalog/preview-reader', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/catalog/preview-reader')>();
    return { ...actual, loadPreviewCatalog: vi.fn(actual.loadPreviewCatalog) };
});

const publicReads = vi.hoisted(() => ({ calls: [] as string[] }));
// eslint-disable-next-line no-restricted-syntax -- replaces the public reader with one that fails the test if the preview calls it
vi.mock('@/lib/catalog/public-reader', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/catalog/public-reader')>();
    const refuse = (name: string) => () => {
        publicReads.calls.push(name);
        throw new Error(`The preview read the public catalog through ${name}()`);
    };
    return { ...actual, getActiveCatalog: refuse('getActiveCatalog'), loadActiveCatalog: refuse('loadActiveCatalog'), isAssetPublic: refuse('isAssetPublic') };
});

const { loadPreviewCatalog } = await import('@/lib/catalog/preview-reader');

const HOST = '127.0.0.1:3001';
const UNKNOWN = `rev_${'0'.repeat(64)}`;
const MALFORMED = ['rev_x', `rev_${'A'.repeat(64)}`, `rev_${'a'.repeat(65)}`, '..', 'index.json'];

let secrets: TestCuratorSecrets;
let catalog: TestCatalog;
let draftId: string;
/** The active revision, published before the draft was edited. */
let activeId: string;

const LONG = 'fixture-long';
const DRAFT_TITLE = 'A retitled long series, draft only';

beforeAll(async () => {
    secrets = await makeCuratorSecrets();
    catalog = await createTestCatalog({ variantBytes: VARIANT_BYTES, seed: 162, photos: 104, series: [{ id: 'ser_fixture-long', slug: LONG, photos: 102 }, { slug: 'fixture-short' }] });
    const published = await publish({ dataRoot: catalog.root, actor: 'test', confirmLaunch: true, logger: { log: () => undefined } });
    if (published.outcome !== 'PUBLISHED' || !published.revisionId) throw new Error(`The publish ended ${published.outcome}`);
    activeId = published.revisionId;
    const record = (await readWorkingLayer(catalog.root)).series.find((series) => series.slug === LONG)!;
    await writeAuthoredRecord({ ...structuredClone(record), title: DRAFT_TITLE }, { expectedVersion: record.version, root: catalog.root });
}, 120_000);

afterAll(async () => {
    secrets.cleanup();
    await catalog.cleanup();
});

beforeEach(async () => {
    vi.stubEnv('CURATION_ENABLED', 'true');
    vi.stubEnv('HOSTNAME', '127.0.0.1');
    vi.stubEnv('CURATOR_TUNNEL_PORT', '');
    vi.stubEnv('CURATION_BIND_SCOPE', '');
    vi.stubEnv('PHOTOGRAPHY_DATA_DIR', catalog.root);
    for (const [name, value] of Object.entries(secrets.env)) vi.stubEnv(name, value);
    resetPreviewReaderForTests();
    draftId = (await currentDraftId())!;
    vi.mocked(loadPreviewCatalog).mockClear();
    publicReads.calls = [];
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    requestHeaders = new Headers();
    resetSessionsForTests();
    resetLoginForTests();
    expect(publicReads.calls).toEqual([]);
});

const { default: AboutPage } = await import('@/app/about/AboutPage');

const pages = {
    frame: await import('../[draftId]/page'),
    home: await import('../[draftId]/site/page'),
    work: await import('../[draftId]/site/work/page'),
    series: await import('../[draftId]/site/work/[slug]/page'),
    viewer: await import('../[draftId]/site/work/[slug]/photo/[photoId]/page'),
    about: await import('../[draftId]/site/about/page'),
    frameMissing: await import('../[draftId]/[...missing]/page'),
    siteMissing: await import('../[draftId]/site/[...missing]/page'),
};
const layouts = {
    site: (await import('../[draftId]/site/layout')).default,
    series: (await import('../[draftId]/site/work/[slug]/layout')).default,
};
const handlers = {
    pages: (await import('../[draftId]/site/api/catalog/series/[slug]/pages/[cursor]/route')).GET,
    records: (await import('../[draftId]/site/api/catalog/home/photos/[photoId]/route')).GET,
    peek: (await import('../[draftId]/site/api/catalog/series/[slug]/photos/[photoId]/route')).GET,
    media: (await import('../[draftId]/site/media/[photoId]/[assetRevision]/[profileId]/[variant]/route')).GET,
    portrait: (await import('../[draftId]/site/about/portrait/[token]/[variant]/route')).GET,
};

const firstPhoto = () => catalog.content.photos.find((photo) => photo.id === catalog.content.series.find((series) => series.slug === LONG)!.photoIds[0])!;

/** A request from the tunnel, signed in or not, optionally as an RSC fetch. */
function as(cookie: string | null, extra: Record<string, string> = {}) {
    requestHeaders = new Headers({ host: HOST, ...(cookie ? { cookie } : {}), ...extra });
}

/** What a call answered: a rendered element, a Response, or the digest of what it threw (notFound, redirect). */
type Outcome = { kind: 'element'; element: ReactElement } | { kind: 'response'; status: number; headers: [string, string][]; body: string } | { kind: 'thrown'; digest: string };

async function outcome(run: () => unknown): Promise<Outcome> {
    try {
        const value = await run();
        if (value instanceof Response) return { kind: 'response', status: value.status, headers: [...value.headers.entries()].sort(), body: await value.text() };
        if (isValidElement(value)) return { kind: 'element', element: value };
        throw new Error(`Unexpected answer ${String(value)}`);
    } catch (error) {
        const digest = (error as { digest?: unknown }).digest;
        if (typeof digest === 'string') return { kind: 'thrown', digest };
        throw error;
    }
}

const LOGIN_REDIRECT = expect.stringMatching(/^NEXT_REDIRECT;replace;\/curation\/login;307;/);
/** #87: a request that sent a session cookie, forged or ended, is told the session ended. */
const ENDED_REDIRECT = expect.stringMatching(/^NEXT_REDIRECT;replace;\/curation\/login\?ended=1;307;/);
const NOT_FOUND = 'NEXT_HTTP_ERROR_FALLBACK;404';

const params = <T extends object>(value: T) => ({ params: Promise.resolve(value) });
const url = (path: string) => new Request(`http://${HOST}${path}`, { headers: requestHeaders });

/** Every preview entry point for one draft ID, as Next would call it. */
function surfaces(id: string): Record<string, () => unknown> {
    const photo = firstPhoto();
    const cursor = /^rev_[0-9a-f]{64}$/.test(id) ? encodeSeriesCursor({ revisionId: id, seriesId: 'ser_fixture-long', offset: 100 }) : 'x';
    const media = { draftId: id, photoId: photo.id, assetRevision: photo.assetRevision, profileId: photo.profileId, variant: 'w400.avif' };
    return {
        'frame page': () => pages.frame.default(params({ draftId: id })),
        'frame metadata': () => pages.frame.generateMetadata(),
        'site layout': () => layouts.site({ children: null, params: Promise.resolve({ draftId: id }) }),
        'series layout': () => layouts.series({ children: null }),
        home: () => pages.home.default(params({ draftId: id })),
        'home metadata': () => pages.home.generateMetadata(),
        work: () => pages.work.default(params({ draftId: id })),
        series: () => pages.series.default(params({ draftId: id, slug: LONG })),
        'series metadata': () => pages.series.generateMetadata(params({ draftId: id, slug: LONG })),
        viewer: () => pages.viewer.default(params({ draftId: id, slug: LONG, photoId: photo.id })),
        'viewer metadata': () => pages.viewer.generateMetadata(params({ draftId: id, slug: LONG, photoId: photo.id })),
        about: () => pages.about.default(params({ draftId: id })),
        'unmatched frame path': () => pages.frameMissing.default(),
        'unmatched frame path metadata': () => pages.frameMissing.generateMetadata(),
        'unmatched site path': () => pages.siteMissing.default(),
        'unmatched site path metadata': () => pages.siteMissing.generateMetadata(),
        'load-more': () => handlers.pages(url(`${previewBase(id)}/api/catalog/series/${LONG}/pages/${cursor}`), params({ draftId: id, slug: LONG, cursor })),
        'home records': () => handlers.records(url(`${previewBase(id)}/api/catalog/home/photos/${photo.id}?revision=${id}`), params({ draftId: id, photoId: photo.id })),
        image: () => handlers.media(url(`${previewBase(id)}/media/${photo.id}/${photo.assetRevision}/${photo.profileId}/w400.avif`), params(media)),
        // About's portrait, through the preview's own copy of its route. A made-up token: the session check comes first.
        portrait: () => handlers.portrait(url(`${previewBase(id)}/about/portrait/${'0'.repeat(32)}/w800.webp`), params({ draftId: id, token: '0'.repeat(32), variant: 'w800.webp' })),
        // 9a's Viewer peek, which the Viewer asks for once a finger goes down on the photograph.
        peek: () => handlers.peek(url(`${previewBase(id)}/api/catalog/series/${LONG}/photos/${photo.id}?revision=${id}`), params({ draftId: id, slug: LONG, photoId: photo.id })),
    };
}

const previewBase = (id: string) => `/curation/preview/${id}/site`;

describe('without a session', () => {
    it.each([null, `${SESSION_COOKIE}=forged`])('answers every preview entry point the same for an existing, an unknown and a malformed draft, before any draft lookup (cookie %j)', async (cookie) => {
        for (const extra of [{}, { rsc: '1' }] as Record<string, string>[]) {
            as(cookie, extra);
            const existing = surfaces(draftId);
            for (const id of [UNKNOWN, ...MALFORMED]) {
                const other = surfaces(id);
                for (const name of Object.keys(existing)) {
                    const a = await outcome(existing[name]);
                    const b = await outcome(other[name]);
                    expect(a, `${name} ${id}`).toEqual(b);
                    expect(a, name).toEqual({ kind: 'thrown', digest: cookie === null ? LOGIN_REDIRECT : ENDED_REDIRECT });
                }
            }
        }
        expect(loadPreviewCatalog).not.toHaveBeenCalled();
    });

    it('checks the session before any kept compile is read, so logout denies the subresources at once', async () => {
        const cookie = secrets.cookie();
        as(cookie);
        // Warm the cache through the subresources themselves.
        for (const name of ['load-more', 'home records', 'peek', 'image']) expect(await outcome(surfaces(draftId)[name]), name).toMatchObject({ kind: 'response', status: 200 });
        const state = previewReaderStateForTests();
        expect(state.kept.size).toBeGreaterThan(0);
        deleteSession(sessionFromCookies(cookie, secrets.sessionKey)!);
        const reads = [vi.spyOn(state.kept, 'get'), vi.spyOn(state.kept, 'has'), vi.spyOn(state.compiling, 'get')];
        vi.mocked(loadPreviewCatalog).mockClear();
        for (const name of ['load-more', 'home records', 'peek', 'image']) expect(await outcome(surfaces(draftId)[name]), name).toEqual({ kind: 'thrown', digest: ENDED_REDIRECT });
        for (const spy of reads) expect(spy).not.toHaveBeenCalled();
        expect(loadPreviewCatalog).not.toHaveBeenCalled();
    });

    it('answers after logout as for any ended session: the session is revoked', async () => {
        const cookie = secrets.cookie();
        as(cookie);
        expect((await outcome(surfaces(draftId).home)).kind).toBe('element');
        deleteSession(sessionFromCookies(cookie, secrets.sessionKey)!);
        for (const [name, run] of Object.entries(surfaces(draftId))) expect(await outcome(run), name).toEqual({ kind: 'thrown', digest: ENDED_REDIRECT });
    });
});

describe('a malformed draft ID, signed in', () => {
    it.each(MALFORMED)('is a 404 everywhere for %j, with nothing read under the data root', async (id) => {
        as(secrets.cookie());
        const reads: string[] = [];
        const record = (name: string) => (target: unknown) => {
            if (String(target).startsWith(catalog.root)) reads.push(`${name} ${String(target)}`);
        };
        for (const name of ['statSync', 'lstatSync', 'readFileSync', 'readdirSync', 'existsSync', 'openSync', 'realpathSync'] as const) {
            const original = fs[name] as (...args: unknown[]) => unknown;
            vi.spyOn(fs, name).mockImplementation(((...args: unknown[]) => {
                record(name)(args[0]);
                return original(...args);
            }) as never);
        }
        for (const name of ['stat', 'lstat', 'readFile', 'readdir', 'open', 'realpath', 'access'] as const) {
            const original = fs.promises[name] as (...args: unknown[]) => unknown;
            vi.spyOn(fs.promises, name).mockImplementation(((...args: unknown[]) => {
                record(`promises.${name}`)(args[0]);
                return original(...args);
            }) as never);
        }
        for (const [name, run] of Object.entries(surfaces(id))) {
            if (name.endsWith('metadata')) {
                // Says nothing about the draft, and still never indexed.
                expect(await run(), name).toMatchObject({ title: 'Preview', robots: { index: false, follow: false } });
                continue;
            }
            // Reads nothing, and leaves the answer to the page under it.
            if (name === 'series layout') continue;
            const answer = await outcome(run);
            if (answer.kind === 'response') expect(answer.status, name).toBe(404);
            else expect(answer, name).toEqual({ kind: 'thrown', digest: NOT_FOUND });
        }
        expect(reads).toEqual([]);
        expect(loadPreviewCatalog).not.toHaveBeenCalled();
    });
});

describe('signed in', () => {
    beforeEach(() => as(secrets.cookie()));

    const element = async (run: () => unknown) => {
        const answer = await outcome(run);
        if (answer.kind !== 'element') throw new Error(`Expected an element, got ${JSON.stringify(answer)}`);
        return answer.element as ReactElement<Record<string, unknown>>;
    };

    it('renders Home, Work, the series, and the Viewer from the draft, every href and image under the preview', async () => {
        const base = previewBasePath(draftId);
        const home = await element(surfaces(draftId).home);
        const work = await element(surfaces(draftId).work);
        const series = await element(surfaces(draftId).series);
        const viewer = await element(surfaces(draftId).viewer);
        const props = [home.props, ...[work, series].map((fragment) => (fragment.props.children as ReactElement<Record<string, unknown>>[])[1].props), viewer.props];
        const text = JSON.stringify(props);
        expect(text).toContain(DRAFT_TITLE);
        expect(text).toContain(`"${base}/media/`);
        expect(text).toContain(`"${base}/work/${LONG}`);
        expect(text).toContain(`"${base}/api/catalog/series/${LONG}/pages/`);
        expect(text).not.toMatch(/"\/(media|work|api)\//);
        expect(text).not.toContain(activeId);
        expect(viewer.props).toMatchObject({ closeHref: `${base}/work/${LONG}`, previousHref: null, nextHref: expect.stringMatching(new RegExp(`^${base}/work/${LONG}/photo/`)) });
    });

    it('gives every page the preview metadata: a Preview title, noindex, and no share or canonical metadata', async () => {
        for (const name of ['frame metadata', 'home metadata', 'series metadata', 'viewer metadata']) {
            const metadata = (await surfaces(draftId)[name]()) as Record<string, unknown>;
            expect(metadata, name).toMatchObject({ robots: { index: false, follow: false }, openGraph: null, twitter: null, alternates: null });
            expect(String(metadata.title), name).toMatch(/^Preview( · |$)/);
        }
        expect(((await surfaces(draftId)['series metadata']()) as { title: string }).title).toBe(`Preview · ${DRAFT_TITLE}`);
    });

    it('answers a draft that is not the current one with the not-found page, a 409 from the mirrors, and a 404 for its images', async () => {
        const unknown = surfaces(UNKNOWN);
        for (const name of ['frame page', 'home', 'work', 'series', 'viewer']) expect(await outcome(unknown[name]), name).toEqual({ kind: 'thrown', digest: NOT_FOUND });
        for (const name of ['load-more', 'home records', 'peek']) expect(await outcome(unknown[name]), name).toMatchObject({ kind: 'response', status: 409 });
        expect(await outcome(unknown.image)).toMatchObject({ kind: 'response', status: 404 });
    });

    it("answers a path no route matches with the preview's not-found page, for an existing and an unknown draft, reading nothing", async () => {
        for (const id of [draftId, UNKNOWN]) {
            for (const name of ['unmatched frame path', 'unmatched site path']) expect(await outcome(surfaces(id)[name]), `${name} ${id}`).toEqual({ kind: 'thrown', digest: NOT_FOUND });
            for (const name of ['unmatched frame path metadata', 'unmatched site path metadata']) {
                expect(await surfaces(id)[name](), name).toEqual({ title: 'Preview', robots: { index: false, follow: false }, openGraph: null, twitter: null, alternates: null });
            }
        }
        expect(loadPreviewCatalog).not.toHaveBeenCalled();
    });

    it('frames the draft its URL names, under the preview marker', async () => {
        const frame = await element(surfaces(draftId)['frame page']);
        expect((frame.props.children as ReactElement<{ src: string }>).props.src).toBe(previewBasePath(draftId));
    });

    it("serves load-more, the Home records and the Viewer's peek from the draft, no-store with no ETag", async () => {
        for (const name of ['load-more', 'home records', 'peek']) {
            const answer = await outcome(surfaces(draftId)[name]);
            if (answer.kind !== 'response') throw new Error(`${name}: ${JSON.stringify(answer)}`);
            expect(answer.status, name).toBe(200);
            const headers = Object.fromEntries(answer.headers);
            expect(headers['cache-control'], name).toBe('no-store');
            expect(headers.etag, name).toBeUndefined();
            const body = JSON.parse(answer.body);
            expect(body.revisionId, name).toBe(draftId);
            expect(answer.body, name).toContain(`"${previewBasePath(draftId)}/media/`);
            expect(answer.body, name).not.toMatch(/"\/(media|work|api)\//);
        }
        const stale = encodeSeriesCursor({ revisionId: activeId, seriesId: 'ser_fixture-long', offset: 100 });
        const answer = await handlers.pages(url('/x'), params({ draftId, slug: LONG, cursor: stale }));
        expect(answer.status).toBe(409);
    });

    it("shows About's portrait from the site config folder under the preview, and serves it private and no-store", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-site-config-'));
        try {
            fs.mkdirSync(path.join(dir, 'about'));
            fs.writeFileSync(path.join(dir, 'about', 'portrait.jpg'), await sharp({ create: { width: 900, height: 1200, channels: 3, background: { r: 180, g: 120, b: 60 } } }).jpeg().toBuffer());
            vi.stubEnv(SITE_CONFIG_ENV, dir);
            resetAboutPortraitReader();
            const base = previewBasePath(draftId);
            const about = await element(surfaces(draftId).about);
            expect(about.props).toEqual({ portraitBasePath: base });
            // AboutPage as Next renders it: About's view, with every variant under the preview.
            const page = (await AboutPage(about.props as { portraitBasePath: string })) as ReactElement<{ children: ReactElement<Record<string, unknown>>[] }>;
            const portrait = page.props.children[1].props.portrait as { asset: { variants: Record<string, Record<string, { url: string }>> } };
            const urls = Object.values(portrait.asset.variants).flatMap((formats) => Object.values(formats).map((variant) => variant.url));
            expect(urls).toHaveLength(8);
            for (const variantUrl of urls) expect(variantUrl).toMatch(new RegExp(`^${base}/about/portrait/[0-9a-f]{32}/w\\d+\\.(avif|webp)$`));
            const [token, variant] = urls[0].slice(`${base}/about/portrait/`.length).split('/');
            const answer = await handlers.portrait(url(urls[0]), params({ draftId, token, variant }));
            expect(answer.status).toBe(200);
            expect(answer.headers.get('cache-control')).toBe('private, no-store');
            expect(answer.headers.get('content-type')).toMatch(/^image\/(avif|webp)$/);
        } finally {
            await resetPortraitVariants();
            resetAboutPortraitReader();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("serves a draft's image private and no-store, and nothing the draft doesn't hold", async () => {
        const answer = await outcome(surfaces(draftId).image);
        if (answer.kind !== 'response') throw new Error(JSON.stringify(answer));
        expect(answer.status).toBe(200);
        expect(Object.fromEntries(answer.headers)['cache-control']).toBe('private, no-store');
        const photo = firstPhoto();
        const other = await handlers.media(url('/x'), params({ draftId, photoId: photo.id, assetRevision: `sha256-${'0'.repeat(64)}`, profileId: photo.profileId, variant: 'w400.avif' }));
        expect(other.status).toBe(404);
        expect(other.headers.get('cache-control')).toBe('no-store');
    });
});

describe('proxy.ts on the preview paths', () => {
    const send = (pathname: string, headers: Record<string, string> = {}) =>
        proxy(new NextRequest(new URL(pathname, `http://${HOST}`), { headers: new Headers({ host: HOST, ...headers }) }));

    const answer = async (response: Response) => ({ status: response.status, headers: [...response.headers.entries()].sort(), body: await response.text() });

    it('answers an anonymous request byte for byte the same for an existing, an unknown and a malformed draft, RSC and unmatched paths included', async () => {
        const photo = firstPhoto();
        const paths = (id: string) => [
            `/curation/preview/${id}`,
            `/curation/preview/${id}/site`,
            `/curation/preview/${id}/site/work/${LONG}`,
            `/curation/preview/${id}/site/work/${LONG}/photo/${photo.id}`,
            `/curation/preview/${id}/site/api/catalog/series/${LONG}/pages/x`,
            `/curation/preview/${id}/site/api/catalog/home/photos/${photo.id}?revision=${id}`,
            `/curation/preview/${id}/site/api/catalog/series/${LONG}/photos/${photo.id}?revision=${id}`,
            `/curation/preview/${id}/site/media/${photo.id}/${photo.assetRevision}/${photo.profileId}/w400.avif`,
            `/curation/preview/${id}/anything`,
            `/curation/preview/${id}/site/gallery`,
            `/curation/preview/${id}/site/work/${LONG}/photo/${photo.id}/more`,
        ];
        // A malformed ID that survives URL parsing: `..` is resolved away before any request is sent.
        const others = [UNKNOWN, ...MALFORMED.filter((id) => id !== '..')];
        for (const headers of [{}, { rsc: '1', 'next-router-state-tree': '%5B%22%22%5D' }, { cookie: `${SESSION_COOKIE}=forged` }] as Record<string, string>[]) {
            const existing = paths(draftId);
            for (const id of others) {
                const other = paths(id);
                for (let at = 0; at < existing.length; at += 1) {
                    // proxy() is async since #92's cutover gate.
                    const a = await answer(await send(existing[at], headers));
                    const b = await answer(await send(other[at], headers));
                    expect(a, other[at]).toEqual(b);
                    expect(a.status, existing[at]).toBe(307);
                    expect(Object.fromEntries(a.headers).location, existing[at]).toBe(`http://${HOST}/curation/login${headers.cookie ? '?ended=1' : ''}`);
                }
            }
        }
        expect(loadPreviewCatalog).not.toHaveBeenCalled();
    });

    it('lets a signed-in request through to the routes, which check again', async () => {
        const response = await send(`/curation/preview/${draftId}/site`, { cookie: secrets.cookie() });
        expect(response.headers.get('x-middleware-next')).toBe('1');
    });
});
