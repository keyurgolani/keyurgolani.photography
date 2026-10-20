// @vitest-environment node
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../../app/api/photos/route';
import { createTempLibrary, type TempLibrary } from '../../test/helpers/tempLibrary';
import { getGalleryImages, type ImageItem } from '../getImageData';

const DECODABLE = ['landscape-edited.jpg', 'landscape-rot6.jpg', 'landscape.jpg', 'portrait.png', 'square.webp'];

let lib: TempLibrary;
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
    lib = await createTempLibrary({ fixtures: 'extras' });
    // A macOS AppleDouble file next to a photo is not a photo
    fs.writeFileSync(lib.file('._landscape.jpg'), 'AppleDouble metadata');
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
    vi.restoreAllMocks();
    await lib.cleanup();
});

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
});
