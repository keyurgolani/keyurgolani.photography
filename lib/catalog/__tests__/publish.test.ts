// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withLock, type LockContext, type LockRecord } from '../../storage/lock';
import { activateRevision, blockingIssues, publish, PUBLISH_EXIT_CODES, rebaseWorkingLayer, recover, type ActivateOptions, type PublishOptions, type PublishResult } from '../publish';
import { references } from '../references';
import { mediaFilePath } from '../../media/path';
import { CATALOG_LOCK, listActivations, readRevisionFile, revisionFilePath } from '../repository';
import { registerRule } from '../rules';
import { createTestCatalog, type TestCatalog, type TestCatalogOptions } from '../testing';
import type { AuthoredPhoto, Issue } from '../types';
import { AUTHORED_LOCK, writeAuthoredRecord } from '../working-layer-writer';
import { catalogPaths, readActivePointer, readWorkingLayer } from '../working-layer';
import { VARIANT_BYTES } from './catalogFixtures';

const cleanups: (() => Promise<void>)[] = [];

/** The revision ID test.editorial reports an editorial error on while it's set, so a stored revision can carry one. */
let editorialErrorOn: string | null = null;
registerRule({
    id: 'test.editorial',
    version: 1,
    severity: 'error',
    gate: 'publish',
    rollbackClass: 'editorial',
    check: (ctx) => (editorialErrorOn !== null && ctx.active?.revisionId === editorialErrorOn && ctx.authored === null
        ? [{ record: { kind: 'site', id: 'site' }, field: 'featuredSeriesIds', message: 'A test editorial error.' }]
        : []),
});

