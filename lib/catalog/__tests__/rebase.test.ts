// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { LockTimeoutError, withLock } from '../../storage/lock';
import { activateRevision, publish, rebaseWorkingLayer, type PublishOptions, type PublishResult } from '../publish';
import { CATALOG_LOCK } from '../repository';
import { createTestCatalog, type TestCatalog, type TestCatalogOptions } from '../testing';
import type { AuthoredPhoto, AuthoredRecord, AuthoredSeries, AuthoredSite } from '../types';
import { AUTHORED_LOCK, writeAuthoredRecord, writeRebasedRecord } from '../working-layer-writer';
import { readWorkingLayer } from '../working-layer';
import { VARIANT_BYTES } from './catalogFixtures';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

const quiet = { log: () => undefined };

interface Setup {
    catalog: TestCatalog;
    root: string;
    run(options?: Partial<PublishOptions>): Promise<PublishResult>;
    edit<R extends AuthoredRecord>(kind: R['kind'], id: string, change: (record: R) => void): Promise<void>;
    record<R extends AuthoredRecord>(kind: R['kind'], id: string): Promise<R>;
    /** Roll back from `from` to `to`, then rebase the working layer onto it, as #15 will. */
    rollBack(to: string, from: string): ReturnType<typeof rebaseWorkingLayer>;
}

async function setup(options: TestCatalogOptions): Promise<Setup> {
    const catalog = await createTestCatalog({ variantBytes: VARIANT_BYTES, ...options });
    cleanups.push(() => catalog.cleanup());
    const root = catalog.root;
    const find = async (kind: AuthoredRecord['kind'], id: string): Promise<AuthoredRecord> => {
        const layer = await readWorkingLayer(root);
        const found = kind === 'site' ? layer.site : (kind === 'series' ? layer.series : layer.photos).find((entry) => entry.id === id);
        if (!found) throw new Error(`No ${kind} record ${id}`);
        return found;
    };
    return {
        catalog,
        root,
        async run(overrides = {}) {
            const result = await publish({ dataRoot: root, actor: 'test', confirmLaunch: true, logger: quiet, ...overrides });
            if (result.outcome !== 'PUBLISHED') throw new Error(`The publish ended ${result.outcome}: ${result.message}`);
            return result;
        },
        async edit(kind, id, change) {
            const found = await find(kind, id);
            const next = structuredClone(found) as Parameters<typeof change>[0];
            change(next);
            await writeAuthoredRecord(next as never, { expectedVersion: found.version, root });
        },
        record: async <R extends AuthoredRecord>(kind: R['kind'], id: string) => (await find(kind, id)) as R,
        async rollBack(to, from) {
            const result = await withLock(CATALOG_LOCK, { root }, (lock) => activateRevision({ lock, dataRoot: root, revisionId: to, expectedActiveRevisionId: from, kind: 'rollback', actor: 'test', reason: 'rollback' }));
            if (result.outcome !== 'ACTIVATED') throw new Error(`The rollback ended ${result.outcome}: ${result.message}`);
            return rebaseWorkingLayer({ root, targetRevisionId: to });
        },
    };
}

const ids = (published: PublishResult) => published.revisionId ?? '';

