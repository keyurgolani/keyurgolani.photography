// @vitest-environment node
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FSWatcherEventMap } from 'chokidar';
import sharp, { type Sharp } from 'sharp';
import { scanLibrary } from '../../lib/identity/scan';
import { dominantChannel, fixtureFiles, withExifOrientation, type Channel } from '../../test/fixtures/makeLibrary';
import { fakeCaseInsensitiveDisk, fakeCaseSensitiveDisk } from '../../test/helpers/caseDisk';
import { REPO_ROOT, runTsx } from '../../test/helpers/runTsx';
import { createTempLibrary, derivativePaths, type TempLibrary } from '../../test/helpers/tempLibrary';
import { baseNameOf, isOrientationTagged, optimizedSize, ownerOf, planOrphanCleanup, planSources, processImage, readSetSource, writeUprightMarker } from '../imageOptimizer';
import {
    attachWatcher,
    createIgnoreFilter,
    createWatcherHandlers,
    createWatchModeHandlers,
    drainOrReport,
    processOnce,
    type WatcherHandlers,
} from '../watcherHandlers';

// When armed, holds the next encode until the test releases it, so a test can
// queue more jobs while the first is mid-flight. It also tracks how many encodes
// are in flight at once, which is how many jobs run at once, since one job
// encodes its outputs one after another.
const gate = vi.hoisted(() => {
    let armed: { reached: () => void; released: Promise<void> } | null = null;
    let releaseHeld = () => {};
    let inFlight = 0;
    let maxInFlight = 0;
    return {
        arm() {
            let reached = () => {};
            let release = () => {};
            const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
            const released = new Promise<void>((resolve) => { release = resolve; });
            armed = { reached, released };
            releaseHeld = release;
            return { reached: reachedPromise, release };
        },
        async encode<T>(run: () => Promise<T>): Promise<T> {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            try {
                const current = armed;
                if (current) {
                    armed = null;
                    current.reached();
                    await current.released;
                }
                return await run();
            } finally {
                inFlight -= 1;
            }
        },
        get maxInFlight() {
            return maxInFlight;
        },
        /** Disarm, release any held encode so a failed test can't leave a job hanging, and reset the counter. */
        reset() {
            armed = null;
            releaseHeld();
            maxInFlight = 0;
        },
    };
});

vi.mock('sharp', async (importOriginal) => {
    // sharp is CommonJS, so its function arrives as the namespace's default
    const actual = await importOriginal<{ default: typeof import('sharp') }>();
    const realSharp = actual.default as unknown as (...args: unknown[]) => Sharp;
    const wrapped = (...args: unknown[]) => {
        const instance = realSharp(...args);
        const toBuffer = instance.toBuffer.bind(instance) as () => Promise<Buffer>;
        Object.defineProperty(instance, 'toBuffer', { value: () => gate.encode(toBuffer) });
        return instance;
    };
    return { ...actual, default: Object.assign(wrapped, actual.default) };
});

// The writes of cache/set-sources, in the order they finish, and which ones fail, as a full disk would.
const recordWrites = vi.hoisted(() => ({
    fail: null as ((data: string) => boolean) | null,
    events: null as string[] | null,
}));

vi.mock('../../lib/storage/atomicWrite', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../lib/storage/atomicWrite')>();
    const isRecord = (file: string) => file.includes(`${path.sep}set-sources${path.sep}`);
    return {
        ...actual,
        async atomicWriteFile(...args: Parameters<typeof actual.atomicWriteFile>) {
            const [file, data] = args;
            if (isRecord(file) && recordWrites.fail?.(String(data))) {
                throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
            }
            await actual.atomicWriteFile(...args);
            if (isRecord(file)) recordWrites.events?.push(`record ${String(data).trim()}`);
        },
    };
});

const LANDSCAPE = derivativePaths('landscape');
const BASIC = ['landscape.jpg', 'portrait.png', 'square.webp'];

let edited: Buffer; // blue-dominant re-export of landscape.jpg
let green: Buffer; // a third version
let corrupt: Buffer; // a JPEG header Sharp can't decode
let turned: Buffer; // landscape.jpg stored as it is, with EXIF Orientation 6
let turnedEdited: Buffer; // edited, with EXIF Orientation 6
let lib: TempLibrary;
let logs: string[];
let handlers: WatcherHandlers;
const handlerSets: WatcherHandlers[] = [];

const logger = {
    log: (...args: unknown[]) => { logs.push(args.map(String).join(' ')); },
    error: (...args: unknown[]) => { logs.push(args.map(String).join(' ')); },
};

/** A handler set that afterEach waits on, so no job outlives its test. */
function newHandlers(options: { maxConcurrentJobs?: number } = {}): WatcherHandlers {
    const created = createWatcherHandlers({ logger, ...options });
    handlerSets.push(created);
    return created;
}

beforeAll(async () => {
    const extras = await fixtureFiles({ extras: true });
    edited = extras.get('landscape-edited.jpg') as Buffer;
    corrupt = extras.get('corrupt.jpg') as Buffer;
    turned = extras.get('landscape-rot6.jpg') as Buffer;
    turnedEdited = withExifOrientation(edited, 6);
    green = await sharp({ create: { width: 960, height: 640, channels: 3, background: { r: 30, g: 190, b: 60 } } })
        .jpeg({ quality: 90 })
        .toBuffer();
});

beforeEach(async () => {
    lib = await createTempLibrary({ fixtures: 'basic' });
    logs = [];
    gate.reset();
    // Several jobs may run at once here, so only the per-basename ordering keeps one source's jobs in turn
    handlers = newHandlers({ maxConcurrentJobs: 4 });
});

afterEach(async () => {
    gate.reset();
    recordWrites.fail = null;
    recordWrites.events = null;
    vi.restoreAllMocks();
    await Promise.all(handlerSets.splice(0).map((set) => set.idle()));
    await lib.cleanup();
});

async function outputChannels(base: string): Promise<Channel[]> {
    return Promise.all(derivativePaths(base).map(async (relativePath) => {
        const data = fs.readFileSync(lib.file(relativePath));
        if (!relativePath.endsWith('.txt')) return dominantChannel(data);
        return dominantChannel(Buffer.from(data.toString('utf8').replace(/^data:image\/webp;base64,/, ''), 'base64'));
    }));
}

/** Give a job that isn't ordered behind the held one a chance to run before the test looks. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 750));

/** Records the order jobs open their sources in, which is the order they start encoding. */
function recordSourceReads(): string[] {
    const reads: string[] = [];
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(((...args: Parameters<typeof fs.promises.open>) => {
        // A record's write opens its folder to fsync it, which reads no source.
        if (args[1] === 'r' && /\.(jpe?g|png|webp)$/i.test(String(args[0]))) reads.push(path.basename(String(args[0])));
        return realOpen(...args);
    }) as typeof fs.promises.open);
    return reads;
}

function setMtime(relativePath: string, mtimeMs: number): void {
    const time = new Date(mtimeMs);
    fs.utimesSync(lib.file(relativePath), time, time);
}

/** The outputs' inodes, which a rewrite replaces. */
function inodes(relativePaths: string[]): number[] {
    return relativePaths.map((relativePath) => fs.statSync(lib.file(relativePath)).ino);
}

/** Counts the listings of the library root. */
function countRootListings(): { count: number } {
    const listings = { count: 0 };
    const realReaddirSync = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((target: fs.PathLike, options?: unknown) => {
        if (path.resolve(String(target)) === path.resolve(lib.root)) listings.count += 1;
        return (realReaddirSync as (target: fs.PathLike, options?: unknown) => unknown)(target, options);
    }) as unknown as typeof fs.readdirSync);
    return listings;
}

