// @vitest-environment node
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRegistry } from '../../identity/registry';
import { compileCandidate } from '../compile';
import {
    currentDraftId,
    loadPreviewCatalog,
    previewBasePath,
    previewDraftId,
    previewFrameHref,
    previewMediaAccess,
    previewMediaUrls,
    previewRoutes,
    resetPreviewReaderForTests,
    SUBRESOURCE_MAX_AGE_MS,
} from '../preview-reader';
import { readRevisionFile } from '../repository';
import { createTestCatalog, type TestCatalog } from '../testing';
import { writeAuthoredRecord } from '../working-layer-writer';
import { readActivePointer, readWorkingLayer } from '../working-layer';
import { VARIANT_BYTES } from './catalogFixtures';

// #16's preview reader: the working layer compiled now, served only as the
// current candidate, a malformed draft ID refused before anything is read.

vi.mock('../working-layer', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../working-layer')>();
    return { ...actual, readWorkingLayer: vi.fn(actual.readWorkingLayer), readActivePointer: vi.fn(actual.readActivePointer) };
});
vi.mock('../../identity/registry', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../identity/registry')>();
    return { ...actual, readRegistry: vi.fn(actual.readRegistry) };
});
vi.mock('../repository', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../repository')>();
    return { ...actual, readRevisionFile: vi.fn(actual.readRevisionFile) };
});
vi.mock('../compile', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../compile')>();
    return { ...actual, compileCandidate: vi.fn(actual.compileCandidate) };
});

const MALFORMED = [
    '',
    'rev_',
    `rev_${'a'.repeat(63)}`,
    `rev_${'a'.repeat(65)}`,
    `rev_${'A'.repeat(64)}`,
    `REV_${'a'.repeat(64)}`,
    `rev_${'a'.repeat(63)}g`,
    `../rev_${'a'.repeat(64)}`,
    `rev_${'a'.repeat(64)}/..`,
    `rev_${'a'.repeat(64)}\n`,
    `rev_${'a'.repeat(32)}%2F${'a'.repeat(29)}`,
];
const UNKNOWN = `rev_${'0'.repeat(64)}`;

/** Every fs function the data root is read with, spied, so a test can say none ran. */
function spyOnFs() {
    const spies = [
        ...(['statSync', 'lstatSync', 'readFileSync', 'readdirSync', 'existsSync', 'openSync', 'realpathSync'] as const).map((name) => vi.spyOn(fs, name)),
        ...(['stat', 'lstat', 'readFile', 'readdir', 'open', 'realpath', 'access'] as const).map((name) => vi.spyOn(fs.promises, name)),
    ];
    return () => spies.reduce((count, spy) => count + spy.mock.calls.length, 0);
}

const readers = () => [readWorkingLayer, readActivePointer, readRegistry, readRevisionFile, compileCandidate].map((fn) => vi.mocked(fn));

let catalog: TestCatalog;

beforeEach(async () => {
    resetPreviewReaderForTests();
    catalog = await createTestCatalog({ variantBytes: VARIANT_BYTES, seed: 16 });
    vi.stubEnv('PHOTOGRAPHY_DATA_DIR', catalog.root);
    for (const fn of readers()) fn.mockClear();
});

afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await catalog.cleanup();
});

/** The current candidate's ID, compiled the way publish compiles it. */
async function candidateId(): Promise<string> {
    const root = catalog.root;
    const pointer = await readActivePointer(root);
    const active = pointer ? await readRevisionFile(root, pointer.revisionId) : null;
    return (await compileCandidate({ layer: await readWorkingLayer(root), registry: await readRegistry(root), root, active })).candidateId;
}

async function retitleFirstSeries(title: string) {
    const record = (await readWorkingLayer(catalog.root)).series[0];
    await writeAuthoredRecord({ ...structuredClone(record), title }, { expectedVersion: record.version, root: catalog.root });
}

describe('previewDraftId', () => {
    it('takes only #13 revision IDs', () => {
        expect(previewDraftId(UNKNOWN)).toBe(UNKNOWN);
        for (const value of [...MALFORMED, undefined, null, 1, ['rev_x'], { draftId: UNKNOWN }]) expect(previewDraftId(value), JSON.stringify(value)).toBeNull();
    });
});

