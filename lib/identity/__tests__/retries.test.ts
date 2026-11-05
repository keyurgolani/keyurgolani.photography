// @vitest-environment node
import fs from 'node:fs';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { assetDir } from '../../media/path';
import { buildDerivativeSet, type BuildOutcome } from '../derivatives';
import { classifyDecodeFailure, failureCodeOf, isRetryable, RETRY_DELAYS_MS } from '../failures';
import { runReconcilePass } from '../pass';
import { currentProfileId, encodeVariant, MAX_SOURCE_PIXELS } from '../profile';
import { readRegistry, writeRegistry } from '../registry';
import type { DerivativeJob, ProfileEntry, Registry } from '../types';
import { createWorker, onceExitCode, prepareForProfile, retryingResults, type WorkerOptions, type WorkerResult, type WorkerTimers } from '../worker';
import { sequentialIds } from './reconcileFixtures';

/**
 * A6 (#17): a transient build error retries after 30 s, 2 min and 10 min,
 * then fails as `retries-exhausted`. `io-error`, `decode-error`,
 * `unsupported-format`, `too-large` and `corrupt-destination` never retry.
 * Each outcome logs one JSON line, a pixel cap applies at decode, and the
 * schedule lives in the registry, so a restart neither starts it over nor
 * builds early.
 */

const NOW = Date.parse('2026-03-02T09:00:00.000Z');
const isRoot = process.getuid?.() === 0;
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
const iso = (ms: number) => new Date(ms).toISOString();

let image: Buffer;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
    image = await sharp({ create: { width: 240, height: 160, channels: 3, background: { r: 60, g: 180, b: 90 } } }).jpeg().toBuffer();
});

afterEach(async () => {
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Timers a test fires by hand, in due order. */
function manualTimers(): WorkerTimers & { due(): number[]; fire(): Promise<void> } {
    let next = 1;
    const pending = new Map<number, { callback: () => void; ms: number }>();
    return {
        setTimeout(callback, ms) {
            const id = next++;
            pending.set(id, { callback, ms });
            return id;
        },
        clearTimeout(handle) {
            pending.delete(handle as number);
        },
        due: () => [...pending.values()].map((timer) => timer.ms),
        async fire() {
            const [first] = [...pending.entries()].sort((a, b) => a[1].ms - b[1].ms);
            if (!first) throw new Error('No timer is due.');
            pending.delete(first[0]);
            first[1].callback();
        },
    };
}

interface Setup {
    lib: TempLibrary;
    data: TempDataRoot;
    photoId: string;
    job: DerivativeJob;
    registry(): Promise<Registry>;
    entry(): Promise<ProfileEntry | undefined>;
    edit(change: (registry: Registry) => void): Promise<void>;
}

/** One photo, reconciled, with a pending entry for the current profile. */
async function setup(): Promise<Setup> {
    const lib = await createTempLibrary();
    cleanups.push(() => lib.cleanup());
    const data = createTempDataRoot();
    cleanups.push(() => data.cleanup());
    fs.writeFileSync(lib.file('photo.jpg'), image);
    const outcome = await runReconcilePass({ clock: () => Date.now() + 3_600_000, idGen: sequentialIds(), logger: quiet });
    if (outcome.status !== 'committed') throw new Error(`the pass didn't commit: ${JSON.stringify(outcome)}`);
    const registry = () => readRegistry(data.root);
    const first = await registry();
    const photo = Object.values(first.photos)[0];
    const job: DerivativeJob = { photoId: photo.photoId, assetRevision: photo.source.observedRevision, profileId: currentProfileId(), path: photo.source.path };
    const entry = async () => (await registry()).photos[job.photoId].revisions[job.assetRevision].profiles[job.profileId];
    const edit = async (change: (current: Registry) => void) => {
        const current = await registry();
        change(current);
        await writeRegistry(data.root, current, current.version);
    };
    return { lib, data, photoId: photo.photoId, job, registry, entry, edit };
}

function jsonLines(lines: readonly string[]): Record<string, unknown>[] {
    return lines.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.event === 'derivative-build');
}

function capture() {
    const lines: string[] = [];
    const push = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    return { lines, logger: { log: push, warn: push, error: push } };
}

function worker(options: Partial<WorkerOptions>) {
    const created = createWorker({ logger: quiet, ...options });
    cleanups.push(async () => {
        created.stop();
        await created.idle();
    });
    return created;
}

const full = () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); };

