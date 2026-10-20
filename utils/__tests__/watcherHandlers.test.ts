// @vitest-environment node
import fs from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp, { type Sharp } from 'sharp';
import { dominantChannel, fixtureFiles, type Channel } from '../../test/fixtures/makeLibrary';
import { createTempLibrary, derivativePaths, type TempLibrary } from '../../test/helpers/tempLibrary';
import { processImage } from '../imageOptimizer';
import { createWatcherHandlers, jobKey, type WatcherHandlers } from '../watcherHandlers';

// When armed, holds the next encode until the test releases it, so a test can
// queue a second job while the first is mid-flight.
const gate = vi.hoisted(() => {
    let armed: { reached: () => void; released: Promise<void> } | null = null;
    let releaseHeld = () => {};
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
        async pass() {
            const current = armed;
            if (!current) return;
            armed = null;
            current.reached();
            await current.released;
        },
        /** Disarm and release any held encode, so a failed test can't leave a job hanging. */
        reset() {
            armed = null;
            releaseHeld();
        },
    };
});

vi.mock('sharp', async (importOriginal) => {
    const actual = await importOriginal<typeof import('sharp')>();
    const realSharp = actual.default as unknown as (...args: unknown[]) => Sharp;
    const wrapped = (...args: unknown[]) => {
        const instance = realSharp(...args);
        const toBuffer = instance.toBuffer.bind(instance) as () => Promise<Buffer>;
        Object.defineProperty(instance, 'toBuffer', {
            value: async () => {
                await gate.pass();
                return toBuffer();
            },
        });
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

beforeAll(async () => {
    edited = (await fixtureFiles({ extras: true })).get('landscape-edited.jpg') as Buffer;
    green = await sharp({ create: { width: 960, height: 640, channels: 3, background: { r: 30, g: 190, b: 60 } } })
        .jpeg({ quality: 90 })
        .toBuffer();
});

const logger = {
    log: (...args: unknown[]) => { logs.push(args.map(String).join(' ')); },
    error: (...args: unknown[]) => { logs.push(args.map(String).join(' ')); },
};

beforeEach(async () => {
    lib = await createTempLibrary({ fixtures: 'basic' });
    logs = [];
    // Several jobs may run at once here, so only the per-basename chain keeps one source's jobs in turn
    handlers = createWatcherHandlers({ logger, maxConcurrentJobs: 4 });
});

afterEach(async () => {
    gate.reset();
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

/** Give a job that isn't chained a chance to run before the test looks. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 750));

describe('watcher handlers', { timeout: 60_000 }, () => {
    it('onUnlink deletes nothing and points at images:cleanup', async () => {
        await handlers.onAdd(lib.file('landscape.jpg'));
        const before = lib.hashes(LANDSCAPE);
        expect(Object.keys(before)).toHaveLength(7);

        fs.unlinkSync(lib.file('landscape.jpg'));
        handlers.onUnlink(lib.file('landscape.jpg'));
        await handlers.idle();

        expect(lib.hashes(LANDSCAPE)).toEqual(before);
        expect(fs.readdirSync(lib.root).filter((name) => name.includes('.')).sort()).toEqual(['portrait.png', 'square.webp']);
        expect(logs).toContain('[ImageWatcher] Source removed: landscape.jpg. Derivatives kept. See npm run images:cleanup.');
    });

    it('the startup batch keeps derivatives whose source is gone', async () => {
        await processImage('landscape.jpg');
        const before = lib.hashes(LANDSCAPE);
        fs.unlinkSync(lib.file('landscape.jpg'));

        const result = await handlers.queueStartupBatch();

        expect(result).toEqual({ processed: ['portrait.png', 'square.webp'], errors: [] });
        expect(lib.hashes(LANDSCAPE)).toEqual(before);
    });

    it('onAdd after an unlink regenerates stale outputs from the new bytes', async () => {
        await handlers.onAdd(lib.file('landscape.jpg'));
        expect(await outputChannels('landscape')).toEqual(Array(7).fill('red'));

        // Delete, then copy a re-export back in with an old mtime, as `cp -p` would
        fs.unlinkSync(lib.file('landscape.jpg'));
        handlers.onUnlink(lib.file('landscape.jpg'));
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
        const held = gate.arm();
        const landscape = handlers.onAdd(lib.file('landscape.jpg'));
        await held.reached;

        const portrait = handlers.onAdd(lib.file('portrait.png'));
        await settle();
        expect(lib.hashes(derivativePaths('portrait'))).toEqual({});

        held.release();
        await Promise.all([landscape, portrait]);
        expect(Object.keys(lib.hashes([...LANDSCAPE, ...derivativePaths('portrait')]))).toHaveLength(14);
    });

    it('ignores files that are not photos', async () => {
        fs.writeFileSync(lib.file('notes.txt'), 'hello');
        await handlers.onAdd(lib.file('notes.txt'));
        await handlers.onChange(lib.file('notes.txt'));
        handlers.onUnlink(lib.file('notes.txt'));
        expect(logs).toEqual([]);
    });
});

describe('jobKey', () => {
    it('keys a.jpg and a.png to one chain, since they share outputs', () => {
        expect(jobKey('a.jpg')).toBe('a');
        expect(jobKey('a.png')).toBe('a');
        expect(jobKey('my.photo.webp')).toBe('my.photo');
    });
});
