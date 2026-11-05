// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importGraph } from '../../../test/helpers/importGraph';
import { REPO_ROOT } from '../../../test/helpers/runTsx';
import { versionFile } from '../../storage/document';
import { withLock } from '../../storage/lock';
import { CUTOVER_KEY } from '../mode';
import { activateRevision, publish, type PublishOptions, type PublishResult } from '../publish';
import { CATALOG_LOCK, revisionFilePath } from '../repository';
import { createTestCatalog } from '../testing';
import { writeAuthoredRecord } from '../working-layer-writer';
import { catalogPaths, readActivePointer, readWorkingLayer } from '../working-layer';
import { VARIANT_BYTES } from './catalogFixtures';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** What the reader answers for a data root with nothing to serve: no root, or nothing published yet. */
const NOT_PUBLISHED = { state: 'unavailable', reason: 'not-published' };

/** A fresh copy of the reader's modules, as a newly started process has: nothing published remembered, cached, or loaded. */
async function freshProcess() {
    vi.resetModules();
    Reflect.deleteProperty(globalThis, CUTOVER_KEY);
    return { ...await import('../public-reader'), ...await import('../mode') };
}

async function fixture(seed: number) {
    const catalog = await createTestCatalog({ variantBytes: VARIANT_BYTES, seed });
    cleanups.push(() => catalog.cleanup());
    const root = catalog.root;
    const logger = { log: () => undefined };
    let edits = 0;
    const published = async (options: Partial<PublishOptions> = {}): Promise<PublishResult> => {
        const result = await publish({ dataRoot: root, actor: 'test', confirmLaunch: true, logger, ...options });
        if (options.hooks === undefined && result.outcome !== 'PUBLISHED') throw new Error(`The publish ended ${result.outcome}: ${result.message}`);
        return result;
    };
    /** Give the first photo a new caption, so the next publish makes a new revision. */
    const edit = async () => {
        const record = (await readWorkingLayer(root)).photos.find((photo) => photo.id === catalog.photos[0].id);
        if (!record) throw new Error('The first photo has no record');
        edits += 1;
        await writeAuthoredRecord({ ...structuredClone(record), caption: `A fixture caption, edit ${edits}.` }, { expectedVersion: record.version, root });
    };
    const rollBack = (to: PublishResult, from: PublishResult) =>
        withLock(CATALOG_LOCK, { root }, (lock) => activateRevision({
            lock, revisionId: to.revisionId ?? '', expectedActiveRevisionId: from.revisionId ?? '', kind: 'rollback', actor: 'test', reason: 'rollback',
        }));
    return { catalog, root, published, edit, rollBack };
}

