// @vitest-environment node
import fs from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import SeriesCatalog from '../../../components/work/SeriesCatalog';
import { PHOTO_ID_RE } from '../../identity/ids';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../../identity/variants';
import { homeRouteOf, homeSeriesPhotosOf, type PublishedHome } from '../../catalog/projections/home';
import type { PublishedSeriesPage } from '../../catalog/projections/series';
import type { PublishedViewerPhoto } from '../../catalog/projections/viewer';
import type { WorkCatalog } from '../../catalog/projections/work';
import { createCatalogReader, createRouteBuilder, type CatalogReader } from '../../catalog/reader';
import { buildTestCatalog, createTestCatalog, type TestCatalogContent } from '../../catalog/testing';
import type { CandidateContent } from '../../catalog/types';
import { BROWSER_BUDGETS, FIRST_IMAGE_MS, HOME_ID_LIST_PHOTOS, KIB, SCREEN_BUDGETS } from '../budgets';
import { BUDGET_PHOTOS, BUDGET_VARIANT_BYTES, budgetFixtureOptions, buildBudgetFixture, FEATURED_PHOTOS, FIXED_SERIES_PHOTOS, LONG_COPY, LONG_SERIES_PHOTOS, REAL_LENGTH_POSITION, seriesSizes } from '../fixture';
import { arraysIn, imagesIn, measureCatalogBudgets, payloadSize, type PayloadSize } from '../measure';
import type { CatalogBudgetMeasurement, CatalogBudgetScreen } from '../catalog-budgets';
import { catalogSection } from '../report';

/**
 * #6's payload budgets: each screen's read model on the 5,000-photo fixture,
 * serialized and gzipped, against lib/perf/budgets.ts. To print the numbers:
 *
 *     BUDGETS_REPORT=1 npx vitest run lib/perf/__tests__/budgets.test.ts --reporter=default
 *
 * (Vitest may pick a reporter that hides a passing test's console output; `--reporter=default` shows it.)
 * `npm run test:budgets` writes the same figures, from measureCatalogBudgets(), to `.perf/report.json`.
 */

const routes = createRouteBuilder();
const PHOTO_IDS_RE = new RegExp(PHOTO_ID_RE.source.slice(1, -1), 'g');

let fixture: TestCatalogContent;
/** One reader for every model, as one request reads one revision. */
let reader: CatalogReader<TestCatalogContent['content']['photos'][number]>;
let buildMs = 0;
let measured: CatalogBudgetMeasurement;
/** The largest model per screen, for the report. */
const report = new Map<CatalogBudgetScreen, { size: PayloadSize; records: number; models: number; note: string }>();

function record(screen: CatalogBudgetScreen, size: PayloadSize, records: number, note: string) {
    const previous = report.get(screen);
    const models = (previous?.models ?? 0) + 1;
    if (!previous || size.gzipBytes > previous.size.gzipBytes) report.set(screen, { size, records, models, note });
    else previous.models = models;
}

function photoIdsIn(model: unknown): Set<string> {
    return new Set(JSON.stringify(model).match(PHOTO_IDS_RE) ?? []);
}

function readerOf(content: CandidateContent, revisionId: string) {
    return createCatalogReader(content, { revisionId, revisionNumber: null });
}

function home(): PublishedHome {
    const result = homeRouteOf({ state: 'ok', reader }, routes);
    if (result.kind !== 'home') throw new Error(`Expected Home, got ${result.kind}`);
    return result.home;
}

function seriesPage(slug: string, from = reader): PublishedSeriesPage {
    const result = from.getSeriesPage(slug, routes);
    if (result.kind !== 'ok') throw new Error(`Expected the page for ${slug}, got ${result.kind}`);
    return result.page;
}

function viewer(slug: string, photoId: string): PublishedViewerPhoto {
    const result = reader.getViewerPhoto(slug, photoId);
    if (result.kind !== 'ok') throw new Error(`Expected the Viewer for ${photoId}, got ${result.kind}`);
    return result.viewer;
}