afterEach(async () => {
    editorialErrorOn = null;
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A promise plus the function that resolves it. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

interface Setup {
    catalog: TestCatalog;
    root: string;
    /** Every JSON line publish logged, parsed. */
    events: { event: string; [key: string]: unknown }[];
    run(options?: Partial<PublishOptions>): Promise<PublishResult>;
    /** Change one photo record through the authored writer, as a tool would. */
    editPhoto(id: string, change: (photo: AuthoredPhoto) => void): Promise<AuthoredPhoto>;
    /** Every file under catalog/, relative to it. */
    catalogFiles(): string[];
}

async function setup(options: TestCatalogOptions = {}): Promise<Setup> {
    const catalog = await createTestCatalog({ variantBytes: VARIANT_BYTES, ...options });
    cleanups.push(() => catalog.cleanup());
    const root = catalog.root;
    const events: Setup['events'] = [];
    const logger = { log: (line: string) => events.push(JSON.parse(line) as Setup['events'][number]) };
    return {
        catalog,
        root,
        events,
        run: (overrides = {}) => publish({ dataRoot: root, actor: 'test', confirmLaunch: true, logger, ...overrides }),
        async editPhoto(id, change) {
            const record = (await readWorkingLayer(root)).photos.find((photo) => photo.id === id);
            if (!record) throw new Error(`No photo record ${id}`);
            const next = structuredClone(record);
            change(next);
            return writeAuthoredRecord(next, { expectedVersion: record.version, root });
        },
        catalogFiles() {
            const dir = catalogPaths(root).dir;
            if (!fs.existsSync(dir)) return [];
            return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
                .filter((entry) => entry.isFile())
                .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
                .sort();
        },
    };
}

const lastPublishFile = (root: string) => path.join(catalogPaths(root).diagnosticsDir, 'last-publish.json');

/** Publish the fixture as revision 1, then forget its log lines. */
async function launched(options: TestCatalogOptions = {}): Promise<Setup & { first: PublishResult }> {
    const context = await setup(options);
    const first = await context.run();
    if (first.outcome !== 'PUBLISHED') throw new Error(`The first publish ended ${first.outcome}: ${first.message}`);
    context.events.length = 0;
    return { ...context, first };
}

/** The base revisions the working layer's records are on. */
async function bases(root: string): Promise<(string | null | undefined)[]> {
    const layer = await readWorkingLayer(root);
    return [...new Set([layer.site, ...layer.series, ...layer.photos].map((record) => record?.baseRevisionId))];
}

/** Read active.json and the revision it names, as a web request would, until stopped. */
function readLoop(root: string) {
    let running = true;
    const seen = new Set<string | null>();
    const errors: string[] = [];
    const done = (async () => {
        while (running) {
            try {
                const pointer = await readActivePointer(root);
                if (pointer === null) {
                    seen.add(null);
                } else {
                    const revision = await readRevisionFile(root, pointer.revisionId);
                    if (revision === null) errors.push(`active.json names ${pointer.revisionId}, which has no revision file`);
                    else seen.add(revision.revisionId);
                }
            } catch (error) {
                errors.push(String(error));
            }
            await new Promise((resolve) => setImmediate(resolve));
        }
    })();
    return {
        seen,
        errors,
        async stop() {
            running = false;
            await done;
        },
    };
}

describe('the first publish', { timeout: 30_000 }, () => {
    it('stops for confirmation, writing nothing but the candidate, its diagnostics, and last-publish.json', async () => {
        const { root, run, catalogFiles } = await setup({ seed: 61 });
        const result = await run({ confirmLaunch: false });
        expect(result).toMatchObject({ outcome: 'LAUNCH_CONFIRMATION_REQUIRED', revisionId: null, launch: { published: 6, gone: 0 } });
        expect(PUBLISH_EXIT_CODES[result.outcome]).toBe(3);
        expect(catalogFiles()).toEqual([`candidates/${result.candidateId}.json`, 'diagnostics/last-publish.json', `diagnostics/${result.candidateId}.json`]);
        await expect(readActivePointer(root)).resolves.toBeNull();
    });

    it('passes a dry run that reports what the launch takes away, and writes no more', async () => {
        const { run, catalogFiles } = await setup({ seed: 62, photos: 6, series: [{ photos: 4 }] });
        const result = await run({ dryRun: true, confirmLaunch: false });
        expect(result).toMatchObject({ outcome: 'DRY_RUN_OK', launch: { published: 4, gone: 2 } });
        expect(PUBLISH_EXIT_CODES[result.outcome]).toBe(0);
        expect(catalogFiles()).toEqual([`candidates/${result.candidateId}.json`, 'diagnostics/last-publish.json', `diagnostics/${result.candidateId}.json`]);
    });

    it('publishes revision 1 once confirmed, and rebases the working layer onto it', async () => {
        const { catalog, root, run, events } = await setup({ seed: 63 });
        const result = await run({ reason: 'launch' });
        expect(result).toMatchObject({ outcome: 'PUBLISHED', candidateId: catalog.revisionId, revisionId: catalog.revisionId, revisionNumber: 1, rebased: true, issues: [], errors: 0 });
        expect(await readActivePointer(root)).toEqual({ schemaVersion: 1, revisionId: catalog.revisionId, activationId: result.activationId });
        expect((await readRevisionFile(root, catalog.revisionId))?.content).toEqual(catalog.content);
        const [activation] = await listActivations(root);
        expect(activation).toMatchObject({
            activationId: result.activationId,
            sequence: 1,
            kind: 'publish',
            status: 'committed',
            revisionId: catalog.revisionId,
            revisionNumber: 1,
            previousRevisionId: null,
            previousActivationId: null,
            actor: 'test',
            reason: 'launch',
            validation: { errors: 0, warnings: 0 },
            acceptedRules: [],
            lockTakeover: null,
        });
        expect(await bases(root)).toEqual([catalog.revisionId]);
        expect(events.map((entry) => entry.event)).toEqual(['catalog.publish.started', 'catalog.publish.validated', 'catalog.publish.activated']);
        const summary = JSON.parse(fs.readFileSync(path.join(catalogPaths(root).diagnosticsDir, 'last-publish.json'), 'utf8')) as Record<string, unknown>;
        expect(summary).toMatchObject({ outcome: 'PUBLISHED', actor: 'test', revisionId: catalog.revisionId, revisionNumber: 1 });
    });

    it('writes the revision and the candidate where references() finds them, so cleanup keeps their assets', async () => {
        const { catalog, root, run } = await setup({ seed: 60, photos: 2, series: 1 });
        await run();
        const found = await references(root);
        const of = (source: string) => found.filter((reference) => reference.source === source).map(({ holder, photoId, assetRevision, profileId }) => ({ holder, photoId, assetRevision, profileId }));
        const assets = catalog.content.photos.map(({ id, assetRevision, profileId }) => ({ holder: catalog.revisionId, photoId: id, assetRevision, profileId }));
        expect(of('active-revision')).toEqual(assets);
        expect(of('candidate')).toEqual(assets);
    });

    it('stops with LAUNCH_RULES_MISSING, naming the rules that aren\'t registered', async () => {
        const { run } = await setup({ seed: 64 });
        const result = await run({ launchRuleIds: ['order.cover', 'order.not-written-yet'] });
        expect(result).toMatchObject({ outcome: 'LAUNCH_RULES_MISSING', missingRules: ['order.not-written-yet'] });
        expect(result.message).toContain('order.not-written-yet');
    });
});

describe('later publishes', { timeout: 30_000 }, () => {
    it('return NO_CHANGES for the active candidate and write no activation', async () => {
        const { root, run, events, first } = await launched({ seed: 65 });
        const again = await run();
        expect(again).toMatchObject({ outcome: 'NO_CHANGES', candidateId: first.revisionId, revisionId: first.revisionId, revisionNumber: 1 });
        expect(PUBLISH_EXIT_CODES[again.outcome]).toBe(0);
        expect(await listActivations(root)).toHaveLength(1);
        expect(events.map((entry) => entry.event)).toEqual(['catalog.publish.started']);
    });

    it('publish an edit as the next revision, pointing back at the one before', async () => {
        const { catalog, root, run, editPhoto, first } = await launched({ seed: 66 });
        const before = fs.readFileSync(revisionFilePath(root, catalog.revisionId));
        await editPhoto(catalog.photos[0].id, (photo) => {
            photo.caption = 'A fixture caption added after launch.';
        });
        const second = await run();
        expect(second).toMatchObject({ outcome: 'PUBLISHED', revisionNumber: 2 });
        expect(second.revisionId).not.toBe(first.revisionId);
        const activations = await listActivations(root);
        expect(activations.map(({ revisionNumber, previousRevisionId, previousActivationId }) => ({ revisionNumber, previousRevisionId, previousActivationId }))).toEqual([
            { revisionNumber: 1, previousRevisionId: null, previousActivationId: null },
            { revisionNumber: 2, previousRevisionId: first.revisionId, previousActivationId: first.activationId },
        ]);
        expect(fs.readFileSync(revisionFilePath(root, catalog.revisionId))).toEqual(before);
        expect(await bases(root)).toEqual([second.revisionId]);
    });

    it('stop on a validation error, keeping every issue in the diagnostics and the active revision as it was', async () => {
        const { catalog, root, run, editPhoto, events } = await launched({ seed: 67 });
        const pointer = fs.readFileSync(catalogPaths(root).active);
        const photoId = catalog.photos[1].id;
        await editPhoto(photoId, (photo) => {
            photo.alt = null;
        });
        const result = await run();
        expect(result.outcome).toBe('VALIDATION_FAILED');
        expect(PUBLISH_EXIT_CODES[result.outcome]).toBe(1);
        expect(result.issues).toContainEqual(expect.objectContaining({ severity: 'error', record: { kind: 'photo', id: photoId }, code: expect.stringMatching(/^description\./) }));
        const diagnostics = JSON.parse(fs.readFileSync(path.join(catalogPaths(root).diagnosticsDir, `${result.candidateId}.json`), 'utf8')) as { issues: unknown[]; errors: number };
        expect(diagnostics).toMatchObject({ issues: result.issues, errors: result.errors });
        expect(fs.readFileSync(catalogPaths(root).active)).toEqual(pointer);
        expect(await listActivations(root)).toHaveLength(1);
        expect(fs.existsSync(revisionFilePath(root, result.candidateId ?? ''))).toBe(false);
        expect(events.map((entry) => entry.event)).toEqual(['catalog.publish.started', 'catalog.publish.validated', 'catalog.publish.failed']);
    });

    it('stop with CANDIDATE_CHANGED unless the candidate is the one the caller reviewed', async () => {
        const { catalog, run, editPhoto } = await launched({ seed: 68 });
        await editPhoto(catalog.photos[0].id, (photo) => {
            photo.title = 'A fixture title.';
        });
        const reviewed = await run({ dryRun: true });
        expect(reviewed.outcome).toBe('DRY_RUN_OK');
        await editPhoto(catalog.photos[0].id, (photo) => {
            photo.title = 'Another fixture title.';
        });
        const changed = await run({ expectedRevisionId: reviewed.candidateId ?? '' });
        expect(changed.outcome).toBe('CANDIDATE_CHANGED');
        expect(changed.message).toContain(reviewed.candidateId);
        const published = await run({ expectedRevisionId: changed.candidateId ?? '' });
        expect(published).toMatchObject({ outcome: 'PUBLISHED', revisionId: changed.candidateId });
    });

    it('stop with INTEGRITY_MISMATCH when the candidate\'s revision file is already there and damaged', async () => {
        const { catalog, root, run, editPhoto, first } = await launched({ seed: 69 });
        await editPhoto(catalog.photos[0].id, (photo) => {
            photo.caption = 'A fixture caption.';
        });
        const { candidateId } = await run({ dryRun: true });
        const file = revisionFilePath(root, candidateId ?? '');
        const damaged = JSON.stringify({ ...(await readRevisionFile(root, first.revisionId ?? '')), revisionId: candidateId });
        fs.writeFileSync(file, damaged);
        const result = await run();
        expect(result.outcome).toBe('INTEGRITY_MISMATCH');
        expect(PUBLISH_EXIT_CODES[result.outcome]).toBe(4);
        expect(result.message).not.toContain(root);
        expect(fs.readFileSync(file, 'utf8')).toBe(damaged);
        expect((await readActivePointer(root))?.revisionId).toBe(first.revisionId);
        expect(await listActivations(root)).toHaveLength(1);
    });
});

describe('arguments and the data root', { timeout: 30_000 }, () => {
    it('refuse a blank actor before touching the catalog', async () => {
        const { run, catalogFiles } = await setup({ seed: 70 });
        await expect(run({ actor: '  ' })).rejects.toThrow(TypeError);
        expect(catalogFiles()).toEqual([]);
    });

    it('stop with DATA_ROOT_NOT_READY on a root nobody initialized, writing nothing', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-empty-'));
        cleanups.push(() => fs.promises.rm(dir, { recursive: true, force: true }));
        const events: string[] = [];
        const result = await publish({ dataRoot: dir, actor: 'test', logger: { log: (line) => events.push(line) } });
        expect(result.outcome).toBe('DATA_ROOT_NOT_READY');
        expect(PUBLISH_EXIT_CODES[result.outcome]).toBe(3);
        expect(fs.readdirSync(dir)).toEqual([]);
        expect(events.map((line) => (JSON.parse(line) as { event: string }).event)).toEqual(['catalog.publish.failed']);
    });
});

describe('an interrupted publish', { timeout: 30_000 }, () => {
    it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])('converges after a crash after step %i: one revision ID, one committed activation, no revision file rewritten', async (crashAfter) => {
        const { catalog, root, run, editPhoto, first } = await launched({ seed: 71 });
        const firstFile = fs.readFileSync(revisionFilePath(root, catalog.revisionId));
        const photoId = catalog.photos[0].id;
        await editPhoto(photoId, (photo) => {
            photo.caption = 'A fixture caption written before the crash.';
        });
        const { candidateId } = await run({ dryRun: true });
        if (!candidateId) throw new Error('The dry run compiled nothing.');
        const loop = readLoop(root);

        const crashed = await run({
            hooks: {
                afterStep(step) {
                    if (step === crashAfter) throw new Error(`crash after step ${crashAfter}`);
                },
            },
        });
        expect(crashed.outcome).toBe('STORAGE_ERROR');
        // From step 11 on, the new revision is live.
        if (crashAfter >= 11) expect(crashed.message).toBe(`crash after step ${crashAfter}. ${candidateId}, revision 2, is live.`);
        else expect(crashed.message).toBe(`crash after step ${crashAfter}`);
        const revisionFile = revisionFilePath(root, candidateId);
        const written = fs.existsSync(revisionFile) ? fs.statSync(revisionFile) : null;
        expect(written !== null).toBe(crashAfter >= 9);

        const retry = await run();
        await loop.stop();
        expect(retry).toMatchObject({ outcome: crashAfter >= 11 ? 'NO_CHANGES' : 'PUBLISHED', revisionId: candidateId, revisionNumber: 2 });

        const activations = await listActivations(root);
        expect(activations.filter((activation) => activation.status === 'committed').map((activation) => activation.revisionId)).toEqual([first.revisionId, candidateId]);
        expect(activations.filter((activation) => activation.status === 'pending')).toEqual([]);
        expect(activations.filter((activation) => activation.status === 'abandoned')).toHaveLength(crashAfter === 10 ? 1 : 0);
        expect((await readActivePointer(root))?.revisionId).toBe(candidateId);
        if (written) expect(fs.statSync(revisionFile)).toMatchObject({ ino: written.ino, mtimeMs: written.mtimeMs });
        expect(fs.readFileSync(revisionFilePath(root, catalog.revisionId))).toEqual(firstFile);
        expect(fs.readdirSync(catalogPaths(root).revisionsDir).sort()).toEqual([`${catalog.revisionId}.json`, `${candidateId}.json`].sort());

        expect(await bases(root)).toEqual([candidateId]);
        expect((await readWorkingLayer(root)).photos.find((photo) => photo.id === photoId)?.caption).toBe('A fixture caption written before the crash.');
        expect(loop.errors).toEqual([]);
        expect([...loop.seen].filter((id) => id !== first.revisionId && id !== candidateId)).toEqual([]);
    });
});

