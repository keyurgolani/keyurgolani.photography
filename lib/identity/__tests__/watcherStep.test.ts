// @vitest-environment node
import fs from 'node:fs';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeRegistryFile } from '../../../test/helpers/registryFiles';
import { createTempDataRoot, writeDataRootMarker, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { assetsRoot } from '../../media/path';
import { withLock } from '../../storage/lock';
import { createDecision, writeDecision } from '../decisions';
import { watcherStatusFile } from '../heartbeat';
import { runReconcilePass } from '../pass';
import { currentProfileId } from '../profile';
import { readRegistry, writeRegistry } from '../registry';
import type { Registry } from '../types';
import type { DerivativeWorker, WorkerStart } from '../worker';
import {
    createIdentityStep,
    runIdentityOnce,
    watchIdentity,
    type IdentityStepOptions,
    type PassReason,
    type PassReport,
} from '../watcherStep';
import { sequentialIds } from './reconcileFixtures';

const NOW = Date.parse('2026-05-04T08:00:00.000Z');
const isRoot = process.getuid?.() === 0;
/** A pass clock an hour ahead, so files written by the test count as settled. */
const settled = () => Date.now() + 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

let images: Buffer[];
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
    images = await Promise.all([30, 110, 190, 240].map((tint) =>
        sharp({ create: { width: 240, height: 160, channels: 3, background: { r: tint, g: 255 - tint, b: 70 } } }).jpeg().toBuffer()));
});

