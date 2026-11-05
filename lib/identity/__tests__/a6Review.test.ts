// @vitest-environment node
import fs from 'node:fs';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary, setLibraryDir, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { IntegrityError } from '../../storage/publish';
import { buildDerivativeSet, buildFailureText, type BuildOutcome } from '../derivatives';
import { classifyDecodeFailure, RETRY_DELAYS_MS } from '../failures';
import { inspectEntry } from '../inspect';
import { runReconcilePass } from '../pass';
import { currentProfileId } from '../profile';
import { IO_ERROR_AFTER_PASSES, IO_ERROR_MIN_SPAN_MS } from '../reconcile';
import { readRegistry, writeRegistry } from '../registry';
import { scanLibrary } from '../scan';
import type { DerivativeJob, IdentityFact, PhotoRecord, Registry } from '../types';
import { createWorker, requeueIoErrors, type WorkerOptions, type WorkerTimers } from '../worker';
import {
    createIdentityStep,
    LIBRARY_REBIND_AFTER_MS,
    LIBRARY_REBIND_LOOKS,
    runIdentityOnce,
    watchIdentity,
    type WatchTimers,
} from '../watcherStep';
import { sequentialIds } from './reconcileFixtures';

/**
 * A6's review (11-05): the pixel cap before any decode, a library outage
 * that never fails the queue, the once-per-outage and once-after-a-clean-pass
 * io-error requeues, the backoff that holds, --once and a waiting retry, the
 * classification, the exit to re-bind a share, and io-error items that need
 * ten minutes, close when the file reads, and give way to library-unavailable
 * when many files go at once.
 */

const NOW = Date.parse('2026-03-02T09:00:00.000Z');
const MINUTE = 60_000;
const isRoot = process.getuid?.() === 0;
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
const iso = (ms: number) => new Date(ms).toISOString();

let images: Buffer[];
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
    images = await Promise.all(Array.from({ length: 30 }, (_, index) =>
        sharp({ create: { width: 24, height: 16, channels: 3, background: { r: index * 8, g: 255 - index * 8, b: 90 } } }).jpeg().toBuffer()));
});

afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The library's files and folders by bytes, size, mode and mtime: what the watcher could have written. ctime moves on a chmod, so it's left out. */
function contents(lib: TempLibrary): Record<string, string> {
    const snapshot = lib.snapshot();
    return Object.fromEntries(Object.entries(snapshot).map(([name, value]) => [name, value.split(' ').slice(0, -1).join(' ')]));
}

async function roots(photos = 2): Promise<{ lib: TempLibrary; data: TempDataRoot }> {
    const lib = await createTempLibrary();
    cleanups.push(() => lib.cleanup());
    const data = createTempDataRoot();
    cleanups.push(() => data.cleanup());
    for (let index = 0; index < photos; index++) fs.writeFileSync(lib.file(`photo-${String(index + 1).padStart(2, '0')}.jpg`), images[index]);
    return { lib, data };
}

/** Passes on a clock the test moves, delivering to `facts`. */
function passes(facts: IdentityFact[] = [], start = Date.now() + 3_600_000) {
    let at = start;
    const idGen = sequentialIds();
    return {
        at: () => at,
        advance(ms: number) {
            at += ms;
        },
        run: (deps: { maxSourcePixels?: number } = {}) => runReconcilePass({ clock: () => at, idGen, logger: quiet, sinks: [(delivered) => { facts.push(...delivered); }], clearDelivered: true, ...deps }),
    };
}

const firstJob = async (data: TempDataRoot): Promise<DerivativeJob> => {
    const registry = await readRegistry(data.root);
    const photo = Object.values(registry.photos).sort((a, b) => (a.source.path < b.source.path ? -1 : 1))[0];
    return { photoId: photo.photoId, assetRevision: photo.source.observedRevision, profileId: currentProfileId(), path: photo.source.path };
};
const entryOf = async (data: TempDataRoot, job: DerivativeJob) => (await readRegistry(data.root)).photos[job.photoId].revisions[job.assetRevision].profiles[job.profileId];

function manualTimers(): WorkerTimers & { due(): number[] } {
    let next = 1;
    const pending = new Map<number, number>();
    return {
        setTimeout(_callback, ms) {
            pending.set(next, ms);
            return next++;
        },
        clearTimeout(handle) {
            pending.delete(handle as number);
        },
        due: () => [...pending.values()],
    };
}

