// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sharp } from 'sharp';
import { dominantChannel, fixtureFiles, type Channel } from '../../test/fixtures/makeLibrary';
import { createTempLibrary, derivativePaths, type TempLibrary } from '../../test/helpers/tempLibrary';
import {
    ensureDirectories,
    getImagePaths,
    getUnprocessedFiles,
    libraryPaths,
    LibraryRootMissingError,
    processAllImages,
    processImage,
    reprocessImage,
} from '../imageOptimizer';

// Counts encodes so a test can fail the Nth one. Everything else passes through to Sharp.
const encodes = vi.hoisted(() => ({ count: 0, failAt: 0 }));

vi.mock('sharp', async (importOriginal) => {
    const actual = await importOriginal<typeof import('sharp')>();
    const realSharp = actual.default as unknown as (...args: unknown[]) => Sharp;
    const wrapped = (...args: unknown[]) => {
        const instance = realSharp(...args);
        const toBuffer = instance.toBuffer.bind(instance) as () => Promise<Buffer>;
        Object.defineProperty(instance, 'toBuffer', {
            value: async () => {
                encodes.count += 1;
                if (encodes.count === encodes.failAt) throw new Error(`injected encode failure at ${encodes.count}`);
                return toBuffer();
            },
        });
        return instance;
    };
    return { ...actual, default: Object.assign(wrapped, actual.default) };
});

const LANDSCAPE = derivativePaths('landscape');
const SEVEN = [1, 2, 3, 4, 5, 6, 7];

let fixtures: Map<string, Buffer>;
let lib: TempLibrary;
const libraries: TempLibrary[] = [];

async function newLibrary(options?: Parameters<typeof createTempLibrary>[0]): Promise<void> {
    lib = await createTempLibrary(options);
    libraries.push(lib);
}

beforeAll(async () => {
    fixtures = await fixtureFiles({ extras: true });
});

afterEach(async () => {
    encodes.count = 0;
    encodes.failAt = 0;
    vi.restoreAllMocks();
    for (const library of libraries.splice(0).reverse()) await library.cleanup();
});

function fixture(name: string): Buffer {
    const data = fixtures.get(name);
    if (!data) throw new Error(`No fixture named ${name}`);
    return data;
}

/** The dominant channel of each of a source's seven outputs, decoding the LQIP data URL too. */
async function outputChannels(base: string): Promise<Channel[]> {
    return Promise.all(derivativePaths(base).map(async (relativePath) => {
        const data = fs.readFileSync(lib.file(relativePath));
        if (!relativePath.endsWith('.txt')) return dominantChannel(data);
        return dominantChannel(Buffer.from(data.toString('utf8').replace(/^data:image\/webp;base64,/, ''), 'base64'));
    }));
}

function setMtime(relativePath: string, mtimeMs: number): void {
    const time = new Date(mtimeMs);
    fs.utimesSync(lib.file(relativePath), time, time);
}

/** Fail the Nth temp file write partway through, the way a full disk does. */
function failTempWrite(at: number) {
    const realOpen = fs.promises.open.bind(fs.promises);
    let tempOpens = 0;
    return vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await realOpen(...args);
        if (String(args[0]).endsWith('.tmp') && ++tempOpens === at) {
            Object.defineProperty(handle, 'writeFile', {
                value: async () => {
                    await handle.write(Buffer.from('partial'));
                    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
                },
            });
        }
        return handle;
    });
}

describe('libraryPaths', () => {
    it('reads PHOTOGRAPHY_LIBRARY_DIR on every call', async () => {
        await newLibrary();
        expect(libraryPaths().root).toBe(lib.root);
        expect(libraryPaths().optimized).toBe(path.join(lib.root, 'optimized'));

        const previous = process.env.PHOTOGRAPHY_LIBRARY_DIR;
        try {
            delete process.env.PHOTOGRAPHY_LIBRARY_DIR;
            expect(libraryPaths().root).toBe(path.join(process.cwd(), 'public/assets/photos'));
        } finally {
            process.env.PHOTOGRAPHY_LIBRARY_DIR = previous;
        }
        expect(libraryPaths().root).toBe(lib.root);
    });
});

describe('ensureDirectories', () => {
    it('creates the seven derivative folders and no cache folder', async () => {
        await newLibrary();
        ensureDirectories();
        expect(fs.readdirSync(lib.root).sort()).toEqual([
            'lqip', 'medium', 'medium-avif', 'optimized', 'optimized-avif', 'thumbnails', 'thumbnails-avif',
        ]);
    });

    it('throws on a missing root instead of recreating it', async () => {
        await newLibrary({ missingRoot: true });
        expect(() => ensureDirectories()).toThrow(LibraryRootMissingError);
        expect(fs.existsSync(lib.root)).toBe(false);
    });
});