describe('the preview routes', () => {
    it('put the frame, the site, the catalog endpoints, and /media under the draft', () => {
        const routes = previewRoutes(UNKNOWN);
        const base = `/curation/preview/${UNKNOWN}/site`;
        expect(previewFrameHref(UNKNOWN)).toBe(`/curation/preview/${UNKNOWN}`);
        expect(previewBasePath(UNKNOWN)).toBe(base);
        expect([routes.homeHref(), routes.workHref(), routes.aboutHref(), routes.seriesHref('a b'), routes.photoHref('a', 'ph_1')]).toEqual([
            base,
            `${base}/work`,
            `${base}/about`,
            `${base}/work/a%20b`,
            `${base}/work/a/photo/ph_1`,
        ]);
        expect(routes.catalogApiHref('series/a/pages/c')).toBe(`${base}/api/catalog/series/a/pages/c`);
        expect(routes.mediaHref('/media/p/r/x/w400.avif')).toBe(`${base}/media/p/r/x/w400.avif`);
    });

    it('refuse a malformed draft ID', () => {
        for (const value of MALFORMED) {
            expect(() => previewRoutes(value), JSON.stringify(value)).toThrow(TypeError);
            expect(() => previewFrameHref(value), JSON.stringify(value)).toThrow(TypeError);
        }
    });
});

describe('loadPreviewCatalog', { timeout: 60_000 }, () => {
    it('reads nothing for a malformed draft ID', async () => {
        const fsCalls = spyOnFs();
        for (const value of MALFORMED) expect(await loadPreviewCatalog(value), JSON.stringify(value)).toEqual({ mode: 'catalog', state: 'not-current' });
        expect(fsCalls()).toBe(0);
        for (const fn of readers()) expect(fn).not.toHaveBeenCalled();
    });

    it('serves the current candidate as the draft, with no revision number', async () => {
        const draftId = await candidateId();
        expect(draftId).toBe(catalog.revisionId);
        const preview = await loadPreviewCatalog(draftId);
        if (preview.state !== 'ok') throw new Error(`expected ok, got ${preview.state}`);
        expect(preview.draftId).toBe(draftId);
        expect(preview.reader.revision()).toEqual({ revisionId: draftId, revisionNumber: null });
        expect(preview.reader.listSeries().map((series) => series.id)).toEqual(catalog.content.series.map((series) => series.id));
    });

    it('answers an unknown ID and a stale one the same way', async () => {
        const before = await candidateId();
        expect((await loadPreviewCatalog(before)).state).toBe('ok');
        await retitleFirstSeries('A retitled fixture series');
        const after = await candidateId();
        expect(after).not.toBe(before);
        expect(await loadPreviewCatalog(before)).toEqual({ mode: 'catalog', state: 'not-current' });
        expect(await loadPreviewCatalog(UNKNOWN)).toEqual({ mode: 'catalog', state: 'not-current' });
        const current = await loadPreviewCatalog(after);
        expect(current.state === 'ok' && current.reader.listSeries()[0].title).toBe('A retitled fixture series');
    });

    it('compiles again for a page, and lets a subresource reuse a compile of the same draft for a while', async () => {
        let now = 1_000;
        const draftId = await candidateId();
        vi.mocked(compileCandidate).mockClear();
        await loadPreviewCatalog(draftId, { now: () => now });
        await loadPreviewCatalog(draftId, { now: () => now });
        expect(compileCandidate).toHaveBeenCalledTimes(2);
        now += SUBRESOURCE_MAX_AGE_MS;
        expect((await loadPreviewCatalog(draftId, { now: () => now, maxAgeMs: SUBRESOURCE_MAX_AGE_MS })).state).toBe('ok');
        expect(compileCandidate).toHaveBeenCalledTimes(2);
        now += 1;
        expect((await loadPreviewCatalog(draftId, { now: () => now, maxAgeMs: SUBRESOURCE_MAX_AGE_MS })).state).toBe('ok');
        expect(compileCandidate).toHaveBeenCalledTimes(3);
    });

    it('shares one compile between concurrent requests', async () => {
        const draftId = await candidateId();
        vi.mocked(compileCandidate).mockClear();
        const answers = await Promise.all([loadPreviewCatalog(draftId), loadPreviewCatalog(draftId), loadPreviewCatalog(UNKNOWN)]);
        expect(answers.map((answer) => answer.state)).toEqual(['ok', 'ok', 'not-current']);
        expect(compileCandidate).toHaveBeenCalledTimes(1);
    });

    it('is unavailable when the data root is not ready or the draft cannot be read, and logs no path', async () => {
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', `${catalog.root}-missing`);
        expect(await loadPreviewCatalog(UNKNOWN)).toEqual({ mode: 'catalog', state: 'unavailable', reason: 'data-root-not-ready' });
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', catalog.root);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.mocked(compileCandidate).mockRejectedValueOnce(Object.assign(new Error(`EACCES: ${catalog.root}/assets`), { code: 'EACCES' }));
        expect(await loadPreviewCatalog(UNKNOWN)).toEqual({ mode: 'catalog', state: 'unavailable', reason: 'draft-unreadable' });
        expect(error).toHaveBeenCalledTimes(1);
        expect(String(error.mock.calls[0][0])).not.toContain(catalog.root);
    });

    it('names the current draft for /curation/preview', async () => {
        expect(await currentDraftId()).toBe(await candidateId());
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', `${catalog.root}-missing`);
        expect(await currentDraftId()).toBeNull();
    });
});