describe('the catalog lock', { timeout: 30_000 }, () => {
    it.each([
        ['PUBLISHED', true],
        ['NO_CHANGES', false],
        ['VALIDATION_FAILED', false],
    ] as const)('writes last-publish.json for %s before it releases the lock', async (outcome, edit) => {
        const { catalog, root, run, editPhoto } = await launched({ seed: 90 });
        if (edit) {
            await editPhoto(catalog.photos[0].id, (photo) => {
                photo.caption = 'A caption revision 2 publishes.';
            });
        } else if (outcome === 'VALIDATION_FAILED') {
            await editPhoto(catalog.photos[0].id, (photo) => {
                photo.alt = null;
            });
        }
        fs.rmSync(lastPublishFile(root));
        const atRelease: unknown[] = [];
        const result = await run({
            hooks: {
                lock: {
                    beforeRelease() {
                        atRelease.push(JSON.parse(fs.readFileSync(lastPublishFile(root), 'utf8')));
                    },
                },
            },
        });
        expect(result.outcome).toBe(outcome);
        expect(atRelease).toEqual([expect.objectContaining({ outcome, candidateId: result.candidateId })]);
    });

    it('makes a second publish fail fast with CATALOG_LOCKED, naming the holder', async () => {
        const { root, run } = await setup({ seed: 72 });
        const result = await withLock(CATALOG_LOCK, { root }, () => run());
        expect(result.outcome).toBe('CATALOG_LOCKED');
        // It never held the lock, so it leaves last-publish.json to the holder.
        expect(fs.existsSync(lastPublishFile(root))).toBe(false);
        expect(PUBLISH_EXIT_CODES[result.outcome]).toBe(3);
        expect(result.holder).toMatchObject({ pid: process.pid, hostname: os.hostname() });
        expect(result.message).toContain(`pid ${process.pid} on ${os.hostname()}, since ${result.holder?.acquiredAt}`);
        await expect(readActivePointer(root)).resolves.toBeNull();
    });

    it('takes over an expired lease and records it in the activation and the log', async () => {
        const { root, run, events } = await setup({ seed: 73 });
        const stale: LockRecord = { owner: 'crashed-owner', hostname: 'old-host', pid: 999_999, acquiredAt: '2026-01-01T00:00:00.000Z', heartbeatAt: '2026-01-01T00:00:00.000Z', leaseMs: 60_000 };
        fs.mkdirSync(path.join(root, 'locks'), { recursive: true });
        fs.writeFileSync(path.join(root, 'locks', `${CATALOG_LOCK}.lock`), `${JSON.stringify(stale)}\n`);
        const result = await run();
        expect(result.outcome).toBe('PUBLISHED');
        const takeover = { previousOwner: 'crashed-owner', previousAcquiredAt: stale.acquiredAt };
        expect((await listActivations(root))[0].lockTakeover).toEqual(takeover);
        expect(events).toContainEqual({ event: 'catalog.lock.takeover', lock: CATALOG_LOCK, ...takeover });
    });

    it('gives a holder paused past its lease LOCK_LOST at step 11, and leaves active.json alone', async () => {
        const { catalog, root, run, editPhoto } = await launched({ seed: 74 });
        await editPhoto(catalog.photos[0].id, (photo) => {
            photo.caption = 'A fixture caption.';
        });
        const pointer = fs.readFileSync(catalogPaths(root).active);
        const summary = fs.readFileSync(lastPublishFile(root));
        let pause = false;
        const paused = deferred();
        const resume = deferred();
        const letGo = deferred();
        const stolen: Promise<void>[] = [];

        const result = await run({
            leaseMs: 200,
            hooks: {
                lock: {
                    async beforeRenew() {
                        if (!pause) return;
                        paused.resolve();
                        await resume.promise;
                    },
                },
                async afterStep(step) {
                    if (step !== 10) return;
                    pause = true;
                    await paused.promise;
                    const tookOver = deferred();
                    stolen.push(withLock(CATALOG_LOCK, { root, waitMs: 5_000, pollMs: 20 }, async () => {
                        tookOver.resolve();
                        await letGo.promise;
                    }));
                    await tookOver.promise;
                    // Let the paused renewal go on once step 11 has looked at the lock.
                    setTimeout(() => resume.resolve(), 100);
                },
            },
        });
        letGo.resolve();
        await Promise.all(stolen);

        expect(result.outcome).toBe('LOCK_LOST');
        expect(PUBLISH_EXIT_CODES[result.outcome]).toBe(3);
        expect(fs.readFileSync(catalogPaths(root).active)).toEqual(pointer);
        expect(fs.readFileSync(lastPublishFile(root))).toEqual(summary);
        const pending = (await listActivations(root)).filter((activation) => activation.status === 'pending');
        expect(pending).toHaveLength(1);

        const next = await run();
        expect(next).toMatchObject({ outcome: 'PUBLISHED', revisionNumber: 2, recovery: { abandoned: [pending[0].activationId] } });
        expect((await listActivations(root)).map((activation) => activation.status)).toEqual(['committed', 'abandoned', 'committed']);
    });
});

