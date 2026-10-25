// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PHOTO_ID_RE } from '../../identity/ids';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../../identity/variants';
import { homeRouteOf, type PublishedHome } from '../../catalog/projections/home';
import type { PublishedSeriesPage } from '../../catalog/projections/series';
import type { PublishedViewerPhoto } from '../../catalog/projections/viewer';
import type { WorkCatalog } from '../../catalog/projections/work';
import { createCatalogReader, createRouteBuilder, type CatalogReader } from '../../catalog/reader';
import { buildTestCatalog, createTestCatalog, type TestCatalogContent } from '../../catalog/testing';
import { KIB, SCREEN_BUDGETS, type Screen } from '../budgets';
import { BUDGET_FIXTURE, BUDGET_VARIANT_BYTES, buildBudgetFixture } from '../fixture';
import { imagesIn, payloadSize, type PayloadSize } from '../measure';

/**
 * #6's payload budgets: each screen's read model on the 5,000-photo fixture,
 * serialized and gzipped, against lib/perf/budgets.ts. To print the numbers:
 *
 *     BUDGETS_REPORT=1 npx vitest run lib/perf/__tests__/budgets.test.ts
 */

const routes = createRouteBuilder();
const PHOTO_IDS_RE = new RegExp(PHOTO_ID_RE.source.slice(1, -1), 'g');

let fixture: TestCatalogContent;
/** One reader for every model, as one request reads one revision. */
let reader: CatalogReader<TestCatalogContent['content']['photos'][number]>;
let buildMs = 0;
/** The largest model per screen, for the report. */
const report = new Map<Screen, { size: PayloadSize; records: number; models: number; note: string }>();

function record(screen: Screen, size: PayloadSize, records: number, note: string) {
    const previous = report.get(screen);
    const models = (previous?.models ?? 0) + 1;
    if (!previous || size.gzipBytes > previous.size.gzipBytes) report.set(screen, { size, records, models, note });
    else previous.models = models;
}

function photoIdsIn(model: unknown): Set<string> {
    return new Set(JSON.stringify(model).match(PHOTO_IDS_RE) ?? []);
}

function home(): PublishedHome {
    const result = homeRouteOf({ mode: 'catalog', state: 'ok', reader }, routes);
    if (result.kind !== 'home') throw new Error(`Expected Home, got ${result.kind}`);
    return result.home;
}

function seriesPage(slug: string): PublishedSeriesPage {
    const result = reader.getSeriesPage(slug, routes);
    if (result.kind !== 'ok') throw new Error(`Expected the page for ${slug}, got ${result.kind}`);
    return result.page;
}

function viewer(slug: string, photoId: string): PublishedViewerPhoto {
    const result = reader.getViewerPhoto(slug, photoId);
    if (result.kind !== 'ok') throw new Error(`Expected the Viewer for ${photoId}, got ${result.kind}`);
    return result.viewer;
}

/** Every image a screen ships reserves its box: the photo's own positive integer size, and a full ladder. */
function expectGeometry(model: unknown) {
    const integer = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n > 0;
    for (const image of imagesIn(model)) {
        expect(integer(image.width) && integer(image.height), JSON.stringify(image).slice(0, 120)).toBe(true);
        const ladder = image.variants as Record<string, Record<string, { url: string; width: number }>>;
        for (const width of VARIANT_WIDTHS) for (const format of VARIANT_FORMATS) expect(integer(ladder[width][format].width)).toBe(true);
    }
}

beforeAll(async () => {
    const started = performance.now();
    fixture = await buildBudgetFixture();
    buildMs = Math.round(performance.now() - started);
    reader = createCatalogReader(fixture.content, { revisionId: fixture.revisionId, revisionNumber: null });
}, 120_000);

afterAll(() => {
    if (!process.env.BUDGETS_REPORT) return;
    const rows = [...report].map(([screen, { size, records, models, note }]) => ({
        screen,
        models,
        'largest: records': records,
        'raw KiB': (size.bytes / KIB).toFixed(1),
        'gzip KiB': (size.gzipBytes / KIB).toFixed(1),
        'budget KiB': SCREEN_BUDGETS[screen].gzipBytes / KIB,
        note,
    }));
    console.info(`#6 budget fixture: ${fixture.content.photos.length} photos, ${fixture.content.series.length} series, built in ${buildMs} ms`);
    console.table(rows);
});

