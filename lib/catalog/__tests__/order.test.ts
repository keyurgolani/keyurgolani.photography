// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importGraph } from '../../../test/helpers/importGraph';
import { featuredSeries, orderedPhotos, orderedSeries, rebaseSeriesOrder, sequencePosition } from '../order';
import { createCatalogReader } from '../reader';
import { createTestCatalog, type TestCatalog } from '../testing';

let catalog: TestCatalog;

beforeAll(async () => {
    // Work and featured order both differ from spec order and ID order, so a sort would show.
    catalog = await createTestCatalog({
        seed: 8,
        photos: 9,
        series: 3,
        seriesOrder: ['ser_fixture-03', 'ser_fixture-01', 'ser_fixture-02'],
        featuredSeriesIds: ['ser_fixture-02', 'ser_fixture-03'],
    });
});

afterAll(async () => {
    await catalog.cleanup();
});

const revision = () => ({ content: catalog.content });
const ids = (list: readonly { id: string }[]) => list.map((entry) => entry.id);

describe('the order helpers', () => {
    it('return series in Work order and featured series in featured order', () => {
        expect(ids(orderedSeries(revision()))).toEqual(['ser_fixture-03', 'ser_fixture-01', 'ser_fixture-02']);
        expect(ids(featuredSeries(revision()))).toEqual(['ser_fixture-02', 'ser_fixture-03']);
    });

    it('return a series\' photos in photoIds order, not the ID order revisions store them in', () => {
        for (const series of catalog.content.series) {
            expect(ids(orderedPhotos(revision(), series.id))).toEqual(series.photoIds);
        }
        const stored = ids(catalog.content.photos);
        expect(stored).toEqual([...stored].sort());
        expect(catalog.content.series.flatMap((series) => series.photoIds)).not.toEqual(stored);
    });

    it('return nothing for a series the revision doesn\'t hold', () => {
        expect(orderedPhotos(revision(), 'ser_fixture-09')).toEqual([]);
    });

    it('give the same order on every call, the order the catalog reader uses', () => {
        const reader = createCatalogReader(catalog.content, { revisionId: catalog.revisionId, revisionNumber: null });
        expect(ids(orderedSeries(revision()))).toEqual(ids(reader.listSeries()));
        for (const series of catalog.content.series) {
            expect(ids(orderedPhotos(revision(), series.id))).toEqual(ids(reader.photosOf(series.id)));
            expect(ids(orderedPhotos(revision(), series.id))).toEqual(ids(orderedPhotos(revision(), series.id)));
        }
    });

    it('give a photo\'s position, with no neighbor past either end', () => {
        const series = { photoIds: ['ph_a', 'ph_b', 'ph_c'] };
        expect(sequencePosition(series, 'ph_a')).toEqual({ index: 0, total: 3, previousPhotoId: null, nextPhotoId: 'ph_b' });
        expect(sequencePosition(series, 'ph_b')).toEqual({ index: 1, total: 3, previousPhotoId: 'ph_a', nextPhotoId: 'ph_c' });
        expect(sequencePosition(series, 'ph_c')).toEqual({ index: 2, total: 3, previousPhotoId: 'ph_b', nextPhotoId: null });
        expect(sequencePosition({ photoIds: ['ph_a'] }, 'ph_a')).toEqual({ index: 0, total: 1, previousPhotoId: null, nextPhotoId: null });
        expect(sequencePosition(series, 'ph_d')).toBeNull();
    });

    it('reach no fs, lock, writer, or Next module', () => {
        const graph = importGraph('lib/catalog/order.ts');
        expect(graph.files).toContain('lib/catalog/order.ts');
        expect(graph.files.filter((file) => /storage\/lock|working-layer-writer|sequence/.test(file))).toEqual([]);
        const packages = [...graph.packages.values()].flat();
        expect(packages.filter((name) => /^(?:node:)?fs(?:\/|$)|^next(?:\/|$)/.test(name))).toEqual([]);
    });
});

