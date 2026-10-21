// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp, { type Sharp } from 'sharp';
import { dominantChannel, fixtureFiles, withExifOrientation, type Channel } from '../../test/fixtures/makeLibrary';
import { createTempLibrary, derivativePaths, type TempLibrary } from '../../test/helpers/tempLibrary';
import {
    baseNameOf,
    ensureDirectories,
    filesToProcess,
    getImagePaths,
    getPhotoFiles,
    getUnprocessedFiles,
    isSourceFile,
    libraryPaths,
    libraryRootExists,
    processImage,
    refreshImage,
    reprocessImage,
    SOURCE_CHANGED,
    tempFilePrefix,
    writeVariants,
} from '../imageOptimizer';
import { createWatcherHandlers, type WatcherHandlers } from '../watcherHandlers';

// Counts encodes so a test can fail the Nth one, or act at it. Everything else passes through to Sharp.
const encodes = vi.hoisted(() => ({ count: 0, failAt: 0, onEncode: null as ((count: number) => void) | null }));

vi.mock('sharp', async (importOriginal) => {
    // sharp is CommonJS, so its function arrives as the namespace's default
    const actual = await importOriginal<{ default: typeof import('sharp') }>();
    const realSharp = actual.default as unknown as (...args: unknown[]) => Sharp;
    const wrapped = (...args: unknown[]) => {
        const instance = realSharp(...args);
        const toBuffer = instance.toBuffer.bind(instance) as (...options: unknown[]) => Promise<unknown>;
        Object.defineProperty(instance, 'toBuffer', {
            value: async (...options: unknown[]) => {
                encodes.count += 1;
                encodes.onEncode?.(encodes.count);
                if (encodes.count === encodes.failAt) throw new Error(`injected encode failure at ${encodes.count}`);
                return toBuffer(...options);
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
const handlerSets: WatcherHandlers[] = [];

async function newLibrary(options?: Parameters<typeof createTempLibrary>[0]): Promise<void> {
    lib = await createTempLibrary(options);
    libraries.push(lib);
}

/** A handler set that afterEach waits on, so no job outlives its test. */
function newHandlers(): WatcherHandlers {
    const handlers = createWatcherHandlers({ logger: quiet });
    handlerSets.push(handlers);
    return handlers;
}

beforeAll(async () => {
    fixtures = await fixtureFiles({ extras: true });
});

afterEach(async () => {
    encodes.count = 0;
    encodes.failAt = 0;
    encodes.onEncode = null;
    vi.restoreAllMocks();
    await Promise.all(handlerSets.splice(0).map((handlers) => handlers.idle()));
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

/** Rename a source in two steps, so a case-only rename works on a case-insensitive disk too. */
function renameSource(from: string, to: string): void {
    fs.renameSync(lib.file(from), lib.file('tmp-rename'));
    fs.renameSync(lib.file('tmp-rename'), lib.file(to));
}

/** The entry in `target`'s folder whose name differs from it only in case, if any. */
function caseVariantOf(target: string): string | undefined {
    const name = path.basename(target).toLowerCase();
    try {
        const match = fs.readdirSync(path.dirname(target)).find((entry) => entry.toLowerCase() === name);
        return match === undefined ? undefined : path.join(path.dirname(target), match);
    } catch {
        return undefined;
    }
}

/**
 * Make existsSync and lstatSync resolve names the way a case-insensitive disk
 * does, whatever disk this runs on. readdir still lists names as stored.
 */
function fakeCaseInsensitiveDisk(): void {
    const realExistsSync = fs.existsSync;
    const realLstatSync = fs.lstatSync;
    vi.spyOn(fs, 'existsSync').mockImplementation(((target: fs.PathLike) =>
        realExistsSync(target) || caseVariantOf(String(target)) !== undefined) as typeof fs.existsSync);
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) =>
        realLstatSync(realExistsSync(target) ? target : caseVariantOf(String(target)) ?? target, options)
    ) as unknown as typeof fs.lstatSync);
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
        expect(() => ensureDirectories()).toThrow(`Library root not found: ${lib.root}`);
        expect(fs.existsSync(lib.root)).toBe(false);
    });

    it('treats a root with no links left as missing, as a host folder deleted under a bind mount stats', async () => {
        await newLibrary();
        const realStatSync = fs.statSync;
        vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
            const stat = realStatSync(target, options);
            if (String(target) !== lib.root || !stat) return stat;
            return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { nlink: 0 });
        }) as unknown as typeof fs.statSync);

        expect(libraryRootExists()).toBe(false);
        expect(() => ensureDirectories()).toThrow(`Library root not found: ${lib.root}`);
        expect(fs.readdirSync(lib.root)).toEqual([]);
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

    it('share one set per base name, so a.jpg and a.png write the same outputs', () => {
        expect(baseNameOf('a.jpg')).toBe('a');
        expect(baseNameOf('a.png')).toBe('a');
        expect(baseNameOf('my.photo.webp')).toBe('my.photo');
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

    it.each([
        ['removed', () => fs.unlinkSync(lib.file('landscape.jpg'))],
        ['saved over again', () => fs.writeFileSync(lib.file('landscape.jpg'), fixture('landscape.jpg'))],
    ])('discards the new outputs when the source is %s mid-job, so a takedown sticks', async (_, change) => {
        encodes.onEncode = (count) => {
            if (count === 3) change();
        };
        await expect(reprocessImage('landscape.jpg')).rejects.toMatchObject({ code: SOURCE_CHANGED });
        expect(lib.hashes(LANDSCAPE)).toEqual(before);
        expect(lib.tempFiles()).toEqual([]);
    });

    it('treats a source removed before its job starts as changed, not failed', async () => {
        fs.unlinkSync(lib.file('landscape.jpg'));
        await expect(writeVariants('landscape.jpg', { overwrite: true })).rejects.toMatchObject({ code: SOURCE_CHANGED });
        expect(lib.hashes(LANDSCAPE)).toEqual(before);
    });

    it('keeps the source open from the read until after the second check', async () => {
        const source = lib.file('landscape.jpg');
        const events: string[] = [];
        const realOpen = fs.promises.open.bind(fs.promises);
        const realStat = fs.promises.stat.bind(fs.promises);
        vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
            const handle = await realOpen(...args);
            if (String(args[0]) === source) {
                events.push('open');
                const close = handle.close.bind(handle);
                Object.defineProperty(handle, 'close', {
                    value: async () => {
                        events.push('close');
                        return close();
                    },
                });
            }
            return handle;
        });
        vi.spyOn(fs.promises, 'stat').mockImplementation((async (...args: Parameters<typeof fs.promises.stat>) => {
            if (String(args[0]) === source) events.push('second check');
            return realStat(...args);
        }) as typeof fs.promises.stat);

        await reprocessImage('landscape.jpg');

        expect(events).toEqual(['open', 'second check', 'close']);
    });

    it('renames the thumbnail last, so a swap interrupted before it is redone on the next run', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        // A re-export saved after the old outputs, as usual
        setMtime('thumbnails/landscape.webp', Date.now() - 60 * 60 * 1000);
        setMtime('landscape.jpg', Date.now() - 60 * 1000);
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

        // The old thumbnail stays older than the source, so the next run redoes the set
        expect(getUnprocessedFiles()).toContain('landscape.jpg');
        await refreshImage('landscape.jpg');
        expect(await outputChannels('landscape')).toEqual(Array(7).fill('blue'));
    });

    it("deletes the photo's /api/image cache files after a full regeneration, matching its base exactly", async () => {
        fs.mkdirSync(lib.file('cache/dynamic'), { recursive: true });
        for (const name of ['landscape-800-85.webp', 'landscape-400-80.avif', 'landscape-edited-800-85.webp', 'portrait-800-85.webp']) {
            fs.writeFileSync(lib.file('cache/dynamic', name), 'cached');
        }

        await reprocessImage('landscape.jpg');

        expect(fs.readdirSync(lib.file('cache/dynamic')).sort()).toEqual(['landscape-edited-800-85.webp', 'portrait-800-85.webp']);
    });

    it("still regenerates when the /api/image cache folder can't be listed, since purging it is best effort", async () => {
        fs.mkdirSync(lib.file('cache/dynamic'), { recursive: true });
        fs.writeFileSync(lib.file('cache/dynamic', 'landscape-800-85.webp'), 'cached');
        const dynamic = lib.file('cache/dynamic');
        const realReaddirSync = fs.readdirSync;
        vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: fs.PathLike, options?: unknown) => {
            if (path.resolve(String(dir)) === dynamic) throw Object.assign(new Error(`EACCES: scandir '${dynamic}'`), { code: 'EACCES' });
            return (realReaddirSync as (dir: fs.PathLike, options?: unknown) => unknown)(dir, options);
        }) as typeof fs.readdirSync);
        fs.writeFileSync(lib.file('landscape.jpg'), fixtures.get('landscape-edited.jpg') as Buffer);

        await reprocessImage('landscape.jpg');

        expect(await outputChannels('landscape')).toEqual(Array(7).fill('blue'));
        expect(realReaddirSync(dynamic)).toEqual(['landscape-800-85.webp']);
    });
});

