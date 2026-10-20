// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../../app/api/photos/route';
import { dominantChannel } from '../../test/fixtures/makeLibrary';
import { createTempLibrary, type TempLibrary } from '../../test/helpers/tempLibrary';
import { getGalleryImages, type ImageItem } from '../getImageData';
import { encodeLqip, processImage } from '../imageOptimizer';

// Counts the gallery's on-the-fly placeholders. The encoder itself still runs.
vi.mock('../imageOptimizer', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../imageOptimizer')>();
    return { ...actual, encodeLqip: vi.fn(actual.encodeLqip) };
});

const DECODABLE = ['landscape-edited.jpg', 'landscape-rot6.jpg', 'landscape.jpg', 'portrait.png', 'square.webp'];
const ORIGINAL_ONLY = {
    thumbnail: '/assets/photos/Landscape.JPG',
    medium: '/assets/photos/Landscape.JPG',
    optimized: '/assets/photos/Landscape.JPG',
    thumbnailAvif: undefined,
    mediumAvif: undefined,
    optimizedAvif: undefined,
};

let lib: TempLibrary;
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
    lib = await createTempLibrary({ fixtures: 'extras' });
    // A macOS AppleDouble file next to a photo is not a photo
    fs.writeFileSync(lib.file('._landscape.jpg'), 'AppleDouble metadata');
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(encodeLqip).mockClear();
});

afterEach(async () => {
    vi.restoreAllMocks();
    await lib.cleanup();
});

async function itemFor(src: string): Promise<ImageItem | undefined> {
    return (await getGalleryImages()).find((image) => image.src === src);
}

function placeholderChannel(item: ImageItem | undefined) {
    return dominantChannel(Buffer.from((item as ImageItem).lqip.replace(/^data:image\/webp;base64,/, ''), 'base64'));
}

describe('getGalleryImages', () => {
    it('logs an undecodable source, leaves it out, and still returns the others', async () => {
        const images = await getGalleryImages();

        expect(images.map((image) => image.src.replace('/assets/photos/', '')).sort()).toEqual(DECODABLE);
        expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^\[getGalleryImages\] Skipping corrupt\.jpg: /));
        expect(errors).toHaveBeenCalledTimes(1);
        expect(images.find((image) => image.src.endsWith('/landscape.jpg'))).toMatchObject({
            src: '/assets/photos/landscape.jpg',
            width: 960,
            height: 640,
        });
    }, 30_000);

    it('GET /api/photos still answers 200 with the decodable photos', async () => {
        const response = await GET();
        expect(response.status).toBe(200);
        const body = (await response.json()) as ImageItem[];
        expect(body.map((image) => image.src.replace('/assets/photos/', '')).sort()).toEqual(DECODABLE);
    }, 30_000);

    it('serves a complete set of derivatives', async () => {
        await processImage('landscape.jpg');

        expect(await itemFor('/assets/photos/landscape.jpg')).toMatchObject({
            thumbnail: '/assets/photos/thumbnails/landscape.webp',
            medium: '/assets/photos/medium/landscape.webp',
            optimized: '/assets/photos/optimized/landscape.webp',
            thumbnailAvif: '/assets/photos/thumbnails-avif/landscape.avif',
            mediumAvif: '/assets/photos/medium-avif/landscape.avif',
            optimizedAvif: '/assets/photos/optimized-avif/landscape.avif',
            lqip: fs.readFileSync(lib.file('lqip/landscape.txt'), 'utf8'),
        });
    }, 30_000);

    it('serves the original for an incomplete set, such as one cleanup only partly removed', async () => {
        await processImage('landscape.jpg');
        fs.unlinkSync(lib.file('optimized/landscape.webp'));

        const item = await itemFor('/assets/photos/landscape.jpg');

        expect(item).toMatchObject({
            thumbnail: '/assets/photos/landscape.jpg',
            medium: '/assets/photos/landscape.jpg',
            optimized: '/assets/photos/landscape.jpg',
            thumbnailAvif: undefined,
            mediumAvif: undefined,
            optimizedAvif: undefined,
        });
        expect(await placeholderChannel(item)).toBe('red');
    }, 30_000);

    it('counts a set only under its exact name, even where the disk ignores case', async () => {
        await processImage('landscape.jpg');
        fs.renameSync(lib.file('landscape.jpg'), lib.file('tmp-rename'));
        fs.renameSync(lib.file('tmp-rename'), lib.file('Landscape.JPG'));
        // existsSync on a case-insensitive disk finds thumbnails/Landscape.webp as thumbnails/landscape.webp
        const realExistsSync = fs.existsSync;
        vi.spyOn(fs, 'existsSync').mockImplementation(((target: fs.PathLike) => {
            if (realExistsSync(target)) return true;
            const name = path.basename(String(target)).toLowerCase();
            try {
                return fs.readdirSync(path.dirname(String(target))).some((entry) => entry.toLowerCase() === name);
            } catch {
                return false;
            }
        }) as typeof fs.existsSync);

        expect(await itemFor('/assets/photos/Landscape.JPG')).toMatchObject(ORIGINAL_ONLY);
    }, 30_000);

    it('reuses an on-the-fly placeholder until the file changes', async () => {
        await getGalleryImages();
        expect(encodeLqip).toHaveBeenCalledTimes(DECODABLE.length);

        await getGalleryImages();
        expect(encodeLqip).toHaveBeenCalledTimes(DECODABLE.length);

        const later = new Date(Date.now() + 60_000);
        fs.utimesSync(lib.file('portrait.png'), later, later);
        await getGalleryImages();
        expect(encodeLqip).toHaveBeenCalledTimes(DECODABLE.length + 1);
    }, 30_000);

    it('throws when every photo fails, so the cache keeps the last good list', async () => {
        for (const name of DECODABLE) fs.unlinkSync(lib.file(name));

        await expect(getGalleryImages()).rejects.toThrow(`Could not read any of the photos in ${lib.root} (1 found).`);
        await expect(GET()).rejects.toThrow('Could not read any of the photos');
    }, 30_000);

    it('returns an empty list for a library with no photos', async () => {
        for (const name of [...DECODABLE, 'corrupt.jpg']) fs.unlinkSync(lib.file(name));

        expect(await getGalleryImages()).toEqual([]);
    });
});