describe('the budget fixture', () => {
    it('holds 5,000 photographs across 100 published series, each with the declared variant sizes', () => {
        expect(fixture.content.series).toHaveLength(100);
        expect(fixture.content.photos).toHaveLength(5_000);
        expect(new Set(fixture.content.series.flatMap((series) => series.photoIds)).size).toBe(5_000);
        for (const photo of fixture.content.photos) {
            for (const width of VARIANT_WIDTHS) for (const format of VARIANT_FORMATS) expect(photo.variants[width][format].bytes).toBe(BUDGET_VARIANT_BYTES[width][format]);
        }
    });

    it('is the catalog createTestCatalog() writes for the same options', async () => {
        // A smaller run of the same options: the write path is the same compose step, and 5,000 photos on disk take minutes.
        const options = { ...BUDGET_FIXTURE, photos: 40, series: 4 };
        const written = await createTestCatalog(options);
        try {
            const built = await buildTestCatalog(options);
            expect(built.revisionId).toBe(written.revisionId);
            expect(built.content).toEqual(written.content);
            expect({ site: built.site, series: built.series, photos: built.photos }).toEqual({ site: written.site, series: written.series, photos: written.photos });
        } finally {
            await written.cleanup();
        }
    });

    it('gives the same revision for the same options', async () => {
        expect((await buildBudgetFixture()).revisionId).toBe(fixture.revisionId);
    });
});

describe('the budgets', () => {
    it('hold the approved guardrails, so a change shows up in review', () => {
        expect(SCREEN_BUDGETS).toEqual({
            home: { gzipBytes: 51_200, eagerFullSizeDerivatives: 2 },
            work: { gzipBytes: 102_400, photoSequences: 0 },
            seriesFirstPage: { gzipBytes: 102_400, photoRecords: 100 },
            viewer: { gzipBytes: 10_240, photoRecords: 1 },
        });
    });
});

describe('payloads on the 5,000-photo fixture', () => {
    it('Home: the featured series stays within its compressed budget', () => {
        const model = home();
        const featured = model.featuredSeries;
        if (!featured) throw new Error('Expected a featured series');
        const size = payloadSize(model);
        record('home', size, featured.photos.length, 'whole featured series until #6 PR 2 narrows it');
        expect(size.gzipBytes).toBeLessThanOrEqual(SCREEN_BUDGETS.home.gzipBytes);
        expectGeometry(model);
    });

    it('Work: every series as a summary with its cover, no photo sequence, within its compressed budget', () => {
        const model: WorkCatalog = reader.getWorkSummaries(routes);
        expect(model.series).toHaveLength(100);
        const size = payloadSize(model);
        record('work', size, imagesIn(model).length, '100 series summaries');
        expect(size.gzipBytes).toBeLessThanOrEqual(SCREEN_BUDGETS.work.gzipBytes);
        // No sequences: the only photographs Work names are the covers, one per series at most.
        const covers = new Set(model.series.flatMap((summary) => (summary.cover ? [summary.cover.photoId] : [])));
        expect(photoIdsIn(model)).toEqual(covers);
        expect(imagesIn(model)).toHaveLength(covers.size);
        expect(model.series.filter((summary) => Object.values(summary).some(Array.isArray))).toHaveLength(SCREEN_BUDGETS.work.photoSequences);
        expectGeometry(model);
    });

    it('Series: every series\' first response stays within both bounds', () => {
        for (const series of fixture.content.series) {
            const model = seriesPage(series.slug);
            const size = payloadSize(model);
            record('seriesFirstPage', size, model.entries.length, `largest of ${fixture.content.series.length} series`);
            expect(model.entries.length, series.slug).toBeLessThanOrEqual(SCREEN_BUDGETS.seriesFirstPage.photoRecords);
            expect(size.gzipBytes, series.slug).toBeLessThanOrEqual(SCREEN_BUDGETS.seriesFirstPage.gzipBytes);
            expectGeometry(model);
        }
    });

    it('Viewer: every photograph\'s model holds one photo record and its neighbors as IDs, within its compressed budget', () => {
        for (const series of fixture.content.series) {
            for (const photoId of series.photoIds) {
                const model = viewer(series.slug, photoId);
                const size = payloadSize(model);
                record('viewer', size, imagesIn(model).length, `largest of ${fixture.content.photos.length} photographs`);
                expect(imagesIn(model), photoId).toHaveLength(SCREEN_BUDGETS.viewer.photoRecords);
                const neighbors = [model.previousPhotoId, model.nextPhotoId].filter((id): id is string => id !== null);
                expect(photoIdsIn(model), photoId).toEqual(new Set([photoId, ...neighbors]));
                expect(size.gzipBytes, photoId).toBeLessThanOrEqual(SCREEN_BUDGETS.viewer.gzipBytes);
            }
        }
        expectGeometry(viewer(fixture.content.series[0].slug, fixture.content.series[0].photoIds[0]));
    });
});
