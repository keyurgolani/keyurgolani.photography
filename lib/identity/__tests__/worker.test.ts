// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { newestRegistryFile, newestRegistryVersion, writeRegistryFile } from '../../../test/helpers/registryFiles';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { resolveAsset } from '../../media/manifest';
import { withLock } from '../../storage/lock';
import { buildDerivativeSet, stagingLockName, stagingRoot, type BuildOutcome } from '../derivatives';
import { sha256, type Hasher } from '../ids';
import { runReconcilePass } from '../pass';
import { currentProfileId } from '../profile';
import { readRegistry, writeRegistry } from '../registry';
import type { DerivativeJob, ProfileEntry, Registry } from '../types';
import { createWorker, onceExitCode, pendingJobs, summarizeResults, WorkerStartError, type WorkerOptions, type WorkerResult } from '../worker';
import { sequentialIds } from './reconcileFixtures';

const OLD_PROFILE = `p_${'0'.repeat(16)}`;
const NOW = Date.parse('2026-03-02T09:00:00.000Z');
const isRoot = process.getuid?.() === 0;
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };

let images: Buffer[];
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
    images = await Promise.all([40, 120, 200, 250].map((tint) =>
        sharp({ create: { width: 240, height: 160, channels: 3, background: { r: tint, g: 255 - tint, b: 90 } } }).jpeg().toBuffer()));
});

