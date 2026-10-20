// @vitest-environment node
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FSWatcherEventMap } from 'chokidar';
import sharp, { type Sharp } from 'sharp';
import { dominantChannel, fixtureFiles, type Channel } from '../../test/fixtures/makeLibrary';
import { createTempLibrary, derivativePaths, type TempLibrary } from '../../test/helpers/tempLibrary';
import { baseNameOf, processImage } from '../imageOptimizer';
import {
    attachWatcher,
    createIgnoreFilter,
    createWatcherHandlers,
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

const LANDSCAPE = derivativePaths('landscape');
const BASIC = ['landscape.jpg', 'portrait.png', 'square.webp'];

let edited: Buffer; // blue-dominant re-export of landscape.jpg
let green: Buffer; // a third version
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
    edited = (await fixtureFiles({ extras: true })).get('landscape-edited.jpg') as Buffer;
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
        if (args[1] === 'r') reads.push(path.basename(String(args[0])));
        return realOpen(...args);
    }) as typeof fs.promises.open);
    return reads;
}

function setMtime(relativePath: string, mtimeMs: number): void {
    const time = new Date(mtimeMs);
    fs.utimesSync(lib.file(relativePath), time, time);
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
});