const cursorOf = (nextHref: string) => nextHref.slice(nextHref.lastIndexOf('/') + 1);
const lengthsOf = (content: CandidateContent) => content.series.map((series) => series.photoIds.length);
const authoredPhoto = (id: string) => {
    const photo = fixture.photos.find((entry) => entry.id === id);
    if (!photo) throw new Error(`No authored record for ${id}`);
    return photo;
};
const share = (count: number, of: number) => count / of;

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
    reader = readerOf(fixture.content, fixture.revisionId);
    measured = measureCatalogBudgets(reader);
}, 120_000);

afterAll(() => {
    if (!process.env.BUDGETS_REPORT) return;
    const rows = [...report].map(([screen, { size, records, models, note }]) => ({
        screen,
        models,
        'largest: records': records,
        'raw KiB': (size.bytes / KIB).toFixed(1),
        'gzip KiB': (size.gzipBytes / KIB).toFixed(1),
        'budget KiB': SCREEN_BUDGETS[screen === 'seriesContinuationPage' ? 'seriesFirstPage' : screen].gzipBytes / KIB,
        note,
    }));
    console.info(`#6 budget fixture: ${fixture.content.photos.length} photos, ${fixture.content.series.length} series, built in ${buildMs} ms`);
    console.table(rows);
    console.info('measureCatalogBudgets():');
    console.table(catalogSection(measured).rows);
});