describe('watcher handlers', { timeout: 60_000 }, () => {
    it('onUnlink deletes nothing, leaves the set as it was, and points at images:cleanup', async () => {
        await handlers.onAdd(lib.file('landscape.jpg'));
        const before = lib.hashes(LANDSCAPE);
        const thumbnail = fs.statSync(lib.file('thumbnails/landscape.webp'));
        expect(Object.keys(before)).toHaveLength(7);

        fs.unlinkSync(lib.file('landscape.jpg'));
        await handlers.onUnlink(lib.file('landscape.jpg'));

        expect(lib.hashes(LANDSCAPE)).toEqual(before);
        expect(fs.statSync(lib.file('thumbnails/landscape.webp')).mtimeMs).toBe(thumbnail.mtimeMs);
        expect(fs.readdirSync(lib.root).filter((name) => name.includes('.')).sort()).toEqual(['portrait.png', 'square.webp']);
        expect(logs).toContain('[ImageWatcher] Source removed: landscape.jpg. Derivatives kept. See npm run images:cleanup.');
    });

    describe('sources sharing one set', () => {
        it('builds the set only from its owner, the first by path, so it shows the photo the Gallery lists', async () => {
            fs.copyFileSync(lib.file('portrait.png'), lib.file('landscape.png'));
            expect(await processOnce(handlers, { force: true, logger })).toBe(0);
            expect(await outputChannels('landscape')).toEqual(Array(7).fill('red'));
            expect(logs).toContain('[ImageWatcher] Skipping landscape.png: it shares its derivatives with landscape.jpg.');
        });

        it('treats base names that differ only by case or Unicode form as one set on a disk that resolves them to one file', async () => {
            fakeCaseInsensitiveDisk();
            fs.copyFileSync(lib.file('portrait.png'), lib.file('Landscape.png'));
            expect(await processOnce(handlers, { force: true, logger })).toBe(0);
            // Landscape.png comes first by path, so its set is the one written, under its own spelling.
            expect(await outputChannels('Landscape')).toEqual(Array(7).fill('green'));
            expect(logs).toContain('[ImageWatcher] Skipping landscape.jpg: it shares its derivatives with Landscape.png.');
        });

        it('builds a set for each of two base names that differ only by case on a disk that keeps them apart', async () => {
            fakeCaseSensitiveDisk();
            fs.copyFileSync(lib.file('portrait.png'), lib.file('Landscape.png'));
            const result = await handlers.queueStartupBatch({ force: true });
            expect(result).toMatchObject({ skipped: [], errors: [] });
            expect(result.processed.sort()).toEqual(['Landscape.png', ...BASIC]);
            expect(logs.filter((line) => line.includes('Skipping'))).toEqual([]);
        });

        it('falls back to the next source when the first by path does not decode', async () => {
            fs.writeFileSync(lib.file('landscape.jpeg'), corrupt);
            expect(await processOnce(handlers, { force: true, logger })).toBe(0);
            expect(await outputChannels('landscape')).toEqual(Array(7).fill('red'));
            expect(logs).toContain("[ImageWatcher] Skipping landscape.jpeg: it can't be decoded, so landscape.jpg has the derivatives they share.");
        });

        it('passes over a truncated source whose header is intact', async () => {
            const whole = fs.readFileSync(lib.file('landscape.jpg'));
            const truncated = whole.subarray(0, Math.floor(whole.length * 0.6));
            await expect(sharp(truncated).metadata()).resolves.toMatchObject({ width: 960 });
            fs.writeFileSync(lib.file('landscape.jpeg'), truncated);
            expect(await processOnce(handlers, { force: true, logger })).toBe(0);
            expect(await outputChannels('landscape')).toEqual(Array(7).fill('red'));
            expect(logs).toContain("[ImageWatcher] Skipping landscape.jpeg: it can't be decoded, so landscape.jpg has the derivatives they share.");
        });

        it('still builds the owner when a change to another source of its set drops its startup job', async () => {
            fs.copyFileSync(lib.file('landscape.jpg'), lib.file('portrait.jpg'));
            const single = newHandlers();
            // Decode the portrait sources now, so the gate holds landscape.jpg's first encode and not the owner check.
            expect(await ownerOf('portrait.png')).toBe('portrait.jpg');
            const held = gate.arm();
            const batch = single.queueStartupBatch();
            await held.reached;
            const change = single.onChange(lib.file('portrait.png'));
            held.release();

            expect(await batch).toEqual({ processed: ['landscape.jpg', 'square.webp'], skipped: ['portrait.jpg'], errors: [] });
            await change;
            expect(await outputChannels('portrait')).toEqual(Array(7).fill('red'));
        });

        it('keeps --force for the owner when a change to a later source of its set drops its startup job', async () => {
            const original = fs.readFileSync(lib.file('portrait.png'));
            // A set built from other pixels, under a source put back older than it, which only --force rebuilds
            fs.writeFileSync(lib.file('portrait.png'), await sharp({ create: { width: 640, height: 960, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer());
            await processImage('portrait.png');
            expect(await outputChannels('portrait')).toEqual(Array(7).fill('red'));
            fs.writeFileSync(lib.file('portrait.png'), original);
            setMtime('portrait.png', Date.parse('2001-01-01T00:00:00Z'));
            fs.copyFileSync(lib.file('portrait.png'), lib.file('portrait.webp'));
            const single = newHandlers();
            // Decode the portrait sources now, so the gate holds landscape.jpg's first encode and not the owner check.
            expect(await ownerOf('portrait.webp')).toBe('portrait.png');
            const held = gate.arm();
            const batch = single.queueStartupBatch({ force: true });
            await held.reached;
            const change = single.onChange(lib.file('portrait.webp'));
            held.release();

            expect(await batch).toEqual({ processed: ['landscape.jpg', 'square.webp'], skipped: ['portrait.png'], errors: [] });
            await change;
            expect(await outputChannels('portrait')).toEqual(Array(7).fill('green'));
        });

        it('leaves the set alone when a source before its owner that never decoded changes', async () => {
            fs.writeFileSync(lib.file('landscape.jpeg'), corrupt);
            expect(await processOnce(handlers, { force: true, logger })).toBe(0);
            const before = inodes(LANDSCAPE);
            fs.writeFileSync(lib.file('landscape.jpeg'), Buffer.concat([corrupt, Buffer.from([0])]));
            // Two events for one save, so the second job finds it decoded already at the version it has now
            await Promise.all([handlers.onChange(lib.file('landscape.jpeg')), handlers.onChange(lib.file('landscape.jpeg'))]);

            expect(inodes(LANDSCAPE)).toEqual(before);
            expect(await outputChannels('landscape')).toEqual(Array(7).fill('red'));
            expect(logs).toContain('[ImageWatcher] Skipping landscape.jpeg: it shares its derivatives with landscape.jpg.');
            expect(logs.filter((line) => line.includes('Rebuilt'))).toEqual([]);
        });

        it('rebuilds the set from a new file that takes it over, whatever its mtime', async () => {
            await handlers.onAdd(lib.file('portrait.png'));
            expect(await outputChannels('portrait')).toEqual(Array(7).fill('green'));
            // As cp -p or a Finder copy leaves it: older than the set it now owns
            fs.copyFileSync(lib.file('landscape.jpg'), lib.file('portrait.jpg'));
            setMtime('portrait.jpg', Date.parse('2001-01-01T00:00:00Z'));
            await handlers.onAdd(lib.file('portrait.jpg'));
            expect(await outputChannels('portrait')).toEqual(Array(7).fill('red'));
            expect(logs).toContain('[ImageWatcher] Rebuilt the set portrait.jpg now owns from it.');
        });

        it('rebuilds the set from the next source when a change leaves its owner undecodable', async () => {
            fs.copyFileSync(lib.file('landscape.jpg'), lib.file('portrait.jpg'));
            await handlers.onAdd(lib.file('portrait.jpg'));
            expect(await outputChannels('portrait')).toEqual(Array(7).fill('red'));
            fs.writeFileSync(lib.file('portrait.jpg'), corrupt);
            await handlers.onChange(lib.file('portrait.jpg'));
            expect(await outputChannels('portrait')).toEqual(Array(7).fill('green'));
            expect(logs).toContain('[ImageWatcher] Rebuilt the set portrait.jpg shared from portrait.png, which owns it now.');
        });

        it('still rebuilds from the next source when something decoded the changed owner again before its change job', async () => {
            fs.copyFileSync(lib.file('landscape.jpg'), lib.file('portrait.jpg'));
            await handlers.onAdd(lib.file('portrait.jpg'));
            expect(await outputChannels('portrait')).toEqual(Array(7).fill('red'));
            fs.writeFileSync(lib.file('portrait.jpg'), corrupt);
            // As a job for another source of the set would, ahead of this change's job
            expect(await ownerOf('portrait.png')).toBe('portrait.png');
            await handlers.onChange(lib.file('portrait.jpg'));
            expect(await outputChannels('portrait')).toEqual(Array(7).fill('green'));
            expect(logs).toContain('[ImageWatcher] Rebuilt the set portrait.jpg shared from portrait.png, which owns it now.');
        });

        it('rebuilds from the next source when another job decoded the changed owner between two saves of it', async () => {
            fs.copyFileSync(lib.file('landscape.jpg'), lib.file('portrait.jpg'));
            await handlers.onAdd(lib.file('portrait.jpg'));
            expect(await outputChannels('portrait')).toEqual(Array(7).fill('red'));
            fs.writeFileSync(lib.file('portrait.jpg'), corrupt);
            // A job for a third source of the set decodes it between the two writes of one save.
            fs.copyFileSync(lib.file('portrait.png'), lib.file('portrait.webp'));
            expect(await ownerOf('portrait.webp')).toBe('portrait.png');
            fs.writeFileSync(lib.file('portrait.jpg'), Buffer.concat([corrupt, Buffer.from([0])]));
            await handlers.onChange(lib.file('portrait.jpg'));
            expect(await outputChannels('portrait')).toEqual(Array(7).fill('green'));
            expect(logs).toContain('[ImageWatcher] Rebuilt the set portrait.jpg shared from portrait.png, which owns it now.');
        });

        it('rebuilds from the next source when the owner went bad while the watcher was down', async () => {
            fs.copyFileSync(lib.file('landscape.jpg'), lib.file('portrait.jpg'));
            // Another process built the set, so this one doesn't know what built it.
            const run = await runTsx('scripts/imageWatcher.ts', ['--once'], {
                env: { PHOTOGRAPHY_LIBRARY_DIR: lib.root, PHOTOGRAPHY_DATA_DIR: path.join(lib.root, '..', 'no-data-root') },
            });
            expect(run.code, run.stderr).toBe(0);
            expect(await outputChannels('portrait')).toEqual(Array(7).fill('red'));
            fs.writeFileSync(lib.file('portrait.jpg'), corrupt);
            // The restarted watcher decodes it at startup, before the next save of it brings a change event.
            const restarted = newHandlers();
            expect(await ownerOf('portrait.png')).toBe('portrait.png');
            fs.writeFileSync(lib.file('portrait.jpg'), Buffer.concat([corrupt, Buffer.from([0])]));
            await restarted.onChange(lib.file('portrait.jpg'));
            expect(await outputChannels('portrait')).toEqual(Array(7).fill('green'));
        });

        it('leaves a set alone on a change of a source it shares, when the record says another process built it from its owner', async () => {
            fs.copyFileSync(lib.file('landscape.jpg'), lib.file('portrait.jpg'));
            const run = await runTsx('scripts/imageWatcher.ts', ['--once'], {
                env: { PHOTOGRAPHY_LIBRARY_DIR: lib.root, PHOTOGRAPHY_DATA_DIR: path.join(lib.root, '..', 'no-data-root') },
            });
            expect(run.code, run.stderr).toBe(0);
            expect(await outputChannels('portrait')).toEqual(Array(7).fill('red'));
            const before = lib.hashes(derivativePaths('portrait'));

            // A watcher started since knows from cache/set-sources that the owner built the set, so it has nothing to rebuild.
            const restarted = newHandlers();
            await restarted.onChange(lib.file('portrait.png'));
            expect(lib.hashes(derivativePaths('portrait'))).toEqual(before);
            expect(logs).toContain('[ImageWatcher] Skipping portrait.png: it shares its derivatives with portrait.jpg.');
        });

        it('writes nothing for an add or a change of a source whose set another owns', async () => {
            await handlers.onAdd(lib.file('landscape.jpg'));
            const before = lib.hashes(LANDSCAPE);
            fs.copyFileSync(lib.file('portrait.png'), lib.file('landscape.png'));
            await handlers.onAdd(lib.file('landscape.png'));
            await handlers.onChange(lib.file('landscape.png'));
            expect(lib.hashes(LANDSCAPE)).toEqual(before);
            expect(logs.filter((line) => line.startsWith('[ImageWatcher] Skipping landscape.png'))).toEqual(
                Array(2).fill('[ImageWatcher] Skipping landscape.png: it shares its derivatives with landscape.jpg.'));
        });

        it('builds the set again from the source that owns it once the owner is removed', async () => {
            fs.copyFileSync(lib.file('portrait.png'), lib.file('landscape.png'));
            await processOnce(handlers, { force: true, logger });
            fs.unlinkSync(lib.file('landscape.jpg'));
            await handlers.onUnlink(lib.file('landscape.jpg'));
            expect(await outputChannels('landscape')).toEqual(Array(7).fill('green'));
            expect(logs).toContain('[ImageWatcher] Rebuilt the set landscape.jpg shared from landscape.png.');
        });

        it('leaves the set alone when a source that never owned it is removed', async () => {
            fs.copyFileSync(lib.file('portrait.png'), lib.file('landscape.png'));
            await processOnce(handlers, { force: true, logger });
            const before = lib.hashes(LANDSCAPE);
            fs.unlinkSync(lib.file('landscape.png'));
            await handlers.onUnlink(lib.file('landscape.png'));
            expect(lib.hashes(LANDSCAPE)).toEqual(before);
            expect(logs.filter((line) => line.includes('Rebuilt'))).toEqual([]);
        });

        it('rebuilds at startup a set whose owner was removed while the watcher was down', async () => {
            fs.copyFileSync(lib.file('portrait.png'), lib.file('landscape.png'));
            expect(await processOnce(handlers, { force: true, logger })).toBe(0);
            handlers.stop();

            // No unlink event: the watcher is down. landscape.png is older than the set, which looks current.
            fs.unlinkSync(lib.file('landscape.jpg'));
            expect(await newHandlers().queueStartupBatch()).toEqual({ processed: ['landscape.png'], skipped: [], errors: [] });
            expect(await outputChannels('landscape')).toEqual(Array(7).fill('green'));
            expect(logs).toContain("[ImageWatcher] Rebuilding landscape.png's set, which was last built from landscape.jpg.");

            expect(await newHandlers().queueStartupBatch()).toEqual({ processed: [], skipped: [], errors: [] });
        });

        it('rebuilds at startup a set that a source sorting first took over while the watcher was down, whatever its mtime', async () => {
            expect(await processOnce(handlers, { force: true, logger })).toBe(0);
            handlers.stop();

            fs.copyFileSync(lib.file('portrait.png'), lib.file('landscape.jpeg'));
            setMtime('landscape.jpeg', Date.parse('2001-01-01T00:00:00Z'));
            expect(await newHandlers().queueStartupBatch()).toEqual({ processed: ['landscape.jpeg'], skipped: [], errors: [] });
            expect(await outputChannels('landscape')).toEqual(Array(7).fill('green'));
        });

        it('rebuilds a set a source sorting first takes over live, whatever its mtime', async () => {
            await handlers.onAdd(lib.file('landscape.jpg'));
            fs.copyFileSync(lib.file('portrait.png'), lib.file('landscape.jpeg'));
            setMtime('landscape.jpeg', Date.parse('2001-01-01T00:00:00Z'));

            await handlers.onAdd(lib.file('landscape.jpeg'));
            expect(await outputChannels('landscape')).toEqual(Array(7).fill('green'));
        });

        it('rebuilds once a shared set nothing records the source of, and leaves a set with one source alone', async () => {
            fs.copyFileSync(lib.file('portrait.png'), lib.file('landscape.png'));
            expect(await processOnce(handlers, { force: true, logger })).toBe(0);
            // As a set written before the record was kept
            fs.rmSync(lib.file('cache', 'set-sources'), { recursive: true });

            expect(await newHandlers().queueStartupBatch()).toEqual({ processed: ['landscape.jpg'], skipped: [], errors: [] });
            expect(logs).toContain("[ImageWatcher] Rebuilding landscape.jpg's set, which it shares, since nothing records which source it was built from.");
            expect(await outputChannels('landscape')).toEqual(Array(7).fill('red'));
            expect(await newHandlers().queueStartupBatch()).toEqual({ processed: [], skipped: [], errors: [] });
        });

        describe('a build stopped partway', () => {
            /** Builds every set and records each one finished. portrait.png's set is green. */
            async function builtLibrary(): Promise<void> {
                expect(await processOnce(handlers, { force: true, logger })).toBe(0);
                expect(readSetSource('portrait.png')).toEqual({ source: 'portrait.png', finished: true });
            }

            /** Runs `run` in handlers that die after `renames` renames, as a watcher killed there would. */
            async function killedAfter(renames: number, run: (killed: WatcherHandlers) => Promise<void>): Promise<void> {
                const realRename = fs.promises.rename.bind(fs.promises);
                let count = 0;
                let reached = () => {};
                const stopped = new Promise<void>((resolve) => { reached = resolve; });
                const rename = vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args: Parameters<typeof fs.promises.rename>) => {
                    if (++count <= renames) return realRename(...args);
                    reached();
                    return new Promise<void>(() => {}); // Never settles, so nothing after it runs
                });
                // Not in handlerSets, since its job never finishes
                const killed = createWatcherHandlers({ logger });
                void run(killed);
                await stopped;
                rename.mockRestore();
                killed.stop();
            }

            /** Fails each write to cache/set-sources that `matches` picks, as a full disk would, until the test ends. */
            function failRecordWrites(matches: (data: string) => boolean): void {
                recordWrites.fail = matches;
            }
            const unfinished = (data: string) => data.includes('"complete":false');

            it('rebuilds at startup a set whose takeover was killed partway, once the source that took it over is removed while the watcher is down', async () => {
                await builtLibrary();
                handlers.stop();
                fs.copyFileSync(lib.file('landscape.jpg'), lib.file('portrait.jpg'));
                await killedAfter(4, (killed) => killed.onAdd(lib.file('portrait.jpg')));
                expect(new Set(await outputChannels('portrait'))).toEqual(new Set(['red', 'green']));
                expect(readSetSource('portrait.png')).toEqual({ source: 'portrait.jpg', finished: false });

                fs.unlinkSync(lib.file('portrait.jpg'));
                expect(await newHandlers().queueStartupBatch()).toEqual({ processed: ['portrait.png'], skipped: [], errors: [] });
                expect(logs).toContain("[ImageWatcher] Rebuilding portrait.png's set, since a build of it from portrait.jpg didn't finish.");
                expect(await outputChannels('portrait')).toEqual(Array(7).fill('green'));
                expect(readSetSource('portrait.png')).toEqual({ source: 'portrait.png', finished: true });
            });

            it('rebuilds at startup a set its one source was rebuilding when killed, whatever the thumbnail says', async () => {
                fs.copyFileSync(lib.file('landscape.jpg'), lib.file('portrait.jpg'));
                expect(await processOnce(handlers, { force: true, logger })).toBe(0);
                expect(await outputChannels('portrait')).toEqual(Array(7).fill('red'));
                handlers.stop();
                // The live removal's rebuild from portrait.png, which owns the set now, is killed before the thumbnail.
                fs.unlinkSync(lib.file('portrait.jpg'));
                await killedAfter(4, (killed) => killed.onUnlink(lib.file('portrait.jpg')));
                expect(readSetSource('portrait.png')).toEqual({ source: 'portrait.png', finished: false });

                expect(await newHandlers().queueStartupBatch()).toEqual({ processed: ['portrait.png'], skipped: [], errors: [] });
                expect(await outputChannels('portrait')).toEqual(Array(7).fill('green'));
            });

            it("rebuilds at startup a set whose takeover finished but couldn't record it, once the source that took it over is removed while the watcher is down", async () => {
                await builtLibrary();
                const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
                failRecordWrites((data) => !unfinished(data));
                fs.copyFileSync(lib.file('landscape.jpg'), lib.file('portrait.jpg'));
                await handlers.onAdd(lib.file('portrait.jpg'));
                expect(await outputChannels('portrait')).toEqual(Array(7).fill('red'));
                expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^\[imageOptimizer\] Couldn't record that portrait\.jpg's set was built from it: /));
                recordWrites.fail = null;
                handlers.stop();

                fs.unlinkSync(lib.file('portrait.jpg'));
                expect(await newHandlers().queueStartupBatch()).toEqual({ processed: ['portrait.png'], skipped: [], errors: [] });
                expect(await outputChannels('portrait')).toEqual(Array(7).fill('green'));
            });

            it('has the record that a build starts on disk, through atomicWriteFile, before its first rename', async () => {
                await builtLibrary();
                recordWrites.events = [];
                const realRename = fs.promises.rename.bind(fs.promises);
                vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args: Parameters<typeof fs.promises.rename>) => {
                    const target = String(args[1]);
                    if (!target.includes(`${path.sep}set-sources${path.sep}`)) recordWrites.events?.push(`rename ${path.relative(lib.root, target)}`);
                    return realRename(...args);
                });
                fs.copyFileSync(lib.file('landscape.jpg'), lib.file('portrait.jpg'));
                await handlers.onAdd(lib.file('portrait.jpg'));

                // atomicWriteFile() resolves only after the record and its folder are fsynced.
                const events = recordWrites.events;
                expect(events[0]).toBe('record {"source":"portrait.jpg","complete":false}');
                expect(events.slice(1, -1)).toHaveLength(7);
                expect(events.slice(1, -1).every((event) => event.startsWith('rename '))).toBe(true);
                expect(events.at(-1)).toBe('record {"source":"portrait.jpg"}');
                expect(await outputChannels('portrait')).toEqual(Array(7).fill('red'));
            });

            it("renames nothing in a set another source shares when it can't record that the build starts", async () => {
                await builtLibrary();
                const before = lib.hashes(derivativePaths('portrait'));
                const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
                failRecordWrites(unfinished);
                fs.copyFileSync(lib.file('landscape.jpg'), lib.file('portrait.jpg'));
                await handlers.onAdd(lib.file('portrait.jpg'));

                expect(lib.hashes(derivativePaths('portrait'))).toEqual(before);
                expect(lib.tempFiles()).toEqual([]);
                expect(readSetSource('portrait.png')).toEqual({ source: 'portrait.png', finished: true });
                expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^\[imageOptimizer\] Couldn't record that portrait\.jpg's set is being rebuilt, so it keeps the outputs of portrait\.png, which built it last: /));
            });

            it("rebuilds a shared set from the owner that last built it whole when it can't record that the build starts", async () => {
                fs.copyFileSync(lib.file('landscape.jpg'), lib.file('portrait.jpg'));
                expect(await processOnce(handlers, { force: true, logger })).toBe(0);
                expect(await outputChannels('portrait')).toEqual(Array(7).fill('red'));
                expect(readSetSource('portrait.png')).toEqual({ source: 'portrait.jpg', finished: true });
                vi.spyOn(console, 'error').mockImplementation(() => undefined);
                failRecordWrites(unfinished);

                // A build stopped partway could only mix the owner's own versions, which the thumbnail going last catches.
                fs.writeFileSync(lib.file('portrait.jpg'), edited);
                await handlers.onChange(lib.file('portrait.jpg'));
                expect(await outputChannels('portrait')).toEqual(Array(7).fill('blue'));
                expect(readSetSource('portrait.png')).toEqual({ source: 'portrait.jpg', finished: true });
            });

            it("rebuilds a shared set from the source that owns it once its owner is removed, live and at the next start, when cache/set-sources can't be written", async () => {
                fs.copyFileSync(lib.file('landscape.jpg'), lib.file('portrait.jpg'));
                fs.copyFileSync(lib.file('square.webp'), lib.file('portrait.webp'));
                expect(await processOnce(handlers, { force: true, logger })).toBe(0);
                expect(await outputChannels('portrait')).toEqual(Array(7).fill('red'));
                expect(readSetSource('portrait.png')).toEqual({ source: 'portrait.jpg', finished: true });
                vi.spyOn(console, 'error').mockImplementation(() => undefined);
                failRecordWrites(() => true);

                // The record still names portrait.jpg, which is gone, so its outputs show nothing the library has.
                fs.unlinkSync(lib.file('portrait.jpg'));
                await handlers.onUnlink(lib.file('portrait.jpg'));
                expect(await outputChannels('portrait')).toEqual(Array(7).fill('green'));
                handlers.stop();

                expect(await newHandlers().queueStartupBatch()).toEqual({ processed: ['portrait.png'], skipped: [], errors: [] });
                expect(await outputChannels('portrait')).toEqual(Array(7).fill('green'));
            });

            it("rebuilds a shared set nothing records from its owner when the owner is replaced and cache/set-sources can't be written", async () => {
                fs.copyFileSync(lib.file('landscape.jpg'), lib.file('portrait.jpg'));
                expect(await processOnce(handlers, { force: true, logger })).toBe(0);
                expect(await outputChannels('portrait')).toEqual(Array(7).fill('red'));
                // As every shared set on a library built before the record was kept
                fs.rmSync(lib.file('cache', 'set-sources'), { recursive: true });
                vi.spyOn(console, 'error').mockImplementation(() => undefined);
                failRecordWrites(() => true);

                fs.writeFileSync(lib.file('portrait.jpg'), edited);
                await handlers.onChange(lib.file('portrait.jpg'));
                expect(await outputChannels('portrait')).toEqual(Array(7).fill('blue'));
            });

            it('keeps the record that a build started after a rename fails, and rebuilds at startup once the source that took the set over is removed', async () => {
                await builtLibrary();
                vi.spyOn(console, 'error').mockImplementation(() => undefined);
                const realRename = fs.promises.rename.bind(fs.promises);
                let renames = 0;
                const rename = vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args: Parameters<typeof fs.promises.rename>) => {
                    if (++renames === 4) throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
                    return realRename(...args);
                });
                fs.copyFileSync(lib.file('landscape.jpg'), lib.file('portrait.jpg'));
                await handlers.onAdd(lib.file('portrait.jpg'));
                rename.mockRestore();
                expect(readSetSource('portrait.png')).toEqual({ source: 'portrait.jpg', finished: false });
                handlers.stop();

                fs.unlinkSync(lib.file('portrait.jpg'));
                expect(await newHandlers().queueStartupBatch()).toEqual({ processed: ['portrait.png'], skipped: [], errors: [] });
                expect(await outputChannels('portrait')).toEqual(Array(7).fill('green'));
            });

            it('removes the record after a fill of only the missing outputs, since another source may have built the rest', async () => {
                await builtLibrary();
                fs.unlinkSync(lib.file('thumbnails', 'portrait.webp'));
                await processImage('portrait.png');
                expect(fs.existsSync(lib.file('thumbnails', 'portrait.webp'))).toBe(true);
                expect(readSetSource('portrait.png')).toBeNull();
            });

            it("rebuilds on a change of a source the set shares when the record says the owner's build of it didn't finish", async () => {
                fs.copyFileSync(lib.file('landscape.jpg'), lib.file('portrait.jpg'));
                expect(await processOnce(handlers, { force: true, logger })).toBe(0);
                fs.writeFileSync(lib.file('cache', 'set-sources', 'portrait.json'), '{"source":"portrait.jpg","complete":false}\n');
                const before = inodes(derivativePaths('portrait'));

                await newHandlers().onChange(lib.file('portrait.png'));
                expect(logs).toContain('[ImageWatcher] Rebuilt the set portrait.png shares from its owner, portrait.jpg.');
                expect(inodes(derivativePaths('portrait')).filter((ino, index) => ino === before[index])).toEqual([]);
            });

            it("rebuilds on an add of a set's one source when the record says its build didn't finish", async () => {
                await builtLibrary();
                fs.writeFileSync(lib.file('cache', 'set-sources', 'landscape.json'), '{"source":"landscape.jpg","complete":false}\n');
                const before = inodes(LANDSCAPE);

                await newHandlers().onAdd(lib.file('landscape.jpg'));
                expect(inodes(LANDSCAPE).filter((ino, index) => ino === before[index])).toEqual([]);
                expect(readSetSource('landscape.jpg')).toEqual({ source: 'landscape.jpg', finished: true });
            });
        });
    });

    it('keeps the old set for a different, older file under a deleted name until it is touched', async () => {
        await handlers.onAdd(lib.file('landscape.jpg'));
        fs.unlinkSync(lib.file('landscape.jpg'));
        await handlers.onUnlink(lib.file('landscape.jpg'));
        handlers.stop();

        // While the watcher is stopped, a different photo arrives under the same name, dated long ago
        fs.writeFileSync(lib.file('landscape.jpg'), edited);
        setMtime('landscape.jpg', Date.parse('2001-01-01T00:00:00Z'));

        const result = await newHandlers().queueStartupBatch();
        expect(result).toMatchObject({ skipped: [], errors: [] });
        expect(result.processed.sort()).toEqual(['portrait.png', 'square.webp']);
        expect(await outputChannels('landscape')).toEqual(Array(7).fill('red'));

        // The accepted risk, and its fix: touch the file
        const now = new Date();
        fs.utimesSync(lib.file('landscape.jpg'), now, now);
        expect(await newHandlers().queueStartupBatch()).toEqual({ processed: ['landscape.jpg'], skipped: [], errors: [] });
        expect(await outputChannels('landscape')).toEqual(Array(7).fill('blue'));
    });

    it('the startup batch keeps derivatives whose source is gone', async () => {
        await processImage('landscape.jpg');
        const before = lib.hashes(LANDSCAPE);
        fs.unlinkSync(lib.file('landscape.jpg'));

        const result = await handlers.queueStartupBatch();

        expect(result.errors).toEqual([]);
        expect(result.processed.sort()).toEqual(['portrait.png', 'square.webp']);
        expect(lib.hashes(LANDSCAPE)).toEqual(before);
    });

    it('onAdd of an unchanged file that a sync tool removed and copied back regenerates nothing', async () => {
        await handlers.onAdd(lib.file('landscape.jpg'));
        const thumbnail = fs.statSync(lib.file('thumbnails/landscape.webp'));
        const original = fs.readFileSync(lib.file('landscape.jpg'));
        const { mtime } = fs.statSync(lib.file('landscape.jpg'));

        fs.unlinkSync(lib.file('landscape.jpg'));
        await handlers.onUnlink(lib.file('landscape.jpg'));
        fs.writeFileSync(lib.file('landscape.jpg'), original);
        fs.utimesSync(lib.file('landscape.jpg'), mtime, mtime);
        const reads = recordSourceReads();
        await handlers.onAdd(lib.file('landscape.jpg'));

        expect(reads).toEqual([]);
        expect(fs.statSync(lib.file('thumbnails/landscape.webp')).ino).toBe(thumbnail.ino);
        expect(logs).toContain('[ImageWatcher] Already up to date: landscape.jpg');
    });

    it('onAdd regenerates a file copied back in that is newer than its set', async () => {
        await handlers.onAdd(lib.file('landscape.jpg'));
        expect(await outputChannels('landscape')).toEqual(Array(7).fill('red'));

        fs.unlinkSync(lib.file('landscape.jpg'));
        await handlers.onUnlink(lib.file('landscape.jpg'));
        setMtime('thumbnails/landscape.webp', Date.now() - 60 * 60 * 1000);
        fs.writeFileSync(lib.file('landscape.jpg'), edited);
        await handlers.onAdd(lib.file('landscape.jpg'));

        expect(await outputChannels('landscape')).toEqual(Array(7).fill('blue'));
        expect(logs).toContain('[ImageWatcher] Processed: landscape.jpg');
        expect(lib.tempFiles()).toEqual([]);
    });

    it('onAdd lists the library once, for a set of its own or one it takes over', async () => {
        const listings = countRootListings();
        await handlers.onAdd(lib.file('landscape.jpg'));
        expect(listings.count).toBe(1);

        fs.copyFileSync(lib.file('landscape.jpg'), lib.file('landscape.jpeg'));
        listings.count = 0;
        await handlers.onAdd(lib.file('landscape.jpeg'));
        expect(listings.count).toBe(1);
        expect(logs).toContain('[ImageWatcher] Rebuilt the set landscape.jpeg now owns from it.');
    });

    it('onChange after a save-by-rename regenerates the outputs from the new bytes', async () => {
        await handlers.onAdd(lib.file('landscape.jpg'));

        fs.writeFileSync(lib.file('.landscape.jpg.saving'), edited);
        fs.renameSync(lib.file('.landscape.jpg.saving'), lib.file('landscape.jpg'));
        await handlers.onChange(lib.file('landscape.jpg'));

        expect(await outputChannels('landscape')).toEqual(Array(7).fill('blue'));
        expect(logs).toContain('[ImageWatcher] Reprocessed: landscape.jpg');
    });

    it('two onChange calls leave seven outputs from the newest source version', async () => {
        await handlers.onAdd(lib.file('landscape.jpg'));

        fs.writeFileSync(lib.file('landscape.jpg'), edited);
        const held = gate.arm();
        const first = handlers.onChange(lib.file('landscape.jpg'));
        await held.reached; // The first job has read the blue bytes and is mid-encode

        fs.writeFileSync(lib.file('landscape.jpg'), green);
        const second = handlers.onChange(lib.file('landscape.jpg'));
        await settle();
        expect(await outputChannels('landscape')).toEqual(Array(7).fill('red'));

        held.release();
        await Promise.all([first, second]);
        expect(await outputChannels('landscape')).toEqual(Array(7).fill('green'));
        expect(lib.tempFiles()).toEqual([]);
        // The first job saw its source change before its swap, so it threw its outputs away
        expect(logs).toContain('[ImageWatcher] Skipped landscape.jpg: it changed or was removed while it was processed.');
        expect(logs.some((line) => line.startsWith('[ImageWatcher] Error processing'))).toBe(false);
    });

    it('the startup batch racing an onChange leaves seven outputs from the newest source version', async () => {
        await processImage('portrait.png');
        await processImage('square.webp');

        const held = gate.arm();
        const startup = handlers.queueStartupBatch();
        await held.reached; // The startup job has read the red bytes and is mid-encode

        fs.writeFileSync(lib.file('landscape.jpg'), edited);
        const change = handlers.onChange(lib.file('landscape.jpg'));
        await settle();
        expect(lib.hashes(LANDSCAPE)).toEqual({});

        held.release();
        // The startup job read the old bytes, so it discards its outputs instead of swapping them in
        expect(await startup).toEqual({ processed: [], skipped: ['landscape.jpg'], errors: [] });
        await change;
        expect(await outputChannels('landscape')).toEqual(Array(7).fill('blue'));
    });

    it('skips a job whose source is gone before it starts, without an error', async () => {
        fs.unlinkSync(lib.file('landscape.jpg'));
        await handlers.onChange(lib.file('landscape.jpg'));

        expect(logs).toContain('[ImageWatcher] Skipped landscape.jpg: it changed or was removed while it was processed.');
        expect(logs.some((line) => line.startsWith('[ImageWatcher] Error processing'))).toBe(false);
    });

    it('logs a failed job and still runs the next one for that basename', async () => {
        fs.writeFileSync(lib.file('landscape.jpg'), 'not an image');
        await handlers.onChange(lib.file('landscape.jpg'));
        expect(logs.some((line) => line.startsWith('[ImageWatcher] Error processing landscape.jpg:'))).toBe(true);
        expect(lib.hashes(LANDSCAPE)).toEqual({});
        expect(lib.tempFiles()).toEqual([]);

        fs.writeFileSync(lib.file('landscape.jpg'), edited);
        await handlers.onChange(lib.file('landscape.jpg'));
        expect(await outputChannels('landscape')).toEqual(Array(7).fill('blue'));
    });

    it('runs one job at a time by default, so a burst of new files is bounded', async () => {
        handlers = newHandlers();
        await Promise.all(BASIC.map((name) => handlers.onAdd(lib.file(name))));

        expect(gate.maxInFlight).toBe(1);
        expect(Object.keys(lib.hashes(['landscape', 'portrait', 'square'].flatMap(derivativePaths)))).toHaveLength(21);
    });

    it('runs a live event ahead of the queued startup backlog', async () => {
        handlers = newHandlers();
        const reads = recordSourceReads();
        const held = gate.arm();
        const startup = handlers.queueStartupBatch();
        await held.reached; // The first startup job is mid-encode, two more are queued

        fs.writeFileSync(lib.file('added.jpg'), edited);
        const added = handlers.onAdd(lib.file('added.jpg'));
        held.release();
        await Promise.all([startup, added]);

        expect(reads).toHaveLength(4);
        expect(reads[1]).toBe('added.jpg');
    });

    it('a live change drops the queued startup job for the same photo, so it is encoded once', async () => {
        handlers = newHandlers();
        const reads = recordSourceReads();
        const held = gate.arm();
        const startup = handlers.queueStartupBatch();
        await held.reached; // One startup job is mid-encode, two more are queued
        const waiting = BASIC.filter((name) => name !== reads[0]);

        const change = handlers.onChange(lib.file(waiting[0]));
        held.release();
        const result = await startup;
        await change;

        expect(result.skipped).toEqual([waiting[0]]);
        expect(result.processed.sort()).toEqual([reads[0], waiting[1]].sort());
        expect(reads.filter((name) => name === waiting[0])).toHaveLength(1);
        expect(Object.keys(lib.hashes(BASIC.map(baseNameOf).flatMap(derivativePaths)))).toHaveLength(21);
    });

    it('a live add keeps the queued startup job, which may regenerate, and encodes nothing twice', async () => {
        handlers = newHandlers();
        const reads = recordSourceReads();
        const held = gate.arm();
        const startup = handlers.queueStartupBatch();
        await held.reached;
        const waiting = BASIC.filter((name) => name !== reads[0]);

        const added = handlers.onAdd(lib.file(waiting[0]));
        held.release();
        const result = await startup;
        await added;

        expect(result).toMatchObject({ skipped: [], errors: [] });
        expect(result.processed.sort()).toEqual([...BASIC].sort());
        expect(reads.filter((name) => name === waiting[0])).toHaveLength(1);
        expect(logs).toContain(`[ImageWatcher] Already up to date: ${waiting[0]}`);
    });

    it('stop() drops queued startup jobs as skipped and still runs queued live ones', async () => {
        handlers = newHandlers();
        const reads = recordSourceReads();
        const held = gate.arm();
        const startup = handlers.queueStartupBatch();
        await held.reached; // One startup job is mid-encode, two more are queued
        fs.writeFileSync(lib.file('added.jpg'), edited);
        const added = handlers.onAdd(lib.file('added.jpg'));

        handlers.stop();
        held.release();

        const result = await startup;
        expect(result.processed).toEqual([reads[0]]);
        expect(result.skipped.sort()).toEqual(BASIC.filter((name) => name !== reads[0]).sort());
        expect(result.errors).toEqual([]);
        await added;
        expect(await handlers.drain(30_000)).toBe(true);
        expect(Object.keys(lib.hashes(derivativePaths('added')))).toHaveLength(7);
        for (const name of result.skipped) expect(lib.hashes(derivativePaths(baseNameOf(name))), name).toEqual({});
    });

    it('stop() ignores new events and drain() waits for queued jobs, within its bound', async () => {
        handlers = newHandlers();
        const held = gate.arm();
        const running = handlers.onAdd(lib.file('landscape.jpg'));
        await held.reached;

        handlers.stop();
        await handlers.onAdd(lib.file('portrait.png'));
        expect(await handlers.drain(50)).toBe(false);

        held.release();
        expect(await handlers.drain(30_000)).toBe(true);
        await running;
        expect(Object.keys(lib.hashes(LANDSCAPE))).toHaveLength(7);
        expect(lib.hashes(derivativePaths('portrait'))).toEqual({});
    });

    it('names the photos still unfinished when the drain gives up', async () => {
        handlers = newHandlers();
        const held = gate.arm();
        const running = handlers.onChange(lib.file('landscape.jpg'));
        await held.reached;
        const queued = handlers.onChange(lib.file('portrait.png'));
        handlers.stop();

        expect(await drainOrReport(handlers, 50, logger)).toBe(false);
        expect(logs).toContain(
            '[ImageWatcher] Jobs still running after 0.05s. Exiting anyway. Not finished: landscape.jpg, portrait.png. ' +
            'Touch them, or run --once --force, to process them.',
        );

        held.release();
        await Promise.all([running, queued]);
    });

    it('ignores files that are not photos, including dot-files', async () => {
        fs.writeFileSync(lib.file('notes.txt'), 'hello');
        fs.writeFileSync(lib.file('._landscape.jpg'), 'AppleDouble metadata');
        for (const name of ['notes.txt', '._landscape.jpg']) {
            await handlers.onAdd(lib.file(name));
            await handlers.onChange(lib.file(name));
            await handlers.onUnlink(lib.file(name));
        }
        expect(logs).toEqual([]);
    });
});