describe('rebaseWorkingLayer', () => {
    it('keeps an edit made while a publish ran, merging step 13 against the step 2 snapshot', async () => {
        const { catalog, run, edit, record } = await setup({ seed: 91, photos: 3, series: 1 });
        await run();
        const photoId = catalog.photos[0].id;
        await edit<AuthoredPhoto>('photo', photoId, (photo) => {
            photo.caption = 'The caption this publish compiles.';
        });
        const second = await run({
            hooks: {
                async afterStep(step) {
                    if (step !== 3) return;
                    await edit<AuthoredPhoto>('photo', photoId, (photo) => {
                        photo.caption = 'The caption written while it ran.';
                    });
                },
            },
        });
        expect(second.rebased).toBe(true);
        const photo = await record<AuthoredPhoto>('photo', photoId);
        expect(photo).toMatchObject({ caption: 'The caption written while it ran.', baseRevisionId: second.revisionId });
        expect(photo).not.toHaveProperty('conflicts');

        const third = await run();
        expect(third.revisionNumber).toBe(3);
    });

    it('hides a once-public series a rollback unpublishes, and leaves a draft a draft', async () => {
        const { catalog, run, edit, record, rollBack } = await setup({
            seed: 92,
            photos: 5,
            series: [{ photos: 2 }, { photos: 2, visibility: 'draft' }, { photos: 1, visibility: 'draft' }],
        });
        const [kept, published, draft] = catalog.series.map((series) => series.id);
        const first = await run();
        await edit<AuthoredSeries>('series', published, (series) => {
            series.visibility = 'published';
        });
        const second = await run();

        const report = await rollBack(ids(first), ids(second));
        expect(report.conflicts).toEqual([]);
        expect(await record<AuthoredSeries>('series', published)).toMatchObject({ visibility: 'hidden', title: catalog.series[1].title, baseRevisionId: first.revisionId });
        expect((await record<AuthoredSeries>('series', draft)).visibility).toBe('draft');
        expect((await record<AuthoredSeries>('series', kept)).visibility).toBe('published');
    });

    it('takes the target\'s featured series and Work order where the curator left them, and keeps the curator\'s where they changed', async () => {
        const { catalog, run, edit, record, rollBack } = await setup({ seed: 93, photos: 6, series: 3 });
        const [a, b, c] = catalog.series.map((series) => series.id);
        const first = await run();
        await edit<AuthoredSite>('site', 'site', (site) => {
            site.featuredSeriesIds = [b];
            site.seriesOrder = [b, a, c];
        });
        const second = await run();

        await rollBack(ids(first), ids(second));
        expect(await record<AuthoredSite>('site', 'site')).toMatchObject({ featuredSeriesIds: [a], seriesOrder: [a, b, c] });
        expect(await record<AuthoredSite>('site', 'site')).not.toHaveProperty('conflicts');
    });

    it('records a conflict for featured series and Work order changed both ways, and keeps the curator\'s', async () => {
        const { catalog, run, edit, record, rollBack } = await setup({ seed: 94, photos: 6, series: 3 });
        const [a, b, c] = catalog.series.map((series) => series.id);
        const first = await run();
        await edit<AuthoredSite>('site', 'site', (site) => {
            site.featuredSeriesIds = [b];
            site.seriesOrder = [b, a, c];
        });
        const second = await run();
        await edit<AuthoredSite>('site', 'site', (site) => {
            site.featuredSeriesIds = [c];
            site.seriesOrder = [c, b, a];
        });

        const report = await rollBack(ids(first), ids(second));
        expect(report.conflicts).toEqual([
            { kind: 'site', id: 'site', field: 'featuredSeriesIds' },
            { kind: 'site', id: 'site', field: 'seriesOrder' },
        ]);
        expect(await record<AuthoredSite>('site', 'site')).toMatchObject({
            featuredSeriesIds: [c],
            seriesOrder: [c, b, a],
            conflicts: [
                { field: 'featuredSeriesIds', base: [b], active: [a] },
                { field: 'seriesOrder', base: [b, a, c], active: [a, b, c] },
            ],
        });
    });

    it('takes a target\'s alt as reviewed, and leaves a capture date #10 knows to #10', async () => {
        const { catalog, run, edit, record, rollBack } = await setup({ seed: 95, photos: 3, series: 1 });
        const [described, dated] = catalog.photos.map((photo) => photo.id);
        const first = await run();
        await edit<AuthoredPhoto>('photo', described, (photo) => {
            photo.alt = { kind: 'decorative' };
        });
        await edit<AuthoredPhoto>('photo', dated, (photo) => {
            photo.capturedAt = '2020-02-02';
        });
        const second = await run();

        await rollBack(ids(first), ids(second));
        expect((await record<AuthoredPhoto>('photo', described)).alt).toEqual({ kind: 'described', text: 'Fixture description of photograph 0001.', reviewed: true });
        // The rollback's date is #10's, so the override goes rather than pinning it.
        expect(await record<AuthoredPhoto>('photo', dated)).not.toHaveProperty('capturedAt');
    });

    it('replaces an older conflict on the same field and keeps one on another', async () => {
        const { catalog, run, edit, record, rollBack } = await setup({ seed: 96, photos: 2, series: 1 });
        const photoId = catalog.photos[0].id;
        const first = await run();
        await edit<AuthoredPhoto>('photo', photoId, (photo) => {
            photo.caption = 'The caption revision 2 publishes.';
        });
        const second = await run();
        const titleConflict = { field: 'title', base: 'Older title', active: 'Old title' };
        await edit<AuthoredPhoto>('photo', photoId, (photo) => {
            photo.caption = 'The curator\'s caption.';
            photo.conflicts = [titleConflict, { field: 'caption', base: 'stale', active: 'staler' }];
        });

        await rollBack(ids(first), ids(second));
        expect((await record<AuthoredPhoto>('photo', photoId)).conflicts).toEqual([titleConflict, { field: 'caption', base: 'The caption revision 2 publishes.', active: null }]);
    });

    it('skips records already on the target, and only moves a record whose base revision is gone', async () => {
        const { catalog, root, run, record } = await setup({ seed: 97, photos: 2, series: 1 });
        const first = await run();
        await expect(rebaseWorkingLayer({ root, targetRevisionId: ids(first) })).resolves.toEqual({ rebased: 0, conflicts: [] });

        const photoId = catalog.photos[0].id;
        const before = await record<AuthoredPhoto>('photo', photoId);
        const gone = `rev_${'9'.repeat(64)}`;
        await withLock(AUTHORED_LOCK, { root }, (lock) => writeRebasedRecord({ ...before, caption: 'A caption no revision has.' }, { expectedVersion: before.version, lock, baseRevisionId: gone }));
        await expect(rebaseWorkingLayer({ root, targetRevisionId: ids(first) })).resolves.toEqual({ rebased: 1, conflicts: [] });
        expect(await record<AuthoredPhoto>('photo', photoId)).toMatchObject({ caption: 'A caption no revision has.', baseRevisionId: first.revisionId, version: before.version + 2 });
    });

    it('needs a target with a revision file, and a live authored hold when it is handed one', async () => {
        const { root, run } = await setup({ seed: 98, photos: 2, series: 1 });
        const first = await run();
        await expect(rebaseWorkingLayer({ root, targetRevisionId: `rev_${'8'.repeat(64)}` })).rejects.toThrow(/has no revision file/);
        await expect(withLock(CATALOG_LOCK, { root }, (lock) => rebaseWorkingLayer({ root, targetRevisionId: ids(first), lock }))).rejects.toThrow(/needs a live hold on the authored lock/);
    });

    it('gives up with LockTimeoutError when a tool holds the working layer past waitMs', async () => {
        const { root, run } = await setup({ seed: 99, photos: 2, series: 1 });
        const first = await run();
        await expect(withLock(AUTHORED_LOCK, { root }, () => rebaseWorkingLayer({ root, targetRevisionId: ids(first), waitMs: 50 }))).rejects.toBeInstanceOf(LockTimeoutError);
    });
});
