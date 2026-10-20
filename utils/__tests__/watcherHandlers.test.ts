// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp, { type Sharp } from 'sharp';
import { dominantChannel, fixtureFiles, type Channel } from '../../test/fixtures/makeLibrary';
import { createTempLibrary, derivativePaths, type TempLibrary } from '../../test/helpers/tempLibrary';
import { processImage } from '../imageOptimizer';
import { createIgnoreFilter, createWatcherHandlers, jobKey, type WatcherHandlers } from '../watcherHandlers';

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

let edited: Buffer; // blue-dominant re-export of landscape.jpg
let green: Buffer; // a third version
let lib: TempLibrary;
let logs: string[];
let handlers: WatcherHandlers;

const logger = {
    log: (...args: unknown[]) => { logs.push(args.map(String).join(' ')); },
    error: (...args: unknown[]) => { logs.push(args.map(String).join(' ')); },
};

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
    handlers = createWatcherHandlers({ logger, maxConcurrentJobs: 4 });
});

afterEach(async () => {
    gate.reset();
    vi.restoreAllMocks();
    await handlers.idle();
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

/** Records the order jobs read their sources in, which is the order they start. */
function recordSourceReads(): string[] {
    const reads: string[] = [];
    const realReadFile = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'readFile').mockImplementation(((...args: Parameters<typeof fs.promises.readFile>) => {
        reads.push(path.basename(String(args[0])));
        return realReadFile(...args);
    }) as typeof fs.promises.readFile);
    return reads;
}

describe('watcher handlers', { timeout: 60_000 }, () => {
    it('onUnlink deletes nothing, marks the set stale, and points at images:cleanup', async () => {
        await handlers.onAdd(lib.file('landscape.jpg'));
        const before = lib.hashes(LANDSCAPE);
        expect(Object.keys(before)).toHaveLength(7);

        fs.unlinkSync(lib.file('landscape.jpg'));
        await handlers.onUnlink(lib.file('landscape.jpg'));

        expect(lib.hashes(LANDSCAPE)).toEqual(before);
        expect(fs.statSync(lib.file('thumbnails/landscape.webp')).mtimeMs).toBe(0);
        expect(fs.readdirSync(lib.root).filter((name) => name.includes('.')).sort()).toEqual(['portrait.png', 'square.webp']);
        expect(logs).toContain('[ImageWatcher] Source removed: landscape.jpg. Derivatives kept. See npm run images:cleanup.');
    });

    it('regenerates at the next start when a different, older file replaces one deleted while running', async () => {
        await handlers.onAdd(lib.file('landscape.jpg'));
        fs.unlinkSync(lib.file('landscape.jpg'));
        await handlers.onUnlink(lib.file('landscape.jpg'));
        handlers.stop();

        // While the watcher is stopped, a different photo arrives under the same name, dated long ago
        fs.writeFileSync(lib.file('landscape.jpg'), edited);
        const old = new Date('2001-01-01T00:00:00Z');
        fs.utimesSync(lib.file('landscape.jpg'), old, old);

        const result = await createWatcherHandlers({ logger }).queueStartupBatch();
        expect(result.errors).toEqual([]);
        expect(result.processed.sort()).toEqual(['landscape.jpg', 'portrait.png', 'square.webp']);
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

    it('onAdd after an unlink regenerates stale outputs from the new bytes', async () => {
        await handlers.onAdd(lib.file('landscape.jpg'));
        expect(await outputChannels('landscape')).toEqual(Array(7).fill('red'));

        // Delete, then copy a re-export back in with an old mtime, as `cp -p` would
        fs.unlinkSync(lib.file('landscape.jpg'));
        await handlers.onUnlink(lib.file('landscape.jpg'));
        fs.writeFileSync(lib.file('landscape.jpg'), edited);
        const old = new Date('2001-01-01T00:00:00Z');
        fs.utimesSync(lib.file('landscape.jpg'), old, old);
        await handlers.onAdd(lib.file('landscape.jpg'));

        expect(await outputChannels('landscape')).toEqual(Array(7).fill('blue'));
        expect(lib.tempFiles()).toEqual([]);
    });

    it('onChange after a save-by-rename regenerates stale outputs from the new bytes', async () => {
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
        expect(await startup).toEqual({ processed: ['landscape.jpg'], errors: [] });
        await change;
        expect(await outputChannels('landscape')).toEqual(Array(7).fill('blue'));
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
        handlers = createWatcherHandlers({ logger });
        await Promise.all(['landscape.jpg', 'portrait.png', 'square.webp'].map((name) => handlers.onAdd(lib.file(name))));

        expect(gate.maxInFlight).toBe(1);
        expect(Object.keys(lib.hashes(['landscape', 'portrait', 'square'].flatMap(derivativePaths)))).toHaveLength(21);
    });

    it('runs a live event ahead of the queued startup backlog', async () => {
        handlers = createWatcherHandlers({ logger });
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

    it('stop() ignores new events and drain() waits for queued jobs, within its bound', async () => {
        handlers = createWatcherHandlers({ logger });
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

describe('jobKey', () => {
    it('keys a.jpg and a.png to one queue position, since they share outputs', () => {
        expect(jobKey('a.jpg')).toBe('a');
        expect(jobKey('a.png')).toBe('a');
        expect(jobKey('my.photo.webp')).toBe('my.photo');
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