describe('the one-time rebuild of orientation-tagged photos', { timeout: 60_000 }, () => {
    const marker = () => lib.file('cache', 'upright-rebuild.json');
    const OTHERS = [...LANDSCAPE, ...derivativePaths('portrait'), ...derivativePaths('square')];
    // Without autoOrient(), as derivatives were written before they were turned upright
    const sideways = () => sharp(turned).webp().toBuffer();
    const UPRIGHT = { width: 640, height: 960 };

    /** Current sets for the basic photos, and one for turned.jpg from before derivatives were turned upright: sideways, and newer than its source. */
    async function oldLibrary(): Promise<void> {
        for (const name of BASIC) await processImage(name);
        fs.writeFileSync(lib.file('turned.jpg'), turned);
        await processImage('turned.jpg');
        fs.writeFileSync(lib.file('optimized/turned.webp'), await sideways());
        expect(await optimizedSize('turned.jpg')).toEqual({ width: 960, height: 640 });
    }

    it('turns upright a tagged photo whose set looks current, records it, and leaves it alone on later starts', async () => {
        await oldLibrary();
        const others = lib.hashes(OTHERS);

        expect(await handlers.queueStartupBatch()).toEqual({ processed: ['turned.jpg'], skipped: [], errors: [] });
        expect(await optimizedSize('turned.jpg')).toEqual(UPRIGHT);
        expect(lib.hashes(OTHERS)).toEqual(others);
        expect(JSON.parse(fs.readFileSync(marker(), 'utf8'))).toMatchObject({ photos: 1 });
        expect(logs).toContain('[ImageWatcher] Rebuilt the sets of 1 orientation-tagged photo. Clear the /_next/image cache, so it drops what it made from the old sets.');
        // images:cleanup leaves the record alone
        expect(planOrphanCleanup().entries.map((entry) => entry.relativePath)).toEqual([]);

        fs.writeFileSync(lib.file('optimized/turned.webp'), await sideways());
        expect(await newHandlers().queueStartupBatch()).toEqual({ processed: [], skipped: [], errors: [] });
        expect((await optimizedSize('turned.jpg')).width).toBe(960);
    });

    it("keeps a startup job's own force, here the upright rebuild, when a change to a later source of its set drops the job", async () => {
        await oldLibrary();
        fs.copyFileSync(lib.file('turned.jpg'), lib.file('turned.png'));
        // landscape.jpg's job goes first, and the gate holds it, so turned.jpg's job is still queued when the change comes.
        fs.rmSync(lib.file(LANDSCAPE[0]));
        expect(await ownerOf('turned.png')).toBe('turned.jpg');
        const single = newHandlers();
        const held = gate.arm();
        const batch = single.queueStartupBatch();
        await held.reached;
        const change = single.onChange(lib.file('turned.png'));
        held.release();

        expect(await batch).toEqual({ processed: ['landscape.jpg'], skipped: ['turned.jpg'], errors: [] });
        await change;
        expect(await optimizedSize('turned.jpg')).toEqual(UPRIGHT);
    });

    it('records nothing while a tagged photo is left unbuilt, so the next start tries again', async () => {
        await oldLibrary();
        const held = gate.arm();
        const batch = handlers.queueStartupBatch();
        await held.reached; // turned.jpg is the one photo to process, and it is mid-encode
        fs.writeFileSync(lib.file('turned.jpg'), turnedEdited);
        held.release();

        expect(await batch).toEqual({ processed: [], skipped: ['turned.jpg'], errors: [] });
        expect(fs.existsSync(marker())).toBe(false);
        expect(logs).toContain("[ImageWatcher] These orientation-tagged photos weren't rebuilt, so the next start tries again: turned.jpg.");

        expect(await newHandlers().queueStartupBatch()).toEqual({ processed: ['turned.jpg'], skipped: [], errors: [] });
        expect(await outputChannels('turned')).toEqual(Array(7).fill('blue'));
        expect(fs.existsSync(marker())).toBe(true);
    });

    it('records the rebuild when a tagged photo fails, and later starts retry only that one', async () => {
        await oldLibrary();
        // Its header, orientation tag included, is intact, but it doesn't decode
        const broken = turned.subarray(0, Math.floor(turned.length * 0.6));
        await expect(sharp(broken).metadata()).resolves.toMatchObject({ orientation: 6 });
        fs.writeFileSync(lib.file('broken.jpg'), broken);

        expect(await handlers.queueStartupBatch()).toEqual({ processed: ['turned.jpg'], skipped: [], errors: ['broken.jpg'] });
        expect(await optimizedSize('turned.jpg')).toEqual(UPRIGHT);
        expect(JSON.parse(fs.readFileSync(marker(), 'utf8'))).toEqual({ rebuiltAt: expect.any(String), photos: 1, retry: ['broken.jpg'] });
        expect(logs).toContain('[ImageWatcher] Rebuilt the sets of 1 orientation-tagged photo. Clear the /_next/image cache, so it drops what it made from the old sets.');
        expect(logs).toContain('[ImageWatcher] These orientation-tagged photos failed to rebuild, so each start tries them again until they build: broken.jpg.');

        // The next start leaves turned.jpg's set alone, sideways or not, and tries broken.jpg again
        fs.writeFileSync(lib.file('optimized/turned.webp'), await sideways());
        expect(await newHandlers().queueStartupBatch()).toEqual({ processed: [], skipped: [], errors: ['broken.jpg'] });
        expect((await optimizedSize('turned.jpg')).width).toBe(960);
        expect(JSON.parse(fs.readFileSync(marker(), 'utf8'))).toMatchObject({ retry: ['broken.jpg'] });

        // Once it builds, nothing is left to retry
        fs.writeFileSync(lib.file('broken.jpg'), turned);
        expect(await newHandlers().queueStartupBatch()).toEqual({ processed: ['broken.jpg'], skipped: [], errors: [] });
        expect(await optimizedSize('broken.jpg')).toEqual(UPRIGHT);
        expect(JSON.parse(fs.readFileSync(marker(), 'utf8'))).toEqual({ rebuiltAt: expect.any(String), photos: 1 });
        expect(await newHandlers().queueStartupBatch()).toEqual({ processed: [], skipped: [], errors: [] });
    });

    it("rebuilds a photo whose orientation can't be read, since it may be tagged", async () => {
        for (const name of BASIC) await processImage(name);
        fs.writeFileSync(lib.file('unknown.jpg'), 'not an image');

        expect(await isOrientationTagged('unknown.jpg')).toBeNull();
        expect(await isOrientationTagged('landscape.jpg')).toBe(false);
        expect((await planSources()).upright).toEqual(['unknown.jpg']);
    });

    it('records it at once when no photo is tagged, and after a forced run too', async () => {
        // Orientation 1 is upright already
        fs.writeFileSync(lib.file('level.jpg'), withExifOrientation(fs.readFileSync(lib.file('landscape.jpg')), 1));
        for (const name of [...BASIC, 'level.jpg']) await processImage(name);
        expect(await handlers.queueStartupBatch()).toEqual({ processed: [], skipped: [], errors: [] });
        expect(JSON.parse(fs.readFileSync(marker(), 'utf8'))).toMatchObject({ photos: 0 });

        fs.rmSync(marker());
        fs.writeFileSync(lib.file('turned.jpg'), turned);
        expect(await processOnce(newHandlers(), { force: true, logger })).toBe(0);
        expect(JSON.parse(fs.readFileSync(marker(), 'utf8'))).toMatchObject({ photos: 1 });
    });

    it('never creates a missing library root to write the record', async () => {
        const missing = await createTempLibrary({ missingRoot: true });
        try {
            expect(() => writeUprightMarker(0)).toThrow(/ENOENT/);
            expect(fs.existsSync(missing.root)).toBe(false);
        } finally {
            await missing.cleanup();
        }
    });

    it('logs a record it could not write, and still rebuilds', async () => {
        await oldLibrary();
        fs.rmSync(lib.file('cache'), { recursive: true, force: true });
        fs.writeFileSync(lib.file('cache'), 'a file where the cache folder goes');
        // The set's own record can't be written either, and that is logged too
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        expect(await handlers.queueStartupBatch()).toEqual({ processed: ['turned.jpg'], skipped: [], errors: [] });
        expect(await optimizedSize('turned.jpg')).toEqual(UPRIGHT);
        // Said up front, before any build
        const warning = `[ImageWatcher] ${path.dirname(marker())} can't be written, so the watcher can't record which sets it rebuilt. Until it can, every start rebuilds the orientation-tagged photos again, and a set last built from another source that's still in the library keeps that source's outputs.`;
        expect(logs.indexOf(warning)).toBeGreaterThanOrEqual(0);
        expect(logs.indexOf(warning)).toBeLessThan(logs.findIndex((line) => line.startsWith('[ImageWatcher] Processing ')));
        expect(logs.some((line) => line.startsWith(`[ImageWatcher] Could not write ${marker()}: `) && line.endsWith('The next start rebuilds the orientation-tagged photos again.'))).toBe(true);
        expect(logs.some((line) => line.startsWith('[ImageWatcher] Rebuilt the sets'))).toBe(false);
        expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^\[imageOptimizer\] Couldn't record that turned\.jpg's set was built from it: /));
    });
});