describe('review 1: the pixel cap applies before anything decodes', () => {
    it("reads an over-cap file's size from its header and never decodes its pixels", async () => {
        const { lib } = await roots(1);
        const raw = vi.spyOn(sharp.prototype, 'raw');
        const scan = await scanLibrary(lib.root, { clock: () => Date.now() + 3_600_000 });
        const inspection = await inspectEntry(lib.root, scan.entries[0], { maxPixels: 100 });
        expect(raw).not.toHaveBeenCalled();
        expect(inspection).toMatchObject({ kind: 'image', pixelDigest: null, width: 24, height: 16, decodeError: expect.stringMatching(/^too-large: /) });
    });

    it('passes the cap to the raw decode of a file under it', async () => {
        const { lib } = await roots(1);
        const raw = vi.spyOn(sharp.prototype, 'raw');
        const scan = await scanLibrary(lib.root, { clock: () => Date.now() + 3_600_000 });
        const inspection = await inspectEntry(lib.root, scan.entries[0], { maxPixels: 1_000 });
        expect(raw).toHaveBeenCalledTimes(1);
        expect((raw.mock.contexts[0] as { options: { limitInputPixels: number } }).options.limitInputPixels).toBe(1_000);
        expect(inspection).toMatchObject({ kind: 'image', pixelDigest: expect.stringMatching(/^sha256-/) });
    });

    it('lets the pass record an over-cap file with its size, so its build fails as too-large, not as undecodable', async () => {
        const { data } = await roots(1);
        const facts: IdentityFact[] = [];
        const raw = vi.spyOn(sharp.prototype, 'raw');
        expect((await passes(facts).run({ maxSourcePixels: 100 })).status).toBe('committed');
        expect(raw).not.toHaveBeenCalled();
        expect(facts.filter((fact) => fact.type === 'processing-failed')).toEqual([]);
        const job = await firstJob(data);
        expect(await entryOf(data, job)).toEqual({ state: 'pending', attempts: 0 });
        expect(await buildDerivativeSet(job, { logger: quiet, maxSourcePixels: 100 })).toMatchObject({ status: 'failed', error: 'too-large: 24x16 is over the 100-pixel cap' });
    });
});