describe('writeVariants', { timeout: 60_000 }, () => {
    let before: Record<string, string>;

    beforeEach(async () => {
        await newLibrary({ fixtures: 'basic' });
        await processImage('landscape.jpg');
        before = lib.hashes(LANDSCAPE);
        expect(Object.keys(before)).toHaveLength(7);
        // A re-export with new pixels, saved over the source
        fs.writeFileSync(lib.file('landscape.jpg'), fixture('landscape-edited.jpg'));
        encodes.count = 0;
    });

    it.each(SEVEN)('a failed encode of output %i keeps the previous seven byte-identical with no temp file', async (n) => {
        encodes.failAt = n;
        await expect(reprocessImage('landscape.jpg')).rejects.toThrow('injected encode failure');
        expect(lib.hashes(LANDSCAPE)).toEqual(before);
        expect(lib.tempFiles()).toEqual([]);
    });

    it.each(SEVEN)('ENOSPC on temp write %i keeps the previous seven byte-identical with no temp file', async (n) => {
        failTempWrite(n);
        await expect(reprocessImage('landscape.jpg')).rejects.toMatchObject({ code: 'ENOSPC' });
        expect(lib.hashes(LANDSCAPE)).toEqual(before);
        expect(lib.tempFiles()).toEqual([]);
    });

    it('a successful regeneration replaces all seven from the new bytes', async () => {
        await reprocessImage('landscape.jpg');
        const after = lib.hashes(LANDSCAPE);
        for (const relativePath of LANDSCAPE) {
            expect(after[relativePath], relativePath).toBeDefined();
            expect(after[relativePath], relativePath).not.toBe(before[relativePath]);
        }
        expect(await outputChannels('landscape')).toEqual(Array(7).fill('blue'));
        expect(lib.tempFiles()).toEqual([]);
    });

    it('logs when a rename fails after others went through, and leaves no temp file', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const realRename = fs.promises.rename.bind(fs.promises);
        let renames = 0;
        vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args: Parameters<typeof fs.promises.rename>) => {
            if (++renames === 3) throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
            return realRename(...args);
        });

        await expect(reprocessImage('landscape.jpg')).rejects.toMatchObject({ code: 'EIO' });
        expect(errors).toHaveBeenCalledWith(expect.stringContaining('failed after replacing 2 of 7'));
        expect(lib.tempFiles()).toEqual([]);
    });
});

describe('leftover temp files', () => {
    it('never count as an output', async () => {
        await newLibrary({ fixtures: 'basic' });
        ensureDirectories();
        const leftovers = LANDSCAPE.map((relativePath) => path.join(path.dirname(relativePath), '.landscape.4242.0a1b2c3d.tmp'));
        for (const leftover of leftovers) fs.writeFileSync(lib.file(leftover), 'partial');

        const paths = getImagePaths('landscape.jpg');
        expect([
            paths.hasThumbnail, paths.hasMedium, paths.hasOptimized,
            paths.hasThumbnailAvif, paths.hasMediumAvif, paths.hasOptimizedAvif, paths.hasLqip,
        ]).toEqual(Array(7).fill(false));
        expect(getUnprocessedFiles()).toContain('landscape.jpg');

        await processImage('landscape.jpg');
        expect(Object.keys(lib.hashes(LANDSCAPE))).toHaveLength(7);
        expect(lib.tempFiles()).toEqual(leftovers.sort());
    }, 30_000);
});

describe('processAllImages', { timeout: 60_000 }, () => {
    beforeEach(async () => {
        await newLibrary({ fixtures: 'basic' });
        const first = await processAllImages();
        expect(first.errors).toEqual([]);
        expect(first.processed.sort()).toEqual(['landscape.jpg', 'portrait.png', 'square.webp']);
    });

    it('regenerates a source newer than its outputs', async () => {
        const others = lib.hashes([...derivativePaths('portrait'), ...derivativePaths('square')]);
        fs.writeFileSync(lib.file('landscape.jpg'), fixture('landscape-edited.jpg'));
        setMtime('landscape.jpg', fs.statSync(lib.file('thumbnails/landscape.webp')).mtimeMs + 60_000);

        const result = await processAllImages();
        expect(result).toEqual({ processed: ['landscape.jpg'], errors: [] });
        expect(await outputChannels('landscape')).toEqual(Array(7).fill('blue'));
        expect(lib.hashes(Object.keys(others))).toEqual(others);
    });

    it('leaves a replacement with an older mtime for --force', async () => {
        const before = lib.hashes(LANDSCAPE);
        fs.writeFileSync(lib.file('landscape.jpg'), fixture('landscape-edited.jpg'));
        setMtime('landscape.jpg', Date.parse('2001-01-01T00:00:00Z'));

        expect(await processAllImages()).toEqual({ processed: [], errors: [] });
        expect(lib.hashes(LANDSCAPE)).toEqual(before);

        const forced = await processAllImages(undefined, { force: true });
        expect(forced.errors).toEqual([]);
        expect(forced.processed.sort()).toEqual(['landscape.jpg', 'portrait.png', 'square.webp']);
        expect(await outputChannels('landscape')).toEqual(Array(7).fill('blue'));
    });
});
