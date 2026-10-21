// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importGraph } from '../../../test/helpers/importGraph';
import { withLock } from '../../storage/lock';
import { activateRevision, publish, type PublishOptions, type PublishResult } from '../publish';
import { CATALOG_LOCK, revisionFilePath } from '../repository';
import { createTestCatalog } from '../testing';
import { writeAuthoredRecord } from '../working-layer-writer';
import { catalogPaths, readWorkingLayer } from '../working-layer';
import { VARIANT_BYTES } from './catalogFixtures';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A fresh copy of the reader's modules, as a newly started process has: nothing cut over, cached, or loaded. */
async function freshProcess() {
    vi.resetModules();
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

        fs.rmSync(catalogPaths(root).active);
        expect(await loadActiveCatalog(root)).toMatchObject({ mode: 'catalog', state: 'degraded', active: { revisionId: first.revisionId } });
        expect(await loadActiveCatalog(root)).toMatchObject({ state: 'degraded' });
        // One line when reads start failing, not one per read
        expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{ event: 'catalog.read.failed', reason: 'active-unreadable', error: 'missing' }]);

        // The committed activation is enough for a new process to know the site cut over.
        const restarted = await freshProcess();
        expect(await restarted.catalogMode(root)).toBe('catalog');
        expect(await restarted.loadActiveCatalog(root)).toEqual({ mode: 'catalog', state: 'unavailable', reason: 'active-unreadable' });
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

    it('treats a pending activation alone as not cut over, and one it cannot read as cut over', async () => {
        const { root, published } = await fixture(6);
        const { catalogMode } = await freshProcess();
        // A crash after step 10 leaves a pending activation and no pointer.
        await published({ hooks: { afterStep: (step) => { if (step === 10) throw new Error('crash after step 10'); } } }).catch(() => undefined);
        expect(fs.readdirSync(catalogPaths(root).activationsDir)).toHaveLength(1);
        expect(fs.existsSync(catalogPaths(root).active)).toBe(false);
        expect(await catalogMode(root)).toBe('legacy');

        fs.writeFileSync(path.join(catalogPaths(root).activationsDir, 'not-an-activation.json'), '{}\n');
        expect(await catalogMode(root)).toBe('catalog');
        fs.rmSync(path.join(catalogPaths(root).activationsDir, 'not-an-activation.json'));
        // And it stays there in this process.
        expect(await catalogMode(root)).toBe('catalog');
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
    it.each(['scripts/photos.ts', 'scripts/imageWatcher.ts', 'scripts/watcherHealth.ts'])('%s never reaches the public reader or request.ts', (entry) => {
        const { files } = importGraph(entry);
        expect(files).not.toContain('lib/catalog/public-reader.ts');
        expect(files).not.toContain('lib/catalog/request.ts');
    });
});
