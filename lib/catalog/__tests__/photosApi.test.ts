// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { leakyJpeg } from '../../../test/fixtures/exif';
import { fakeCaseInsensitiveDisk, fakeCaseSensitiveDisk } from '../../../test/helpers/caseDisk';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { optimizedSize, processImage } from '../../../utils/imageOptimizer';
import { sequentialIds } from '../../identity/__tests__/reconcileFixtures';
import { runReconcilePass } from '../../identity/pass';
import { identityPaths, readRegistry, writeRegistry } from '../../identity/registry';
import type { Registry } from '../../identity/types';
import { readVersionedDocument, versionFile } from '../../storage/document';
import { catalogPhotos, legacyPhotos, type ImageItem } from '../photos-api';
import { createCatalogReader } from '../reader';
import { publish } from '../publish';
import { createTestCatalog } from '../testing';
import type { PublicPhotoRecord, RevisionContent } from '../types';
import { catalogPaths, readActivePointer } from '../working-layer';
import { VARIANT_BYTES } from './catalogFixtures';

vi.mock('next/server', async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    // Outside Next there is no request scope, and the route only needs it to wait.
    connection: vi.fn(async () => undefined),
}));

const { GET } = await import('../../../app/api/photos/route');
const { GET: ready } = await import('../../../app/api/ready/route');

const URL_FIELDS = ['src', 'thumbnail', 'medium', 'optimized', 'thumbnailAvif', 'mediumAvif', 'optimizedAvif'] as const;
const DERIVATIVE_URL = /^\/assets\/photos\/(thumbnails|medium|optimized)(-avif)?\/[^/]+\.(webp|avif)$/;

let template: TempLibrary;
let lib: TempLibrary;
let data: TempDataRoot;
/** One generator per test, so a later pass never mints an ID an earlier one used. */
let ids: () => string;
const cleanups: (() => Promise<void>)[] = [];

/** Each item's base name, from its optimized URL. */
const bases = (items: ImageItem[]) => items.map((item) => decodeURIComponent(item.optimized.replace('/assets/photos/optimized/', '').replace(/\.webp$/, '')));

async function dated(day: string): Promise<Buffer> {
    return sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 10, g: 200, b: 90 } } })
        .withExif({ IFD2: { DateTimeOriginal: `${day.replace(/-/g, ':')} 12:00:00` } })
        .jpeg()
        .toBuffer();
}

beforeAll(async () => {
    // Derivatives built once: the basic and extra fixtures, a dated photo with camera settings, an older one, and a
    // wide one. corrupt.jpg can't be decoded, so it gets none.
    template = await createTempLibrary({ fixtures: 'extras' });
    fs.writeFileSync(template.file('camera.jpg'), (await leakyJpeg()).jpeg);
    fs.writeFileSync(template.file('older.jpg'), await dated('2023-03-04'));
    fs.writeFileSync(template.file('wide.jpg'), await sharp({ create: { width: 3000, height: 1999, channels: 3, background: { r: 5, g: 5, b: 200 } } }).jpeg().toBuffer());
    for (const name of fs.readdirSync(template.root).filter((entry) => /\.(jpe?g|png|webp)$/.test(entry))) {
        await processImage(name).catch(() => undefined);
    }
}, 120_000);

afterAll(async () => {
    await template.cleanup();
});

beforeEach(async () => {
    lib = await createTempLibrary();
    fs.cpSync(template.root, lib.root, { recursive: true });
    data = createTempDataRoot();
    ids = sequentialIds();
});

afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    await data.cleanup();
    await lib.cleanup();
});

/** Folder contents with no registry version in them, as a write that stopped before its link leaves them. */
const NO_VERSION: Record<string, (dir: string) => void> = {
    'no file': (dir) => fs.mkdirSync(dir, { recursive: true }),
    'only a temp file': (dir) => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '.v1.4242.00000000-0000-4000-8000-000000000000.tmp'), '{}');
    },
};

