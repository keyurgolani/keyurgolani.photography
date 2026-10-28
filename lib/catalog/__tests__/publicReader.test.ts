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

/** A fresh copy of the reader's modules, as a newly started process has: nothing cut over, cached, or loaded. */
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
    it('stays legacy until the first activation, then serves the active revision', async () => {
        const { root, published } = await fixture(1);
        const { loadActiveCatalog } = await freshProcess();
        expect(await loadActiveCatalog(root)).toEqual({ mode: 'legacy' });

        const first = await published();
        const active = await loadActiveCatalog(root);
        if (active.mode !== 'catalog' || active.state !== 'ok') throw new Error(`Expected an ok catalog, got ${JSON.stringify(active)}`);
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

    it('keeps catalog mode once the pointer goes away, serving the last revision it loaded, and a new process serves nothing', async () => {
        const { root, published } = await fixture(3);
        const { loadActiveCatalog } = await freshProcess();
        const first = await published();
        await loadActiveCatalog(root);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        fs.rmSync(catalogPaths(root).active, { recursive: true });
        expect(await loadActiveCatalog(root)).toMatchObject({ mode: 'catalog', state: 'degraded', active: { revisionId: first.revisionId } });
        expect(await loadActiveCatalog(root)).toMatchObject({ state: 'degraded' });
        // One line when reads start failing, not one per read
        expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{ event: 'catalog.read.failed', reason: 'active-unreadable', error: 'missing' }]);

        // The committed activation is enough for a new process to know the site cut over.
        const restarted = await freshProcess();
        expect(await restarted.catalogMode(root)).toBe('catalog');
        expect(await restarted.loadActiveCatalog(root)).toEqual({ mode: 'catalog', state: 'unavailable', reason: 'active-unreadable' });
    });

    it('serves the last revision it loaded while the newest pointer version is damaged, and a new process sees the cutover in it', async () => {
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
        expect(await loadActiveCatalog(root)).toMatchObject({ mode: 'catalog', state: 'degraded', active: { revisionId: first.revisionId } });
        expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{ event: 'catalog.read.failed', reason: 'active-unreadable', error: 'Error' }]);
        expect(errors.mock.calls.join('\n')).not.toContain(root);

        // With the activations gone too, the damaged version alone shows a new process the site cut over.
        fs.rmSync(catalogPaths(root).activationsDir, { recursive: true });
        const restarted = await freshProcess();
        expect(await restarted.checkCatalogMode(root)).toEqual({ mode: 'catalog' });
        expect(await restarted.loadActiveCatalog(root)).toEqual({ mode: 'catalog', state: 'unavailable', reason: 'active-unreadable' });
    });

    it('reads the pointer once per request, before and after the cutover', async () => {
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
        // The first read in catalog mode, which the mode check reuses, then one that it remembers.
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
        expect(await restarted.loadActiveCatalog(root)).toEqual({ mode: 'catalog', state: 'unavailable', reason: 'revision-unreadable' });
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

    it('treats a pending activation alone as not cut over, and one it cannot read as cut over for that read only', async () => {
        const { root, published } = await fixture(6);
        const { catalogMode, checkCatalogMode, loadActiveCatalog } = await freshProcess();
        // A crash after step 10 leaves a pending activation and no pointer.
        await published({ hooks: { afterStep: (step) => { if (step === 10) throw new Error('crash after step 10'); } } }).catch(() => undefined);
        expect(fs.readdirSync(catalogPaths(root).activationsDir)).toHaveLength(1);
        expect(fs.existsSync(catalogPaths(root).active)).toBe(false);
        expect(await catalogMode(root)).toBe('legacy');
        // A pointer folder with no version yet, as a writer that stopped before its link leaves it, isn't a cutover either.
        fs.mkdirSync(catalogPaths(root).active, { mode: 0o700 });
        expect(await catalogMode(root)).toBe('legacy');

        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        fs.writeFileSync(path.join(catalogPaths(root).activationsDir, 'not-an-activation.json'), '{}\n');
        expect(await checkCatalogMode(root)).toEqual({ mode: 'catalog', unreadable: expect.any(String) });
        expect(await loadActiveCatalog(root)).toEqual({ mode: 'catalog', state: 'unavailable', reason: 'catalog-unreadable' });
        fs.rmSync(path.join(catalogPaths(root).activationsDir, 'not-an-activation.json'));
        // Nothing showed the site cut over, so it goes back to legacy once the file reads.
        expect(await catalogMode(root)).toBe('legacy');
        expect(await loadActiveCatalog(root)).toEqual({ mode: 'legacy' });
    });

    it('serves nothing while a listing of the pointer folder fails, and goes back to legacy once it succeeds', async () => {
        const { root } = await fixture(7);
        const { checkCatalogMode, loadActiveCatalog } = await freshProcess();
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const active = catalogPaths(root).active;
        const readdir = fs.promises.readdir.bind(fs.promises);
        const failing = vi.spyOn(fs.promises, 'readdir').mockImplementation((async (dir: fs.PathLike, options?: unknown) => {
            if (String(dir) === active) throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
            return readdir(dir, options as never);
        }) as typeof fs.promises.readdir);
        expect(await checkCatalogMode(root)).toEqual({ mode: 'catalog', unreadable: 'EMFILE' });
        expect(await loadActiveCatalog(root)).toEqual({ mode: 'catalog', state: 'unavailable', reason: 'catalog-unreadable' });
        expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{ event: 'catalog.read.failed', reason: 'catalog-unreadable', error: 'EMFILE' }]);

        failing.mockRestore();
        expect(await checkCatalogMode(root)).toEqual({ mode: 'legacy' });
        expect(await loadActiveCatalog(root)).toEqual({ mode: 'legacy' });
    });

    it.skipIf(process.getuid?.() === 0)('serves nothing while catalog/ can\'t be read, as a dry run by another user leaves it, and goes back to legacy once it can', async () => {
        const { root, published } = await fixture(8);
        const { loadActiveCatalog } = await freshProcess();
        expect((await published({ dryRun: true, hooks: {} })).outcome).toBe('DRY_RUN_OK');
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const dir = catalogPaths(root).dir;
        fs.chmodSync(dir, 0o000);
        cleanups.push(async () => fs.chmodSync(dir, 0o700));

        expect(await loadActiveCatalog(root)).toEqual({ mode: 'catalog', state: 'unavailable', reason: 'catalog-unreadable' });
        fs.chmodSync(dir, 0o700);
        expect(await loadActiveCatalog(root)).toEqual({ mode: 'legacy' });
    });

    it('remembers a cutover it saw, so a pointer that goes unreadable later still serves catalog mode', async () => {
        const { root, published } = await fixture(9);
        const { checkCatalogMode } = await freshProcess();
        await published();
        expect(await checkCatalogMode(root)).toEqual({ mode: 'catalog' });
        fs.rmSync(catalogPaths(root).dir, { recursive: true, force: true });
        expect(await checkCatalogMode(root)).toEqual({ mode: 'catalog' });
    });

    it('shares the cutover memory between copies of the mode check, as the separate server bundles in one process load it', async () => {
        const { root, published } = await fixture(14);
        const route = await freshProcess();
        await published();
        expect(await route.checkCatalogMode(root)).toEqual({ mode: 'catalog' });
        // A second copy, as the proxy's bundle has, that never saw the cutover itself.
        vi.resetModules();
        const proxyCopy = await import('../mode');
        expect(proxyCopy.checkCatalogMode).not.toBe(route.checkCatalogMode);
        fs.rmSync(catalogPaths(root).dir, { recursive: true, force: true });
        expect(await proxyCopy.checkCatalogMode(root)).toEqual({ mode: 'catalog' });
    });

    it('reads a revision once for concurrent cold requests, and tries again after a read that failed', async () => {
        const { root, published } = await fixture(10);
        const first = await published();
        const file = revisionFilePath(root, first.revisionId ?? '');
        const revisionReads = (reads: { mock: { calls: unknown[][] } }) => reads.mock.calls.filter(([read]) => String(read) === file).length;

        const cold = await freshProcess();
        const reads = vi.spyOn(fs.promises, 'readFile');
        const loads = await Promise.all(Array.from({ length: 10 }, () => cold.loadActiveCatalog(root)));
        expect(loads.every((load) => load.mode === 'catalog' && load.state === 'ok')).toBe(true);
        expect(revisionReads(reads)).toBe(1);
        reads.mockRestore();

        // A failed read is dropped, so the read after it goes to the file again.
        const restarted = await freshProcess();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const bytes = fs.readFileSync(file);
        fs.rmSync(file);
        const missing = await Promise.all([restarted.loadActiveCatalog(root), restarted.loadActiveCatalog(root)]);
        expect(missing).toEqual([{ mode: 'catalog', state: 'unavailable', reason: 'revision-unreadable' }, { mode: 'catalog', state: 'unavailable', reason: 'revision-unreadable' }]);
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

    it('is legacy with a file where the data root should be, as a missing root is, and still catalog for one that cut over there', async () => {
        const { loadActiveCatalog, checkCatalogMode } = await freshProcess();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-mode-file-root-'));
        cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
        const file = path.join(dir, 'portfolio-data');
        fs.writeFileSync(file, 'not a folder');
        expect(await checkCatalogMode(file)).toEqual({ mode: 'legacy' });
        expect(await loadActiveCatalog(file)).toEqual({ mode: 'legacy' });
        // Under a real root, a file where `catalog/` should be still can't be told apart from a damaged cutover.
        const { root } = await fixture(41);
        fs.writeFileSync(catalogPaths(root).dir, '');
        expect(await checkCatalogMode(root)).toEqual({ mode: 'catalog', unreadable: 'ENOTDIR' });
    });

    it('is legacy without a data root', async () => {
        const { loadActiveCatalog, catalogMode } = await freshProcess();
        expect(await catalogMode(null)).toBe('legacy');
        expect(await loadActiveCatalog(null)).toEqual({ mode: 'legacy' });
    });
});