describe("the web process's libvips setting", () => {
    it('leaves the cache on in the watcher, which loads nothing that turns it off', () => {
        // The modules this file loads are the ones the watcher runs.
        expect(sharp.cache().items.max).toBeGreaterThan(0);

        const loaded = new Set<string>();
        const visit = (file: string) => {
            if (loaded.has(file)) return;
            loaded.add(file);
            for (const [, specifier] of fs.readFileSync(file, 'utf8').matchAll(/from '(\.[^']+)'/g)) {
                const base = path.resolve(path.dirname(file), specifier);
                const resolved = [base, `${base}.ts`, `${base}.tsx`].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
                if (resolved) visit(resolved);
            }
        };
        visit(path.join(REPO_ROOT, 'scripts/imageWatcher.ts'));
        const relative = [...loaded].map((file) => path.relative(REPO_ROOT, file));
        expect(relative).toContain('utils/imageOptimizer.ts');
        expect(relative).not.toContain('utils/getImageData.ts');
    });
});

describe('processOnce', { timeout: 60_000 }, () => {
    it('returns 1 when a photo changed while it was processed, since it still needs a run', async () => {
        await processImage('portrait.png');
        await processImage('square.webp');
        const held = gate.arm();
        const once = processOnce(handlers, { logger });
        await held.reached; // landscape.jpg is the one photo to process, and it is mid-encode

        fs.writeFileSync(lib.file('landscape.jpg'), edited);
        held.release();

        expect(await once).toBe(1);
        expect(logs).toContain('[ImageWatcher] Done, but some photos changed while they were processed. Run it again.');
        expect(lib.hashes(LANDSCAPE)).toEqual({});
    });
});