/** Commit the next registry version, changed by `change`. */
async function rewrite(change: (registry: Registry) => Registry): Promise<void> {
    const registry = await readRegistry(data.root);
    await writeRegistry(data.root, change(structuredClone(registry)), registry.version);
}

/** The photo ID of the top-level photo named `<base>.*`. */
async function photoIdOf(base: string): Promise<string> {
    const photo = Object.values((await readRegistry(data.root)).photos).find((entry) => entry.source.path.replace(/\.[^.]+$/, '') === base);
    if (!photo) throw new Error(`No photo named ${base}`);
    return photo.photoId;
}

function setHealth(registry: Registry, photoId: string, health: 'present' | 'missing'): Registry {
    registry.photos[photoId].sourceHealth = health;
    return registry;
}

/** Overwrite the newest version in the pointer's folder, the one readActivePointer() reads, with something that isn't JSON. */
async function damagePointer(root: string): Promise<void> {
    const pointer = await readActivePointer(root);
    if (!pointer) throw new Error('There is no active pointer to damage');
    fs.writeFileSync(versionFile(catalogPaths(root).active, pointer.version), 'not json');
}

/** One reconcile pass over the library, which writes the registry legacy mode reads. */
async function pass(): Promise<void> {
    const outcome = await runReconcilePass({ clock: () => Date.now() + 60_000, idGen: ids, sinks: [], logger: { log: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Console });
    expect(outcome.status).toBe('committed');
}

async function listLegacy(): Promise<ImageItem[]> {
    const listed = await legacyPhotos(data.root, lib.root);
    if (!listed.ok) throw new Error(`Legacy mode listed nothing: ${listed.reason}`);
    return listed.items;
}

describe('legacy /api/photos', { timeout: 60_000 }, () => {
    it('lists each decodable top-level photo by its complete set, newest first, undated last by photo ID', async () => {
        await pass();
        const items = await listLegacy();
        const registry = await readRegistry(data.root);
        const idOf = (base: string) => Object.values(registry.photos).find((photo) => photo.source.path.replace(/\.[^.]+$/, '') === base)?.photoId ?? '';

        const undated = ['landscape', 'landscape-edited', 'landscape-rot6', 'portrait', 'square', 'wide'].sort((a, b) => (idOf(a) < idOf(b) ? -1 : 1));
        expect(bases(items)).toEqual(['camera', 'older', ...undated]);
        expect(items.map((item) => item.id)).toEqual(items.map((_, index) => index));
        for (const item of items) {
            for (const field of URL_FIELDS) expect(item[field], `${field} of ${item.optimized}`).toMatch(DERIVATIVE_URL);
            expect(item.src).toBe(item.optimized);
        }
        expect(items[0].date).toBe(Date.UTC(2024, 4, 1));
        expect(items[1].date).toBe(Date.UTC(2023, 2, 4));
        expect(items.slice(2).every((item) => item.date === 0)).toBe(true);
    });

    it("reports the upright size, and the 1920 px WebP's size as the pipeline wrote it", async () => {
        await pass();
        const items = await listLegacy();
        const item = (base: string) => items.find((candidate) => candidate.optimized === `/assets/photos/optimized/${base}.webp`) as ImageItem;
        // Stored 960 by 640 and tagged 6, so it lists turned upright.
        expect(item('landscape-rot6')).toMatchObject({ width: 640, height: 960 });
        expect(item('wide')).toMatchObject({ width: 3000, height: 1999 });
        for (const base of ['landscape-rot6', 'wide', 'portrait', 'square']) {
            const file = `${base}.${base === 'portrait' ? 'png' : base === 'square' ? 'webp' : 'jpg'}`;
            expect({ width: item(base).optimizedWidth, height: item(base).optimizedHeight }, base).toEqual(await optimizedSize(file));
        }
    });

    it('captions a photo with its camera settings and takes its LQIP from its file', async () => {
        await pass();
        const camera = (await listLegacy()).find((item) => item.optimized.endsWith('/camera.webp')) as ImageItem;
        expect(camera.caption).toBe('FX-1 | 35mm f/1.8 1/200s ISO 400');
        expect(camera.lqip).toBe(fs.readFileSync(lib.file('lqip/camera.txt'), 'utf8'));
        expect((await listLegacy()).find((item) => item.optimized.endsWith('/square.webp'))?.caption).toBe('');
    });

    it('leaves out a photo whose set is incomplete, a nested one, a missing one, and one that never decoded', async () => {
        fs.rmSync(lib.file('medium-avif/square.avif'));
        fs.mkdirSync(lib.file('nested'));
        fs.copyFileSync(lib.file('portrait.png'), lib.file('nested/deep.png'));
        await pass();
        fs.rmSync(lib.file('older.jpg'));
        // The pass that sees older.jpg gone marks it missing.
        await pass();
        const listed = bases(await listLegacy());
        expect(listed).not.toContain('square');
        expect(listed).not.toContain('older');
        expect(listed).not.toContain('corrupt');
        expect(listed.some((base) => base.includes('deep'))).toBe(false);
        expect(listed).toContain('landscape');
    });

    it('lists one source per shared set: the first by path that decodes, which the watcher builds the set from', async () => {
        fs.copyFileSync(lib.file('portrait.png'), lib.file('landscape.png'));
        fs.copyFileSync(lib.file('corrupt.jpg'), lib.file('landscape-edited.jpeg'));
        await pass();
        const items = await listLegacy();
        expect(bases(items).filter((base) => base === 'landscape')).toHaveLength(1);
        // landscape.jpg's size, not portrait.png's
        expect(items.find((item) => item.optimized.endsWith('/landscape.webp'))).toMatchObject({ width: 960, height: 640 });
        // landscape-edited.jpeg sorts first but never decoded, so landscape-edited.jpg owns the set.
        expect(items.find((item) => item.optimized.endsWith('/landscape-edited.webp'))).toMatchObject({ width: 960, height: 640 });
    });

    it('shares a set across case only where the disk resolves both spellings to one file', async () => {
        fs.copyFileSync(lib.file('portrait.png'), lib.file('Landscape.png'));
        await pass();
        fakeCaseSensitiveDisk();
        // Each name has a set of its own on a case-sensitive disk. Landscape.png's isn't built, so only landscape.jpg lists.
        const sensitive = await legacyPhotos(data.root, lib.root);
        vi.restoreAllMocks();
        expect(sensitive.ok && bases(sensitive.items).filter((base) => base.toLowerCase() === 'landscape')).toEqual(['landscape']);

        // Where both spellings are one file, the two share one set, which the first by path owns and builds.
        await processImage('Landscape.png');
        const fresh = createTempDataRoot();
        cleanups.push(() => fresh.cleanup());
        await pass();
        fakeCaseInsensitiveDisk();
        const insensitive = await legacyPhotos(fresh.root, lib.root);
        expect(insensitive.ok && bases(insensitive.items).filter((base) => base.toLowerCase() === 'landscape')).toEqual(['Landscape']);
    });

    it('builds the list again only when the registry is written', async () => {
        await pass();
        const first = await listLegacy();
        // The registry is a version folder, and an unchanged folder is neither listed nor read.
        const registry = identityPaths(data.root).registry;
        const inRegistry = (file: unknown) => String(file) === registry || String(file).startsWith(`${registry}${path.sep}`);
        const reads = [vi.spyOn(fs.promises, 'readFile'), vi.spyOn(fs.promises, 'readdir'), vi.spyOn(fs.promises, 'open')];
        expect(await listLegacy()).toBe(first);
        for (const spy of reads) expect(spy.mock.calls.some(([file]) => inRegistry(file))).toBe(false);
        for (const spy of reads) spy.mockRestore();

        fs.copyFileSync(lib.file('landscape.jpg'), lib.file('added.jpg'));
        await processImage('added.jpg');
        expect(bases(await listLegacy())).not.toContain('added');
        await pass();
        expect(bases(await listLegacy())).toContain('added');
    });

    it("doesn't load Sharp or the image pipeline, from the projections or the route", async () => {
        // A fresh module registry in which loading either throws.
        vi.resetModules();
        vi.doMock('sharp', () => {
            throw new Error('The web side loaded sharp.');
        });
        vi.doMock('../../../utils/imageOptimizer', () => {
            throw new Error('The web side loaded the image pipeline.');
        });
        try {
            await expect(import('../photos-api')).resolves.toHaveProperty('legacyPhotos');
            await expect(import('../../../app/api/photos/route')).resolves.toHaveProperty('GET');
        } finally {
            vi.doUnmock('sharp');
            vi.doUnmock('../../../utils/imageOptimizer');
            vi.resetModules();
        }
    });

    it('never runs Sharp or lists a folder but the registry\'s own', async () => {
        await pass();
        const decodes = [vi.spyOn(sharp.prototype, 'metadata'), vi.spyOn(sharp.prototype, 'toBuffer')];
        const listings = [vi.spyOn(fs.promises, 'readdir'), vi.spyOn(fs, 'readdirSync'), vi.spyOn(fs.promises, 'opendir')];
        expect((await listLegacy()).length).toBeGreaterThan(0);
        for (const spy of decodes) expect(spy).not.toHaveBeenCalled();
        // Reading the registry lists its version folder, to find the newest version. Nothing lists the library.
        for (const spy of listings) expect(spy.mock.calls.map(([dir]) => String(dir))).toEqual(spy === listings[0] ? [identityPaths(data.root).registry] : []);
    });

    it('is unavailable as registry-missing before the migration', async () => {
        expect(await legacyPhotos(data.root, lib.root)).toEqual({ ok: false, reason: 'registry-missing' });
        fs.mkdirSync(identityPaths(data.root).registry, { recursive: true });
        fs.writeFileSync(versionFile(identityPaths(data.root).registry, 1), 'not json');
        expect(await legacyPhotos(data.root, lib.root)).toEqual({ ok: false, reason: 'registry-unreadable' });
    });

    it.each(Object.entries(NO_VERSION))('is unavailable as registry-missing while identity/registry/ holds %s', async (_, lay) => {
        lay(identityPaths(data.root).registry);
        expect(await legacyPhotos(data.root, lib.root)).toEqual({ ok: false, reason: 'registry-missing' });
        const photos = await GET();
        expect(photos.status).toBe(503);
        expect(await photos.json()).toEqual({ reason: 'registry-missing' });
        const readiness = await ready();
        expect(readiness.status).toBe(503);
        expect(await readiness.json()).toMatchObject({ mode: 'legacy', state: 'unavailable', reason: 'registry-missing' });
    });

    it('builds the list again for every new registry version once the folder keeps two', async () => {
        await pass();
        const dir = identityPaths(data.root).registry;
        // Each write adds one version and prunes one, so from here the folder keeps its count of names and its size.
        for (let index = 0; index < 3; index += 1) await rewrite((registry) => registry);
        const target = await photoIdOf('landscape');
        expect(bases(await listLegacy())).toContain('landscape');

        const before = fs.statSync(dir);
        await rewrite((registry) => setHealth(registry, target, 'missing'));
        expect(fs.statSync(dir).size).toBe(before.size);
        expect(bases(await listLegacy())).not.toContain('landscape');
        await rewrite((registry) => setHealth(registry, target, 'present'));
        expect(bases(await listLegacy())).toContain('landscape');
    });

    it('sees a hand-made copy of the newest version saved in place after a list was built from it', async () => {
        await pass();
        const dir = identityPaths(data.root).registry;
        const stored = await readVersionedDocument(dir);
        if (!stored) throw new Error('The pass wrote no registry');
        const copy = versionFile(dir, stored.version + 1);
        // The documented hand edit: copy the newest to the next number, then edit the copy.
        fs.copyFileSync(stored.file, copy, fs.constants.COPYFILE_EXCL);
        expect(bases(await listLegacy())).toContain('landscape');

        // An editor that saves in place: the same file at the same size, so the folder doesn't change.
        const folder = fs.statSync(dir);
        const target = await photoIdOf('landscape');
        const text = fs.readFileSync(copy, 'utf8');
        const edited = text.replace(new RegExp(`("photoId": "${target}"[\\s\\S]*?"sourceHealth": )"present"`), '$1"missing"');
        expect(edited).not.toBe(text);
        expect(edited.length).toBe(text.length);
        fs.writeFileSync(copy, edited);
        expect(fs.statSync(dir).mtimeMs).toBe(folder.mtimeMs);
        expect(bases(await listLegacy())).not.toContain('landscape');
    });
});

describe('GET /api/photos', { timeout: 60_000 }, () => {
    it('answers in legacy mode from the registry, uncached, naming the mode', async () => {
        await pass();
        const response = await GET();
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-cache');
        expect(response.headers.get('x-catalog-mode')).toBe('legacy');
        expect(response.headers.get('x-catalog-revision')).toBe('legacy');
        expect(bases(await response.json() as ImageItem[])).toEqual(bases(await listLegacy()));
    });

    it('answers 503 with registry-missing before the migration', async () => {
        const response = await GET();
        expect(response.status).toBe(503);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('x-catalog-mode')).toBe('legacy');
        expect(await response.json()).toEqual({ reason: 'registry-missing' });
    });

    it('answers in catalog mode from the active revision, naming it', async () => {
        const catalog = await createTestCatalog({ variantBytes: VARIANT_BYTES, seed: 11 });
        cleanups.push(() => catalog.cleanup());
        const restore = process.env.PHOTOGRAPHY_DATA_DIR;
        process.env.PHOTOGRAPHY_DATA_DIR = catalog.root;
        cleanups.push(async () => {
            process.env.PHOTOGRAPHY_DATA_DIR = restore;
        });
        const published = await publish({ dataRoot: catalog.root, actor: 'test', confirmLaunch: true, logger: { log: () => undefined } });
        expect(published.outcome).toBe('PUBLISHED');

        const response = await GET();
        expect(response.status).toBe(200);
        expect(response.headers.get('x-catalog-mode')).toBe('catalog');
        expect(response.headers.get('x-catalog-revision')).toBe(published.revisionId);
        const items = await response.json() as ImageItem[];
        expect(items.length).toBeGreaterThan(0);
        expect(items.every((item) => item.src.startsWith('/media/'))).toBe(true);
    });
});