describe('recovery', { timeout: 30_000 }, () => {
    it.each([
        ['an abandoned activation', (file: string) => fs.writeFileSync(file, JSON.stringify({ ...(JSON.parse(fs.readFileSync(file, 'utf8')) as object), status: 'abandoned' }))],
        ['a missing activation', (file: string) => fs.rmSync(file)],
    ])('repairs an active.json that names %s with a repair activation for its revision', async (_label, damage) => {
        const { catalog, root, run, editPhoto, events } = await launched({ seed: 75 });
        await editPhoto(catalog.photos[0].id, (photo) => {
            photo.caption = 'A fixture caption.';
        });
        const second = await run();
        const named = (await listActivations(root)).find((activation) => activation.activationId === second.activationId);
        if (!named) throw new Error('No second activation.');
        damage(path.join(catalogPaths(root).activationsDir, `000002-${named.activationId}.json`));
        events.length = 0;

        const result = await run();
        expect(result).toMatchObject({ outcome: 'NO_CHANGES', revisionId: second.revisionId, revisionNumber: 2 });
        const repaired = result.recovery?.repaired;
        const repair = (await listActivations(root)).find((activation) => activation.activationId === repaired);
        expect(repair).toMatchObject({ kind: 'publish', status: 'committed', actor: 'recover', revisionId: second.revisionId, revisionNumber: 2, reason: expect.stringMatching(/^repair: active\.json named the/) });
        expect(await readActivePointer(root)).toMatchObject({ revisionId: second.revisionId, activationId: repaired });
        expect(events).toContainEqual(expect.objectContaining({ event: 'catalog.recover.repaired', activationId: repaired, revisionId: second.revisionId, replaced: named.activationId }));
    });

    it('leaves active.json alone when the catalog lock is lost before a repair moves it, and repairs on the next publish', async () => {
        const { catalog, root, run, editPhoto } = await launched({ seed: 82 });
        await editPhoto(catalog.photos[0].id, (photo) => {
            photo.caption = 'A fixture caption.';
        });
        const second = await run();
        fs.rmSync(path.join(catalogPaths(root).activationsDir, `000002-${second.activationId}.json`));
        const pointer = fs.readFileSync(catalogPaths(root).active);

        const lost: LockContext = { name: CATALOG_LOCK, root, signal: new AbortController().signal, takeover: null, isHeld: async () => false };
        await expect(recover({ dataRoot: root, lock: lost, logger: { log: () => undefined } })).rejects.toThrow(/took over the catalog lock, so nothing was activated/);
        expect(fs.readFileSync(catalogPaths(root).active)).toEqual(pointer);
        const stale = (await listActivations(root)).filter((activation) => activation.status === 'pending');
        expect(stale).toHaveLength(1);

        const result = await run();
        expect(result).toMatchObject({ outcome: 'NO_CHANGES', revisionId: second.revisionId, revisionNumber: 2, recovery: { abandoned: [stale[0].activationId] } });
        expect(result.recovery?.repaired).toEqual(expect.stringMatching(/^act_/));
    });
});