describe('failure codes', () => {
    it.each([
        ['source unreadable: EACCES: permission denied, open \'a.jpg\'', 'io-error'],
        ['source unreadable: EPERM: operation not permitted, open \'a.jpg\'', 'io-error'],
        ['source unreadable: EIO: i/o error, read', 'io-error'],
        ['decode-error: VipsJpeg: Premature end of JPEG file', 'decode-error'],
        ['undecodable', 'decode-error'],
        ['unsupported-format: Input buffer contains unsupported image format', 'unsupported-format'],
        ['too-large: 20000x20000 is over the 200000000-pixel cap', 'too-large'],
        ['integrity: w400.webp is 1 bytes, expected 2', 'corrupt-destination'],
        ['retries-exhausted: ENOSPC: no space left on device, write', 'retries-exhausted'],
        ['source-superseded', 'source-superseded'],
    ])('reads %j as %s, which never retries', (error, code) => {
        expect(failureCodeOf(error)).toBe(code);
        expect(isRetryable(error)).toBe(false);
    });

    it.each([
        'ENOSPC: no space left on device, write',
        'source unreadable: EMFILE: too many open files, open \'a.jpg\'',
        'w800.avif is empty',
        'the disk was full',
    ])('reads %j as transient', (error) => {
        expect(failureCodeOf(error)).toBeNull();
        expect(isRetryable(error)).toBe(true);
    });

    it('waits 30 s, 2 min and 10 min', () => {
        expect(RETRY_DELAYS_MS).toEqual([30_000, 120_000, 600_000]);
    });

    it.each([
        ['Input image exceeds pixel limit', 'too-large'],
        ['Input buffer contains unsupported image format', 'unsupported-format'],
        ['VipsJpeg: Premature end of JPEG file', 'decode-error'],
    ])("names Sharp's %j as %s", (message, code) => {
        expect(classifyDecodeFailure(new Error(message))).toBe(code);
    });

    it('leaves an errno error alone, since that is I/O and not the decoder', () => {
        expect(classifyDecodeFailure(Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }))).toBeNull();
    });

    it("caps the pixels Sharp decodes at MAX_SOURCE_PIXELS, which isn't part of the profile", async () => {
        expect(MAX_SOURCE_PIXELS).toBe(200_000_000);
        await expect(encodeVariant(image, 'w400', 'webp', { limitInputPixels: 1_000 })).rejects.toThrow(/pixel limit/);
    });
});