describe('GET /api/ready', { timeout: 60_000 }, () => {
    const NO_REVISION = { revisionId: null, revisionNumber: null, activatedAt: null };

    /** A published test catalog as PHOTOGRAPHY_DATA_DIR. */
    async function published(seed: number): Promise<{ root: string; revisionId: string }> {
        const catalog = await createTestCatalog({ variantBytes: VARIANT_BYTES, seed });
        cleanups.push(() => catalog.cleanup());
        const restore = process.env.PHOTOGRAPHY_DATA_DIR;
        process.env.PHOTOGRAPHY_DATA_DIR = catalog.root;
        cleanups.push(async () => {
            process.env.PHOTOGRAPHY_DATA_DIR = restore;
        });
        const outcome = await publish({ dataRoot: catalog.root, actor: 'test', confirmLaunch: true, logger: { log: () => undefined } });
        if (outcome.outcome !== 'PUBLISHED') throw new Error(outcome.message);
        return { root: catalog.root, revisionId: outcome.revisionId as string };
    }

    it('answers 503 with registry-missing before the migration, then 200 in legacy mode with no revision, never cached', async () => {
        const before = await ready();
        expect(before.status).toBe(503);
        expect(before.headers.get('cache-control')).toBe('no-store');
        expect(await before.json()).toEqual({ mode: 'legacy', state: 'unavailable', ...NO_REVISION, reason: 'registry-missing' });

        await pass();
        const after = await ready();
        expect(after.status).toBe(200);
        expect(after.headers.get('cache-control')).toBe('no-store');
        expect(await after.json()).toEqual({ mode: 'legacy', state: 'ok', ...NO_REVISION });
    });

    it('names the active revision, then answers 200 as degraded once its pointer turns unreadable, naming no path', async () => {
        const { root, revisionId } = await published(12);
        const ok = await ready();
        expect(ok.status).toBe(200);
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

    it('answers 503 when its pointer is unreadable and no revision loaded before', async () => {
        const { root } = await published(13);
        await damagePointer(root);
        const response = await ready();
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ mode: 'catalog', state: 'unavailable', ...NO_REVISION, reason: 'active-unreadable' });
    });
});

