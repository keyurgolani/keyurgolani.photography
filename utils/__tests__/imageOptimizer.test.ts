// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sharp } from 'sharp';
import { dominantChannel, fixtureFiles, type Channel } from '../../test/fixtures/makeLibrary';
import { createTempLibrary, derivativePaths, type TempLibrary } from '../../test/helpers/tempLibrary';
import {
    ensureDirectories,
    filesToProcess,
    getImagePaths,
    getPhotoFiles,
    getUnprocessedFiles,
    isSourceFile,
    libraryPaths,
    LibraryRootMissingError,
    processImage,
    refreshImage,
    reprocessImage,
    tempFilePrefix,
} from '../imageOptimizer';
import { createWatcherHandlers } from '../watcherHandlers';

// Counts encodes so a test can fail the Nth one. Everything else passes through to Sharp.
const encodes = vi.hoisted(() => ({ count: 0, failAt: 0 }));

vi.mock('sharp', async (importOriginal) => {
    // sharp is CommonJS, so its function arrives as the namespace's default
    const actual = await importOriginal<{ default: typeof import('sharp') }>();
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
const quiet = { log: () => undefined, error: () => undefined };

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

function relativeToLibrary(target: fs.PathLike): string {
    return path.relative(lib.root, String(target)).split(path.sep).join('/');
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

describe('source files', () => {
    it('never counts a dot-file, such as a macOS AppleDouble file, as a photo', async () => {
        await newLibrary({ fixtures: 'basic' });
        fs.writeFileSync(lib.file('._landscape.jpg'), 'AppleDouble metadata');
        fs.writeFileSync(lib.file('.hidden.png'), fixture('portrait.png'));

        expect(getPhotoFiles().sort()).toEqual(['landscape.jpg', 'portrait.png', 'square.webp']);
        expect(isSourceFile('._landscape.jpg')).toBe(false);
        expect(isSourceFile(lib.file('._landscape.jpg'))).toBe(false);
        expect(isSourceFile('landscape.JPG')).toBe(true);
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

    it('renames the thumbnail last, so a swap interrupted before it is redone on the next run', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        // An older mtime than the outputs, so only the stale mark can trigger the redo
        setMtime('landscape.jpg', Date.parse('2001-01-01T00:00:00Z'));
        const renamed: string[] = [];
        const realRename = fs.promises.rename.bind(fs.promises);
        const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args: Parameters<typeof fs.promises.rename>) => {
            renamed.push(relativeToLibrary(args[1]));
            if (renamed.length === 7) throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
            return realRename(...args);
        });

        await expect(reprocessImage('landscape.jpg')).rejects.toMatchObject({ code: 'EIO' });
        expect(renamed[6]).toBe('thumbnails/landscape.webp');
        renameSpy.mockRestore();

        expect(getUnprocessedFiles()).toContain('landscape.jpg');
        await refreshImage('landscape.jpg');
        expect(await outputChannels('landscape')).toEqual(Array(7).fill('blue'));
    });
});

describe('temp files', { timeout: 30_000 }, () => {
    it('never count as an output', async () => {
        await newLibrary({ fixtures: 'basic' });
        ensureDirectories();
        const leftovers = LANDSCAPE.map((relativePath) =>
            path.join(path.dirname(relativePath), `${tempFilePrefix('landscape')}4242.0a1b2c3d.tmp`));
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
    });

    it('keep a fixed length, so a long but valid photo name still processes', async () => {
        await newLibrary();
        const base = 'a'.repeat(240);
        fs.writeFileSync(lib.file(`${base}.jpg`), fixture('landscape.jpg'));
        const temps: string[] = [];
        const realOpen = fs.promises.open.bind(fs.promises);
        vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
            if (String(args[0]).endsWith('.tmp')) temps.push(path.basename(String(args[0])));
            return realOpen(...args);
        });

        await processImage(`${base}.jpg`);

        expect(Object.keys(lib.hashes(derivativePaths(base)))).toHaveLength(7);
        expect(temps).toHaveLength(7);
        expect(temps.every((name) => name.length === temps[0].length && name.length < 64)).toBe(true);
    });
});

describe('isSourceNewer', () => {
    it('treats a thumbnail removed mid-check as missing instead of throwing', async () => {
        await newLibrary({ fixtures: 'basic' });
        await processImage('landscape.jpg');
        const thumbnail = lib.file('thumbnails/landscape.webp');
        const realStatSync = fs.statSync;
        vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
            if (String(target) === thumbnail) {
                // Gone by the time it is stat'ed, after existsSync() saw it
                if (options?.throwIfNoEntry === false) return undefined;
                throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${thumbnail}'`), { code: 'ENOENT' });
            }
            return realStatSync(target, options);
        }) as unknown as typeof fs.statSync);

        expect(getUnprocessedFiles()).toContain('landscape.jpg');
    }, 30_000);
});

describe('startup batch overwrite rule', { timeout: 60_000 }, () => {
    beforeEach(async () => {
        await newLibrary({ fixtures: 'basic' });
        const first = await createWatcherHandlers({ logger: quiet }).queueStartupBatch();
        expect(first.errors).toEqual([]);
        expect(first.processed.sort()).toEqual(['landscape.jpg', 'portrait.png', 'square.webp']);
    });

    it('regenerates a source newer than its outputs', async () => {
        const others = lib.hashes([...derivativePaths('portrait'), ...derivativePaths('square')]);
        fs.writeFileSync(lib.file('landscape.jpg'), fixture('landscape-edited.jpg'));
        // Newer than the outputs but not in the future, which the next test covers
        setMtime('thumbnails/landscape.webp', Date.now() - 60 * 60 * 1000);
        setMtime('landscape.jpg', Date.now() - 60 * 1000);

        const result = await createWatcherHandlers({ logger: quiet }).queueStartupBatch();
        expect(result).toEqual({ processed: ['landscape.jpg'], errors: [] });
        expect(await outputChannels('landscape')).toEqual(Array(7).fill('blue'));
        expect(lib.hashes(Object.keys(others))).toEqual(others);
    });

    it('leaves a replacement with an older mtime for --force', async () => {
        const before = lib.hashes(LANDSCAPE);
        fs.writeFileSync(lib.file('landscape.jpg'), fixture('landscape-edited.jpg'));
        setMtime('landscape.jpg', Date.parse('2001-01-01T00:00:00Z'));

        expect(await createWatcherHandlers({ logger: quiet }).queueStartupBatch()).toEqual({ processed: [], errors: [] });
        expect(lib.hashes(LANDSCAPE)).toEqual(before);

        const forced = await createWatcherHandlers({ logger: quiet }).queueStartupBatch({ force: true });
        expect(forced.errors).toEqual([]);
        expect(forced.processed.sort()).toEqual(['landscape.jpg', 'portrait.png', 'square.webp']);
        expect(await outputChannels('landscape')).toEqual(Array(7).fill('blue'));
    });

    it('does not re-encode a source dated in the future on every start', async () => {
        const before = lib.hashes(LANDSCAPE);
        setMtime('landscape.jpg', Date.now() + 24 * 60 * 60 * 1000);

        expect(filesToProcess()).not.toContain('landscape.jpg');
        expect(await createWatcherHandlers({ logger: quiet }).queueStartupBatch()).toEqual({ processed: [], errors: [] });
        expect(lib.hashes(LANDSCAPE)).toEqual(before);
    });
});