describe('the authored lock', { timeout: 30_000 }, () => {
    it('stops a publish with AUTHORED_LOCKED at step 2 while a tool holds the working layer', async () => {
        const { root, run } = await launched({ seed: 76 });
        const result = await withLock(AUTHORED_LOCK, { root }, () => run({ authoredWaitMs: 50 }));
        expect(result.outcome).toBe('AUTHORED_LOCKED');
        expect(PUBLISH_EXIT_CODES[result.outcome]).toBe(3);
        expect(result.holder).toMatchObject({ pid: process.pid });
        expect(result.candidateId).toBeNull();
    });

    it('still publishes when step 13 can\'t get the authored lock, and the next publish rebases', async () => {
        const { catalog, root, run, editPhoto, first } = await launched({ seed: 77 });
        await editPhoto(catalog.photos[0].id, (photo) => {
            photo.caption = 'A fixture caption.';
        });
        const release = deferred();
        const holds: Promise<void>[] = [];
        const result = await run({
            authoredWaitMs: 50,
            hooks: {
                async afterStep(step) {
                    if (step !== 12) return;
                    const held = deferred();
                    holds.push(withLock(AUTHORED_LOCK, { root }, async () => {
                        held.resolve();
                        await release.promise;
                    }));
                    await held.promise;
                },
            },
        });
        release.resolve();
        await Promise.all(holds);
        expect(result).toMatchObject({ outcome: 'PUBLISHED', revisionNumber: 2, rebased: false });
        expect(result.message).toMatch(/the next publish rebases it/);
        expect(await bases(root)).toEqual([first.revisionId]);

        const next = await run();
        expect(next.outcome).toBe('NO_CHANGES');
        expect(next.recovery?.rebased?.rebased).toBeGreaterThan(0);
        expect(await bases(root)).toEqual([result.revisionId]);
    });
});

