// @vitest-environment node
import fs from 'node:fs';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { leakyJpeg } from '../../../test/fixtures/exif';
import { fakeCaseInsensitiveDisk, fakeCaseSensitiveDisk } from '../../../test/helpers/caseDisk';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { optimizedSize, processImage } from '../../../utils/imageOptimizer';
import { sequentialIds } from '../../identity/__tests__/reconcileFixtures';
import { runReconcilePass } from '../../identity/pass';
import { readRegistry } from '../../identity/registry';
import { cameraSettingsCaption, legacyList, type ImageItem } from '../legacy-photos';

// The legacy list (#13): the photos the legacy Gallery showed, from the #10
// registry. Slice E removed /api/photos, which served it, and the pages that
// read it; `photos carry-over` and publish's launch count still do.

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

/** One reconcile pass over the library, which writes the registry the legacy list reads, into the newest temp data root. */
async function pass(): Promise<void> {
    const outcome = await runReconcilePass({ clock: () => Date.now() + 60_000, idGen: ids, sinks: [], logger: { log: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Console });
    expect(outcome.status).toBe('committed');
}

async function listLegacy(): Promise<ImageItem[]> {
    return legacyList(await readRegistry(data.root), lib.root);
}

describe('cameraSettingsCaption', () => {
    it('joins the model and settings the way the legacy Gallery caption does', () => {
        expect(cameraSettingsCaption({ Make: 'Fixture Make', Model: 'Fixture Model', FocalLength: '35', FNumber: '1.8', ExposureTime: '1/200', ISO: '100' }))
            .toBe('Fixture Model | 35mm f/1.8 1/200s ISO 100');
    });

    it.each([
        [{ Model: 'Fixture Model' }, 'Fixture Model'],
        [{ FocalLength: '50', FNumber: '2' }, '50mm f/2'],
        [{ Model: 'Fixture Model', ExposureTime: '2' }, 'Fixture Model | 2s'],
        [{ Make: 'Fixture Make' }, ''],
        [{}, ''],
    ])('leaves out what is missing: %j', (technical, caption) => {
        expect(cameraSettingsCaption(technical)).toBe(caption);
    });
});

describe('legacyList', { timeout: 60_000 }, () => {
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
        const sensitive = await legacyList(await readRegistry(data.root), lib.root);
        vi.restoreAllMocks();
        expect(bases(sensitive).filter((base) => base.toLowerCase() === 'landscape')).toEqual(['landscape']);

        // Where both spellings are one file, the two share one set, which the first by path owns and builds.
        await processImage('Landscape.png');
        const fresh = createTempDataRoot();
        cleanups.push(() => fresh.cleanup());
        await pass();
        fakeCaseInsensitiveDisk();
        const insensitive = await legacyList(await readRegistry(fresh.root), lib.root);
        expect(bases(insensitive).filter((base) => base.toLowerCase() === 'landscape')).toEqual(['Landscape']);
    });
});