describe('the writer, with a retry policy', () => {
    const policy = { delaysMs: RETRY_DELAYS_MS };

    it('leaves a transient failure pending with its next try, three times, then fails it as retries-exhausted', async () => {
        const s = await setup();
        let now = NOW;
        const build = () => buildDerivativeSet(s.job, { clock: () => now, logger: quiet, retry: policy, faults: { writeFile: full } });
        let at = NOW;
        for (const [index, delay] of RETRY_DELAYS_MS.entries()) {
            const outcome = await build();
            at = now + delay;
            expect(outcome).toEqual({ status: 'pending', reason: 'retrying', retries: index + 1, retryAt: iso(at), error: 'ENOSPC: no space left on device, write' });
            expect(await s.entry()).toEqual({ state: 'pending', attempts: index + 1, error: 'ENOSPC: no space left on device, write', retries: index + 1, retryAt: iso(at) });
            now = at;
        }
        expect(await build()).toMatchObject({ status: 'failed', error: 'retries-exhausted: ENOSPC: no space left on device, write' });
        expect(await s.entry()).toEqual({ state: 'failed', attempts: 4, error: 'retries-exhausted: ENOSPC: no space left on device, write' });
    }, 60_000);

    it('clears the schedule once a retry builds the set', async () => {
        const s = await setup();
        expect(await buildDerivativeSet(s.job, { clock: () => NOW, logger: quiet, retry: policy, faults: { writeFile: full } })).toMatchObject({ status: 'pending', reason: 'retrying' });
        expect(await buildDerivativeSet(s.job, { clock: () => NOW + 30_000, logger: quiet, retry: policy })).toEqual({ status: 'ready', reused: false });
        expect(await s.entry()).toEqual({ state: 'ready', attempts: 2, readyAt: iso(NOW + 30_000) });
    }, 60_000);

    it('records a transient failure as failed, as before, without a policy', async () => {
        const s = await setup();
        expect(await buildDerivativeSet(s.job, { clock: () => NOW, logger: quiet, faults: { writeFile: full } })).toMatchObject({ status: 'failed' });
        expect(await s.entry()).toEqual({ state: 'failed', attempts: 1, error: 'ENOSPC: no space left on device, write' });
    }, 60_000);

    it.skipIf(isRoot)('fails an unreadable source as io-error at once', async () => {
        const s = await setup();
        fs.chmodSync(s.lib.file('photo.jpg'), 0o000);
        cleanups.push(async () => fs.chmodSync(s.lib.file('photo.jpg'), 0o644));
        const outcome = await buildDerivativeSet(s.job, { clock: () => NOW, logger: quiet, retry: policy });
        expect(outcome).toMatchObject({ status: 'failed', error: expect.stringMatching(/^source unreadable: EACCES/) });
        expect(failureCodeOf((await s.entry())?.error)).toBe('io-error');
        expect(await s.entry()).not.toHaveProperty('retryAt');
    }, 60_000);

    it('fails a source over the pixel cap as too-large before decoding it', async () => {
        const s = await setup();
        const outcome = await buildDerivativeSet(s.job, { clock: () => NOW, logger: quiet, retry: policy, maxSourcePixels: 1_000 });
        expect(outcome).toMatchObject({ status: 'failed', error: 'too-large: 240x160 is over the 1000-pixel cap' });
        expect(fs.existsSync(assetDir(s.job))).toBe(false);
    }, 60_000);

    it("fails as too-large when Sharp's own cap refuses the decode", async () => {
        const s = await setup();
        // The registry under-reports the size, so only the decoder's cap can catch it.
        await s.edit((registry) => {
            const revision = registry.photos[s.job.photoId].revisions[s.job.assetRevision];
            revision.width = 10;
            revision.height = 10;
        });
        const outcome = await buildDerivativeSet(s.job, { clock: () => NOW, logger: quiet, retry: policy, maxSourcePixels: 1_000 });
        expect(outcome).toMatchObject({ status: 'failed', error: expect.stringMatching(/^too-large: .*pixel limit/) });
        expect(failureCodeOf((await s.entry())?.error)).toBe('too-large');
    }, 60_000);

    it('fails a damaged set already in place as corrupt-destination, and never retries it', async () => {
        const s = await setup();
        fs.mkdirSync(assetDir(s.job), { recursive: true });
        fs.writeFileSync(`${assetDir(s.job)}/w400.webp`, 'not a variant');
        const outcome = await buildDerivativeSet(s.job, { clock: () => NOW, logger: quiet, retry: policy });
        expect(outcome).toMatchObject({ status: 'failed', error: expect.stringMatching(/^integrity: /) });
        expect(failureCodeOf((await s.entry())?.error)).toBe('corrupt-destination');
        // The writer only ever adds sets: the damaged one is left as it is.
        expect(fs.readFileSync(`${assetDir(s.job)}/w400.webp`, 'utf8')).toBe('not a variant');
    }, 60_000);
});