describe('the budget fixture', () => {
    it('holds 5,000 photographs across 100 published series, skewed: the featured 100 first, 1,200, three of 300, page edges, one single photograph', () => {
        expect(BUDGET_PHOTOS).toBe(5_000);
        expect(fixture.content.series).toHaveLength(100);
        expect(fixture.content.photos).toHaveLength(5_000);
        const lengths = lengthsOf(fixture.content);
        expect(lengths).toEqual(seriesSizes(5_000));
        // The fixed series lead Work's order: the featured one, the long one, three of 300, the edges of one and two
        // 100-record pages, and a single photograph. The other 89 split the rest.
        expect(FIXED_SERIES_PHOTOS).toEqual([FEATURED_PHOTOS, LONG_SERIES_PHOTOS, 300, 300, 300, 99, 101, 199, 200, 201, 1]);
        expect(lengths.slice(0, FIXED_SERIES_PHOTOS.length)).toEqual(FIXED_SERIES_PHOTOS);
        expect(new Set(lengths.slice(FIXED_SERIES_PHOTOS.length))).toEqual(new Set([22, 23]));
        expect(fixture.content.site.featuredSeriesIds).toEqual([fixture.content.series[0].id]);
        expect(new Set(fixture.content.series.flatMap((series) => series.photoIds)).size).toBe(5_000);
        for (const photo of fixture.content.photos) {
            for (const width of VARIANT_WIDTHS) for (const format of VARIANT_FORMATS) expect(photo.variants[width][format].bytes).toBe(BUDGET_VARIANT_BYTES[width][format]);
        }
    });

    it('carries real-length copy: a tenth of photographs and series at length, 2% decorative, and the long series\' photograph 600 always', () => {
        const photos = fixture.photos;
        const long = photos.filter((photo) => photo.alt?.kind === 'described' && [...photo.alt.text].length === LONG_COPY.alt);
        expect(LONG_COPY).toEqual({ alt: 250, caption: 600, title: 80, seriesTitle: 80, statement: 1_200, shortStatement: 300 });
        expect(share(long.length, photos.length)).toBeGreaterThan(0.08);
        expect(share(long.length, photos.length)).toBeLessThan(0.12);
        for (const photo of long) expect([[...(photo.caption ?? '')].length, [...(photo.title ?? '')].length]).toEqual([LONG_COPY.caption, LONG_COPY.title]);
        const decorative = photos.filter((photo) => photo.alt?.kind === 'decorative');
        expect(share(decorative.length, photos.length)).toBeGreaterThan(0.01);
        expect(share(decorative.length, photos.length)).toBeLessThan(0.03);
        const realLength = authoredPhoto(fixture.content.series[1].photoIds[REAL_LENGTH_POSITION]);
        expect(realLength.alt?.kind === 'described' && [...realLength.alt.text].length).toBe(LONG_COPY.alt);
        expect([...(realLength.caption ?? '')].length).toBe(LONG_COPY.caption);
        const longSeries = fixture.content.series.filter((series) => [...series.statement].length === LONG_COPY.statement);
        expect(longSeries.length).toBeGreaterThanOrEqual(5);
        expect(longSeries.length).toBeLessThanOrEqual(15);
        for (const series of longSeries) expect([[...series.title].length, [...series.shortStatement].length]).toEqual([LONG_COPY.seriesTitle, LONG_COPY.shortStatement]);
    });

    it('mixes shapes: about 30% portrait, a few 3:1 panoramas, 5% shown whole with two in the featured series, a fifth off-center, and plain covers', () => {
        const photos = fixture.content.photos;
        const portrait = photos.filter((photo) => photo.height > photo.width);
        const panorama = photos.filter((photo) => photo.width === 3 * photo.height);
        expect(share(portrait.length, photos.length)).toBeGreaterThan(0.25);
        expect(share(portrait.length, photos.length)).toBeLessThan(0.36);
        expect(panorama.length).toBeGreaterThan(50);
        expect(share(panorama.length, photos.length)).toBeLessThan(0.06);
        const contain = photos.filter((photo) => photo.crop === 'contain');
        expect(share(contain.length, photos.length)).toBeGreaterThan(0.035);
        expect(share(contain.length, photos.length)).toBeLessThan(0.065);
        const offCenter = photos.filter((photo) => photo.focalPoint && (photo.focalPoint.x !== 0.5 || photo.focalPoint.y !== 0.5));
        expect(share(offCenter.length, photos.length)).toBeGreaterThan(0.16);
        expect(share(offCenter.length, photos.length)).toBeLessThan(0.24);

        // The featured series has no panorama, two photographs shown whole, and opens on two plain landscapes, which
        // Home loads eagerly and e2e/first-viewport.spec.ts sizes. No cover is a panorama or shown whole, so Work's
        // first viewport asks for the rungs it always has.
        const byId = new Map(photos.map((photo) => [photo.id, photo]));
        const [featured] = fixture.content.series;
        const members = featured.photoIds.map((id) => byId.get(id)!);
        expect(members.filter((photo) => photo.width === 3 * photo.height)).toEqual([]);
        expect(members.filter((photo) => photo.crop === 'contain')).toHaveLength(2);
        for (const photo of members.slice(0, 2)) {
            expect([photo.width, photo.height, photo.crop, photo.focalPoint]).toEqual([2400, 1600, undefined, undefined]);
            expect(authoredPhoto(photo.id).alt).toMatchObject({ kind: 'described', reviewed: true });
        }
        for (const series of fixture.content.series) {
            const cover = byId.get(series.cover!.photoId)!;
            expect(cover.width === 3 * cover.height || cover.crop === 'contain', series.slug).toBe(false);
            expect(authoredPhoto(cover.id).alt?.kind, series.slug).toBe('described');
        }
    });

    it('with --photos 500 keeps the 100 series, the featured 100 and every series record, and shrinks the rest', async () => {
        const small = await buildBudgetFixture({ photos: 500 });
        expect(small.content.photos).toHaveLength(500);
        expect(small.content.series).toHaveLength(100);
        const lengths = lengthsOf(small.content);
        expect(lengths).toEqual(seriesSizes(500));
        expect(lengths[0]).toBe(FEATURED_PHOTOS);
        expect(Math.min(...lengths)).toBeGreaterThanOrEqual(1);
        expect(lengths[1]).toBeGreaterThan(lengths[2]);
        // Series records come from the seed, whatever the photo count, and so do the covers.
        const authored = (series: TestCatalogContent['series']) => series.map(({ photoIds: _ids, cover: _cover, ...rest }) => rest);
        expect(authored(small.series)).toEqual(authored(fixture.series));
        expect(small.content.series.map((series) => series.cover)).toEqual(fixture.content.series.map((series) => series.cover));
        expect(() => budgetFixtureOptions({ photos: 198 })).toThrow(/at least 199/);
    });

    it('as --variant b reorders the long series and drops a photograph from the 101, so variant a\'s cursor gets revision-changed', async () => {
        const b = await buildBudgetFixture({ variant: 'b' });
        expect(b.revisionId).not.toBe(fixture.revisionId);
        const [aLong, bLong] = [fixture.content.series[1], b.content.series[1]];
        expect(bLong.photoIds).not.toEqual(aLong.photoIds);
        expect([...bLong.photoIds].sort()).toEqual([...aLong.photoIds].sort());
        expect(bLong.cover).toEqual(aLong.cover);
        const edge = fixture.content.series.findIndex((series) => series.photoIds.length === 101);
        expect(b.content.series[edge].photoIds).toEqual(fixture.content.series[edge].photoIds.slice(0, 100));
        expect(lengthsOf(b.content).filter((length, index) => length !== lengthsOf(fixture.content)[index])).toEqual([100]);

        // The 101-photograph series has a second page under variant a, and that page's cursor names variant a.
        const first = seriesPage(fixture.content.series[edge].slug);
        expect(first.nextHref).not.toBeNull();
        const continued = readerOf(b.content, b.revisionId).getSeriesContinuation(fixture.content.series[edge].slug, cursorOf(first.nextHref!), routes);
        expect(continued.kind).toBe('revision-changed');
    });

    it('is the catalog createTestCatalog() writes for the same options', async () => {
        // A smaller run of the same options: the write path is the same compose step, and 5,000 photos on disk take minutes.
        const options = budgetFixtureOptions({ photos: 200 });
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

    it('hold the browser\'s refined table on today\'s basis: documents, eager image bytes, other images, and the first image', () => {
        expect(BROWSER_BUDGETS).toEqual({
            home: { documentBytes: 133_120, eagerImageBytes: { phone: 768_000, desktop: 768_000 }, otherImageBytes: 153_600 },
            work: { documentBytes: 235_520 },
            seriesFirstPage: { documentBytes: 235_520 },
            viewer: { documentBytes: 81_920, eagerImageBytes: { phone: 409_600, desktop: 768_000 } },
        });
        expect(FIRST_IMAGE_MS).toEqual({ target: 300, gate: 1_000 });
    });

    it('say in the header what to do when one fails, in order, and how far Home\'s ID list goes', () => {
        const header = fs.readFileSync(new URL('../budgets.ts', import.meta.url), 'utf8');
        const order = ['drop fields the screen doesn\'t render', 'variant `url`s', '`lqip`', 'only then'].map((step) => header.toLowerCase().indexOf(step.toLowerCase()));
        expect(order.every((at) => at >= 0), header.slice(0, 800)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        // Limit 25: every featured series' ID list ships, so the line counts featured photographs in total.
        expect(header).toMatch(/featured photographs in total/);
        expect(header).toContain(HOME_ID_LIST_PHOTOS.toLocaleString('en-US'));
    });
});

describe('payloads on the 5,000-photo fixture', () => {
    it('Home: every ID of the featured series, records only for the opening photograph and its neighbors, within its compressed budget', () => {
        const model = home();
        const featured = model.featuredSeries;
        if (!featured) throw new Error('Expected a featured series');
        const order = fixture.content.series[0].photoIds;
        expect(featured.photoIds).toEqual(order);
        expect(order).toHaveLength(FEATURED_PHOTOS);
        // The shape, not just the bytes: a model that shipped every record again would still pass 50 KiB here.
        const at = order.indexOf(featured.openingPhotoId);
        const window = [at - 1, at, at + 1].map((index) => order[(index + order.length) % order.length]);
        expect(featured.records.map((photo) => photo.id)).toEqual(window);
        expect(imagesIn(model)).toHaveLength(window.length);
        const size = payloadSize(model);
        record('home', size, featured.records.length, `${featured.photoIds.length} IDs, ${featured.records.length} records`);
        expect(size.gzipBytes).toBeLessThanOrEqual(SCREEN_BUDGETS.home.gzipBytes);
        expectGeometry(model);
    });

    it('Home: each window Home asks for as it moves holds three records and stays far inside Home\'s budget', () => {
        const source = { revisionId: fixture.revisionId, site: () => reader.site(), listSeries: () => reader.listSeries(), photosOf: (seriesId: string) => reader.photosOf(seriesId) };
        const [series] = fixture.content.series;
        for (const photoId of series.photoIds) {
            const result = homeSeriesPhotosOf(source, series.id, photoId);
            if (result.kind !== 'ok') throw new Error(`Expected a window around ${photoId}, got ${result.kind}`);
            expect(result.window.photos, photoId).toHaveLength(3);
            expect(payloadSize(result.window).gzipBytes, photoId).toBeLessThanOrEqual(SCREEN_BUDGETS.home.gzipBytes);
            expectGeometry(result.window);
        }
    });

    it('Home with ten featured series, the long one among them: every series\' order, but still three records, within its compressed budget', () => {
        const content = structuredClone(fixture.content);
        content.site.featuredSeriesIds = content.series.slice(0, 10).map((series) => series.id);
        const looping = readerOf(content, fixture.revisionId);
        const result = homeRouteOf({ state: 'ok', reader: looping }, routes, () => 0);
        if (result.kind !== 'home' || !result.home.featuredSeries) throw new Error('Expected a featured series');
        const model = result.home;
        const loop = [model.featuredSeries!, ...(model.followingSeries ?? [])];
        expect(loop.map((series) => series.id)).toEqual(content.site.featuredSeriesIds);
        expect(loop.flatMap((series) => series.photoIds)).toHaveLength(content.series.slice(0, 10).reduce((sum, series) => sum + series.photoIds.length, 0));
        expect(model.featuredSeries!.records).toHaveLength(3);
        expect(imagesIn(model)).toHaveLength(3);
        const size = payloadSize(model);
        record('home', size, 3, `10 featured series, ${loop.flatMap((series) => series.photoIds).length} IDs, 3 records`);
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
        // At any depth: a summary and its cover hold no arrays, so a sequence without IDs (alt or sizes alone) fails too.
        expect(model.series.filter((summary) => arraysIn(summary) > 0)).toHaveLength(SCREEN_BUDGETS.work.photoSequences);
        expectGeometry(model);
    });

    it('Series: every series\' first response stays within both bounds, and the long one is cut at 100', () => {
        for (const series of fixture.content.series) {
            const model = seriesPage(series.slug);
            const size = payloadSize(model);
            record('seriesFirstPage', size, model.entries.length, `largest of ${fixture.content.series.length} series`);
            expect(model.entries.length, series.slug).toBeLessThanOrEqual(SCREEN_BUDGETS.seriesFirstPage.photoRecords);
            expect(size.gzipBytes, series.slug).toBeLessThanOrEqual(SCREEN_BUDGETS.seriesFirstPage.gzipBytes);
            expectGeometry(model);
        }
        const long = seriesPage(fixture.content.series[1].slug);
        expect([long.entries.length, long.total, long.nextHref !== null]).toEqual([SCREEN_BUDGETS.seriesFirstPage.photoRecords, LONG_SERIES_PHOTOS, true]);
    });

    it('Series: every continuation page stays within the same bounds, and each series\' pages add up to it', () => {
        // The approved bound is per response, so a continuation page is held to the first page's numbers.
        const pagesOf = (slug: string): number[] => {
            const first = seriesPage(slug);
            const lengths = [first.entries.length];
            let nextHref = first.nextHref;
            while (nextHref !== null) {
                const result = reader.getSeriesContinuation(slug, cursorOf(nextHref), routes);
                if (result.kind !== 'ok') throw new Error(`Expected a page, got ${result.kind}`);
                const size = payloadSize(result.page);
                record('seriesContinuationPage', size, result.page.entries.length, 'largest continuation page');
                expect(result.page.entries.length, slug).toBeLessThanOrEqual(SCREEN_BUDGETS.seriesFirstPage.photoRecords);
                expect(size.gzipBytes, slug).toBeLessThanOrEqual(SCREEN_BUDGETS.seriesFirstPage.gzipBytes);
                expectGeometry(result.page);
                lengths.push(result.page.entries.length);
                nextHref = result.page.nextHref;
            }
            return lengths;
        };
        for (const series of fixture.content.series) {
            const lengths = pagesOf(series.slug);
            expect(lengths.reduce((sum, length) => sum + length, 0), series.slug).toBe(series.photoIds.length);
            expect(lengths.length, series.slug).toBe(Math.ceil(series.photoIds.length / SCREEN_BUDGETS.seriesFirstPage.photoRecords));
        }
        expect(pagesOf(fixture.content.series[1].slug)).toEqual(Array.from({ length: 12 }, () => 100));
    });

    it('Series: a full page of very long copy still fits the byte bound', async () => {
        // No schema caps copy length, so the byte bound is held here rather than cut at runtime: 100 photographs, each
        // with a 1,000-character description and a 200-character title, well past real alt text. The words are random
        // syllables, which compress worse than real prose, so the number errs high.
        const consonants = 'bcdfghklmnprstvwz';
        const vowels = 'aeiou';
        // mulberry32, seeded, so the copy is the same on every run.
        let state = 7;
        const random = () => {
            state = (state + 0x6d2b79f5) | 0;
            let t = Math.imul(state ^ (state >>> 15), 1 | state);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        const pick = (from: string) => from[Math.floor(random() * from.length)];
        const word = () => Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(consonants) + pick(vowels)).join('');
        const prose = (length: number) => {
            let text = '';
            while (text.length < length) text += `${word()}${random() < 0.1 ? '. ' : ' '}`;
            return text.slice(0, length).trim();
        };
        const long = await buildTestCatalog({
            seed: 61,
            variantBytes: BUDGET_VARIANT_BYTES,
            photos: Array.from({ length: 150 }, () => ({ alt: { kind: 'described' as const, text: prose(1_000), reviewed: true }, title: prose(200) })),
            series: [{ photos: 150, statement: prose(1_200), shortStatement: prose(200) }],
        });
        const longReader = readerOf(long.content, long.revisionId);
        const result = longReader.getSeriesPage(long.content.series[0].slug, routes);
        if (result.kind !== 'ok') throw new Error(result.kind);
        expect(result.page.entries).toHaveLength(SCREEN_BUDGETS.seriesFirstPage.photoRecords);
        const size = payloadSize(result.page);
        record('seriesFirstPage', size, result.page.entries.length, 'long-copy page');
        expect(size.gzipBytes).toBeLessThanOrEqual(SCREEN_BUDGETS.seriesFirstPage.gzipBytes);
    }, 60_000);

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
                expectGeometry(model);
            }
        }
    });
});