describe('the public reader', { timeout: 60_000 }, () => {
    it('serves nothing, as not-published, until the first activation, then serves the active revision', async () => {
        const { root, published } = await fixture(1);
        const { loadActiveCatalog } = await freshProcess();
        expect(await loadActiveCatalog(root)).toEqual(NOT_PUBLISHED);

        const first = await published();
        const active = await loadActiveCatalog(root);
        if (active.state !== 'ok') throw new Error(`Expected an ok catalog, got ${JSON.stringify(active)}`);
        expect(active.active).toMatchObject({ revisionId: first.revisionId, revisionNumber: 1 });
        expect(Date.parse(active.active.activatedAt ?? '')).not.toBeNaN();
        expect(active.reader.revision()).toEqual({ revisionId: first.revisionId, revisionNumber: 1 });
        expect(active.reader.listSeries().length).toBeGreaterThan(0);
    });

    it('serves a new activation on the next read, with no restart, and a rollback the same way', async () => {
        const { root, published, edit, rollBack } = await fixture(2);
        const { loadActiveCatalog } = await freshProcess();
        const first = await published();
        expect(await loadActiveCatalog(root)).toMatchObject({ state: 'ok', active: { revisionId: first.revisionId } });

        await edit();
        const second = await published();
        expect(second.revisionId).not.toBe(first.revisionId);
        expect(await loadActiveCatalog(root)).toMatchObject({ state: 'ok', active: { revisionId: second.revisionId, revisionNumber: 2 } });

        await rollBack(first, second);
        // A rolled-back-to revision keeps its first number.
        expect(await loadActiveCatalog(root)).toMatchObject({ state: 'ok', active: { revisionId: first.revisionId, revisionNumber: 1 } });
    });

    it('remembers the publish once the pointer goes away, serving the last revision it loaded, and a new process serves nothing', async () => {
        const { root, published } = await fixture(3);
        const { loadActiveCatalog } = await freshProcess();
        const first = await published();
        await loadActiveCatalog(root);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        fs.rmSync(catalogPaths(root).active, { recursive: true });
        expect(await loadActiveCatalog(root)).toMatchObject({ state: 'degraded', active: { revisionId: first.revisionId } });
        expect(await loadActiveCatalog(root)).toMatchObject({ state: 'degraded' });
        // One line when reads start failing, not one per read
        expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{ event: 'catalog.read.failed', reason: 'active-unreadable', error: 'missing' }]);

        // The committed activation is enough for a new process to know the site published.
        const restarted = await freshProcess();
        expect(await restarted.checkPublished(root)).toEqual({ state: 'published' });
        expect(await restarted.loadActiveCatalog(root)).toEqual({ state: 'unavailable', reason: 'active-unreadable' });
    });

    // #171 (B3): Work's Try again after a missing pointer. A process that never loaded a revision has nothing to fall
    // back on, so it serves nothing, and the first read after the pointer is back serves the revision, with no restart.
    it('serves nothing while the pointer is missing in a process that never loaded, and serves the revision once it is back', async () => {
        const { root, published } = await fixture(15);
        const first = await published();
        const aside = `${catalogPaths(root).active}.aside`;
        fs.renameSync(catalogPaths(root).active, aside);
        const { loadActiveCatalog } = await freshProcess();
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(await loadActiveCatalog(root)).toEqual({ state: 'unavailable', reason: 'active-unreadable' });
        expect(await loadActiveCatalog(root)).toEqual({ state: 'unavailable', reason: 'active-unreadable' });
        // The one log line names the reason, never a path.
        expect(errors.mock.calls.join('\n')).not.toContain(root);

        fs.renameSync(aside, catalogPaths(root).active);
        expect(await loadActiveCatalog(root)).toMatchObject({ state: 'ok', active: { revisionId: first.revisionId } });
    });

    it('serves the last revision it loaded while the newest pointer version is damaged, and a new process sees the publish in it', async () => {
        const { root, published } = await fixture(12);
        const { loadActiveCatalog } = await freshProcess();
        const first = await published();
        expect(await loadActiveCatalog(root)).toMatchObject({ state: 'ok', active: { revisionId: first.revisionId } });
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        // Damage the version the pointer's folder reads, found through the pointer itself.
        const pointer = await readActivePointer(root);
        if (!pointer) throw new Error('The publish left no pointer');
        const file = versionFile(catalogPaths(root).active, pointer.version);
        fs.chmodSync(file, 0o600);
        fs.writeFileSync(file, 'not json');
        expect(await loadActiveCatalog(root)).toMatchObject({ state: 'degraded', active: { revisionId: first.revisionId } });
        expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{ event: 'catalog.read.failed', reason: 'active-unreadable', error: 'Error' }]);
        expect(errors.mock.calls.join('\n')).not.toContain(root);

        // With the activations gone too, the damaged version alone shows a new process the site published.
        fs.rmSync(catalogPaths(root).activationsDir, { recursive: true });
        const restarted = await freshProcess();
        expect(await restarted.checkPublished(root)).toEqual({ state: 'published' });
        expect(await restarted.loadActiveCatalog(root)).toEqual({ state: 'unavailable', reason: 'active-unreadable' });
    });

    it('reads the pointer once per request, before and after the first publish', async () => {
        const { root, published } = await fixture(13);
        const { loadActiveCatalog } = await freshProcess();
        const pointerListings = async () => {
            const listings = vi.spyOn(fs.promises, 'readdir');
            await loadActiveCatalog(root);
            const count = listings.mock.calls.filter(([dir]) => String(dir) === catalogPaths(root).active).length;
            listings.mockRestore();
            return count;
        };
        expect(await pointerListings()).toBe(1);
        await published();
        // The first read after the publish, which the publish check reuses, then one that it remembers.
        expect(await pointerListings()).toBe(1);
        expect(await pointerListings()).toBe(1);
    });

    it('serves nothing from a revision file that fails its check, in a process that never loaded it', async () => {
        const { root, published } = await fixture(4);
        const { loadActiveCatalog } = await freshProcess();
        const first = await published();
        expect(await loadActiveCatalog(root)).toMatchObject({ state: 'ok' });

        const file = revisionFilePath(root, first.revisionId ?? '');
        const revision = JSON.parse(fs.readFileSync(file, 'utf8'));
        // Still a valid revision, but its content no longer hashes to its name
        revision.content.photos[0].width += 1;
        fs.chmodSync(file, 0o600);
        fs.writeFileSync(file, `${JSON.stringify(revision)}\n`);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);

        // Revision files never change, so the one this process parsed keeps serving.
        expect(await loadActiveCatalog(root)).toMatchObject({ state: 'ok' });
        const restarted = await freshProcess();
        expect(await restarted.loadActiveCatalog(root)).toEqual({ state: 'unavailable', reason: 'revision-unreadable' });
    });

    it('keeps the last three revisions it parsed', async () => {
        const { root, published, edit, rollBack } = await fixture(5);
        const { loadActiveCatalog, REVISION_CACHE_SIZE } = await freshProcess();
        expect(REVISION_CACHE_SIZE).toBe(3);
        const results: PublishResult[] = [];
        for (let index = 0; index < 4; index += 1) {
            if (index > 0) await edit();
            results.push(await published());
            await loadActiveCatalog(root);
        }
        /** How many revision files one read of the active catalog opens. The rollbacks read some too, so they don't count. */
        const revisionReads = async () => {
            const reads = vi.spyOn(fs.promises, 'readFile');
            await loadActiveCatalog(root);
            const count = reads.mock.calls.filter(([file]) => String(file).includes(`${path.sep}revisions${path.sep}`)).length;
            reads.mockRestore();
            return count;
        };

        await rollBack(results[1], results[3]);
        expect(await revisionReads()).toBe(0);
        await rollBack(results[0], results[1]);
        // The first was the oldest of four, so it was read again.
        expect(await revisionReads()).toBe(1);
    });

    it('treats a pending activation alone as unpublished, and one it cannot read as unknown for that read only', async () => {
        const { root, published } = await fixture(6);
        const { checkPublished, loadActiveCatalog } = await freshProcess();
        // A crash after step 10 leaves a pending activation and no pointer.
        await published({ hooks: { afterStep: (step) => { if (step === 10) throw new Error('crash after step 10'); } } }).catch(() => undefined);
        expect(fs.readdirSync(catalogPaths(root).activationsDir)).toHaveLength(1);
        expect(fs.existsSync(catalogPaths(root).active)).toBe(false);
        expect(await checkPublished(root)).toEqual({ state: 'unpublished' });
        // A pointer folder with no version yet, as a writer that stopped before its link leaves it, isn't a publish either.
        fs.mkdirSync(catalogPaths(root).active, { mode: 0o700 });
        expect(await checkPublished(root)).toEqual({ state: 'unpublished' });

        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        fs.writeFileSync(path.join(catalogPaths(root).activationsDir, 'not-an-activation.json'), '{}\n');
        expect(await checkPublished(root)).toEqual({ state: 'unknown', unreadable: expect.any(String) });
        expect(await loadActiveCatalog(root)).toEqual({ state: 'unavailable', reason: 'catalog-unreadable' });
        fs.rmSync(path.join(catalogPaths(root).activationsDir, 'not-an-activation.json'));
        // Nothing showed the site published, so it goes back to unpublished once the file reads.
        expect(await checkPublished(root)).toEqual({ state: 'unpublished' });
        expect(await loadActiveCatalog(root)).toEqual(NOT_PUBLISHED);
    });

    it('serves nothing while a listing of the pointer folder fails, and goes back to not-published once it succeeds', async () => {
        const { root } = await fixture(7);
        const { checkPublished, loadActiveCatalog } = await freshProcess();
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const active = catalogPaths(root).active;
        const readdir = fs.promises.readdir.bind(fs.promises);
        const failing = vi.spyOn(fs.promises, 'readdir').mockImplementation((async (dir: fs.PathLike, options?: unknown) => {
            if (String(dir) === active) throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
            return readdir(dir, options as never);
        }) as typeof fs.promises.readdir);
        expect(await checkPublished(root)).toEqual({ state: 'unknown', unreadable: 'EMFILE' });
        expect(await loadActiveCatalog(root)).toEqual({ state: 'unavailable', reason: 'catalog-unreadable' });
        expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{ event: 'catalog.read.failed', reason: 'catalog-unreadable', error: 'EMFILE' }]);

        failing.mockRestore();
        expect(await checkPublished(root)).toEqual({ state: 'unpublished' });
        expect(await loadActiveCatalog(root)).toEqual(NOT_PUBLISHED);
    });

    it.skipIf(process.getuid?.() === 0)('serves nothing while catalog/ can\'t be read, as a dry run by another user leaves it, and goes back to not-published once it can', async () => {
        const { root, published } = await fixture(8);
        const { loadActiveCatalog } = await freshProcess();
        expect((await published({ dryRun: true, hooks: {} })).outcome).toBe('DRY_RUN_OK');
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const dir = catalogPaths(root).dir;
        fs.chmodSync(dir, 0o000);
        cleanups.push(async () => fs.chmodSync(dir, 0o700));

        expect(await loadActiveCatalog(root)).toEqual({ state: 'unavailable', reason: 'catalog-unreadable' });
        fs.chmodSync(dir, 0o700);
        expect(await loadActiveCatalog(root)).toEqual(NOT_PUBLISHED);
    });

    it('remembers a publish it saw, so a catalog that goes away later still counts as published', async () => {
        const { root, published } = await fixture(9);
        const { checkPublished } = await freshProcess();
        await published();
        expect(await checkPublished(root)).toEqual({ state: 'published' });
        fs.rmSync(catalogPaths(root).dir, { recursive: true, force: true });
        expect(await checkPublished(root)).toEqual({ state: 'published' });
    });

    it('shares the publish memory between copies of the check, as the separate server bundles in one process load it', async () => {
        const { root, published } = await fixture(14);
        const route = await freshProcess();
        await published();
        expect(await route.checkPublished(root)).toEqual({ state: 'published' });
        // A second copy, as another server bundle has, that never saw the publish itself.
        vi.resetModules();
        const proxyCopy = await import('../mode');
        expect(proxyCopy.checkPublished).not.toBe(route.checkPublished);
        fs.rmSync(catalogPaths(root).dir, { recursive: true, force: true });
        expect(await proxyCopy.checkPublished(root)).toEqual({ state: 'published' });
    });

    it('reads a revision once for concurrent cold requests, and tries again after a read that failed', async () => {
        const { root, published } = await fixture(10);
        const first = await published();
        const file = revisionFilePath(root, first.revisionId ?? '');
        const revisionReads = (reads: { mock: { calls: unknown[][] } }) => reads.mock.calls.filter(([read]) => String(read) === file).length;

        const cold = await freshProcess();
        const reads = vi.spyOn(fs.promises, 'readFile');
        const loads = await Promise.all(Array.from({ length: 10 }, () => cold.loadActiveCatalog(root)));
        expect(loads.every((load) => load.state === 'ok')).toBe(true);
        expect(revisionReads(reads)).toBe(1);
        reads.mockRestore();

        // A failed read is dropped, so the read after it goes to the file again.
        const restarted = await freshProcess();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const bytes = fs.readFileSync(file);
        fs.rmSync(file);
        const missing = await Promise.all([restarted.loadActiveCatalog(root), restarted.loadActiveCatalog(root)]);
        expect(missing).toEqual([{ state: 'unavailable', reason: 'revision-unreadable' }, { state: 'unavailable', reason: 'revision-unreadable' }]);
        fs.writeFileSync(file, bytes);
        expect(await restarted.loadActiveCatalog(root)).toMatchObject({ state: 'ok', active: { revisionId: first.revisionId } });
    });

    it('keeps a pending activation briefly, so a burst of requests reads the activations once, and reads them again after', async () => {
        const { root, published, edit } = await fixture(11);
        await published();
        await edit();
        // A crash after step 11 leaves the pointer naming a pending activation until the next CLI run's recovery.
        await published({ hooks: { afterStep: (step) => { if (step === 11) throw new Error('crash after step 11'); } } });
        const { loadActiveCatalog, UNSETTLED_ACTIVATION_TTL_MS } = await freshProcess();
        let now = Date.parse('2026-06-01T00:00:00.000Z');
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const activationReads = async (loads: number) => {
            const reads = vi.spyOn(fs.promises, 'readFile');
            for (let index = 0; index < loads; index += 1) expect(await loadActiveCatalog(root)).toMatchObject({ state: 'ok', active: { revisionNumber: 2 } });
            const count = reads.mock.calls.filter(([file]) => String(file).includes(`${path.sep}activations${path.sep}`)).length;
            reads.mockRestore();
            return count;
        };

        const burst = await activationReads(5);
        expect(burst).toBeGreaterThan(0);
        expect(await activationReads(5)).toBe(0);
        now += UNSETTLED_ACTIVATION_TTL_MS;
        expect(await activationReads(1)).toBe(burst);
    });

    it('is unpublished with a file where the data root should be, as a missing root is, and unknown with a file where its catalog should be', async () => {
        const { loadActiveCatalog, checkPublished } = await freshProcess();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-mode-file-root-'));
        cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
        const file = path.join(dir, 'portfolio-data');
        fs.writeFileSync(file, 'not a folder');
        expect(await checkPublished(file)).toEqual({ state: 'unpublished' });
        expect(await loadActiveCatalog(file)).toEqual(NOT_PUBLISHED);
        // A file where a parent folder should be is the same: stat says ENOTDIR, and no catalog can be under it.
        expect(await checkPublished(path.join(file, 'portfolio'))).toEqual({ state: 'unpublished' });
        expect(await loadActiveCatalog(path.join(file, 'portfolio'))).toEqual(NOT_PUBLISHED);
        // Under a real root, a file where `catalog/` should be still can't be told apart from a damaged publish.
        const { root } = await fixture(41);
        fs.writeFileSync(catalogPaths(root).dir, '');
        expect(await checkPublished(root)).toEqual({ state: 'unknown', unreadable: 'ENOTDIR' });
    });

    it('stays published for a root this process saw publish, once a file is at its path', async () => {
        const { checkPublished } = await freshProcess();
        const { root, published } = await fixture(42);
        await published();
        expect((await checkPublished(root)).state).toBe('published');
        fs.rmSync(root, { recursive: true, force: true });
        fs.writeFileSync(root, 'not a folder');
        expect(await checkPublished(root)).toEqual({ state: 'published' });
    });

    it('answers not-published without a data root, and gives Home and Work the unavailable state, never a photo list', async () => {
        const { loadActiveCatalog, checkPublished } = await freshProcess();
        expect(await checkPublished(null)).toEqual({ state: 'unpublished' });
        const catalog = await loadActiveCatalog(null);
        expect(catalog).toEqual(NOT_PUBLISHED);
        const { homeRouteOf } = await import('../projections/home');
        const { workRouteOf } = await import('../projections/work');
        const { publicRoutes } = await import('../public-reader');
        expect(homeRouteOf(catalog, publicRoutes)).toEqual({ kind: 'unavailable', reason: 'not-published' });
        expect(workRouteOf(catalog, publicRoutes)).toEqual({ kind: 'unavailable', reason: 'not-published' });
    });
});

