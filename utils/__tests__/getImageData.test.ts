// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../../app/api/photos/route';
import { createTempLibrary, derivativePaths, type TempLibrary } from '../../test/helpers/tempLibrary';
import { getGalleryImages, type ImageItem } from '../getImageData';
import { encodeLqip, getPhotoFiles, processImage } from '../imageOptimizer';

// Counts the gallery's on-the-fly placeholders. The encoder itself still runs.
vi.mock('../imageOptimizer', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../imageOptimizer')>();
    return { ...actual, encodeLqip: vi.fn(actual.encodeLqip) };
});

const DECODABLE = ['landscape-edited', 'landscape-rot6', 'landscape', 'portrait', 'square'];
const DECODABLE_FILES = ['landscape-edited.jpg', 'landscape-rot6.jpg', 'landscape.jpg', 'portrait.png', 'square.webp'];
const URL_FIELDS = ['src', 'thumbnail', 'medium', 'optimized', 'thumbnailAvif', 'mediumAvif', 'optimizedAvif'] as const;
const DERIVATIVE_URL = /^\/assets\/photos\/(thumbnails|medium|optimized)(-avif)?\/[^/]+\.(webp|avif)$/;

let template: TempLibrary;
let lib: TempLibrary;
let errors: ReturnType<typeof vi.spyOn>;

/** Each listed photo's base name, from its optimized URL. */
function bases(images: ImageItem[]): string[] {
    return images.map((image) => image.optimized.replace('/assets/photos/optimized/', '').replace(/\.webp$/, '')).sort();
}

beforeAll(async () => {
    // Build the derivatives once. corrupt.jpg can't be decoded, so it gets none.
    template = await createTempLibrary({ fixtures: 'extras' });
    for (const file of getPhotoFiles()) await processImage(file).catch(() => undefined);
}, 120_000);

afterAll(async () => {
    await template.cleanup();
});

beforeEach(async () => {
    lib = await createTempLibrary();
    fs.cpSync(template.root, lib.root, { recursive: true });
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(encodeLqip).mockClear();
});

afterEach(async () => {
    vi.restoreAllMocks();
    await lib.cleanup();
});