describe('activateRevision', { timeout: 30_000 }, () => {
    type Overrides = Omit<ActivateOptions, 'lock' | 'dataRoot' | 'kind' | 'actor' | 'reason'> & Partial<ActivateOptions>;
    const activate = (root: string, overrides: Overrides) =>
        withLock(CATALOG_LOCK, { root }, (lock) => activateRevision({ lock, dataRoot: root, kind: 'rollback', actor: 'test', reason: 'rollback', ...overrides }));

    it('refuses with NOTHING_ACTIVE before the first activation', async () => {
        const { catalog, root, catalogFiles } = await setup({ seed: 78 });
        const result = await activate(root, { revisionId: catalog.revisionId, expectedActiveRevisionId: catalog.revisionId });
        expect(result).toMatchObject({ outcome: 'NOTHING_ACTIVE', activation: null });
        expect(catalogFiles()).toEqual([]);
    });

    it('returns ACTIVE_CHANGED, writing nothing, unless the expected revision is active', async () => {
        const { root, first } = await launched({ seed: 79 });
        const result = await activate(root, { revisionId: first.revisionId ?? '', expectedActiveRevisionId: `rev_${'0'.repeat(64)}` });
        expect(result.outcome).toBe('ACTIVE_CHANGED');
        expect(await listActivations(root)).toHaveLength(1);
    });

    it('refuses a revision with no revision file with INTEGRITY_MISMATCH', async () => {
        const { root, first } = await launched({ seed: 80 });
        const result = await activate(root, { revisionId: `rev_${'1'.repeat(64)}`, expectedActiveRevisionId: first.revisionId ?? '' });
        expect(result.outcome).toBe('INTEGRITY_MISMATCH');
        expect(await listActivations(root)).toHaveLength(1);
    });

    it("refuses a value that isn't a revision ID before reading or writing anything, and so does the rebase", async () => {
        const { root, first, catalogFiles } = await launched({ seed: 86 });
        const files = catalogFiles();
        for (const revisionId of ['../../authored/site', `${first.revisionId}/../../../authored/site`]) {
            await expect(activate(root, { revisionId, expectedActiveRevisionId: first.revisionId ?? '' })).rejects.toThrow(/A revision ID is rev_ plus 64 hex/);
            await expect(activate(root, { revisionId: first.revisionId ?? '', expectedActiveRevisionId: revisionId })).rejects.toThrow(TypeError);
            await expect(rebaseWorkingLayer({ root, targetRevisionId: revisionId })).rejects.toThrow(TypeError);
        }
        expect(catalogFiles()).toEqual(files);
        expect(await listActivations(root)).toHaveLength(1);
    });

    it.each([
        [10, 'abandons'],
        [11, 'commits'],
    ])('settles a publish that crashed after step %i first: it %s that activation before recording the rollback', async (crashAfter) => {
        const { catalog, root, run, editPhoto, first } = await launched({ seed: 87 });
        await editPhoto(catalog.photos[0].id, (photo) => {
            photo.caption = 'A caption the crashed publish carries.';
        });
        const crashed = await run({
            hooks: {
                afterStep(step) {
                    if (step === crashAfter) throw new Error(`crash after step ${crashAfter}`);
                },
            },
        });
        expect(crashed.outcome).toBe('STORAGE_ERROR');
        const [pending] = (await listActivations(root)).filter((activation) => activation.status === 'pending');
        const live = (await readActivePointer(root))?.revisionId ?? '';
        expect(live).toBe(crashAfter === 11 ? pending.revisionId : first.revisionId);

        const target = crashAfter === 11 ? first.revisionId ?? '' : pending.revisionId;
        if (crashAfter === 10) {
            // The crashed publish wrote its revision file at step 9, so it can be activated by hand.
            expect(fs.existsSync(revisionFilePath(root, target))).toBe(true);
        }
        const result = await activate(root, { revisionId: target, expectedActiveRevisionId: live });
        expect(result.outcome).toBe('ACTIVATED');
        expect(result.recovery).toMatchObject(crashAfter === 11 ? { committed: pending.activationId, abandoned: [] } : { committed: null, abandoned: [pending.activationId] });
        expect(result.activation?.previousActivationId).toBe(crashAfter === 11 ? pending.activationId : first.activationId);

        const next = await run();
        expect(next.recovery).toMatchObject({ committed: null, abandoned: [], repaired: null });
        const statuses = (await listActivations(root)).map((activation) => `${activation.sequence}:${activation.kind}:${activation.status}`);
        expect(statuses.slice(0, 3)).toEqual(['1:publish:committed', `2:publish:${crashAfter === 11 ? 'committed' : 'abandoned'}`, '3:rollback:committed']);
    });

    it('refuses a stored revision with an integrity error, even one the caller lists as accepted, writing nothing', async () => {
        const { catalog, root, run, editPhoto, first, catalogFiles } = await launched({ seed: 88 });
        await editPhoto(catalog.photos[0].id, (photo) => {
            photo.caption = 'A caption revision 2 publishes.';
        });
        const second = await run();
        expect(second.revisionNumber).toBe(2);
        // A derivative of revision 1's photo goes missing after it was published.
        const firstRevision = await readRevisionFile(root, first.revisionId ?? '');
        const photo = firstRevision?.content.photos[0];
        if (!photo) throw new Error('Revision 1 has no photo.');
        fs.rmSync(mediaFilePath({ photoId: photo.id, assetRevision: photo.assetRevision, profileId: photo.profileId }, 'w400', 'webp', root));
        const pointer = fs.readFileSync(catalogPaths(root).active);
        const files = catalogFiles();

        for (const acceptedRules of [[], ['assets.variant']]) {
            const result = await activate(root, { revisionId: first.revisionId ?? '', expectedActiveRevisionId: second.revisionId ?? '', acceptedRules });
            expect(result).toMatchObject({ outcome: 'VALIDATION_FAILED', activation: null });
            expect(result.message).toMatch(/1 error keeps rev_[0-9a-f]{64} from going live \(assets\.variant\)\. Nothing was activated\./);
            expect(result.issues?.[0]).toMatchObject({ code: 'assets.variant', severity: 'error', field: 'variants.w400.webp' });
        }
        expect(fs.readFileSync(catalogPaths(root).active)).toEqual(pointer);
        expect(catalogFiles()).toEqual(files);
    });

    it('refuses a stored revision with an editorial error unless the caller accepts that rule, and records what it accepted', async () => {
        const { catalog, root, run, editPhoto, first } = await launched({ seed: 89 });
        await editPhoto(catalog.photos[0].id, (photo) => {
            photo.caption = 'A caption revision 2 publishes.';
        });
        const second = await run();
        editorialErrorOn = first.revisionId;

        const refused = await activate(root, { revisionId: first.revisionId ?? '', expectedActiveRevisionId: second.revisionId ?? '' });
        expect(refused).toMatchObject({ outcome: 'VALIDATION_FAILED', activation: null });
        expect(refused.message).toContain('(test.editorial)');
        expect(await readActivePointer(root)).toMatchObject({ revisionId: second.revisionId });

        const accepted = await activate(root, { revisionId: first.revisionId ?? '', expectedActiveRevisionId: second.revisionId ?? '', acceptedRules: ['test.editorial'] });
        expect(accepted.outcome).toBe('ACTIVATED');
        expect(accepted.activation).toMatchObject({ acceptedRules: ['test.editorial'], validation: { errors: 1 } });
        expect(await readActivePointer(root)).toMatchObject({ revisionId: first.revisionId });
    });

    it('blocks on every error but an accepted editorial one, and on an error from a rule it does not know', () => {
        const issue = (code: string, severity: Issue['severity'] = 'error'): Issue => ({ code, severity, record: { kind: 'site', id: 'site' }, field: 'f', message: 'm' });
        const issues = [issue('test.editorial'), issue('assets.variant'), issue('nobody.knows'), issue('order.source-missing', 'warning')];
        expect(blockingIssues(issues).map((entry) => entry.code)).toEqual(['test.editorial', 'assets.variant', 'nobody.knows']);
        expect(blockingIssues(issues, ['test.editorial', 'assets.variant', 'nobody.knows']).map((entry) => entry.code)).toEqual(['assets.variant', 'nobody.knows']);
    });

    it("takes its data root from the lock when it isn't given", async () => {
        const { catalog, root, run, editPhoto, first } = await launched({ seed: 84 });
        await editPhoto(catalog.photos[0].id, (photo) => {
            photo.caption = 'A caption revision 2 publishes.';
        });
        const second = await run();
        expect(second.revisionNumber).toBe(2);

        const result = await withLock(CATALOG_LOCK, { root }, (lock) => activateRevision({
            lock, revisionId: first.revisionId ?? '', expectedActiveRevisionId: second.revisionId ?? '', kind: 'rollback', actor: 'test', reason: 'rollback',
        }));
        expect(result.outcome).toBe('ACTIVATED');
        expect(await readActivePointer(root)).toMatchObject({ revisionId: first.revisionId });
    });

    it("refuses a hold on another data root's catalog lock", async () => {
        const { root, first } = await launched({ seed: 85 });
        const other = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-other-'));
        cleanups.push(() => fs.promises.rm(other, { recursive: true, force: true }));
        await expect(withLock(CATALOG_LOCK, { root: other }, (lock) => activateRevision({
            lock, dataRoot: root, revisionId: first.revisionId ?? '', expectedActiveRevisionId: first.revisionId ?? '', kind: 'rollback', actor: 'test', reason: 'rollback',
        }))).rejects.toThrow(/live hold on this data root's catalog lock/);
        expect(await listActivations(root)).toHaveLength(1);
    });

    it('rolls back to a stored revision under its first number, and the rebase after it brings the working layer along', async () => {
        const { catalog, root, run, editPhoto, first } = await launched({ seed: 81, photos: 4, series: 1 });
        const [rolled, edited, untouched] = catalog.photos.map((photo) => photo.id);
        await editPhoto(rolled, (photo) => {
            photo.caption = 'A caption revision 2 publishes.';
        });
        await editPhoto(edited, (photo) => {
            photo.caption = 'Another caption revision 2 publishes.';
        });
        const second = await run();
        expect(second.revisionNumber).toBe(2);
        // After revision 2, the curator changes a field revision 2 changed too, and one it didn't.
        await editPhoto(edited, (photo) => {
            photo.caption = 'The curator\'s caption after revision 2.';
        });
        await editPhoto(untouched, (photo) => {
            photo.title = 'A title nobody published.';
        });

        const result = await activate(root, { revisionId: first.revisionId ?? '', expectedActiveRevisionId: second.revisionId ?? '', reason: 'roll back the captions' });
        expect(result.outcome).toBe('ACTIVATED');
        expect(result.activation).toMatchObject({ kind: 'rollback', revisionId: first.revisionId, revisionNumber: 1, previousRevisionId: second.revisionId, previousActivationId: second.activationId, validation: { errors: 0 } });
        expect(await readActivePointer(root)).toMatchObject({ revisionId: first.revisionId, activationId: result.activation?.activationId });

        const report = await rebaseWorkingLayer({ root, targetRevisionId: first.revisionId ?? '' });
        expect(report.conflicts).toEqual([{ kind: 'photo', id: edited, field: 'caption' }]);
        const layer = await readWorkingLayer(root);
        const photo = (id: string) => layer.photos.find((entry) => entry.id === id);
        // Left alone since revision 2: it takes the rollback's value.
        expect(photo(rolled)).not.toHaveProperty('caption');
        // Changed on both sides: the curator's value stays, with a conflict naming both.
        expect(photo(edited)).toMatchObject({ caption: 'The curator\'s caption after revision 2.', conflicts: [{ field: 'caption', base: 'Another caption revision 2 publishes.', active: null }] });
        // A change revision 2 never had stays as it is.
        expect(photo(untouched)?.title).toBe('A title nobody published.');
        expect(await bases(root)).toEqual([first.revisionId]);

        // The conflict blocks a publish until someone settles it.
        const blocked = await run();
        expect(blocked.outcome).toBe('VALIDATION_FAILED');
        expect(blocked.issues).toContainEqual(expect.objectContaining({ code: 'working.conflicts', record: { kind: 'photo', id: edited } }));
    });
});