describe('attachWatcher', { timeout: 60_000 }, () => {
    it('queues the startup batch only once chokidar is ready', async () => {
        const watcher = new EventEmitter<FSWatcherEventMap>();
        const batch = vi.spyOn(handlers, 'queueStartupBatch');
        const onRootRemoved = vi.fn();
        attachWatcher(watcher, handlers, { root: lib.root, logger, onRootRemoved });

        // Saved during chokidar's initial scan, which reports no event for it
        fs.writeFileSync(lib.file('added.jpg'), edited);
        expect(batch).not.toHaveBeenCalled();

        watcher.emit('ready');
        expect(batch).toHaveBeenCalledTimes(1);
        await batch.mock.results[0].value;
        expect(Object.keys(lib.hashes(derivativePaths('added')))).toHaveLength(7);

        watcher.emit('unlinkDir', lib.file('thumbnails'));
        expect(onRootRemoved).not.toHaveBeenCalled();
        watcher.emit('unlinkDir', lib.root);
        expect(onRootRemoved).toHaveBeenCalledTimes(1);
    });

    it('routes add, change, and unlink to their handlers', () => {
        const watcher = new EventEmitter<FSWatcherEventMap>();
        const onAdd = vi.spyOn(handlers, 'onAdd').mockResolvedValue(undefined);
        const onChange = vi.spyOn(handlers, 'onChange').mockResolvedValue(undefined);
        const onUnlink = vi.spyOn(handlers, 'onUnlink').mockResolvedValue(undefined);
        attachWatcher(watcher, handlers, { root: lib.root, logger, onRootRemoved: () => undefined });

        watcher.emit('add', lib.file('a.jpg'));
        watcher.emit('change', lib.file('b.jpg'));
        watcher.emit('unlink', lib.file('c.jpg'));

        expect(onAdd.mock.calls).toEqual([[lib.file('a.jpg')]]);
        expect(onChange.mock.calls).toEqual([[lib.file('b.jpg')]]);
        expect(onUnlink.mock.calls).toEqual([[lib.file('c.jpg')]]);
    });

    it('hands the legacy handlers only files directly in the root, and reports every change in the library', () => {
        const watcher = new EventEmitter<FSWatcherEventMap>();
        const onAdd = vi.spyOn(handlers, 'onAdd').mockResolvedValue(undefined);
        const onChange = vi.spyOn(handlers, 'onChange').mockResolvedValue(undefined);
        const onUnlink = vi.spyOn(handlers, 'onUnlink').mockResolvedValue(undefined);
        const changes: [string, string][] = [];
        const onRootRemoved = vi.fn();
        attachWatcher(watcher, handlers, {
            root: lib.root,
            logger,
            onRootRemoved,
            onLibraryChange: (event, changed) => { changes.push([event, changed]); },
        });

        watcher.emit('add', lib.file('a.jpg'));
        watcher.emit('add', lib.file('trips', 'b.jpg'));
        watcher.emit('change', lib.file('trips', 'b.jpg'));
        watcher.emit('unlink', lib.file('trips', 'c.jpg'));
        watcher.emit('addDir', lib.file('series'));
        watcher.emit('unlinkDir', lib.file('series'));
        // The root itself is no change in the library: its removal shuts the watcher down instead.
        watcher.emit('addDir', lib.root);
        watcher.emit('unlinkDir', lib.root);

        expect(onAdd.mock.calls).toEqual([[lib.file('a.jpg')]]);
        expect(onChange).not.toHaveBeenCalled();
        expect(onUnlink).not.toHaveBeenCalled();
        expect(onRootRemoved).toHaveBeenCalledTimes(1);
        expect(changes).toEqual([
            ['add', lib.file('a.jpg')],
            ['add', lib.file('trips', 'b.jpg')],
            ['change', lib.file('trips', 'b.jpg')],
            ['unlink', lib.file('trips', 'c.jpg')],
            ['addDir', lib.file('series')],
            ['unlinkDir', lib.file('series')],
        ]);
    });

    it("isn't idle while the startup batch works out its jobs, so what onReady waits for comes after them", async () => {
        const watcher = new EventEmitter<FSWatcherEventMap>();
        const outputs = ['landscape', 'portrait', 'square'].flatMap(derivativePaths);
        const seen: number[] = [];
        attachWatcher(watcher, handlers, {
            root: lib.root,
            logger,
            onRootRemoved: () => undefined,
            onReady: () => { void handlers.idle().then(() => { seen.push(Object.keys(lib.hashes(outputs)).length); }); },
        });

        watcher.emit('ready');

        await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 30_000 });
        expect(seen).toEqual([21]);
    });

    it("with awaitStartup, isn't idle before ready queues the startup batch, so nothing waiting on idle() runs alongside it", async () => {
        const watcher = new EventEmitter<FSWatcherEventMap>();
        const waiting = createWatcherHandlers({ logger, awaitStartup: true });
        const outputs = ['landscape', 'portrait', 'square'].flatMap(derivativePaths);
        const seen: number[] = [];
        attachWatcher(watcher, waiting, { root: lib.root, logger, onRootRemoved: () => undefined });
        // Asked before chokidar's initial scan is done, as the identity step's first heartbeat can.
        void waiting.idle().then(() => { seen.push(Object.keys(lib.hashes(outputs)).length); });

        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(seen).toEqual([]);
        watcher.emit('ready');

        await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 30_000 });
        expect(seen).toEqual([21]);
    });

    it("gives watch mode handlers that aren't idle before ready, and the watcher script's watch mode uses them", async () => {
        const waiting = createWatchModeHandlers({ logger });
        let idle = false;
        void waiting.idle().then(() => { idle = true; });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(idle).toBe(false);
        waiting.stop();
        await vi.waitFor(() => expect(idle).toBe(true));

        // The script runs when it's imported, so this reads it instead.
        const script = fs.readFileSync(path.join(REPO_ROOT, 'scripts/imageWatcher.ts'), 'utf8');
        const watchMode = script.slice(script.indexOf('function startWatcher('), script.indexOf('async function runOnce('));
        expect(watchMode).toContain('const handlers = createWatchModeHandlers();');
        expect(watchMode).not.toContain('createWatcherHandlers(');
    });

    it('with awaitStartup, is idle once stopped before ready, so shutdown never waits for a batch that won\'t come', async () => {
        const waiting = createWatcherHandlers({ logger, awaitStartup: true });
        let idle = false;
        void waiting.idle().then(() => { idle = true; });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(idle).toBe(false);
        waiting.stop();
        await vi.waitFor(() => expect(idle).toBe(true));
        expect(await waiting.queueStartupBatch()).toEqual({ processed: [], skipped: [], errors: [] });
    });

    it('on ready, queues the startup batch and then calls onReady', () => {
        const watcher = new EventEmitter<FSWatcherEventMap>();
        const order: string[] = [];
        vi.spyOn(handlers, 'queueStartupBatch').mockImplementation(async () => {
            order.push('startup batch');
            return { processed: [], skipped: [], errors: [] };
        });
        attachWatcher(watcher, handlers, { root: lib.root, logger, onRootRemoved: () => undefined, onReady: () => { order.push('onReady'); } });

        watcher.emit('ready');

        expect(order).toEqual(['startup batch', 'onReady']);
    });
});