describe('the worker', () => {
    it('retries a transient failure after 30 s, 2 min and 10 min, logging one JSON line per outcome, then gives up', async () => {
        const s = await setup();
        const timers = manualTimers();
        const { lines, logger } = capture();
        let now = NOW;
        const w = worker({ clock: () => now, timers, logger, faults: { writeFile: full } });
        expect(await w.start()).toEqual({ started: true, queued: 1 });
        await w.idle();
        for (const delay of RETRY_DELAYS_MS) {
            expect(timers.due()).toEqual([delay]);
            expect(w.isQueued(s.job)).toBe(true);
            now += delay;
            await timers.fire();
            await w.idle();
        }
        expect(timers.due()).toEqual([]);
        expect(w.isQueued(s.job)).toBe(false);
        expect(await s.entry()).toEqual({ state: 'failed', attempts: 4, error: 'retries-exhausted: ENOSPC: no space left on device, write' });
        const logged = jsonLines(lines);
        expect(logged.map((line) => [line.outcome, line.code ?? null, line.retry ?? null])).toEqual([
            ['retrying', null, 1],
            ['retrying', null, 2],
            ['retrying', null, 3],
            ['failed', 'retries-exhausted', null],
        ]);
        expect(logged[0]).toMatchObject({ photoId: s.job.photoId, assetRevision: s.job.assetRevision, profileId: s.job.profileId, retryAt: iso(NOW + 30_000) });
        expect(JSON.stringify(logged)).not.toContain(s.lib.root);
    }, 60_000);

    it('logs a JSON line for a built set and for a permanent failure, with its code', async () => {
        const s = await setup();
        const { lines, logger } = capture();
        const w = worker({ clock: () => NOW, logger, maxSourcePixels: 1_000 });
        await w.start();
        await w.idle();
        expect(jsonLines(lines)).toEqual([expect.objectContaining({ event: 'derivative-build', outcome: 'failed', code: 'too-large', photoId: s.job.photoId })]);

        const t = await setup();
        const other = capture();
        const built = worker({ clock: () => NOW, logger: other.logger });
        await built.start();
        await built.idle();
        expect(jsonLines(other.lines)).toEqual([expect.objectContaining({ outcome: 'built', photoId: t.job.photoId })]);
    }, 60_000);

    it('keeps the schedule across a restart: it neither starts it over nor builds before the retry is due', async () => {
        const s = await setup();
        const first = worker({ clock: () => NOW, timers: manualTimers(), faults: { writeFile: full } });
        await first.start();
        await first.idle();
        first.stop();
        expect(await s.entry()).toMatchObject({ state: 'pending', retries: 1, retryAt: iso(NOW + 30_000) });

        // Ten seconds later a new process starts.
        const timers = manualTimers();
        let built = 0;
        let now = NOW + 10_000;
        const second = worker({
            clock: () => now,
            timers,
            build: async (job, options) => {
                built++;
                return buildDerivativeSet(job, options);
            },
        });
        expect(await second.start()).toEqual({ started: true, queued: 0 });
        await second.idle();
        expect(built).toBe(0);
        expect(timers.due()).toEqual([20_000]);
        expect(second.isQueued(s.job)).toBe(true);
        // A pass that finds the entry pending queues nothing new.
        expect(await second.enqueuePending()).toBe(0);
        // The timer fires when the retry is due. One that fired early would wait again (A6 review's 24 h clamp).
        now = NOW + 30_000;
        await timers.fire();
        await second.idle();
        expect(built).toBe(1);
        expect(await s.entry()).toEqual({ state: 'ready', attempts: 2, readyAt: iso(NOW + 30_000) });
    }, 60_000);

    it('builds at once an entry whose retry fell due while no worker ran', async () => {
        const s = await setup();
        await s.edit((registry) => {
            registry.photos[s.job.photoId].revisions[s.job.assetRevision].profiles[s.job.profileId] = { state: 'pending', attempts: 1, error: 'ENOSPC', retries: 1, retryAt: iso(NOW - 1) };
        });
        const w = worker({ clock: () => NOW, timers: manualTimers() });
        expect(await w.start()).toEqual({ started: true, queued: 1 });
        await w.idle();
        expect(await s.entry()).toMatchObject({ state: 'ready', attempts: 2 });
    }, 60_000);

    it('never retries with retry: false', async () => {
        const s = await setup();
        const timers = manualTimers();
        const w = worker({ clock: () => NOW, timers, retry: false, faults: { writeFile: full } });
        await w.start();
        await w.idle();
        expect(timers.due()).toEqual([]);
        expect(await s.entry()).toMatchObject({ state: 'failed', error: 'ENOSPC: no space left on device, write' });
    }, 60_000);

    it('clears its retry timers when stopped', async () => {
        await setup();
        const timers = manualTimers();
        const w = worker({ clock: () => NOW, timers, faults: { writeFile: full } });
        await w.start();
        await w.idle();
        expect(timers.due()).toHaveLength(1);
        w.stop();
        expect(timers.due()).toEqual([]);
    }, 60_000);
});

