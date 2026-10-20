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
    it('gives an untouched Work order the target\'s order within the slots published series hold', () => {
        // ser_d is a draft and ser_h is hidden: neither is in a revision, so both keep their slots.
        expect(rebaseSeriesOrder({
            authored: ['ser_a', 'ser_d', 'ser_b', 'ser_h', 'ser_c'],
            base: ['ser_a', 'ser_b', 'ser_c'],
            target: ['ser_c', 'ser_a', 'ser_b'],
        })).toEqual({ seriesOrder: ['ser_c', 'ser_d', 'ser_a', 'ser_h', 'ser_b'], conflict: null });
    });

    it('keeps a series the target doesn\'t publish where it is, and adds none the curator never listed', () => {
        expect(rebaseSeriesOrder({
            authored: ['ser_a', 'ser_b', 'ser_c'],
            base: ['ser_a', 'ser_b', 'ser_c'],
            target: ['ser_x', 'ser_b', 'ser_a'],
        })).toEqual({ seriesOrder: ['ser_b', 'ser_a', 'ser_c'], conflict: null });
    });

    it('places a newly published series by the target, in the slot it already holds', () => {
        expect(rebaseSeriesOrder({
            authored: ['ser_a', 'ser_new', 'ser_b'],
            base: ['ser_a', 'ser_b'],
            target: ['ser_b', 'ser_new', 'ser_a'],
        })).toEqual({ seriesOrder: ['ser_b', 'ser_new', 'ser_a'], conflict: null });
    });

    it('keeps the curator\'s order when only the curator changed it', () => {
        expect(rebaseSeriesOrder({
            authored: ['ser_b', 'ser_d', 'ser_a'],
            base: ['ser_a', 'ser_b'],
            target: ['ser_a', 'ser_b'],
        })).toEqual({ seriesOrder: ['ser_b', 'ser_d', 'ser_a'], conflict: null });
    });

    it('keeps the curator\'s order without a conflict when both sides made the same change', () => {
        expect(rebaseSeriesOrder({ authored: ['ser_b', 'ser_a'], base: ['ser_a', 'ser_b'], target: ['ser_b', 'ser_a'] }))
            .toEqual({ seriesOrder: ['ser_b', 'ser_a'], conflict: null });
    });

    it('keeps the curator\'s order and reports a conflict when both sides changed it differently', () => {
        expect(rebaseSeriesOrder({
            authored: ['ser_b', 'ser_a', 'ser_c'],
            base: ['ser_a', 'ser_b', 'ser_c'],
            target: ['ser_a', 'ser_c', 'ser_b'],
        })).toEqual({
            seriesOrder: ['ser_b', 'ser_a', 'ser_c'],
            conflict: { field: 'seriesOrder', base: ['ser_a', 'ser_b', 'ser_c'], active: ['ser_a', 'ser_c', 'ser_b'] },
        });
    });

    it('leaves a Work order with a repeated entry as it is', () => {
        expect(rebaseSeriesOrder({ authored: ['ser_a', 'ser_b', 'ser_a'], base: ['ser_a', 'ser_b'], target: ['ser_b', 'ser_a'] }))
            .toEqual({ seriesOrder: ['ser_a', 'ser_b', 'ser_a'], conflict: null });
    });

    it('does not change its inputs', () => {
        const input = { authored: ['ser_a', 'ser_b'], base: ['ser_a', 'ser_b'], target: ['ser_b', 'ser_a'] };
        const copy = structuredClone(input);
        rebaseSeriesOrder(input);
        expect(input).toEqual(copy);
    });
});