describe('isAssetPublic', { timeout: 60_000 }, () => {
    it('is true only for a set the served revision holds, at its asset revision and profile', async () => {
        const { root, published } = await fixture(7);
        const { isAssetPublic, loadActiveCatalog } = await freshProcess();
        expect(await loadActiveCatalog(root)).toEqual(NOT_PUBLISHED);
        const photo = (await readWorkingLayer(root)).photos[0];
        expect(await isAssetPublic(photo.id, photo.assetRevision, 'p_0000000000000000', await loadActiveCatalog(root))).toBe(false);

        await published();
        const active = await loadActiveCatalog(root);
        if (active.state !== 'ok') throw new Error('Expected an ok catalog');
        const served = active.reader.photo(photo.id);
        if (!served) throw new Error('The first photo is not published');
        expect(await isAssetPublic(served.id, served.assetRevision, served.profileId, active)).toBe(true);
        expect(await isAssetPublic(served.id, served.assetRevision, 'p_ffffffffffffffff', active)).toBe(false);
        expect(await isAssetPublic(served.id, `sha256-${'0'.repeat(64)}`, served.profileId, active)).toBe(false);
        expect(await isAssetPublic('ph_00000000-0000-4000-8000-000000000000', served.assetRevision, served.profileId, active)).toBe(false);
        expect(await isAssetPublic(served.id, served.assetRevision, served.profileId, { state: 'unavailable', reason: 'active-unreadable' })).toBe(false);
    });
});

describe('the CLI and watcher entrypoints', () => {
    // Every script, so one added later is covered too.
    const entries = fs.readdirSync(path.join(REPO_ROOT, 'scripts')).filter((name) => name.endsWith('.ts')).sort().map((name) => `scripts/${name}`);

    it('include the photos CLI and the watcher', () => {
        expect(entries).toEqual(expect.arrayContaining(['scripts/photos.ts', 'scripts/imageWatcher.ts']));
    });

    it.each(entries)('%s never reaches the public reader or request.ts', (entry) => {
        const { files } = importGraph(entry);
        expect(files).not.toContain('lib/catalog/public-reader.ts');
        expect(files).not.toContain('lib/catalog/request.ts');
    });
});