describe('getGalleryImages', () => {
    it('lists every photo by its complete set and never by its original file', async () => {
        const images = await getGalleryImages();

        expect(bases(images)).toEqual([...DECODABLE].sort());
        for (const image of images) {
            for (const field of URL_FIELDS) expect(image[field], `${field} of ${image.optimized}`).toMatch(DERIVATIVE_URL);
            expect(image.src).toBe(image.optimized);
        }
        expect(images.find((image) => image.optimized.endsWith('/landscape.webp'))).toMatchObject({
            src: '/assets/photos/optimized/landscape.webp',
            thumbnail: '/assets/photos/thumbnails/landscape.webp',
            medium: '/assets/photos/medium/landscape.webp',
            thumbnailAvif: '/assets/photos/thumbnails-avif/landscape.avif',
            mediumAvif: '/assets/photos/medium-avif/landscape.avif',
            optimizedAvif: '/assets/photos/optimized-avif/landscape.avif',
            lqip: fs.readFileSync(lib.file('lqip/landscape.txt'), 'utf8'),
            width: 960,
            height: 640,
        });
        expect(encodeLqip).not.toHaveBeenCalled();
    });

    it('reports an orientation-tagged photo at its upright size, as its derivatives are, with an upright placeholder', async () => {
        const rotated = () => getGalleryImages().then((images) => images.find((image) => image.optimized.endsWith('/landscape-rot6.webp')));
        expect(await rotated()).toMatchObject({ width: 640, height: 960 });

        // With its LQIP file empty, the listing makes a placeholder from the source.
        fs.writeFileSync(lib.file('lqip/landscape-rot6.txt'), '');
        const placeholder = (await rotated())?.lqip.replace(/^data:image\/webp;base64,/, '') ?? '';
        const { width, height } = await sharp(Buffer.from(placeholder, 'base64')).metadata();
        expect(height).toBeGreaterThan(width);
    });

    it('lists sources that share derivatives once, by the first path, and warns naming both', async () => {
        // landscape.png would get landscape.jpg's derivatives, since both have the base name landscape.
        fs.copyFileSync(lib.file('portrait.png'), lib.file('landscape.png'));
        const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const images = await getGalleryImages();

        expect(bases(images)).toEqual([...DECODABLE].sort());
        expect(images.find((image) => image.src === '/assets/photos/optimized/landscape.webp')).toMatchObject({ width: 960, height: 640 });
        expect(warnings).toHaveBeenCalledWith('[getGalleryImages] Skipping landscape.png: it shares its derivatives with landscape.jpg.');
    });

    it('warns about base names that differ only by case or Unicode form, which share one set on a case-insensitive disk', async () => {
        fs.copyFileSync(lib.file('portrait.png'), lib.file('Landscape.png'));
        // crème in NFC, then in NFD.
        fs.copyFileSync(lib.file('portrait.png'), lib.file('crème.png'));
        fs.copyFileSync(lib.file('landscape.jpg'), lib.file('cre\u0300me.jpg'));
        const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const images = await getGalleryImages();

        // None of the new files has a set under its own name, so the listing is as it was.
        expect(bases(images)).toEqual([...DECODABLE].sort());
        const shared = (a: string, b: string) =>
            `[getGalleryImages] ${a} and ${b} share one set of derivatives on a case-insensitive disk, since their base names differ only by case or Unicode form.`;
        expect(warnings).toHaveBeenCalledWith(shared('Landscape.png', 'landscape.jpg'));
        expect(warnings).toHaveBeenCalledWith(shared('cre\u0300me.jpg', 'crème.png'));
        expect(warnings).toHaveBeenCalledTimes(2);
    });

    it('still lists both when each has a set under its own name, as on a case-sensitive disk', async () => {
        fs.copyFileSync(lib.file('portrait.png'), lib.file('Landscape.png'));
        // A case-sensitive disk holds a Landscape.* set beside the landscape.* one.
        const realReaddirSync = fs.readdirSync;
        vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike, options?: never) => {
            const names = realReaddirSync(dir, options) as string[];
            return [...names, ...names.filter((name) => /^landscape\.(webp|avif|txt)$/.test(name)).map((name) => `L${name.slice(1)}`)];
        }) as typeof fs.readdirSync);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        expect(bases(await getGalleryImages())).toEqual(['Landscape', ...DECODABLE].sort());
    });

    it('logs an undecodable source, leaves it out, and still returns the others', async () => {
        // A macOS AppleDouble file next to a photo is not a photo
        fs.writeFileSync(lib.file('._landscape.jpg'), 'AppleDouble metadata');
        const images = await getGalleryImages();

        expect(bases(images)).toEqual([...DECODABLE].sort());
        expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^\[getGalleryImages\] Skipping corrupt\.jpg: /));
        expect(errors).toHaveBeenCalledTimes(1);
    });

    it('leaves out a photo whose set is incomplete, such as one cleanup only partly removed', async () => {
        fs.rmSync(lib.file('medium/portrait.webp'));
        fs.rmSync(lib.file('optimized-avif/square.avif'));
        fs.rmSync(lib.file('lqip/landscape-edited.txt'));
        const images = await getGalleryImages();

        expect(bases(images)).toEqual(['landscape', 'landscape-rot6']);
        expect(JSON.stringify(images)).not.toMatch(/\/assets\/photos\/[^/"]+\.(jpe?g|png|webp)"/);
    });

    it('counts a set only under its exact name, even where the disk ignores case', async () => {
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

        expect(bases(await getGalleryImages())).toEqual(DECODABLE.filter((base) => base !== 'landscape').sort());
    });

    it('reuses an on-the-fly placeholder until the file changes', async () => {
        // An empty LQIP file still completes the set, and the listing makes a placeholder from the source.
        for (const base of DECODABLE) fs.writeFileSync(lib.file(`lqip/${base}.txt`), '');
        await getGalleryImages();
        expect(encodeLqip).toHaveBeenCalledTimes(DECODABLE.length);

        await getGalleryImages();
        expect(encodeLqip).toHaveBeenCalledTimes(DECODABLE.length);

        const later = new Date(Date.now() + 60_000);
        fs.utimesSync(lib.file('portrait.png'), later, later);
        await getGalleryImages();
        expect(encodeLqip).toHaveBeenCalledTimes(DECODABLE.length + 1);
    });

    it('lists nothing before any derivative exists', async () => {
        const fresh = await createTempLibrary({ fixtures: 'basic' });
        try {
            expect(await getGalleryImages()).toEqual([]);
        } finally {
            await fresh.cleanup();
        }
    });

    it('skips dot-files, whose derivatives the site never serves', async () => {
        fs.copyFileSync(lib.file('landscape.jpg'), lib.file('.hidden.jpg'));
        for (const relativePath of derivativePaths('landscape')) {
            fs.copyFileSync(lib.file(relativePath), lib.file(relativePath.replace('landscape', '.hidden')));
        }
        expect(bases(await getGalleryImages())).toEqual([...DECODABLE].sort());
    });

    it('throws when every photo fails, so the cache keeps the last good list', async () => {
        for (const name of DECODABLE_FILES) fs.unlinkSync(lib.file(name));

        await expect(getGalleryImages()).rejects.toThrow(`Could not read any of the photos in ${lib.root} (1 found).`);
        await expect(GET()).rejects.toThrow('Could not read any of the photos');
    });

    it('lists a photo whose name has a percent sign or a hash with URLs that reach its derivatives', async () => {
        fs.copyFileSync(lib.file('landscape-edited.jpg'), lib.file('50% #1.jpg'));
        await processImage('50% #1.jpg');

        const image = (await getGalleryImages()).find((candidate) => decodeURIComponent(candidate.optimized) === '/assets/photos/optimized/50% #1.webp');
        expect(image?.src).toBe('/assets/photos/optimized/50%25%20%231.webp');
        for (const field of URL_FIELDS) {
            const url = image?.[field] ?? '';
            expect(fs.existsSync(lib.file(decodeURIComponent(url.replace('/assets/photos/', '')))), `${field}: ${url}`).toBe(true);
        }
    });

    it.each(['EACCES', 'EIO', 'EMFILE'])("throws when a derivative folder can't be listed (%s), instead of listing no photos", async (code) => {
        const thumbnails = lib.file('thumbnails');
        const realReaddirSync = fs.readdirSync;
        vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike, options?: unknown) => {
            if (path.resolve(String(dir)) === thumbnails) throw Object.assign(new Error(`${code}: scandir '${thumbnails}'`), { code });
            return (realReaddirSync as (dir: fs.PathLike, options?: unknown) => unknown)(dir, options);
        }) as typeof fs.readdirSync);

        await expect(getGalleryImages()).rejects.toMatchObject({ code });
        await expect(GET()).rejects.toMatchObject({ code });
    });

    it('returns an empty list for a library with no photos', async () => {
        for (const name of [...DECODABLE_FILES, 'corrupt.jpg']) fs.unlinkSync(lib.file(name));

        expect(await getGalleryImages()).toEqual([]);
    });

    it('GET /api/photos still answers 200 with the listed photos', async () => {
        const response = await GET();
        expect(response.status).toBe(200);
        const body = (await response.json()) as ImageItem[];
        expect(bases(body)).toEqual([...DECODABLE].sort());
        expect(JSON.stringify(body)).not.toMatch(/\/assets\/photos\/[^/"]+\.(jpe?g|png)"/);
    });
});