describe('catalog /api/photos', { timeout: 60_000 }, () => {
    async function revision(seed: number): Promise<{ content: RevisionContent; revisionId: string }> {
        const catalog = await createTestCatalog({ variantBytes: VARIANT_BYTES, seed, photos: 6, series: 2 });
        cleanups.push(() => catalog.cleanup());
        const published = await publish({ dataRoot: catalog.root, actor: 'test', confirmLaunch: true, logger: { log: () => undefined } });
        if (published.outcome !== 'PUBLISHED') throw new Error(published.message);
        const file = JSON.parse(fs.readFileSync(`${catalog.root}/catalog/revisions/${published.revisionId}.json`, 'utf8'));
        return { content: file.content, revisionId: published.revisionId as string };
    }

    it('lists photos in Work order, then photoIds order, each once, at their /media URLs', async () => {
        const { content, revisionId } = await revision(12);
        // A repeat that validation would refuse still lists once.
        const repeated: RevisionContent = structuredClone(content);
        repeated.series[1].photoIds.push(repeated.series[0].photoIds[0]);
        const items = catalogPhotos(createCatalogReader(repeated, { revisionId, revisionNumber: 1 }));

        const expected = content.series.flatMap((series) => series.photoIds);
        const photos = new Map(content.photos.map((photo) => [photo.id, photo] as const));
        expect(items.map((item) => item.optimized)).toEqual(expected.map((id) => (photos.get(id) as PublicPhotoRecord).variants.w1920.webp.url));
        expect(items.map((item) => item.id)).toEqual(expected.map((_, index) => index));
        const [first] = items;
        const photo = photos.get(expected[0]) as PublicPhotoRecord;
        expect(first).toEqual({
            id: 0,
            src: photo.variants.w1920.webp.url,
            thumbnail: photo.variants.w400.webp.url,
            medium: photo.variants.w800.webp.url,
            optimized: photo.variants.w1920.webp.url,
            thumbnailAvif: photo.variants.w400.avif.url,
            mediumAvif: photo.variants.w800.avif.url,
            optimizedAvif: photo.variants.w1920.avif.url,
            width: photo.width,
            height: photo.height,
            optimizedWidth: photo.variants.w1920.webp.width,
            optimizedHeight: photo.variants.w1920.webp.height,
            caption: photo.alt.kind === 'described' ? photo.alt.text : '',
            date: photo.capturedAt ? Date.parse(`${photo.capturedAt}T00:00:00.000Z`) : 0,
            lqip: photo.lqip,
        });
    });

    it("captions with the alt text, or '' for a decorative photo, and dates at UTC midnight or 0", async () => {
        const { content, revisionId } = await revision(13);
        const edited: RevisionContent = structuredClone(content);
        const [described, decorative] = edited.series[0].photoIds.map((id) => edited.photos.find((photo) => photo.id === id) as PublicPhotoRecord);
        described.alt = { kind: 'described', text: 'A fixture description.' };
        described.capturedAt = '2024-02-29';
        decorative.alt = { kind: 'decorative' };
        delete decorative.capturedAt;
        const items = catalogPhotos(createCatalogReader(edited, { revisionId, revisionNumber: 1 }));
        expect(items[0]).toMatchObject({ caption: 'A fixture description.', date: Date.UTC(2024, 1, 29) });
        expect(items[1]).toMatchObject({ caption: '', date: 0 });
    });
});