afterEach(async () => {
    // Before the cleanups, which put PHOTOGRAPHY_DATA_DIR back as it was before the test.
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function captureLogger() {
    const lines: string[] = [];
    const push = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    return { lines, logger: { log: push, warn: push, error: push } };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

interface Setup {
    lib: TempLibrary;
    data: TempDataRoot;
    lines: string[];
    requests: { reason: PassReason; delayMs?: number }[];
    step: ReturnType<typeof createIdentityStep>;
    registry(): Promise<Registry>;
    heartbeat(): unknown;
}

/** A temp library holding `photos` photos, a temp data root in `state`, and an identity step over both. */
async function setup(
    { photos = 2, state = 'ready', options = {} }: { photos?: number; state?: 'ready' | 'uninitialized' | 'missing'; options?: IdentityStepOptions } = {},
): Promise<Setup> {
    const lib = await createTempLibrary();
    cleanups.push(() => lib.cleanup());
    const data = createTempDataRoot({ state });
    cleanups.push(() => data.cleanup());
    for (let index = 0; index < photos; index++) fs.writeFileSync(lib.file(`photo-${index + 1}.jpg`), images[index]);
    const { lines, logger } = captureLogger();
    const requests: Setup['requests'] = [];
    const step = createIdentityStep({
        logger,
        clock: () => NOW,
        pid: 4242,
        hostname: 'test-host',
        requestPass: (reason, delayMs) => { requests.push(delayMs === undefined ? { reason } : { reason, delayMs }); },
        ...options,
        pass: { clock: settled, idGen: sequentialIds(), ...options.pass },
    });
    cleanups.push(async () => {
        step.stop();
        await step.idle();
    });
    return {
        lib,
        data,
        lines,
        requests,
        step,
        registry: () => readRegistry(data.root),
        heartbeat: () => JSON.parse(fs.readFileSync(watcherStatusFile(data.root), 'utf8')) as unknown,
    };
}

/** Every file in the asset store with its bytes. */
function assetStore(root: string): Record<string, string> {
    const store = assetsRoot(root);
    if (!fs.existsSync(store)) return {};
    const files: Record<string, string> = {};
    for (const relative of fs.readdirSync(store, { recursive: true, encoding: 'utf8' }).sort()) {
        const file = `${store}/${relative}`;
        if (fs.statSync(file).isFile()) files[relative] = fs.readFileSync(file).toString('base64');
    }
    return files;
}

/** A worker that builds nothing, with whatever behavior a test overrides. */
function fakeWorker(overrides: Partial<DerivativeWorker> = {}): DerivativeWorker {
    return {
        start: async () => ({ started: true, queued: 0 }),
        enqueuePending: async () => 0,
        isQueued: () => false,
        idle: async () => undefined,
        stop: () => undefined,
        results: [],
        takeResults: () => [],
        ...overrides,
    };
}

function profileStates(registry: Registry): string[] {
    return Object.values(registry.photos).map((photo) => photo.revisions[photo.source.observedRevision].profiles[currentProfileId()]?.state ?? 'none');
}

const offLines = (lines: string[]) => lines.filter((line) => line.startsWith('[identity] Identity step off'));

describe('an identity pass', { timeout: 60_000 }, () => {
    it('on a ready data root commits, starts the worker, builds every set, and records the pass in the heartbeat', async () => {
        const s = await setup();

        const report = await s.step.pass('startup');
        await s.step.idle();

        expect(report).toEqual({ status: 'committed', facts: 2, queued: 2, retryAfterMs: null });
        const registry = await s.registry();
        expect(profileStates(registry)).toEqual(['ready', 'ready']);
        expect(registry.pendingFacts).toEqual([]);
        expect(Object.keys(assetStore(s.data.root)).filter((file) => file.endsWith('manifest.json'))).toHaveLength(2);
        expect(s.heartbeat()).toEqual({ pid: 4242, hostname: 'test-host', lastPassAt: iso(NOW), lastPassResult: 'committed', passStartedAt: null, heartbeatAt: iso(NOW) });
        expect(s.lines).toContain(`[identity] Identity step on: data root ${s.data.root}.`);
        expect(s.lines.filter((line) => line.includes('"event":"identity-fact"'))).toHaveLength(2);
        expect(s.requests).toEqual([]);
    });

    it('with nothing new queues nothing, and leaves the asset store byte-identical', async () => {
        const s = await setup();
        await s.step.pass('startup');
        await s.step.idle();
        const store = assetStore(s.data.root);

        expect(await s.step.pass('timer')).toEqual({ status: 'committed', facts: 0, queued: 0, retryAfterMs: null });
        await s.step.idle();
        expect(assetStore(s.data.root)).toEqual(store);
    });

    it('reads the library only after the legacy step has finished its queued jobs', async () => {
        const legacy = deferred();
        const s = await setup({ options: { legacyIdle: () => legacy.promise } });

        const report = s.step.pass('startup');
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(fs.existsSync(s.data.file('identity', 'registry'))).toBe(false);
        // A first start's legacy backlog can take hours, so the wait for it
        // isn't part of the pass the healthcheck times.
        await s.step.check();
        expect(s.heartbeat()).toMatchObject({ passStartedAt: null });

        legacy.resolve();
        expect((await report).status).toBe('committed');
    });

    it('never overlaps another: requests made while one runs share one pass after it', async () => {
        const legacy = deferred();
        let legacyWaits = 0;
        const s = await setup({ options: { legacyIdle: () => { legacyWaits++; return legacy.promise; } } });

        const first = s.step.pass('startup');
        const second = s.step.pass('event');
        const third = s.step.pass('event');
        expect(third).toBe(second);
        legacy.resolve();
        await Promise.all([first, second]);

        expect(legacyWaits).toBe(2);
    });

    it.each([
        ['uninitialized', true],
        ['unavailable', false],
        ['unwritable', false],
        ['unset', false],
    ] as const)('while the data root is %s, logs one line, runs no identity work, and writes a heartbeat only into a root it can write', async (state, heartbeat) => {
        if (state === 'unwritable' && isRoot) return; // root writes through any mode
        const s = await setup({ state: state === 'unavailable' ? 'missing' : state === 'uninitialized' ? 'uninitialized' : 'ready' });
        if (state === 'unwritable') fs.chmodSync(s.data.root, 0o500);
        if (state === 'unset') {
            vi.stubEnv('NODE_ENV', 'production');
            vi.stubEnv('PHOTOGRAPHY_DATA_DIR', '');
        }

        expect(await s.step.pass('startup')).toEqual({ status: 'off', state });
        await s.step.check();
        expect(await s.step.pass('timer')).toEqual({ status: 'off', state });

        expect(offLines(s.lines)).toHaveLength(1);
        expect(offLines(s.lines)[0]).toContain(`the data root is ${state}`);
        expect(s.lines.filter((line) => line.includes('status/watcher.json'))).toEqual([]);
        expect(s.step.worker).toBeNull();
        expect(s.requests).toEqual([]);
        if (state === 'unwritable') fs.chmodSync(s.data.root, 0o700);
        expect(fs.existsSync(s.data.file('identity'))).toBe(false);
        expect(fs.existsSync(watcherStatusFile(s.data.root))).toBe(heartbeat);
        if (heartbeat) {
            expect(s.heartbeat()).toMatchObject({ lastPassAt: iso(NOW), lastPassResult: 'data-root-uninitialized' });
        }
    });

    it('turns the identity step on once the data root becomes ready, and says so', async () => {
        const s = await setup({ state: 'uninitialized' });
        expect((await s.step.pass('startup')).status).toBe('off');

        writeDataRootMarker(s.data.root);
        expect((await s.step.pass('timer')).status).toBe('committed');

        expect(s.lines.filter((line) => line.startsWith('[identity] Identity step'))).toEqual([
            expect.stringContaining('[identity] Identity step off: the data root is uninitialized'),
            `[identity] Identity step on: data root ${s.data.root}.`,
        ]);
    });

    it('skips while the registry is busy, logs it, and asks for another pass', async () => {
        const s = await setup({ options: { pass: { lock: { waitMs: 0 } } } });

        const report = await withLock('registry', { root: s.data.root }, () => s.step.pass('startup'));

        expect(report).toEqual({ status: 'locked' });
        expect(s.requests).toEqual([{ reason: 'locked' }]);
        expect(s.lines.some((line) => line.startsWith('[identity] Skipped a pass: the registry is busy'))).toBe(true);
        expect(s.heartbeat()).toMatchObject({ lastPassResult: 'locked' });
    });

    it('asks for another pass once a file still being written has had time to settle', async () => {
        const s = await setup({ photos: 0, options: { pass: { clock: Date.now } } });
        fs.writeFileSync(s.lib.file('fresh.jpg'), images[0]);

        const report = await s.step.pass('event');

        expect(report).toMatchObject({ status: 'committed', facts: 0 });
        const retryAfterMs = (report as Extract<PassReport, { status: 'committed' }>).retryAfterMs;
        expect(retryAfterMs).toBeGreaterThan(0);
        expect(retryAfterMs).toBeLessThanOrEqual(5_000);
        expect(s.requests).toEqual([{ reason: 'settling', delayMs: retryAfterMs }]);
    });

    it("logs once why a worker can't start, builds nothing, and keeps reconciling", async () => {
        const s = await setup({ options: { worker: { deviceOf: (dir) => (dir.endsWith('staging') ? 2 : 1) } } });

        expect((await s.step.pass('startup')).status).toBe('committed');
        fs.writeFileSync(s.lib.file('photo-3.jpg'), images[2]);
        expect(await s.step.pass('event')).toMatchObject({ status: 'committed', facts: 1, queued: 0 });

        expect(s.step.workerError).toContain('EXDEV');
        expect(s.lines.filter((line) => line.includes('EXDEV'))).toHaveLength(1);
        expect(assetStore(s.data.root)).toEqual({});
        expect(profileStates(await s.registry())).toEqual(['pending', 'pending', 'pending']);
        // Pending sets it can never build don't make the check ask for a pass every 30 s.
        await s.step.check();
        expect(s.requests).toEqual([]);
    });

    it('asks for another pass when the worker has to wait for a busy registry to start, and starts it on the next', async () => {
        const starts: WorkerStart[] = [{ started: false, reason: 'locked', holder: null }, { started: true, queued: 2 }];
        const s = await setup({ options: { createWorker: () => fakeWorker({ start: async () => starts.shift() as WorkerStart }) } });

        expect(await s.step.pass('startup')).toMatchObject({ status: 'committed', queued: 0 });
        expect(s.requests).toEqual([{ reason: 'locked' }]);
        expect(s.lines).toContain('[identity] The worker waits to start: the registry is busy. Trying again shortly.');
        expect(await s.step.pass('locked')).toMatchObject({ status: 'committed', queued: 2 });
    });

    it("warns once when it can't write the heartbeat, and keeps passing", async () => {
        const s = await setup();
        fs.writeFileSync(s.data.file('status'), 'a file where the status folder goes');

        expect((await s.step.pass('startup')).status).toBe('committed');
        expect((await s.step.pass('timer')).status).toBe('committed');
        await s.step.check();

        expect(s.lines.filter((line) => line.startsWith('[identity] Could not write status/watcher.json'))).toHaveLength(1);
    });

    it('turns itself off, saying why, when the registry comes from a newer build', async () => {
        const s = await setup();
        fs.mkdirSync(s.data.file('identity'), { mode: 0o700 });
        writeRegistryFile(s.data.root, 1, JSON.stringify({ schemaVersion: 99, version: 1 }));

        expect(await s.step.pass('startup')).toEqual({ status: 'off', state: 'unavailable' });
        expect(offLines(s.lines)).toEqual([expect.stringContaining('the data root is unavailable')]);
        expect(s.step.worker).toBeNull();
        expect(s.heartbeat()).toMatchObject({ lastPassResult: 'data-root-unavailable' });
    });

    it('after stop() finishes the pass under way without reading the library, and starts no new one', async () => {
        const legacy = deferred();
        const s = await setup({ options: { legacyIdle: () => legacy.promise } });

        const report = s.step.pass('startup');
        s.step.stop();
        legacy.resolve();

        expect(await report).toEqual({ status: 'stopped' });
        expect(await s.step.pass('event')).toEqual({ status: 'stopped' });
        await s.step.check();
        expect(fs.existsSync(s.data.file('identity'))).toBe(false);
        expect(fs.existsSync(watcherStatusFile(s.data.root))).toBe(false);
    });

    it('drops what the builds did at the next pass, and keeps only the error text until then', async () => {
        const s = await setup({ options: { worker: { faults: { afterEncode: () => { throw new Error('encoder exploded'); } } } } });

        await s.step.pass('startup');
        await s.step.idle();
        expect(s.step.worker?.results.map(({ outcome }) => outcome)).toEqual([
            { status: 'failed', error: 'encoder exploded' },
            { status: 'failed', error: 'encoder exploded' },
        ]);

        await s.step.pass('timer');
        await s.step.idle();
        expect(s.step.worker?.results).toEqual([]);
    });

    it('stop() stops the worker too, so it starts no queued build', async () => {
        let workerStops = 0;
        const s = await setup({ options: { createWorker: () => fakeWorker({ stop: () => { workerStops++; } }) } });
        await s.step.pass('startup');

        s.step.stop();

        expect(workerStops).toBe(1);
    });
});

describe('the 30 s check', { timeout: 60_000 }, () => {
    it('writes the heartbeat and asks for nothing when no work waits', async () => {
        let now = NOW;
        const s = await setup({ options: { clock: () => now } });
        await s.step.pass('startup');
        await s.step.idle();

        now += 30_000;
        await s.step.check();

        expect(s.heartbeat()).toEqual({ pid: 4242, hostname: 'test-host', lastPassAt: iso(NOW), lastPassResult: 'committed', passStartedAt: null, heartbeatAt: iso(NOW + 30_000) });
        expect(s.requests).toEqual([]);
    });

    it('stamps the heartbeats it writes while a pass runs with when that pass started, and clears it once the pass ends', async () => {
        let now = NOW;
        const gate = deferred();
        const entered = deferred();
        const s = await setup({
            options: {
                clock: () => now,
                sinks: [async () => {
                    entered.resolve();
                    await gate.promise;
                }],
            },
        });
        cleanups.push(async () => gate.resolve());
        const pass = s.step.pass('startup');
        await entered.promise;

        now += 30_000;
        await s.step.check();
        expect(s.heartbeat()).toMatchObject({ passStartedAt: iso(NOW), heartbeatAt: iso(NOW + 30_000) });

        gate.resolve();
        await pass;
        await s.step.idle();
        now += 30_000;
        await s.step.check();
        expect(s.heartbeat()).toMatchObject({ passStartedAt: null, lastPassResult: 'committed', heartbeatAt: iso(NOW + 60_000) });
    });

    it('keeps the heartbeat for its owner only', async () => {
        const s = await setup();
        await s.step.check();

        expect(fs.statSync(s.data.file('status')).mode & 0o777).toBe(0o700);
        expect(fs.statSync(watcherStatusFile(s.data.root)).mode & 0o777).toBe(0o600);
        expect(s.heartbeat()).toEqual({ pid: 4242, hostname: 'test-host', lastPassAt: null, lastPassResult: null, passStartedAt: null, heartbeatAt: iso(NOW) });
    });

    it('asks for a pass when a decision is waiting', async () => {
        const s = await setup();
        await s.step.pass('startup');
        await s.step.idle();
        const [photoId] = Object.keys((await s.registry()).photos);

        await writeDecision(s.data.root, createDecision({ type: 'archive', photoId, actor: 'test' }));
        await s.step.check();

        expect(s.requests).toEqual([{ reason: 'decisions' }]);
    });

    it('asks for no pass for a decision the last pass deferred, and for one when another arrives', async () => {
        let ahead = 3_600_000;
        const s = await setup({ options: { pass: { clock: () => Date.now() + ahead } } });
        await s.step.pass('startup');
        await s.step.idle();
        const [photoId] = Object.keys((await s.registry()).photos);

        // A decision about a file still being written waits for it to settle, and the pass asks for one then.
        fs.writeFileSync(s.lib.file('fresh.jpg'), images[2]);
        ahead = 0;
        await writeDecision(s.data.root, createDecision({ type: 'new', path: 'fresh.jpg', actor: 'test' }));
        expect(await s.step.pass('decisions')).toMatchObject({ status: 'committed' });
        expect(s.requests.map(({ reason }) => reason)).toEqual(['settling']);
        await s.step.check();
        expect(s.requests.map(({ reason }) => reason)).toEqual(['settling']);

        await writeDecision(s.data.root, createDecision({ type: 'reprofile', photoId, actor: 'test' }));
        await s.step.check();
        expect(s.requests.map(({ reason }) => reason)).toEqual(['settling', 'decisions']);
    });

    it('asks for a pass when another process left facts undelivered', async () => {
        const s = await setup();
        await s.step.pass('startup');
        await s.step.idle();

        // A CLI pass delivers only to its log and leaves the facts for the watcher.
        fs.writeFileSync(s.lib.file('photo-3.jpg'), images[2]);
        await runReconcilePass({ clock: settled, logger: captureLogger().logger });
        await s.step.check();

        expect(s.requests).toEqual([{ reason: 'facts' }]);
    });

    it('asks for a pass for pending sets the worker has not queued, and for none once they are built', async () => {
        const s = await setup();
        await s.step.pass('startup');
        await s.step.idle();

        // As a reprofile decision applied by a CLI pass leaves it: pending again, and no fact.
        const registry = await s.registry();
        const [photo] = Object.values(registry.photos);
        photo.revisions[photo.source.observedRevision].profiles[currentProfileId()] = { state: 'pending', attempts: 0 };
        await writeRegistry(s.data.root, registry, registry.version);
        await s.step.check();
        expect(s.requests).toEqual([{ reason: 'pending-sets' }]);

        expect(await s.step.pass('pending-sets')).toMatchObject({ status: 'committed', queued: 1 });
        await s.step.idle();
        await s.step.check();
        expect(s.requests).toEqual([{ reason: 'pending-sets' }]);
        expect(profileStates(await s.registry())).toEqual(['ready', 'ready']);
    });

    it('asks for a pass for pending sets left before the worker ever started, as by a migration', async () => {
        const s = await setup();
        // Another process's pass that delivered its facts: the sets are pending, and no worker has run yet.
        await runReconcilePass({ clock: settled, logger: captureLogger().logger, clearDelivered: true, sinks: [() => undefined] });

        await s.step.check();

        expect(s.step.worker).toBeNull();
        expect(s.requests).toEqual([{ reason: 'pending-sets' }]);
    });
});

describe('watchIdentity', () => {
    function fakeTimers() {
        let now = NOW;
        let nextId = 1;
        const scheduled = new Map<number, { due: number; fn: () => void; every: number | null }>();
        return {
            clock: () => now,
            timers: {
                setTimeout: (fn: () => void, ms: number) => { scheduled.set(nextId, { due: now + ms, fn, every: null }); return nextId++; },
                clearTimeout: (id: unknown) => { scheduled.delete(id as number); },
                setInterval: (fn: () => void, ms: number) => { scheduled.set(nextId, { due: now + ms, fn, every: ms }); return nextId++; },
                clearInterval: (id: unknown) => { scheduled.delete(id as number); },
            },
            /** Move time on by `ms`, firing each timer that falls due, in order, and letting promise callbacks run after each as real time would. */
            async advance(ms: number) {
                const end = now + ms;
                for (;;) {
                    const next = [...scheduled.entries()].filter(([, timer]) => timer.due <= end).sort(([a, x], [b, y]) => x.due - y.due || a - b)[0];
                    if (!next) break;
                    const [id, timer] = next;
                    now = timer.due;
                    if (timer.every === null) scheduled.delete(id);
                    else timer.due += timer.every;
                    timer.fn();
                    await new Promise((resolve) => setImmediate(resolve));
                }
                now = end;
            },
            pending: () => scheduled.size,
        };
    }

    function fakeStep() {
        const passes: { reason: PassReason; at: number }[] = [];
        const state = { checks: 0, checkRunning: null as Promise<void> | null, clock: () => NOW };
        return {
            passes,
            state,
            step: {
                pass: async (reason: PassReason): Promise<PassReport> => {
                    passes.push({ reason, at: state.clock() });
                    return { status: 'committed', facts: 0, queued: 0, retryAfterMs: null };
                },
                check: () => {
                    state.checks++;
                    return state.checkRunning ?? Promise.resolve();
                },
            },
        };
    }

    function start() {
        const fake = fakeTimers();
        const step = fakeStep();
        step.state.clock = fake.clock;
        const watch = watchIdentity(step.step, { timers: fake.timers, clock: fake.clock, logger: captureLogger().logger });
        return { fake, step, watch };
    }

    it('runs one pass 5 s after the last of a burst of requests', async () => {
        const { fake, step, watch } = start();
        watch.schedule('event');
        await fake.advance(3_000);
        watch.schedule('event');
        await fake.advance(4_900);
        expect(step.passes).toEqual([]);

        await fake.advance(100);
        expect(step.passes).toEqual([{ reason: 'event', at: NOW + 8_000 }]);
        watch.stop();
    });

    it('runs a pass within 30 s of the first request, however steady the stream', async () => {
        const { fake, step, watch } = start();
        for (let elapsed = 0; elapsed < 40_000; elapsed += 4_000) {
            watch.schedule('event');
            await fake.advance(4_000);
        }
        // The next pass is 5 s after the last request, which is still to come.
        expect(step.passes).toEqual([{ reason: 'event', at: NOW + 30_000 }]);
        watch.stop();
    });

    it('runs a request that names a delay after it, without putting off a pass due sooner', async () => {
        const { fake, step, watch } = start();
        watch.schedule('settling', 2_000);
        await fake.advance(2_000);
        expect(step.passes).toEqual([{ reason: 'settling', at: NOW + 2_000 }]);

        watch.schedule('event');
        watch.schedule('settling', 9_000);
        await fake.advance(9_000);
        expect(step.passes).toEqual([{ reason: 'settling', at: NOW + 2_000 }, { reason: 'settling', at: NOW + 7_000 }]);
        watch.stop();
    });

    it('checks every 30 s and asks for a pass every 10 minutes', async () => {
        const { fake, step, watch } = start();
        await fake.advance(30_000);
        expect(step.state.checks).toBe(1);

        await fake.advance(600_000 - 30_000 + 5_000);
        expect(step.state.checks).toBe(20);
        expect(step.passes).toEqual([{ reason: 'timer', at: NOW + 605_000 }]);
        watch.stop();
    });

    it('starts no check while the last one is still running', async () => {
        const { fake, step, watch } = start();
        step.state.checkRunning = new Promise(() => undefined);
        await fake.advance(120_000);
        expect(step.state.checks).toBe(1);
        watch.stop();
    });

    it('stop() clears every timer, so nothing runs after it', async () => {
        const { fake, step, watch } = start();
        watch.schedule('event');
        watch.stop();
        watch.schedule('event');
        await fake.advance(700_000);

        expect(step.passes).toEqual([]);
        expect(step.state.checks).toBe(0);
        expect(fake.pending()).toBe(0);
    });
});

describe('runIdentityOnce', { timeout: 60_000 }, () => {
    async function once(options: Parameters<typeof runIdentityOnce>[0] & { photos?: number; state?: 'ready' | 'uninitialized' | 'missing' } = {}) {
        const { photos = 2, state = 'ready', ...rest } = options;
        const lib = await createTempLibrary();
        cleanups.push(() => lib.cleanup());
        const data = createTempDataRoot({ state });
        cleanups.push(() => data.cleanup());
        for (let index = 0; index < photos; index++) fs.writeFileSync(lib.file(`photo-${index + 1}.jpg`), images[index]);
        const { lines, logger } = captureLogger();
        return { lib, data, lines, run: () => runIdentityOnce({ logger, pid: 7, hostname: 'once-host', ...rest, pass: { clock: settled, ...rest.pass } }) };
    }

    it('returns 0 once every set is built, and says what it did', async () => {
        const o = await once();
        expect(await o.run()).toBe(0);

        expect(profileStates(await readRegistry(o.data.root))).toEqual(['ready', 'ready']);
        expect(o.lines).toContain('[identity] Done: 2 built, 0 kept, 0 failed.');
        expect(JSON.parse(fs.readFileSync(watcherStatusFile(o.data.root), 'utf8'))).toMatchObject({ pid: 7, hostname: 'once-host', lastPassResult: 'committed' });
    });

    it('returns 1 when a build fails, naming it', async () => {
        const o = await once({ worker: { build: async () => ({ status: 'failed', error: 'encoder exploded' }) } });
        expect(await o.run()).toBe(1);
        expect(o.lines.filter((line) => line.includes('encoder exploded'))).toHaveLength(2);
    });

    it('returns 0 when the only failures are sources that moved on', async () => {
        const o = await once({ worker: { build: async () => ({ status: 'failed', error: 'source-superseded' }) } });
        expect(await o.run()).toBe(0);
        expect(o.lines).toContain('[identity] Done: 0 built, 0 kept, 0 failed, 2 superseded.');
    });

    it('returns 1 when the registry stays busy', async () => {
        const o = await once({ pass: { lock: { waitMs: 0 } } });
        expect(await withLock('registry', { root: o.data.root }, () => o.run())).toBe(1);
        expect(o.lines).toContain('[identity] The registry stayed busy, so the identity step did not run. Run it again.');
    });

    it('returns 0 and logs one line while the data root is off', async () => {
        const o = await once({ state: 'missing' });
        expect(await o.run()).toBe(0);
        expect(offLines(o.lines)).toHaveLength(1);
        expect(fs.existsSync(o.data.root)).toBe(false);
    });

    it('waits for a file still being written, and builds its set before it returns', async () => {
        let ahead = 0;
        const o = await once({ photos: 0, pass: { clock: () => Date.now() + ahead }, sleep: async (ms) => { ahead += ms; } });
        fs.writeFileSync(o.lib.file('fresh.jpg'), images[0]);

        expect(await o.run()).toBe(0);
        expect(ahead).toBeGreaterThan(0);
        expect(profileStates(await readRegistry(o.data.root))).toEqual(['ready']);
    });

    it('returns 1 when a file is still changing after its last pass', async () => {
        let passes = 0;
        const o = await once({ photos: 0, pass: { clock: Date.now }, sleep: async () => undefined, maxPasses: 2, legacyIdle: async () => { passes++; } });
        fs.writeFileSync(o.lib.file('fresh.jpg'), images[0]);

        expect(await o.run()).toBe(1);
        expect(passes).toBe(2);
        expect(o.lines).toContain('[identity] Some photos were still changing, so not every set was built. Run it again.');
    });

    it("returns 1 when the worker can't start", async () => {
        const o = await once({ worker: { deviceOf: (dir) => (dir.endsWith('staging') ? 2 : 1) } });
        expect(await o.run()).toBe(1);
        expect(o.lines.some((line) => line.includes('EXDEV'))).toBe(true);
    });

    it("returns 1 when the worker can't start for another reason", async () => {
        const o = await once();
        fs.writeFileSync(o.data.file('assets'), 'a file where the asset store goes');

        expect(await o.run()).toBe(1);
        expect(o.lines.some((line) => line.startsWith('[identity] The worker could not start') && line.includes('EEXIST'))).toBe(true);
        expect(o.lines).toContain('[identity] The worker never started, so no set was built. Run it again.');
    });

    it('passes again at once when a build asks for it, even while a file still settles', async () => {
        let ahead = 0;
        const sleeps: number[] = [];
        let asked = false;
        const o = await once({
            photos: 0,
            pass: { clock: () => Date.now() + ahead },
            sleep: async (ms) => {
                sleeps.push(ms);
                ahead += ms;
            },
            createWorker: (workerOptions) => fakeWorker({
                start: async () => {
                    if (!asked) workerOptions.onPassNeeded?.('digest-mismatch');
                    asked = true;
                    return { started: true, queued: 0 };
                },
            }),
        });
        fs.writeFileSync(o.lib.file('fresh.jpg'), images[0]);

        expect(await o.run()).toBe(0);
        expect(sleeps[0]).toBe(0);
        expect(sleeps.length).toBeGreaterThan(1);
    });
});