describe('previewMediaUrls', () => {
    const routes = previewRoutes(UNKNOWN);
    const media = '/media/ph_1/sha256-abc/p1/w400.avif';

    it('moves every /media path under the preview, deep, and leaves everything else', () => {
        const model = {
            href: '/work/a',
            image: { variants: { w400: { avif: { url: media, width: 400 } } }, lqip: 'data:image/webp;base64,AAAA' },
            list: [media, '/media/ph_1/x', `${media}?q=1`, 'media/ph_1/a/b/c', 3, null, true],
        };
        const before = structuredClone(model);
        expect(previewMediaUrls(model, routes)).toEqual({
            href: '/work/a',
            image: { variants: { w400: { avif: { url: routes.mediaHref(media), width: 400 } } }, lqip: 'data:image/webp;base64,AAAA' },
            list: [routes.mediaHref(media), '/media/ph_1/x', `${media}?q=1`, 'media/ph_1/a/b/c', 3, null, true],
        });
        expect(model).toEqual(before);
    });

    it('leaves no public /media path in any read model of a draft', async () => {
        const draftId = await candidateId();
        const preview = await loadPreviewCatalog(draftId);
        if (preview.state !== 'ok') throw new Error('expected ok');
        const draftRoutes = previewRoutes(draftId);
        const slug = preview.reader.listSeries()[0].slug;
        const photoId = preview.reader.photosOf(preview.reader.listSeries()[0].id)[0].id;
        const models = [preview.reader.getWorkSummaries(draftRoutes), preview.reader.getSeriesPage(slug, draftRoutes), preview.reader.getViewerPhoto(slug, photoId)];
        for (const model of models) {
            const text = JSON.stringify(previewMediaUrls(model, draftRoutes));
            expect(text).toContain(`"${draftRoutes.basePath}/media/`);
            expect(text).not.toMatch(/"\/media\//);
        }
    });
});

describe('previewMediaAccess', { timeout: 60_000 }, () => {
    it("serves the draft's sets privately and denies anything else", async () => {
        const draftId = await candidateId();
        const photo = catalog.content.photos[0];
        const ref = { photoId: photo.id, assetRevision: photo.assetRevision, profileId: photo.profileId };
        const request = new Request('http://127.0.0.1/x');
        expect(await previewMediaAccess(draftId)(ref, request)).toBe('private');
        expect(await previewMediaAccess(draftId)({ ...ref, assetRevision: `sha256-${'0'.repeat(64)}` }, request)).toBe('deny');
        expect(await previewMediaAccess(draftId)({ ...ref, profileId: 'other' }, request)).toBe('deny');
        expect(await previewMediaAccess(draftId)({ ...ref, photoId: 'ph_00000000-0000-4000-8000-0000000000ff' }, request)).toBe('deny');
        expect(await previewMediaAccess(UNKNOWN)(ref, request)).toBe('deny');
    });
});
