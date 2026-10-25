// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LockTimeoutError, withLock } from '../../storage/lock';
import { activateRevision, publish, rebaseWorkingLayer, type PublishOptions, type PublishResult } from '../publish';
import { CATALOG_LOCK, readRevisionFile, revisionFilePath } from '../repository';
import { createTestCatalog, type TestCatalog, type TestCatalogOptions } from '../testing';
import type { AuthoredPhoto, AuthoredRecord, AuthoredSeries, AuthoredSite } from '../types';
import { AUTHORED_LOCK, writeAuthoredRecord, writeRebasedRecord } from '../working-layer-writer';
import { readActivePointer, readWorkingLayer } from '../working-layer';
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

describe('rebaseWorkingLayer', { timeout: 30_000 }, () => {
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

    it('keeps the owner\'s move of a series the base revision hid through a rollback, with a conflict that blocks publish until a roll forward settles it', async () => {
        // #8's review, P3: as #15 will call it, through publish(), activateRevision() and rebaseWorkingLayer().
        const { catalog, root, run, edit, record, rollBack } = await setup({ seed: 104, photos: 6, series: 3 });
        const [a, b, c] = catalog.series.map((series) => series.id);
        const first = await run();
        await edit<AuthoredSeries>('series', c, (series) => {
            series.visibility = 'hidden';
        });
        const second = await run();
        await edit<AuthoredSite>('site', 'site', (site) => {
            site.seriesOrder = [c, a, b];
        });

        const report = await rollBack(ids(first), ids(second));
        expect(report.conflicts).toContainEqual({ kind: 'site', id: 'site', field: 'seriesOrder' });
        expect(await record<AuthoredSite>('site', 'site')).toMatchObject({
            seriesOrder: [c, a, b],
            baseRevisionId: first.revisionId,
            conflicts: [{ field: 'seriesOrder', base: [a, b], active: [a, b, c] }],
        });
        const blocked = await publish({ dataRoot: root, actor: 'test', logger: quiet });
        expect(blocked.outcome).toBe('VALIDATION_FAILED');
        expect(blocked.issues).toContainEqual(expect.objectContaining({ code: 'working.conflicts' }));
        expect((await readActivePointer(root))?.revisionId).toBe(first.revisionId);

        // Rolling forward again, the owner's order agrees with revision 2, so the conflict naming revision 1 goes.
        const forward = await rollBack(ids(second), ids(first));
        expect(forward.conflicts).toEqual([]);
        const site = await record<AuthoredSite>('site', 'site');
        expect(site).toMatchObject({ seriesOrder: [c, a, b], baseRevisionId: second.revisionId });
        expect(site).not.toHaveProperty('conflicts');
        const unblocked = await publish({ dataRoot: root, actor: 'test', logger: quiet });
        expect(unblocked.outcome).toBe('NO_CHANGES');
        expect((await readActivePointer(root))?.revisionId).toBe(second.revisionId);
    });

    it('keeps a Work order and featured edit made after a first publish that couldn\'t rebase, and publishes them with no conflict', async () => {
        // 13B's review, finding 1: the site's base is null, since nothing was published before it.
        const { catalog, root, run, edit, record } = await setup({ seed: 105, photos: 6, series: 3 });
        const [a, b, c] = catalog.series.map((series) => series.id);
        let release = () => undefined as void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let holding: Promise<void> | null = null;
        const first = await run({
            authoredWaitMs: 100,
            hooks: {
                async afterStep(step) {
                    if (step !== 12) return;
                    // A tool holds the working layer, so step 13 can't get the authored lock.
                    let taken = () => undefined as void;
                    const holds = new Promise<void>((resolve) => {
                        taken = resolve;
                    });
                    holding = withLock(AUTHORED_LOCK, { root }, async () => {
                        taken();
                        await held;
                    });
                    await holds;
                },
            },
        });
        release();
        await holding;
        expect(first.rebased).toBe(false);
        expect((await record<AuthoredSite>('site', 'site')).baseRevisionId).toBeNull();

        await edit<AuthoredSite>('site', 'site', (site) => {
            site.seriesOrder = [c, a, b];
            site.featuredSeriesIds = [b];
        });
        const second = await run();
        expect(second.recovery?.rebased?.conflicts).toEqual([]);
        const site = await record<AuthoredSite>('site', 'site');
        expect(site).toMatchObject({ seriesOrder: [c, a, b], featuredSeriesIds: [b], baseSeriesOrder: [c, a, b], baseRevisionId: second.revisionId });
        expect(site).not.toHaveProperty('conflicts');
        const published = await readRevisionFile(root, ids(second));
        expect(published?.content.series.map((series) => series.id)).toEqual([c, a, b]);
        expect(published?.content.site.featuredSeriesIds).toEqual([b]);
    });

    it.each([
        ['missing', () => undefined],
        ['damaged', (file: string) => {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, '{ not json');
        }],
    ])('keeps the owner\'s Work order with a conflict when the site\'s base revision is %s, and leaves the active revision live', async (_label, damage) => {
        const { catalog, root, run, record } = await setup({ seed: 106, photos: 6, series: 3 });
        const [a, b, c] = catalog.series.map((series) => series.id);
        const first = await run();
        const site = await record<AuthoredSite>('site', 'site');
        // A base that should exist and can't be read, on a record that never learned its base order.
        const lost = `rev_${'9'.repeat(64)}`;
        damage(revisionFilePath(root, lost));
        // With no base to compare against, the rebase can't settle a featured conflict, so it stays.
        const featured = { field: 'featuredSeriesIds', base: [b], active: [a] };
        await withLock(AUTHORED_LOCK, { root }, (lock) => writeRebasedRecord({ ...site, seriesOrder: [c, a, b], baseSeriesOrder: null, conflicts: [featured] }, { expectedVersion: site.version, lock, baseRevisionId: lost }));

        const result = await publish({ dataRoot: root, actor: 'test', logger: quiet });
        expect(result.outcome).toBe('VALIDATION_FAILED');
        expect(result.issues).toContainEqual(expect.objectContaining({ code: 'working.conflicts' }));
        expect((await readActivePointer(root))?.revisionId).toBe(first.revisionId);
        expect(await record<AuthoredSite>('site', 'site')).toMatchObject({
            seriesOrder: [c, a, b],
            featuredSeriesIds: site.featuredSeriesIds,
            baseRevisionId: first.revisionId,
            conflicts: [featured, { field: 'seriesOrder', base: [], active: [a, b, c] }],
        });
    });

    it('keeps a stored Work order conflict when a repeated entry leaves the order undecided', async () => {
        const { catalog, run, edit, record, rollBack } = await setup({ seed: 108, photos: 6, series: 3 });
        const [a, b, c] = catalog.series.map((series) => series.id);
        const first = await run();
        await edit<AuthoredSite>('site', 'site', (site) => {
            site.seriesOrder = [b, a, c];
        });
        const second = await run();
        const stored = { field: 'seriesOrder', base: [a, b, c], active: [b, a, c] };
        await edit<AuthoredSite>('site', 'site', (site) => {
            // A hand edit repeats a slot. refs.series-order blocks publish until it's fixed.
            site.seriesOrder = [c, b, a, a];
            site.conflicts = [stored];
        });

        const report = await rollBack(ids(first), ids(second));
        expect(report.conflicts).toEqual([]);
        expect(await record<AuthoredSite>('site', 'site')).toMatchObject({ seriesOrder: [c, b, a, a], conflicts: [stored] });
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

    it('replaces an older conflict on a field it compares, drops one that field no longer has, and keeps one on a field it can\'t compare', async () => {
        const { catalog, run, edit, record, rollBack } = await setup({ seed: 96, photos: 3, series: [{ photos: 2 }, { photos: 1, visibility: 'draft' }] });
        const photoId = catalog.photos[0].id;
        const draft = catalog.series[1].id;
        const first = await run();
        await edit<AuthoredPhoto>('photo', photoId, (photo) => {
            photo.caption = 'The caption revision 2 publishes.';
        });
        const second = await run();
        await edit<AuthoredPhoto>('photo', photoId, (photo) => {
            photo.caption = 'The curator\'s caption.';
            // The photo's title is the same on both sides now, so this one is settled.
            photo.conflicts = [{ field: 'title', base: 'Older title', active: 'Old title' }, { field: 'caption', base: 'stale', active: 'staler' }];
        });
        // Neither revision publishes the draft, so the rebase can't compare its title.
        const titleConflict = { field: 'title', base: 'Older title', active: 'Old title' };
        await edit<AuthoredSeries>('series', draft, (series) => {
            series.conflicts = [titleConflict];
        });

        await rollBack(ids(first), ids(second));
        expect((await record<AuthoredPhoto>('photo', photoId)).conflicts).toEqual([{ field: 'caption', base: 'The caption revision 2 publishes.', active: null }]);
        expect((await record<AuthoredSeries>('series', draft)).conflicts).toEqual([titleConflict]);
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