afterEach(async () => {
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

interface Setup {
    lib: TempLibrary;
    data: TempDataRoot;
    /** Photo IDs in the order the photos were written. */
    ids: string[];
    pass(): Promise<void>;
    registry(): Promise<Registry>;
    /** The current profile's entry for the photo's first revision. */
    entry(registry: Registry, photoId: string, profileId?: string): ProfileEntry | undefined;
    /** Change the registry the way another writer would. */
    edit(change: (registry: Registry) => void): Promise<void>;
    worker(options?: Partial<WorkerOptions>): ReturnType<typeof createWorker>;
}

/** A library of `count` photos, reconciled once, so each has a pending entry for the current profile. */
async function setup(count = 2, { hasher }: { hasher?: Hasher } = {}): Promise<Setup> {
    const lib = await createTempLibrary();
    cleanups.push(() => lib.cleanup());
    const data = createTempDataRoot();
    cleanups.push(() => data.cleanup());
    for (let index = 0; index < count; index++) fs.writeFileSync(lib.file(`photo-${index + 1}.jpg`), images[index]);
    const idGen = sequentialIds();
    // Files written just now count as settled, an hour into the future.
    const pass = async () => {
        const outcome = await runReconcilePass({ clock: () => Date.now() + 3_600_000, idGen, hasher, logger: quiet });
        if (outcome.status !== 'committed') throw new Error(`the pass didn't commit: ${JSON.stringify(outcome)}`);
    };
    await pass();
    const registry = () => readRegistry(data.root);
    const first = await registry();
    const ids = Object.values(first.photos).sort((a, b) => a.source.path.localeCompare(b.source.path)).map((photo) => photo.photoId);
    const entry = (current: Registry, photoId: string, profileId = currentProfileId()) => Object.values(current.photos[photoId].revisions)[0].profiles[profileId];
    const edit = async (change: (registry: Registry) => void) => {
        const current = await registry();
        change(current);
        await writeRegistry(data.root, current, current.version);
    };
    const worker = (options: Partial<WorkerOptions> = {}) => {
        const created = createWorker({ clock: () => NOW, logger: quiet, ...options });
        cleanups.push(async () => {
            created.stop();
            await created.idle();
        });
        return created;
    };
    return { lib, data, ids, pass, registry, entry, edit, worker };
}

const states = (s: Setup, registry: Registry) => s.ids.map((photoId) => s.entry(registry, photoId)?.state ?? 'none');
const statuses = (results: readonly WorkerResult[]) => results.map((result) => result.outcome.status);

describe('the derivative worker', () => {
    it('builds every pending entry at start, one at a time, and queues each once', async () => {
        const s = await setup(3);
        let running = 0;
        let most = 0;
        const worker = s.worker({
            build: async (job, options) => {
                running++;
                most = Math.max(most, running);
                try {
                    return await buildDerivativeSet(job, options);
                } finally {
                    running--;
                }
            },
        });
        expect(await worker.start()).toEqual({ started: true, queued: 3 });
        // Already queued or building: a second look adds nothing.
        expect(await worker.enqueuePending()).toBe(0);
        await worker.idle();
        expect(most).toBe(1);
        const registry = await s.registry();
        expect(states(s, registry)).toEqual(['ready', 'ready', 'ready']);
        expect(s.entry(registry, s.ids[0])).toEqual({ state: 'ready', attempts: 1, readyAt: new Date(NOW).toISOString() });
        for (const photo of Object.values(registry.photos)) {
            const ref = { photoId: photo.photoId, assetRevision: photo.source.observedRevision, profileId: currentProfileId() };
            expect((await resolveAsset(ref)).state).toBe('ready');
        }
        expect(statuses(worker.results)).toEqual(['ready', 'ready', 'ready']);
    }, 60_000);

    it('moves pending and failed entries for an older profile to the current one, and leaves ready ones', async () => {
        const s = await setup(4);
        const [pending, failed, ready, both] = s.ids;
        const oldReady: ProfileEntry = { state: 'ready', attempts: 1, readyAt: '2025-01-01T00:00:00.000Z' };
        const currentReady: ProfileEntry = { state: 'ready', attempts: 1, readyAt: '2026-01-01T00:00:00.000Z' };
        await s.edit((registry) => {
            const set = (photoId: string, profiles: Record<string, ProfileEntry>) => {
                Object.values(registry.photos[photoId].revisions)[0].profiles = profiles;
            };
            set(pending, { [OLD_PROFILE]: { state: 'pending', attempts: 0 } });
            set(failed, { [OLD_PROFILE]: { state: 'failed', attempts: 2, error: 'an older encoder failed' } });
            set(ready, { [OLD_PROFILE]: oldReady });
            set(both, { [OLD_PROFILE]: { state: 'pending', attempts: 0 }, [currentProfileId()]: currentReady });
        });
        const worker = s.worker();
        expect(await worker.start()).toEqual({ started: true, queued: 2 });
        await worker.idle();
        const registry = await s.registry();
        const profilesOf = (photoId: string) => Object.values(registry.photos[photoId].revisions)[0].profiles;
        expect(profilesOf(pending)).toEqual({ [currentProfileId()]: { state: 'ready', attempts: 1, readyAt: new Date(NOW).toISOString() } });
        // A move keeps the attempt count, and the start-up retry adds one.
        expect(profilesOf(failed)).toEqual({ [currentProfileId()]: { state: 'ready', attempts: 3, readyAt: new Date(NOW).toISOString() } });
        // A set ready under an older profile still serves. Only `reprofile` queues the current one for it.
        expect(profilesOf(ready)).toEqual({ [OLD_PROFILE]: oldReady });
        // The current profile's own entry wins over a moved one.
        expect(profilesOf(both)).toEqual({ [currentProfileId()]: currentReady });
    }, 60_000);

    it('retries a failed entry once at start, but not source-superseded or undecodable', async () => {
        const s = await setup(3);
        const [full, superseded, undecodable] = s.ids;
        await s.edit((registry) => {
            const fail = (photoId: string, error: string) => {
                Object.values(registry.photos[photoId].revisions)[0].profiles[currentProfileId()] = { state: 'failed', attempts: 1, error };
            };
            fail(full, 'the disk was full');
            fail(superseded, 'source-superseded');
            fail(undecodable, 'undecodable');
        });
        const worker = s.worker();
        expect(await worker.start()).toEqual({ started: true, queued: 1 });
        await worker.idle();
        const registry = await s.registry();
        expect(s.entry(registry, full)).toEqual({ state: 'ready', attempts: 2, readyAt: new Date(NOW).toISOString() });
        expect(s.entry(registry, superseded)).toEqual({ state: 'failed', attempts: 1, error: 'source-superseded' });
        expect(s.entry(registry, undecodable)).toEqual({ state: 'failed', attempts: 1, error: 'undecodable' });
    }, 60_000);

    it('retries only at start: an entry that fails again stays failed through later passes', async () => {
        const s = await setup(1);
        await s.edit((registry) => {
            Object.values(registry.photos[s.ids[0]].revisions)[0].profiles[currentProfileId()] = { state: 'failed', attempts: 1, error: 'the disk was full' };
        });
        const worker = s.worker({ faults: { beforeManifest: () => { throw new Error('still full'); } } });
        await worker.start();
        await worker.idle();
        await s.pass();
        expect(await worker.enqueuePending()).toBe(0);
        await worker.idle();
        expect(statuses(worker.results)).toEqual(['failed']);
        expect(s.entry(await s.registry(), s.ids[0])).toEqual({ state: 'failed', attempts: 2, error: 'still full' });
    }, 60_000);

    it('queues what a later pass leaves pending', async () => {
        const s = await setup(1);
        const worker = s.worker();
        await worker.start();
        await worker.idle();
        fs.writeFileSync(s.lib.file('photo-new.jpg'), images[3]);
        await s.pass();
        expect(await worker.enqueuePending()).toBe(1);
        await worker.idle();
        const registry = await s.registry();
        expect(Object.values(registry.photos).map((photo) => Object.values(photo.revisions)[0].profiles[currentProfileId()].state)).toEqual(['ready', 'ready']);
        expect(statuses(worker.results)).toEqual(['ready', 'ready']);
    }, 60_000);

    it('says which jobs are queued or building, and forgets each once it is built', async () => {
        const s = await setup(2);
        const held = deferred();
        const worker = s.worker({
            build: async (job, options) => {
                await held.promise;
                return buildDerivativeSet(job, options);
            },
        });
        const jobs = pendingJobs(await s.registry(), currentProfileId());
        expect(jobs.map((job) => worker.isQueued(job))).toEqual([false, false]);

        await worker.start();
        // One is building and the other waits behind it.
        expect(jobs.map((job) => worker.isQueued(job))).toEqual([true, true]);
        held.resolve();
        await worker.idle();
        expect(jobs.map((job) => worker.isQueued(job))).toEqual([false, false]);
    }, 60_000);

    it('builds nothing for a revision that moved to another photo, and leaves its entries alone', async () => {
        const s = await setup(2);
        const failed: ProfileEntry = { state: 'failed', attempts: 1, error: 'the disk was full' };
        await s.edit((registry) => {
            for (const photoId of s.ids) Object.values(registry.photos[photoId].revisions)[0].reassignedTo = 'ph_00000000-0000-4000-8000-000000000099';
            Object.values(registry.photos[s.ids[1]].revisions)[0].profiles = { [OLD_PROFILE]: failed };
        });
        const before = await s.registry();
        const worker = s.worker();
        expect(await worker.start()).toEqual({ started: true, queued: 0 });
        await worker.idle();
        expect(worker.results).toEqual([]);
        // Neither the profile move nor the start-up retry touches them.
        expect(await s.registry()).toEqual(before);
    });

    it('builds nothing for an archived photo', async () => {
        const s = await setup(2);
        await s.edit((registry) => {
            registry.photos[s.ids[0]].sourceHealth = 'archived';
        });
        const worker = s.worker();
        expect(await worker.start()).toEqual({ started: true, queued: 1 });
        await worker.idle();
        expect(states(s, await s.registry())).toEqual(['pending', 'ready']);
    }, 60_000);

    it('builds nothing for a photo whose source is missing, and builds it once the file is back', async () => {
        const s = await setup(2);
        const saved = fs.readFileSync(s.lib.file('photo-1.jpg'));
        fs.rmSync(s.lib.file('photo-1.jpg'));
        await s.pass();
        expect((await s.registry()).photos[s.ids[0]].sourceHealth).toBe('missing');
        const worker = s.worker();
        expect(await worker.start()).toEqual({ started: true, queued: 1 });
        await worker.idle();
        expect(states(s, await s.registry())).toEqual(['pending', 'ready']);

        fs.writeFileSync(s.lib.file('photo-1.jpg'), saved);
        await s.pass();
        expect(await worker.enqueuePending()).toBe(1);
        await worker.idle();
        expect(states(s, await s.registry())).toEqual(['ready', 'ready']);
    }, 60_000);

    it("builds nothing at a held path, whose bytes are in dispute, and still builds the hold's other candidate", async () => {
        const s = await setup(2);
        // photo-1.jpg now holds photo-2's bytes: a hold with both photos as candidates.
        fs.writeFileSync(s.lib.file('photo-1.jpg'), images[1]);
        await s.pass();
        expect((await s.registry()).holds).toEqual([expect.objectContaining({ path: 'photo-1.jpg', candidates: [...s.ids].sort() })]);
        const passes: string[] = [];
        const worker = s.worker({ onPassNeeded: (reason) => { passes.push(reason); } });
        expect(await worker.start()).toEqual({ started: true, queued: 1 });
        await worker.idle();
        expect(states(s, await s.registry())).toEqual(['pending', 'ready']);
        expect(passes).toEqual([]);
    }, 60_000);

    it('as a second instance after a crash between publishing and recording, marks the set ready without encoding', async () => {
        const s = await setup(1);
        const crashing = s.worker({ faults: { beforeRecord: () => { throw new Error('the process died'); } } });
        await crashing.start();
        await crashing.idle();
        expect(crashing.results).toEqual([{ job: expect.objectContaining({ photoId: s.ids[0] }), outcome: { status: 'failed', error: 'the process died' } }]);
        expect(onceExitCode(crashing.results)).toBe(1);
        expect(states(s, await s.registry())).toEqual(['pending']);

        const encoded: string[] = [];
        const restarted = s.worker({ faults: { afterVariant: (name) => { encoded.push(name); } } });
        expect(await restarted.start()).toEqual({ started: true, queued: 1 });
        await restarted.idle();
        expect(encoded).toEqual([]);
        expect(restarted.results.map((result) => result.outcome)).toEqual([{ status: 'ready', reused: true }]);
        expect(states(s, await s.registry())).toEqual(['ready']);
    }, 60_000);

    it('asks for a pass when a source changed since the last one, then builds what the pass found', async () => {
        const s = await setup(1);
        const [photoId] = s.ids;
        const replaced = (await s.registry()).photos[photoId].source.observedRevision;
        fs.writeFileSync(s.lib.file('photo-1.jpg'), images[2]);
        const passes: string[] = [];
        const worker = s.worker({ onPassNeeded: (reason) => { passes.push(reason); } });
        await worker.start();
        await worker.idle();
        expect(passes).toEqual(['digest-mismatch']);
        expect(states(s, await s.registry())).toEqual(['pending']);

        // The pass records the new bytes as a new revision. The old one is still pending, and is
        // queued again now that its first build is done: the writer fails it as superseded.
        await s.pass();
        expect(await worker.enqueuePending()).toBe(2);
        await worker.idle();
        const registry = await s.registry();
        const current = registry.photos[photoId].source.observedRevision;
        expect(registry.photos[photoId].revisions[replaced].profiles[currentProfileId()]).toEqual({ state: 'failed', attempts: 1, error: 'source-superseded' });
        expect(registry.photos[photoId].revisions[current].profiles[currentProfileId()]).toMatchObject({ state: 'ready' });
        expect(worker.results.map((result) => result.outcome)).toEqual([
            { status: 'pending', reason: 'digest-mismatch' },
            { status: 'failed', error: 'source-superseded' },
            { status: 'ready', reused: false },
        ]);
        expect(onceExitCode(worker.results)).toBe(0);
    }, 60_000);

    it('keeps building when asking for a pass throws', async () => {
        const s = await setup(2);
        fs.writeFileSync(s.lib.file('photo-1.jpg'), images[2]);
        const errors: string[] = [];
        const worker = s.worker({
            logger: { ...quiet, error: (line: string) => { errors.push(line); } },
            onPassNeeded: () => { throw new Error('the scheduler is gone'); },
        });
        await worker.start();
        await worker.idle();
        expect(statuses(worker.results)).toEqual(['pending', 'ready']);
        expect(errors).toEqual([expect.stringContaining('the scheduler is gone')]);
    }, 60_000);

    it('passes its root, library, hasher, and ID generator to every build', async () => {
        const salted: Hasher = (chunks) => sha256([Buffer.from('salt:'), ...chunks]);
        const s = await setup(1, { hasher: salted });
        // The environment now points somewhere else: the worker must use what it was given.
        const otherData = createTempDataRoot({ state: 'uninitialized' });
        cleanups.push(() => otherData.cleanup());
        const otherLib = await createTempLibrary();
        cleanups.push(() => otherLib.cleanup());
        const staged: string[] = [];
        const worker = s.worker({
            root: s.data.root,
            library: s.lib.root,
            hasher: salted,
            idGen: () => 'staging-from-the-test',
            faults: { beforePublish: () => { staged.push(...fs.readdirSync(stagingRoot(s.data.root))); } },
        });
        expect(await worker.start()).toEqual({ started: true, queued: 1 });
        await worker.idle();
        expect(worker.results.map((result) => result.outcome)).toEqual([{ status: 'ready', reused: false }]);
        expect(staged).toEqual(['staging-from-the-test']);
        const registry = await s.registry();
        const ref = { photoId: s.ids[0], assetRevision: registry.photos[s.ids[0]].source.observedRevision, profileId: currentProfileId() };
        expect((await resolveAsset(ref, { root: s.data.root })).state).toBe('ready');
        expect(fs.readdirSync(otherData.root)).toEqual([]);
    }, 60_000);

    it('removes the staging folders killed builds left when it starts, and keeps any a live build may still hold', async () => {
        const s = await setup(1);
        const staging = stagingRoot(s.data.root);
        const leave = (name: string) => {
            fs.mkdirSync(path.join(staging, name), { recursive: true });
            fs.writeFileSync(path.join(staging, name, 'w400.webp'), 'half a set');
        };
        // The lock record a killed build leaves, last renewed at `heartbeat`.
        const lease = (name: string, heartbeat: number) => {
            const at = new Date(heartbeat).toISOString();
            fs.mkdirSync(s.data.file('locks'), { recursive: true });
            fs.writeFileSync(s.data.file('locks', `${stagingLockName(name)}.lock`),
                JSON.stringify({ owner: `killed ${name}`, hostname: 'elsewhere', pid: 1, acquiredAt: at, heartbeatAt: at, leaseMs: 60_000 }));
        };
        const buildLocks = () => fs.readdirSync(s.data.file('locks')).filter((name) => name.startsWith(stagingLockName(''))).sort();
        leave('killed-long-ago');
        lease('killed-long-ago', Date.now() - 10 * 60_000);
        leave('never-locked');
        // Killed a moment ago, or still building on another host: its lease still runs.
        leave('killed-just-now');
        lease('killed-just-now', Date.now());
        // Not what a build stages: a folder no build would name, and a file.
        leave('Not-A-Build');
        fs.writeFileSync(path.join(staging, 'notes'), 'kept');

        const logs: string[] = [];
        const warnings: string[] = [];
        await withLock(stagingLockName('building-now'), { root: s.data.root }, async () => {
            leave('building-now');
            const worker = s.worker({ logger: { ...quiet, log: (line: string) => { logs.push(line); }, warn: (line: string) => { warnings.push(line); } } });
            const started = Date.now();
            expect(await worker.start()).toEqual({ started: true, queued: 1 });
            // A held lock is tried once, not waited on.
            expect(Date.now() - started).toBeLessThan(5_000);
            await worker.idle();
            expect(statuses(worker.results)).toEqual(['ready']);
            expect(fs.readdirSync(staging).sort()).toEqual(['Not-A-Build', 'building-now', 'killed-just-now', 'notes']);
        });
        expect(logs.filter((line) => line.includes('staging/'))).toEqual([
            '[derivatives] Removed staging/killed-long-ago, which a build stopped before publishing left.',
            '[derivatives] Removed staging/never-locked, which a build stopped before publishing left.',
        ]);
        expect(warnings).toEqual([]);
        // The removed folders' locks went with them.
        expect(buildLocks()).toEqual([`${stagingLockName('killed-just-now')}.lock`]);

        // Once its lease runs out, and with the live build's lock let go, the next start removes both.
        lease('killed-just-now', Date.now() - 10 * 60_000);
        const next = s.worker();
        await next.start();
        await next.idle();
        expect(fs.readdirSync(staging).sort()).toEqual(['Not-A-Build', 'notes']);
        expect(buildLocks()).toEqual([]);
    }, 60_000);

    it('refuses to start, changing nothing, when staging and the asset store are on different devices', async () => {
        const s = await setup(1);
        await s.edit((registry) => {
            Object.values(registry.photos[s.ids[0]].revisions)[0].profiles[currentProfileId()] = { state: 'failed', attempts: 1, error: 'the disk was full' };
        });
        const before = fs.readFileSync(newestRegistryFile(s.data.root));
        const worker = s.worker({ deviceOf: (dir) => (dir.endsWith('staging') ? 2 : 1) });
        const error = await worker.start().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(WorkerStartError);
        expect(error).toMatchObject({ code: 'EXDEV', message: expect.stringContaining('different devices') });
        expect(fs.readFileSync(newestRegistryFile(s.data.root)).equals(before)).toBe(true);
        expect(await worker.enqueuePending()).toBe(0);
    });

    describe('against a data root that is not ready', () => {
        /** Every file and folder under `root`, so a test sees anything created, even an empty `assets/`. */
        const tree = (root: string) => (fs.existsSync(root) ? fs.readdirSync(root, { recursive: true, encoding: 'utf8' }).sort() : []);

        async function expectNothingDone(worker: ReturnType<typeof createWorker>, root: string, state: string): Promise<void> {
            const before = tree(root);
            expect(await worker.start()).toMatchObject({ started: false, reason: 'data-root', state });
            expect(await worker.enqueuePending()).toBe(0);
            await worker.idle();
            expect(worker.results).toEqual([]);
            expect(tree(root)).toEqual(before);
            expect(before).not.toContain('assets');
        }

        it.each(['uninitialized', 'missing'] as const)('does nothing when it is %s', async (state) => {
            const s = await setup(1);
            const other = createTempDataRoot({ state });
            cleanups.push(() => other.cleanup());
            await expectNothingDone(s.worker(), other.root, state === 'missing' ? 'unavailable' : 'uninitialized');
            expect(fs.existsSync(other.root)).toBe(state !== 'missing');
        });

        it('does nothing when PHOTOGRAPHY_DATA_DIR is unset in production', async () => {
            const s = await setup(1);
            vi.stubEnv('PHOTOGRAPHY_DATA_DIR', '');
            vi.stubEnv('NODE_ENV', 'production');
            await expectNothingDone(s.worker(), s.data.root, 'unset');
            expect(states(s, await s.registry())).toEqual(['pending']);
        });

        it.skipIf(isRoot)('does nothing when it is unwritable', async () => {
            const s = await setup(1);
            fs.chmodSync(s.data.root, 0o555);
            await expectNothingDone(s.worker(), s.data.root, 'unwritable');
        });

        it('does nothing, and creates nothing, when the registry comes from a newer build', async () => {
            const s = await setup(1);
            writeRegistryFile(s.data.root, 9, JSON.stringify({ schemaVersion: 2, version: 9 }));
            const before = fs.readFileSync(newestRegistryFile(s.data.root));
            await expectNothingDone(s.worker(), s.data.root, 'unavailable');
            expect(fs.readFileSync(newestRegistryFile(s.data.root)).equals(before)).toBe(true);
        });
    });

    it('reports a busy registry lock at start, and starts on a later try', async () => {
        const s = await setup(1);
        const entered = deferred();
        const release = deferred();
        const holder = withLock('registry', { root: s.data.root }, async () => {
            entered.resolve();
            await release.promise;
        });
        await entered.promise;
        const worker = s.worker({ lock: { waitMs: 0 } });
        expect(await worker.start()).toMatchObject({ started: false, reason: 'locked', holder: { pid: process.pid } });
        expect(await worker.enqueuePending()).toBe(0);
        release.resolve();
        await holder;
        expect(await worker.start()).toEqual({ started: true, queued: 1 });
        await worker.idle();
        expect(states(s, await s.registry())).toEqual(['ready']);
        expect(await worker.start()).toEqual({ started: true, queued: 0 });
    }, 60_000);

    it('changes nothing when stopped while it waits for the registry lock', async () => {
        const s = await setup(1);
        await s.edit((registry) => {
            Object.values(registry.photos[s.ids[0]].revisions)[0].profiles[currentProfileId()] = { state: 'failed', attempts: 1, error: 'the disk was full' };
        });
        const before = fs.readFileSync(newestRegistryFile(s.data.root));
        const entered = deferred();
        const release = deferred();
        const holder = withLock('registry', { root: s.data.root }, async () => {
            entered.resolve();
            await release.promise;
        });
        await entered.promise;
        const worker = s.worker();
        const starting = worker.start();
        worker.stop();
        release.resolve();
        await holder;
        expect(await starting).toEqual({ started: false, reason: 'stopped' });
        expect(fs.readFileSync(newestRegistryFile(s.data.root)).equals(before)).toBe(true);
        expect(worker.results).toEqual([]);
    });

    it('finishes the build in progress when stopped, then takes no more', async () => {
        const s = await setup(3);
        const worker: ReturnType<typeof createWorker> = s.worker({
            build: (job, options) => {
                worker.stop();
                return buildDerivativeSet(job, options);
            },
        });
        await worker.start();
        await worker.idle();
        expect(statuses(worker.results)).toEqual(['ready']);
        expect(states(s, await s.registry())).toEqual(['ready', 'pending', 'pending']);
        expect(await worker.enqueuePending()).toBe(0);
        expect(await worker.start()).toEqual({ started: false, reason: 'stopped' });
    }, 60_000);

    it('queues nothing a later pass finds once stopped', async () => {
        const s = await setup(1);
        const worker = s.worker();
        await worker.start();
        await worker.idle();
        worker.stop();
        fs.writeFileSync(s.lib.file('photo-new.jpg'), images[3]);
        await s.pass();
        expect(await worker.enqueuePending()).toBe(0);
        await worker.idle();
        expect(statuses(worker.results)).toEqual(['ready']);
    }, 60_000);

    it('never starts once stopped, and never waits for the lock to say so', async () => {
        const s = await setup(1);
        const worker = s.worker({ lock: { waitMs: 0 } });
        worker.stop();
        const release = deferred();
        const entered = deferred();
        const holder = withLock('registry', { root: s.data.root }, async () => {
            entered.resolve();
            await release.promise;
        });
        await entered.promise;
        expect(await worker.start()).toEqual({ started: false, reason: 'stopped' });
        release.resolve();
        await holder;
        await worker.idle();
        expect(worker.results).toEqual([]);
        expect(states(s, await s.registry())).toEqual(['pending']);
    });

    it('queues nothing when stopped while it writes the start-up changes', async () => {
        const s = await setup(1);
        await s.edit((registry) => {
            Object.values(registry.photos[s.ids[0]].revisions)[0].profiles[currentProfileId()] = { state: 'failed', attempts: 1, error: 'the disk was full' };
        });
        // The clock stamps the registry write, so stopping there lands between the write and the queueing.
        const worker: ReturnType<typeof createWorker> = s.worker({
            clock: () => {
                worker.stop();
                return NOW;
            },
        });
        expect(await worker.start()).toEqual({ started: false, reason: 'stopped' });
        await worker.idle();
        expect(worker.results).toEqual([]);
        expect(states(s, await s.registry())).toEqual(['pending']);
    });

    it('shares one start between calls made while it is under way', async () => {
        const s = await setup(2);
        const worker = s.worker();
        const [first, second] = await Promise.all([worker.start(), worker.start()]);
        expect(first).toEqual({ started: true, queued: 2 });
        expect(second).toEqual(first);
        await worker.idle();
        expect(statuses(worker.results)).toEqual(['ready', 'ready']);
    }, 60_000);

    it("logs and queues nothing when the registry can't be read after start", async () => {
        const s = await setup(1);
        const warnings: string[] = [];
        const worker = s.worker({ logger: { ...quiet, warn: (line: string) => { warnings.push(line); } } });
        await worker.start();
        await worker.idle();
        writeRegistryFile(s.data.root, newestRegistryVersion(s.data.root) + 1, '{ not json');
        expect(await worker.enqueuePending()).toBe(0);
        expect(warnings).toEqual([expect.stringContaining('Could not read the registry')]);
    }, 60_000);

    it('hands its results over once with takeResults()', async () => {
        const s = await setup(1);
        const worker = s.worker();
        await worker.start();
        await worker.idle();
        expect(statuses(worker.takeResults())).toEqual(['ready']);
        expect(worker.results).toEqual([]);
        expect(worker.takeResults()).toEqual([]);
    }, 60_000);
});

describe('summarizeResults and onceExitCode', () => {
    const result = (outcome: BuildOutcome): WorkerResult => ({ job: { photoId: 'p', assetRevision: 'r', profileId: 'f', path: 'x.jpg' } as DerivativeJob, outcome });
    const results = [
        result({ status: 'ready', reused: false }),
        result({ status: 'ready', reused: true }),
        result({ status: 'pending', reason: 'digest-mismatch' }),
        result({ status: 'skipped', reason: 'not-pending' }),
        result({ status: 'failed', error: 'source-superseded' }),
    ];

    it('counts each outcome, and lists failures other than source-superseded', () => {
        const failure = result({ status: 'failed', error: 'the disk was full' });
        expect(summarizeResults([...results, failure])).toEqual({ built: 1, kept: 1, pending: 1, skipped: 1, superseded: 1, failed: [failure] });
    });

    it('is 1 only when a build failed for a reason other than source-superseded', () => {
        expect(onceExitCode([])).toBe(0);
        expect(onceExitCode(results)).toBe(0);
        expect(onceExitCode([...results, result({ status: 'failed', error: 'integrity: w400.webp changed' })])).toBe(1);
    });
});