describe('createIgnoreFilter', () => {
    it('skips the generated folders by exact name under the root, never by substring', () => {
        const ignored = createIgnoreFilter('/srv/cache/photos');

        expect(ignored('/srv/cache/photos')).toBe(false);
        expect(ignored('/srv/cache/photos/landscape.jpg')).toBe(false);
        expect(ignored('/srv/cache/photos/thumbnails-beach.jpg')).toBe(false);
        expect(ignored('/srv/cache/photos/optimized-avif')).toBe(true);
        expect(ignored('/srv/cache/photos/thumbnails/landscape.webp')).toBe(true);
        expect(ignored('/srv/cache/photos/lqip')).toBe(true);
        expect(ignored('/srv/cache/photos/cache')).toBe(true);
        expect(ignored('/srv/cache')).toBe(false);
    });

    it('skips dot-entries at any depth and watches nested folders, even ones named like a generated folder', () => {
        const ignored = createIgnoreFilter('/srv/photos');

        expect(ignored('/srv/photos/.DS_Store')).toBe(true);
        expect(ignored('/srv/photos/._landscape.jpg')).toBe(true);
        expect(ignored('/srv/photos/trips/.hidden')).toBe(true);
        expect(ignored('/srv/photos/trips/.hidden/x.jpg')).toBe(true);
        expect(ignored('/srv/photos/trips')).toBe(false);
        expect(ignored('/srv/photos/trips/x.jpg')).toBe(false);
        expect(ignored('/srv/photos/trips/thumbnails/x.webp')).toBe(false);
        expect(ignored('/srv/photos/cache-1.jpg')).toBe(false);
    });

    it('skips exactly what the identity scan skips', async () => {
        const files = [
            'a.jpg', '.b.jpg', 'cache-1.jpg', 'medium-format.jpg', 'notes.txt', 'raw.heic',
            'trips/c.jpg', 'trips/.d.jpg', 'trips/deep/e.png', 'trips/thumbnails/f.webp',
            '.hidden/g.jpg', 'thumbnails/h.webp', 'cache/dynamic/i.webp', 'optimized-avif/j.avif',
        ];
        for (const relativePath of files) {
            fs.mkdirSync(path.dirname(lib.file(relativePath)), { recursive: true });
            fs.writeFileSync(lib.file(relativePath), 'not decoded by a scan');
        }
        const ignored = createIgnoreFilter(lib.root);
        // chokidar never descends into an ignored folder, so a file counts as watched only if it and every folder above it are.
        const watched = (relativePath: string) => relativePath.split('/').every((_, index, segments) => !ignored(lib.file(...segments.slice(0, index + 1))));

        const scanned = (await scanLibrary(lib.root)).entries.map((entry) => entry.path).sort();
        // Every file with an extension the scan reads, the fixtures from beforeEach included.
        const scannable = [...BASIC, ...files].filter((relativePath) => !relativePath.endsWith('.txt'));
        expect(scannable.filter(watched).sort()).toEqual(scanned);
        expect(scanned).toEqual([...BASIC, 'a.jpg', 'cache-1.jpg', 'medium-format.jpg', 'raw.heic', 'trips/c.jpg', 'trips/deep/e.png', 'trips/thumbnails/f.webp'].sort());
    });
});