describe('rebaseSeriesOrder', () => {
    const A = 'ser_a';
    const B = 'ser_b';
    const C = 'ser_c';

    /** The site record's two order fields, as a rebase leaves them. */
    interface Site {
        seriesOrder: string[];
        baseSeriesOrder: string[] | null;
    }

    /** One rebase as #13's rebaseWorkingLayer() runs it, storing seriesOrder and baseSeriesOrder from the result. */
    function rebase(site: Site, base: string[], target: string[], baseAuthored = site.baseSeriesOrder) {
        const result = rebaseSeriesOrder({ authored: site.seriesOrder, baseAuthored, base, target });
        return { site: { seriesOrder: result.seriesOrder, baseSeriesOrder: result.baseSeriesOrder }, conflict: result.conflict };
    }

    /** A publish's step 13: the base is what it compiled, so the target, and the base Work order is the one it compiled from. */
    const published = (site: Site, compiledFrom: string[], target: string[]) => rebase(site, target, target, compiledFrom);

    it('gives an untouched Work order the target\'s order within the slots published series hold', () => {
        // ser_d is a draft and ser_h is hidden: neither is in a revision, so both keep their slots.
        const authored = ['ser_a', 'ser_d', 'ser_b', 'ser_h', 'ser_c'];
        expect(rebaseSeriesOrder({ authored, baseAuthored: authored, base: [A, B, C], target: [C, A, B] }))
            .toEqual({ seriesOrder: [C, 'ser_d', A, 'ser_h', B], baseSeriesOrder: [C, 'ser_d', A, 'ser_h', B], conflict: null });
    });

    it('keeps a series the target doesn\'t publish where it is, and adds none the owner never listed', () => {
        expect(rebaseSeriesOrder({ authored: [A, B, C], baseAuthored: [A, B, C], base: [A, B, C], target: ['ser_x', B, A] }))
            .toEqual({ seriesOrder: [B, A, C], baseSeriesOrder: [B, A, C], conflict: null });
    });

    it('places a newly published series by the target only when the owner left the order as the last rebase did', () => {
        expect(rebaseSeriesOrder({ authored: [A, 'ser_new', B], baseAuthored: [A, 'ser_new', B], base: [A, B], target: [B, 'ser_new', A] }))
            .toEqual({ seriesOrder: [B, 'ser_new', A], baseSeriesOrder: [B, 'ser_new', A], conflict: null });
    });

    it('keeps the owner\'s move of a series the base didn\'t publish, with a conflict when the target places it elsewhere', () => {
        // The owner moved ser_new to the middle after the last rebase put it at the end.
        expect(rebaseSeriesOrder({ authored: [A, 'ser_new', B], baseAuthored: [A, B, 'ser_new'], base: [A, B], target: [B, 'ser_new', A] })).toEqual({
            seriesOrder: [A, 'ser_new', B],
            baseSeriesOrder: [B, 'ser_new', A],
            conflict: { field: 'seriesOrder', base: [A, B], active: [B, 'ser_new', A] },
        });
        // The review's P1b: ser_c wasn't published at the base, and the target publishes it where the owner's move took it from.
        expect(rebaseSeriesOrder({ authored: [C, A, B], baseAuthored: [A, B, C], base: [A, B], target: [A, B, C] })).toEqual({
            seriesOrder: [C, A, B],
            baseSeriesOrder: [A, B, C],
            conflict: { field: 'seriesOrder', base: [A, B], active: [A, B, C] },
        });
    });

    it('keeps the owner\'s order when only the owner changed it, draft slots included', () => {
        expect(rebaseSeriesOrder({ authored: [B, 'ser_d', A], baseAuthored: [A, 'ser_d', B], base: [A, B], target: [A, B] }))
            .toEqual({ seriesOrder: [B, 'ser_d', A], baseSeriesOrder: [A, 'ser_d', B], conflict: null });
        // A move of a draft alone is the owner's change too: its order stays, and a target that reorders the rest conflicts.
        expect(rebaseSeriesOrder({ authored: [A, B, 'ser_d'], baseAuthored: ['ser_d', A, B], base: [A, B], target: [B, A] }))
            .toEqual({ seriesOrder: [A, B, 'ser_d'], baseSeriesOrder: ['ser_d', B, A], conflict: { field: 'seriesOrder', base: [A, B], active: [B, A] } });
    });

    it('keeps the owner\'s order without a conflict when both sides made the same change', () => {
        expect(rebaseSeriesOrder({ authored: [B, A], baseAuthored: [A, B], base: [A, B], target: [B, A] }))
            .toEqual({ seriesOrder: [B, A], baseSeriesOrder: [B, A], conflict: null });
    });

    it('keeps the owner\'s order and reports a conflict when both sides changed it differently', () => {
        expect(rebaseSeriesOrder({ authored: [B, A, C], baseAuthored: [A, B, C], base: [A, B, C], target: [A, C, B] })).toEqual({
            seriesOrder: [B, A, C],
            baseSeriesOrder: [A, C, B],
            conflict: { field: 'seriesOrder', base: [A, B, C], active: [A, C, B] },
        });
    });

    describe('with no base to compare', () => {
        it('keeps the owner\'s order when the base Work order is unknown and the base revision is empty (the review\'s P1a)', () => {
            expect(rebaseSeriesOrder({ authored: [C, A, B], baseAuthored: null, base: [], target: [A, B, C] })).toEqual({
                seriesOrder: [C, A, B],
                baseSeriesOrder: [A, B, C],
                conflict: { field: 'seriesOrder', base: [], active: [A, B, C] },
            });
        });

        it('keeps the owner\'s order when the base Work order was empty', () => {
            expect(rebaseSeriesOrder({ authored: [C, A, B], baseAuthored: [], base: [], target: [A, B, C] })).toMatchObject({ seriesOrder: [C, A, B], conflict: { field: 'seriesOrder' } });
        });

        it('keeps the owner\'s order without a conflict when the target agrees or didn\'t change', () => {
            expect(rebaseSeriesOrder({ authored: [C, A, B], baseAuthored: null, base: [], target: [C, A, B] }))
                .toEqual({ seriesOrder: [C, A, B], baseSeriesOrder: [C, A, B], conflict: null });
            expect(rebaseSeriesOrder({ authored: [C, A, B], baseAuthored: null, base: [A, B, C], target: [A, B, C] }))
                .toEqual({ seriesOrder: [C, A, B], baseSeriesOrder: [A, B, C], conflict: null });
        });

        it('keeps the move through a first publish whose rebase never ran, and the next publish (13B\'s finding 1)', () => {
            // The first publish compiled [A, B, C], but step 13 couldn't get the lock, so the record keeps a null base.
            let site: Site = { seriesOrder: [A, B, C], baseSeriesOrder: null };
            site = { ...site, seriesOrder: [C, A, B] };
            const recovered = rebase(site, [], [A, B, C]);
            expect(recovered.site.seriesOrder).toEqual([C, A, B]);
            expect(recovered.conflict).not.toBeNull();
        });
    });

    describe('over several rebases', () => {
        it('keeps a move of a hidden series through a rollback to a revision that publishes it, then publishes it (the review\'s P3)', () => {
            // R1 publishes A, B, C. Then the owner hides C and R2 publishes A, B.
            let site: Site = published({ seriesOrder: [A, B, C], baseSeriesOrder: null }, [A, B, C], [A, B, C]).site;
            site = published(site, [A, B, C], [A, B]).site;
            expect(site).toEqual({ seriesOrder: [A, B, C], baseSeriesOrder: [A, B, C] });

            // The owner moves the hidden C to the front, and #15 rolls back to R1.
            site = { ...site, seriesOrder: [C, A, B] };
            const rolledBack = rebase(site, [A, B], [A, B, C]);
            expect(rolledBack.site.seriesOrder).toEqual([C, A, B]);
            expect(rolledBack.conflict).toEqual({ field: 'seriesOrder', base: [A, B], active: [A, B, C] });

            // Rolling forward to R2 again keeps it too, now with no conflict, since R2 is R1 with C taken out.
            const forward = rebase(rolledBack.site, [A, B, C], [A, B]);
            expect(forward).toEqual({ site: { seriesOrder: [C, A, B], baseSeriesOrder: [A, B, C] }, conflict: null });

            // The owner publishes C again, and the publish compiles C, A, B. Its step 13 makes that the base.
            const republished = published(forward.site, [C, A, B], [C, A, B]);
            expect(republished).toEqual({ site: { seriesOrder: [C, A, B], baseSeriesOrder: [C, A, B] }, conflict: null });

            // From there an untouched order follows the target again.
            expect(rebase(republished.site, [C, A, B], [A, C, B]).site).toEqual({ seriesOrder: [A, C, B], baseSeriesOrder: [A, C, B] });
        });

        it('keeps a move the target didn\'t publish pending, so a later rebase still sees it as the owner\'s', () => {
            let site: Site = published({ seriesOrder: [A, B, C], baseSeriesOrder: null }, [A, B, C], [A, B, C]).site;
            site = { ...site, seriesOrder: [B, A, C] };
            // A rollback to a revision with the base's order: the owner's move stays, with nothing to conflict with.
            const first = rebase(site, [A, B, C], [A, B, C]);
            expect(first).toEqual({ site: { seriesOrder: [B, A, C], baseSeriesOrder: [A, B, C] }, conflict: null });
            // A second rollback, to a revision that reorders: still the owner's move, now in conflict. Storing the
            // merged order as the base would have read the move as untouched here and put [C, A, B] in its place.
            const second = rebase(first.site, [A, B, C], [C, A, B]);
            expect(second.site.seriesOrder).toEqual([B, A, C]);
            expect(second.conflict).toEqual({ field: 'seriesOrder', base: [A, B, C], active: [C, A, B] });
        });

        it('keeps an edit made while a publish ran as the owner\'s, not the base', () => {
            // The publish compiled [A, B, C], and the owner moved C up while it ran.
            const site: Site = { seriesOrder: [A, C, B], baseSeriesOrder: [A, B, C] };
            const after = published(site, [A, B, C], [A, B, C]);
            expect(after).toEqual({ site: { seriesOrder: [A, C, B], baseSeriesOrder: [A, B, C] }, conflict: null });
            expect(rebase(after.site, [A, B, C], [B, A, C]).site.seriesOrder).toEqual([A, C, B]);
        });
    });

    it('leaves a Work order with a repeated entry as it is', () => {
        expect(rebaseSeriesOrder({ authored: [A, B, A], baseAuthored: [A, B], base: [A, B], target: [B, A] }))
            .toEqual({ seriesOrder: [A, B, A], baseSeriesOrder: [A, B], conflict: null });
        expect(rebaseSeriesOrder({ authored: [A, B], baseAuthored: [A, A], base: [A, B], target: [B, A] }))
            .toMatchObject({ seriesOrder: [A, B], baseSeriesOrder: [B, A] });
    });

    it('does not change its inputs', () => {
        const input = { authored: [A, B], baseAuthored: [B, A], base: [A, B], target: [B, A] };
        const copy = structuredClone(input);
        rebaseSeriesOrder(input);
        expect(input).toEqual(copy);
    });
});