describe('measureCatalogBudgets()', () => {
    it('measures every model a screen can serve, keeps the largest of each, and finds none over on the fixture', () => {
        const continuationPages = fixture.content.series.reduce((sum, series) => sum + Math.ceil(series.photoIds.length / 100) - 1, 0);
        expect(Object.fromEntries(Object.entries(measured.screens).map(([screen, { count }]) => [screen, count]))).toEqual({
            home: 1,
            work: 1,
            seriesFirstPage: 100,
            seriesContinuationPage: continuationPages,
            viewer: 5_000,
        });
        expect(measured.revisionId).toBe(fixture.revisionId);
        expect(measured.over).toEqual([]);
        expect(measured.screens.work.largest).toMatchObject({ gzipBytes: payloadSize(reader.getWorkSummaries(routes)).gzipBytes, budget: 'work', limit: SCREEN_BUDGETS.work.gzipBytes });
        expect(measured.screens.home.largest).toMatchObject({ gzipBytes: payloadSize(home()).gzipBytes, budget: 'home', records: 3 });
        const largestFirst = Math.max(...fixture.content.series.map((series) => payloadSize(seriesPage(series.slug)).gzipBytes));
        expect(measured.screens.seriesFirstPage.largest?.gzipBytes).toBe(largestFirst);
        // Until the continuation budget lands on its own, a continuation page answers to the first page's.
        expect(measured.screens.seriesContinuationPage.largest?.budget).toBe('seriesFirstPage');
        expect(measured.screens.seriesContinuationPage.largest?.subject).toMatch(/^fixture-\d\d, photographs \d+ to \d+$/);
        expect(measured.screens.viewer.largest?.subject).toMatch(PHOTO_ID_RE);
    });

    it('names every model over its budget, against the budgets it\'s given', () => {
        const tight = { ...SCREEN_BUDGETS, work: { ...SCREEN_BUDGETS.work, gzipBytes: 1 * KIB }, viewer: { ...SCREEN_BUDGETS.viewer, gzipBytes: 700 } };
        const result = measureCatalogBudgets(reader, { budgets: tight });
        expect(result.over.filter((row) => row.screen === 'work')).toEqual([expect.objectContaining({ subject: '100 series', limit: 1 * KIB })]);
        const viewers = result.over.filter((row) => row.screen === 'viewer');
        expect(viewers.length).toBeGreaterThan(0);
        for (const row of viewers) expect(row.gzipBytes).toBeGreaterThan(700);
        expect(result.over.filter((row) => row.screen === 'home' || row.screen === 'seriesFirstPage')).toEqual([]);
    });

    it('measures a catalog with nothing featured, and one with nothing published', () => {
        const content = structuredClone(fixture.content);
        content.site.featuredSeriesIds = [];
        expect(measureCatalogBudgets(readerOf(content, fixture.revisionId)).home).toBeNull();
        const empty = measureCatalogBudgets(readerOf({ site: { featuredSeriesIds: [] }, series: [], photos: [] }, fixture.revisionId));
        expect(empty.screens.viewer).toEqual({ count: 0, largest: null });
        expect(empty.screens.work.count).toBe(1);
        expect(empty.over).toEqual([]);
    });
});