describe('at start', () => {
    const entryFor = (error: string): Registry => ({
        schemaVersion: 1,
        version: 1,
        updatedAt: null,
        holds: [],
        pendingFacts: [],
        photos: {
            ph_00000000000000000000000000000001: {
                photoId: 'ph_00000000000000000000000000000001',
                createdAt: iso(NOW),
                source: { path: 'a.jpg', key: 'a.jpg', present: true, observedRevision: `sha256-${'a'.repeat(64)}`, lastSeenAt: iso(NOW) },
                sourceHealth: 'present',
                duplicateOf: null,
                revisions: {
                    [`sha256-${'a'.repeat(64)}`]: {
                        assetRevision: `sha256-${'a'.repeat(64)}`, pixelDigest: null, firstSeenAt: iso(NOW), firstSeenPath: 'a.jpg', sourceBytes: 1, sourceFormat: 'jpeg', width: 1, height: 1, orientation: null,
                        derived: { extractorVersion: 1, technical: {}, capturedDate: null } as never,
                        curatorOnly: { extractorVersion: 1 } as never,
                        profiles: { p_current: { state: 'failed', attempts: 4, error } },
                    },
                },
            },
        },
    });
    const after = (error: string) => {
        const registry = entryFor(error);
        prepareForProfile(registry, 'p_current');
        return Object.values(Object.values(registry.photos)[0].revisions)[0].profiles.p_current;
    };

    it.each([
        'retries-exhausted: ENOSPC: no space left on device, write',
        'too-large: 1x1 is over the 1-pixel cap',
        'decode-error: VipsJpeg: Premature end of JPEG file',
        "source unreadable: EIO: i/o error, open 'a.jpg'",
        'integrity: w400.webp changed',
        'source-superseded',
        'undecodable',
    ])('keeps %j failed, so a restart repeats no work', (error) => {
        expect(after(error)).toEqual({ state: 'failed', attempts: 4, error });
    });

    it('still puts a v1.7.x failure, which has no code, back to pending once', () => {
        expect(after('the disk was full')).toEqual({ state: 'pending', attempts: 4 });
    });
});

describe('--once', () => {
    const result = (outcome: BuildOutcome): WorkerResult => ({ job: { photoId: 'p', assetRevision: 'r', profileId: 'f', path: 'x.jpg' }, outcome });

    it('exits 1 while a build waits for its retry, since its set is not built', () => {
        const retrying = result({ status: 'pending', reason: 'retrying', retries: 1, retryAt: iso(NOW), error: 'ENOSPC' });
        expect(retryingResults([result({ status: 'ready', reused: false }), retrying])).toEqual([retrying]);
        expect(onceExitCode([result({ status: 'ready', reused: false }), retrying])).toBe(1);
    });
});