describe('exact names', { timeout: 60_000 }, () => {
    beforeEach(async () => {
        await newLibrary({ fixtures: 'basic' });
        await processImage('landscape.jpg');
        renameSource('landscape.jpg', 'Landscape.JPG');
    });

    it('count an output only under its exact name, even where the disk ignores case', () => {
        fakeCaseInsensitiveDisk();

        const outputs = getImagePaths('Landscape.JPG');
        expect([
            outputs.hasThumbnail, outputs.hasMedium, outputs.hasOptimized,
            outputs.hasThumbnailAvif, outputs.hasMediumAvif, outputs.hasOptimizedAvif, outputs.hasLqip,
        ]).toEqual(Array(7).fill(false));
        expect(getUnprocessedFiles()).toContain('Landscape.JPG');
    });

    it('rename an output to the new spelling before the swap, where the disk ignores case', async () => {
        fakeCaseInsensitiveDisk();

        expect(await refreshImage('Landscape.JPG')).toHaveLength(7);

        for (const relativePath of derivativePaths('Landscape')) {
            const folder = lib.file(path.dirname(relativePath));
            const spellings = fs.readdirSync(folder).filter((name) => name.toLowerCase() === path.basename(relativePath).toLowerCase());
            expect(spellings, relativePath).toEqual([path.basename(relativePath)]);
        }
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

describe('tall panoramas', () => {
    it("fit inside WebP's and AVIF's size limits, so all seven outputs are written", async () => {
        await newLibrary();
        const tall = await sharp({ create: { width: 1000, height: 20000, channels: 3, background: { r: 200, g: 40, b: 40 } } })
            .jpeg()
            .toBuffer();
        fs.writeFileSync(lib.file('tall.jpg'), tall);

        await processImage('tall.jpg');

        expect(Object.keys(lib.hashes(derivativePaths('tall')))).toHaveLength(7);
        for (const relativePath of ['optimized/tall.webp', 'optimized-avif/tall.avif']) {
            const { height } = await sharp(lib.file(relativePath)).metadata();
            expect(height, relativePath).toBeLessThanOrEqual(16383);
        }
    }, 120_000);
});

describe('isSourceNewer', () => {
    it('treats a thumbnail removed mid-check as missing instead of throwing', async () => {
        await newLibrary({ fixtures: 'basic' });
        await processImage('landscape.jpg');
        const thumbnail = lib.file('thumbnails/landscape.webp');
        const realStatSync = fs.statSync;
        vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
            if (String(target) === thumbnail) {
                // Gone by the time it is stat'ed, after the folder listing saw it
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
        const first = await newHandlers().queueStartupBatch();
        expect(first.errors).toEqual([]);
        expect(first.processed.sort()).toEqual(['landscape.jpg', 'portrait.png', 'square.webp']);
    });

    it('regenerates a source newer than its outputs', async () => {
        const others = lib.hashes([...derivativePaths('portrait'), ...derivativePaths('square')]);
        fs.writeFileSync(lib.file('landscape.jpg'), fixture('landscape-edited.jpg'));
        // Newer than the outputs but not in the future, which a later test covers
        setMtime('thumbnails/landscape.webp', Date.now() - 60 * 60 * 1000);
        setMtime('landscape.jpg', Date.now() - 60 * 1000);

        const result = await newHandlers().queueStartupBatch();
        expect(result).toEqual({ processed: ['landscape.jpg'], skipped: [], errors: [] });
        expect(await outputChannels('landscape')).toEqual(Array(7).fill('blue'));
        expect(lib.hashes(Object.keys(others))).toEqual(others);
    });

    it('regenerates all seven when one is missing, not just the gap', async () => {
        fs.rmSync(lib.file('medium/landscape.webp'));
        // A replacement with an older mtime, so only the missing output starts the job
        fs.writeFileSync(lib.file('landscape.jpg'), fixture('landscape-edited.jpg'));
        setMtime('landscape.jpg', Date.parse('2001-01-01T00:00:00Z'));

        const result = await newHandlers().queueStartupBatch();
        expect(result).toEqual({ processed: ['landscape.jpg'], skipped: [], errors: [] });
        expect(await outputChannels('landscape')).toEqual(Array(7).fill('blue'));
    });

    it('leaves a replacement with an older mtime for touch or --force', async () => {
        const before = lib.hashes(LANDSCAPE);
        fs.writeFileSync(lib.file('landscape.jpg'), fixture('landscape-edited.jpg'));
        setMtime('landscape.jpg', Date.parse('2001-01-01T00:00:00Z'));

        expect(await newHandlers().queueStartupBatch()).toEqual({ processed: [], skipped: [], errors: [] });
        expect(lib.hashes(LANDSCAPE)).toEqual(before);

        const forced = await newHandlers().queueStartupBatch({ force: true });
        expect(forced.errors).toEqual([]);
        expect(forced.processed.sort()).toEqual(['landscape.jpg', 'portrait.png', 'square.webp']);
        expect(await outputChannels('landscape')).toEqual(Array(7).fill('blue'));
    });

    it('regenerates a future-dated replacement made while stopped, and dates the thumbnail when it was written', async () => {
        // From a camera whose clock runs a day ahead
        fs.writeFileSync(lib.file('landscape.jpg'), fixture('landscape-edited.jpg'));
        setMtime('landscape.jpg', Date.now() + 24 * 60 * 60 * 1000);

        const startedAt = Date.now();
        expect(await newHandlers().queueStartupBatch()).toEqual({ processed: ['landscape.jpg'], skipped: [], errors: [] });
        expect(await outputChannels('landscape')).toEqual(Array(7).fill('blue'));

        // Nothing sets file times, so until its date passes this source counts as newer on each start
        const written = fs.statSync(lib.file('thumbnails/landscape.webp')).mtimeMs;
        expect(written).toBeGreaterThanOrEqual(startedAt - 1000);
        expect(written).toBeLessThanOrEqual(Date.now() + 1000);
        expect(filesToProcess()).toContain('landscape.jpg');
    });

    it('throws on a missing root when forced, the same as unforced', async () => {
        const missing = await createTempLibrary({ missingRoot: true });
        libraries.push(missing);

        expect(() => filesToProcess()).toThrow(`Library root not found: ${missing.root}`);
        expect(() => filesToProcess({ force: true })).toThrow(`Library root not found: ${missing.root}`);
        await expect(newHandlers().queueStartupBatch({ force: true })).rejects.toThrow('Library root not found');
    });
});

describe('orientation', { timeout: 60_000 }, () => {
    const STORED = { width: 960, height: 640 };

    /** A stored 960x640 JPEG whose top-left quarter is red and the rest blue, tagged with `orientation`. */
    async function markedJpeg(orientation: number): Promise<Buffer> {
        const { width, height } = STORED;
        const pixels = Buffer.alloc(width * height * 3);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const red = x < width / 2 && y < height / 2;
                pixels.set(red ? [220, 30, 30] : [30, 30, 220], (y * width + x) * 3);
            }
        }
        const jpeg = await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
        return withExifOrientation(jpeg, orientation);
    }

    /** An output's size and which quarter of it is red, sampled at each quarter's center. */
    async function look(image: Buffer): Promise<{ width: number; height: number; red: string[] }> {
        const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
        const quarters: [string, number, number][] = [['top-left', 0.25, 0.25], ['top-right', 0.75, 0.25], ['bottom-left', 0.25, 0.75], ['bottom-right', 0.75, 0.75]];
        const red = quarters
            .filter(([, fx, fy]) => {
                const offset = (Math.floor(fy * info.height) * info.width + Math.floor(fx * info.width)) * info.channels;
                return data[offset] > data[offset + 2];
            })
            .map(([quarter]) => quarter);
        return { width: info.width, height: info.height, red };
    }

    it.each([
        [3, 'bottom-right', 960, 640],
        [6, 'top-right', 640, 960],
        [8, 'bottom-left', 640, 960],
    ])('turns Orientation %i upright in all seven outputs, so the red quarter ends %s', async (orientation, quarter, width, height) => {
        await newLibrary();
        fs.writeFileSync(lib.file('turned.jpg'), await markedJpeg(orientation));
        await processImage('turned.jpg');

        const widths: Record<string, number> = { thumbnails: 400, medium: 800, optimized: 1920 };
        for (const relativePath of derivativePaths('turned').filter((output) => !output.endsWith('.txt'))) {
            const expectedWidth = Math.min(width, widths[relativePath.split('/')[0].replace(/-avif$/, '')]);
            const seen = await look(fs.readFileSync(lib.file(relativePath)));
            expect(seen.red, relativePath).toEqual([quarter]);
            expect(seen.width, relativePath).toBe(expectedWidth);
            expect(Math.abs(seen.height - (expectedWidth * height) / width), relativePath).toBeLessThanOrEqual(1);
        }

        const lqip = fs.readFileSync(lib.file('lqip/turned.txt'), 'utf8').replace(/^data:image\/webp;base64,/, '');
        const small = await look(Buffer.from(lqip, 'base64'));
        expect(small.red).toEqual([quarter]);
        expect(small.width > small.height).toBe(width > height);
    });
});