describe('the scale test', () => {
    // The same 100 series at 500 and 5,000 photographs: Work ships summaries, never sequences, so neither its bytes
    // nor the markup SeriesCatalog renders from them grows with the library.
    const startTags = (html: string) => html.match(/<[a-zA-Z]/g)?.length ?? 0;
    const workAt = async (photos: number) => {
        const built = photos === BUDGET_PHOTOS ? fixture : await buildBudgetFixture({ photos });
        const work = readerOf(built.content, built.revisionId).getWorkSummaries(routes);
        return { gzipBytes: payloadSize(work).gzipBytes, tags: startTags(renderToStaticMarkup(createElement(SeriesCatalog, { work }))) };
    };

    it('holds Work\'s gzip bytes and SeriesCatalog\'s start tags at 5,000 photographs within 5% of 500', async () => {
        const [small, large] = [await workAt(500), await workAt(5_000)];
        expect(small.tags).toBeGreaterThan(100 * 4);
        expect(Math.abs(large.gzipBytes - small.gzipBytes) / small.gzipBytes).toBeLessThanOrEqual(0.05);
        expect(Math.abs(large.tags - small.tags) / small.tags).toBeLessThanOrEqual(0.05);
    });
});

describe('real-length figures (gap 33)', () => {
    // The fixture's long copy makes these the figures #69's body took from a scratch run. `npm run test:budgets`
    // writes catalogSection(measureCatalogBudgets()) to `.perf/report.json`, so this is the report's catalog half.
    it('gives the report Home, Work and Viewer figures from real-length copy, each beside its budget', () => {
        const section = catalogSection(measured);
        const row = (screen: CatalogBudgetScreen) => section.rows.find((entry) => entry.screen === screen);
        for (const screen of ['home', 'work', 'viewer'] as const) {
            expect(row(screen), screen).toMatchObject({ budgetKiB: SCREEN_BUDGETS[screen].gzipBytes / KIB, over: false });
            expect(row(screen)!.gzipKiB, screen).toBeGreaterThan(0);
        }
        // The Viewer's largest model is a photograph with real-length copy, as photograph 600 of the long series has.
        const largest = authoredPhoto(measured.screens.viewer.largest!.subject);
        expect([...(largest.caption ?? '')].length).toBe(LONG_COPY.caption);
        expect(payloadSize(viewer(fixture.content.series[1].slug, fixture.content.series[1].photoIds[REAL_LENGTH_POSITION])).gzipBytes).toBeGreaterThan(payloadSize(viewer(fixture.content.series[0].slug, fixture.content.series[0].photoIds[0])).gzipBytes);
        // Work carries the long series titles and short statements.
        expect(measured.screens.work.largest!.gzipBytes).toBeGreaterThan(payloadSize(readerOf(plainCopy(fixture.content), fixture.revisionId).getWorkSummaries(routes)).gzipBytes);
        // Home: what each featured photograph costs in its ID list, and how many Home's budget holds (limit 25).
        expect(section.home).toEqual(measured.home);
        expect(measured.home!.featuredPhotos).toBe(FEATURED_PHOTOS);
        expect(measured.home!.bytesPerPhoto).toBeGreaterThan(10);
        expect(measured.home!.bytesPerPhoto).toBeLessThan(40);
        expect(measured.home!.photosAtBudget).toBeGreaterThanOrEqual(HOME_ID_LIST_PHOTOS);
    });
});

/** The content with every series' copy cut to one word, to show what the long copy adds. */
function plainCopy(content: CandidateContent): CandidateContent {
    const plain = structuredClone(content);
    for (const series of plain.series) Object.assign(series, { title: 'Series', statement: 'Statement.', shortStatement: 'Short.' });
    return plain;
}