describe('review 2: a library outage never fails the queue', () => {
    /** A registry of `count` present photos, each with a pending set, as a pass would leave them. */
    async function queueOf(data: TempDataRoot, count: number): Promise<void> {
        const registry = await readRegistry(data.root);
        const profileId = currentProfileId();
        for (let index = 0; index < count; index++) {
            const photoId = `ph_00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
            const assetRevision = `sha256-${index.toString(16).padStart(64, '0')}`;
            const record: PhotoRecord = {
                photoId,
                createdAt: iso(NOW),
                source: { path: `p/${index}.jpg`, key: `p/${index}.jpg`, present: true, observedRevision: assetRevision, lastSeenAt: iso(NOW) },
                sourceHealth: 'present',
                duplicateOf: null,
                revisions: {
                    [assetRevision]: {
                        assetRevision, pixelDigest: null, firstSeenAt: iso(NOW), firstSeenPath: `p/${index}.jpg`, sourceBytes: 1, sourceFormat: 'jpeg', width: 1, height: 1, orientation: null,
                        derived: { extractorVersion: 1, technical: {}, capturedDate: null } as never,
                        curatorOnly: { extractorVersion: 1 } as never,
                        profiles: { [profileId]: { state: 'pending', attempts: 0 } },
                    },
                },
            };
            registry.photos[photoId] = record;
        }
        await writeRegistry(data.root, registry, registry.version);
    }

    it('pauses a 300-set queue on the first build that finds the library gone, and builds them all once it is back', async () => {
        const { data } = await roots(0);
        await queueOf(data, 300);
        let down = false;
        let calls = 0;
        const built = new Set<string>();
        const outcomes: BuildOutcome[] = [];
        const worker = createWorker({
            logger: quiet,
            build: async (job) => {
                calls++;
                if (calls === 101) down = true;
                const outcome: BuildOutcome = down ? { status: 'pending', reason: 'library-unavailable' } : { status: 'ready', reused: false };
                if (!down) built.add(job.photoId);
                outcomes.push(outcome);
                return outcome;
            },
        });
        cleanups.push(async () => {
            worker.stop();
            await worker.idle();
        });
        expect(await worker.start()).toEqual({ started: true, queued: 300 });
        await worker.idle();
        expect(built.size).toBe(100);
        expect(calls).toBe(101);
        expect(outcomes.filter((outcome) => outcome.status === 'failed')).toEqual([]);
        down = false;
        worker.resume?.();
        await worker.idle();
        expect(built.size).toBe(300);
        expect(calls).toBe(301);
    }, 60_000);

    it.skipIf(isRoot)('holds a build whose source read fails while the library root reads no more, recording nothing', async () => {
        const { lib, data } = await roots(1);
        await passes().run();
        const job = await firstJob(data);
        fs.chmodSync(lib.root, 0o000);
        cleanups.push(async () => fs.chmodSync(lib.root, 0o755));
        expect(await buildDerivativeSet(job, { logger: quiet, retry: { delaysMs: RETRY_DELAYS_MS } })).toEqual({ status: 'pending', reason: 'library-unavailable' });
        fs.chmodSync(lib.root, 0o755);
        expect(await entryOf(data, job)).toEqual({ state: 'pending', attempts: 0 });
    });

    it.skipIf(isRoot)('gives an io-error one more try after a clean pass, then keeps it failed', async () => {
        const { lib, data } = await roots(1);
        await passes().run();
        const job = await firstJob(data);
        const file = lib.file(job.path);
        cleanups.push(async () => fs.chmodSync(file, 0o644));
        fs.chmodSync(file, 0o000);
        expect(await buildDerivativeSet(job, { logger: quiet, retry: { delaysMs: RETRY_DELAYS_MS } })).toMatchObject({ status: 'failed', error: expect.stringMatching(/^source unreadable: EACCES/) });
        expect(await requeueIoErrors(data.root, { logger: quiet })).toBe(1);
        expect(await entryOf(data, job)).toEqual({ state: 'pending', attempts: 1, requeuedFor: 'clean-pass' });
        // Still unreadable: the extra try fails, and that's final.
        expect(await buildDerivativeSet(job, { logger: quiet, retry: { delaysMs: RETRY_DELAYS_MS } })).toMatchObject({ status: 'failed' });
        expect(await entryOf(data, job)).toMatchObject({ state: 'failed', attempts: 2, requeuedFor: 'clean-pass' });
        expect(await requeueIoErrors(data.root, { logger: quiet })).toBe(0);
        // An outage that ends puts it back once more, once for that outage.
        expect(await requeueIoErrors(data.root, { outageId: 'evt_x@2026-03-02T09:00:00.000Z', logger: quiet })).toBe(1);
        expect(await entryOf(data, job)).toEqual({ state: 'pending', attempts: 2, requeuedFor: 'evt_x@2026-03-02T09:00:00.000Z' });
        fs.chmodSync(file, 0o644);
        expect(await buildDerivativeSet(job, { logger: quiet })).toEqual({ status: 'ready', reused: false });
        expect(await requeueIoErrors(data.root, { outageId: 'evt_x@2026-03-02T09:00:00.000Z', logger: quiet })).toBe(0);
    });

    it('requeues once per outage id', async () => {
        const { data } = await roots(1);
        await passes().run();
        const job = await firstJob(data);
        const registry = await readRegistry(data.root);
        registry.photos[job.photoId].revisions[job.assetRevision].profiles[job.profileId] = { state: 'failed', attempts: 2, error: "source unreadable: EIO: i/o error, read", requeuedFor: 'clean-pass' };
        await writeRegistry(data.root, registry, registry.version);
        expect(await requeueIoErrors(data.root, { outageId: 'a', logger: quiet })).toBe(1);
        const after = await readRegistry(data.root);
        after.photos[job.photoId].revisions[job.assetRevision].profiles[job.profileId] = { state: 'failed', attempts: 3, error: "source unreadable: EIO: i/o error, read", requeuedFor: 'a' };
        await writeRegistry(data.root, after, after.version);
        expect(await requeueIoErrors(data.root, { outageId: 'a', logger: quiet })).toBe(0);
        expect(await requeueIoErrors(data.root, { logger: quiet })).toBe(0);
        expect(await requeueIoErrors(data.root, { outageId: 'b', logger: quiet })).toBe(1);
    });
});

/** Timers on a clock the test moves, firing in due order. */
function simulatedTimers(start: number) {
    let now = start;
    let next = 1;
    const timers = new Map<number, { at: number; callback: () => void; every?: number }>();
    const api: WatchTimers = {
        setTimeout(callback, ms) {
            timers.set(next, { at: now + ms, callback });
            return next++;
        },
        clearTimeout(handle) {
            timers.delete(handle as number);
        },
        setInterval(callback, ms) {
            timers.set(next, { at: now + ms, callback, every: ms });
            return next++;
        },
        clearInterval(handle) {
            timers.delete(handle as number);
        },
    };
    return {
        api,
        now: () => now,
        async advance(ms: number, settle: () => Promise<void>) {
            const end = now + ms;
            for (;;) {
                const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                const [id, timer] = due;
                now = timer.at;
                if (timer.every) timer.at += timer.every;
                else timers.delete(id);
                timer.callback();
                await settle();
            }
            now = end;
        },
    };
}

describe('review 4: the backoff holds', () => {
    it('makes about six passes in 30 minutes with the root gone and a set pending, not one every 30 s', { timeout: 60_000 }, async () => {
        const { lib } = await roots(1);
        const sim = simulatedTimers(NOW);
        let passed = 0;
        const step = createIdentityStep({
            logger: quiet,
            clock: sim.now,
            requestPass: (reason, delayMs) => watch.schedule(reason, delayMs),
            pass: { clock: () => Date.now() + 3_600_000, idGen: sequentialIds() },
            // A worker that builds nothing, so the set stays pending.
            createWorker: () => ({ start: async () => ({ started: true, queued: 0 }), enqueuePending: async () => 0, isQueued: () => false, idle: async () => undefined, stop: () => undefined, results: [], takeResults: () => [] }),
        });
        const counting = { pass: async (...args: Parameters<typeof step.pass>) => { passed++; return step.pass(...args); }, check: () => step.check() };
        const watch = watchIdentity(counting, { timers: sim.api, clock: sim.now, logger: quiet });
        cleanups.push(async () => {
            watch.stop();
            step.stop();
            await step.idle();
        });
        expect((await counting.pass('startup')).status).toBe('committed');
        cleanups.push(async () => setLibraryDir(lib.root)());
        setLibraryDir(`${lib.root}-unmounted`);
        passed = 0;
        watch.schedule('event');
        await sim.advance(30 * MINUTE, () => step.idle());
        expect(passed).toBeGreaterThanOrEqual(5);
        expect(passed).toBeLessThanOrEqual(8);
    });
});

describe('review 5: --once and a retry that waits', () => {
    it('exits 1 through the real run, naming how many builds wait and when', async () => {
        const { data } = await roots(1);
        await passes().run();
        const job = await firstJob(data);
        const at = iso(Date.now() + 3_600_000);
        const registry = await readRegistry(data.root);
        registry.photos[job.photoId].revisions[job.assetRevision].profiles[job.profileId] = { state: 'pending', attempts: 1, error: 'ENOSPC', retries: 1, retryAt: at };
        await writeRegistry(data.root, registry, registry.version);
        const lines: string[] = [];
        const push = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
        expect(await runIdentityOnce({ logger: { log: push, warn: push, error: push }, pass: { clock: () => Date.now() + 3_600_000, idGen: sequentialIds(100) } })).toBe(1);
        expect(lines).toContain(`[identity] 1 build waits for a retry at ${at}. Run it again after that, or leave it to the watcher.`);
    });
});

describe('review 6: classification', () => {
    it.each([
        'VipsJpeg: Premature end of JPEG file',
        'VipsJpeg: Corrupt JPEG data: 22 extraneous bytes before marker 0xd9',
        'Input buffer has corrupt header: pngload_buffer: libspng read error',
        'webpload_buffer: unable to parse image',
        'heifload_buffer: Invalid input: No \'ftyp\' box',
    ])('reads %j as a decode error', (message) => {
        expect(classifyDecodeFailure(new Error(message))).toBe('decode-error');
    });

    it.each([
        'vips_malloc: out of memory -- size == 1.2 GB',
        'Cannot allocate memory',
        'some error libvips never documented',
    ])('reads %j as transient', (message) => {
        expect(classifyDecodeFailure(new Error(message))).toBeNull();
    });

    it("names an IntegrityError corrupt-destination only for the set's own folder", () => {
        const finalDir = '/data/assets/ph_x/sha256-y/p_z';
        expect(buildFailureText(new IntegrityError(finalDir, ['w400.webp changed']), finalDir)).toBe('integrity: w400.webp changed');
        expect(buildFailureText(new IntegrityError('/data/staging/abc', ['w400.webp changed']), finalDir)).toBe('staging check failed: w400.webp changed');
        expect(buildFailureText(new Error('ENOSPC: no space left on device'), finalDir)).toBe('ENOSPC: no space left on device');
    });

    it('clamps a retry due far ahead to a timer of 24 h at most', async () => {
        const { data } = await roots(1);
        await passes().run();
        const job = await firstJob(data);
        const registry = await readRegistry(data.root);
        registry.photos[job.photoId].revisions[job.assetRevision].profiles[job.profileId] = { state: 'pending', attempts: 1, retries: 1, retryAt: iso(NOW + 30 * 24 * 60 * MINUTE) };
        await writeRegistry(data.root, registry, registry.version);
        const timers = manualTimers();
        const worker = createWorker({ clock: () => NOW, timers, logger: quiet } satisfies WorkerOptions);
        cleanups.push(async () => {
            worker.stop();
            await worker.idle();
        });
        await worker.start();
        expect(timers.due()).toEqual([24 * 60 * MINUTE]);
    });
});

describe('review 7: an outage the watcher exits to re-bind', { timeout: 60_000 }, () => {
    function stepFor(clock: () => number) {
        const rebinds: string[] = [];
        const step = createIdentityStep({
            logger: quiet,
            clock,
            requestPass: () => undefined,
            onRebind: (cause) => { rebinds.push(cause); },
            pass: { clock: () => Date.now() + 3_600_000, idGen: sequentialIds() },
            createWorker: () => ({ start: async () => ({ started: true, queued: 0 }), enqueuePending: async () => 0, isQueued: () => false, idle: async () => undefined, stop: () => undefined, results: [], takeResults: () => [] }),
        });
        cleanups.push(async () => {
            step.stop();
            await step.idle();
        });
        return { step, rebinds };
    }

    it('re-binds an empty root while the registry holds photos, after 3 looks and 30 minutes, once, writing nothing in the library', async () => {
        expect(LIBRARY_REBIND_LOOKS).toBe(3);
        expect(LIBRARY_REBIND_AFTER_MS).toBe(30 * MINUTE);
        const { lib, data } = await roots(2);
        let now = NOW;
        const { step, rebinds } = stepFor(() => now);
        await step.pass('startup');
        for (const name of fs.readdirSync(lib.root)) fs.renameSync(lib.file(name), `${data.root}/${name}.aside`);
        const before = contents(lib);
        for (const minute of [0, 10, 20]) {
            now = NOW + minute * MINUTE;
            expect((await step.pass('library-empty')).status).toBe('refused');
        }
        expect(rebinds).toEqual([]);
        now = NOW + 30 * MINUTE;
        await step.pass('library-empty');
        expect(rebinds).toEqual(['empty']);
        now = NOW + 40 * MINUTE;
        await step.pass('library-empty');
        expect(rebinds).toEqual(['empty']);
        expect(contents(lib)).toEqual(before);
    });

    it.skipIf(isRoot)('re-binds an unreadable root the same way', async () => {
        const { lib } = await roots(2);
        let now = NOW;
        const { step, rebinds } = stepFor(() => now);
        await step.pass('startup');
        fs.chmodSync(lib.root, 0o000);
        cleanups.push(async () => fs.chmodSync(lib.root, 0o755));
        for (const minute of [0, 10, 20, 30]) {
            now = NOW + minute * MINUTE;
            await step.pass('library-unavailable');
        }
        expect(rebinds).toEqual(['unreadable']);
    });

    it('never re-binds an empty root with an empty registry, a new library, or a missing root, which the script exits on at once', async () => {
        const { lib } = await roots(0);
        let now = NOW;
        const { step, rebinds } = stepFor(() => now);
        for (const minute of [0, 10, 20, 30, 40, 50]) {
            now = NOW + minute * MINUTE;
            expect((await step.pass('timer')).status).toBe('committed');
        }
        cleanups.push(async () => setLibraryDir(lib.root)());
        setLibraryDir(`${lib.root}-unmounted`);
        for (const minute of [60, 70, 80, 90, 100]) {
            now = NOW + minute * MINUTE;
            await step.pass('timer');
        }
        expect(rebinds).toEqual([]);
    });

    it("doesn't count a refused pass as progress", async () => {
        const { lib, data } = await roots(1);
        let now = NOW;
        const { step } = stepFor(() => now);
        await step.pass('startup');
        const progress = () => (JSON.parse(fs.readFileSync(`${data.root}/status/watcher.json`, 'utf8')) as { lastProgressAt: string }).lastProgressAt;
        const after = progress();
        cleanups.push(async () => setLibraryDir(lib.root)());
        setLibraryDir(`${lib.root}-unmounted`);
        now += 10 * MINUTE;
        await step.pass('timer');
        expect(progress()).toBe(after);
    });

    it('counts only source files when deciding whether the root is empty', async () => {
        const { lib } = await roots(1);
        const run = passes();
        await run.run();
        fs.renameSync(lib.file('photo-01.jpg'), `${lib.root}/../photo-01.aside`);
        fs.writeFileSync(lib.file('only.heic'), 'not a photo the watcher reads');
        run.advance(3_600_000);
        expect(await run.run()).toMatchObject({ status: 'skipped', reason: 'library-empty', present: 1 });
    });
});

describe.skipIf(isRoot)('review 8: io-error items', { timeout: 60_000 }, () => {
    it('need three skipped passes over at least 10 minutes', async () => {
        const { lib } = await roots(1);
        const facts: IdentityFact[] = [];
        const run = passes(facts);
        await run.run();
        cleanups.push(async () => fs.chmodSync(lib.file('photo-01.jpg'), 0o644));
        fs.chmodSync(lib.file('photo-01.jpg'), 0o000);
        expect(IO_ERROR_MIN_SPAN_MS).toBe(10 * MINUTE);
        for (let skipped = 1; skipped <= IO_ERROR_AFTER_PASSES + 2; skipped++) {
            run.advance(2 * MINUTE);
            await run.run();
        }
        // Five skips in 8 minutes: not yet.
        expect(facts.filter((fact) => fact.type === 'processing-failed')).toEqual([]);
        run.advance(3 * MINUTE);
        await run.run();
        expect(facts.filter((fact) => fact.type === 'processing-failed')).toEqual([expect.objectContaining({ reason: 'io-error', path: 'photo-01.jpg' })]);
    });

    it('report io-recovered, with the same key, on the pass that reads the file again', async () => {
        const { lib } = await roots(1);
        const facts: IdentityFact[] = [];
        const run = passes(facts);
        await run.run();
        cleanups.push(async () => fs.chmodSync(lib.file('photo-01.jpg'), 0o644));
        fs.chmodSync(lib.file('photo-01.jpg'), 0o000);
        for (let pass = 0; pass < 3; pass++) {
            run.advance(10 * MINUTE);
            await run.run();
        }
        const [failed] = facts.filter((fact) => fact.type === 'processing-failed');
        expect(failed).toMatchObject({ reason: 'io-error' });
        fs.chmodSync(lib.file('photo-01.jpg'), 0o644);
        facts.length = 0;
        run.advance(10 * MINUTE);
        await run.run();
        expect(facts).toEqual([expect.objectContaining({ type: 'io-recovered', key: failed.key, photoId: failed.photoId, assetRevision: failed.assetRevision, path: 'photo-01.jpg' })]);
        run.advance(10 * MINUTE);
        facts.length = 0;
        await run.run();
        expect(facts).toEqual([]);
    });

    it('give way to library-unavailable when 20 or more files and over 10% of them go unreadable at once', async () => {
        const { lib, data } = await roots(30);
        const facts: IdentityFact[] = [];
        const run = passes(facts);
        await run.run();
        const names = fs.readdirSync(lib.root).sort().slice(0, 21);
        cleanups.push(async () => { for (const name of names) fs.chmodSync(lib.file(name), 0o644); });
        for (const name of names) fs.chmodSync(lib.file(name), 0o000);
        const before = await readRegistry(data.root);
        for (let pass = 0; pass < 4; pass++) {
            run.advance(10 * MINUTE);
            expect(await run.run()).toEqual({ status: 'skipped', reason: 'library-unavailable', cause: 'unreadable', detail: 'EACCES on 21 of 30 files' });
        }
        expect(facts.filter((fact) => fact.type === 'processing-failed')).toEqual([]);
        expect((await readRegistry(data.root)).version).toBe(before.version);
    });
});