describe('isAssetPublic', { timeout: 60_000 }, () => {
    it('is true only for a set the served revision holds, at its asset revision and profile', async () => {
        const { root, published } = await fixture(7);
        const { isAssetPublic, loadActiveCatalog } = await freshProcess();
        expect(await loadActiveCatalog(root)).toEqual({ mode: 'legacy' });
        const photo = (await readWorkingLayer(root)).photos[0];
        expect(await isAssetPublic(photo.id, photo.assetRevision, 'p_0000000000000000', await loadActiveCatalog(root))).toBe(false);

        await published();
        const active = await loadActiveCatalog(root);
        if (active.mode !== 'catalog' || active.state !== 'ok') throw new Error('Expected an ok catalog');
        const served = active.reader.photo(photo.id);
        if (!served) throw new Error('The first photo is not published');
        expect(await isAssetPublic(served.id, served.assetRevision, served.profileId, active)).toBe(true);
        expect(await isAssetPublic(served.id, served.assetRevision, 'p_ffffffffffffffff', active)).toBe(false);
        expect(await isAssetPublic(served.id, `sha256-${'0'.repeat(64)}`, served.profileId, active)).toBe(false);
        expect(await isAssetPublic('ph_00000000-0000-4000-8000-000000000000', served.assetRevision, served.profileId, active)).toBe(false);
        expect(await isAssetPublic(served.id, served.assetRevision, served.profileId, { mode: 'catalog', state: 'unavailable', reason: 'active-unreadable' })).toBe(false);
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
