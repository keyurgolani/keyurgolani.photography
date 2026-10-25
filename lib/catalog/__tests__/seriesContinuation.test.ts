// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeSeriesCursor, encodeSeriesCursor } from '../cursor';
import {
    SERIES_PAGE_SIZE,
    seriesContinuationFrom,
    seriesContinuationOf,
    seriesPagesPath,
    type PublishedSeriesPage,
    type SeriesActiveCatalog,
    type SeriesContinuation,
    type SeriesEntry,
} from '../projections/series';
import { createCatalogReader, createRouteBuilder, type CatalogContent, type CatalogReader } from '../reader';
import { buildTestCatalog, type TestCatalogContent } from '../testing';

// #6's series continuation: the first page in the page model, then each
// page after it from seriesContinuationOf(), on a 250-photo series.

const routes = createRouteBuilder();
const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LONG = Array.from({ length: 250 }, (_, n) => id(n + 1));
const SHORT = Array.from({ length: 10 }, (_, n) => id(n + 301));
const DRAFT = [id(401)];
const HIDDEN = [id(402)];
const REVISION_B = `rev_${'b'.repeat(64)}`;

let fixture: TestCatalogContent;

beforeAll(async () => {
    fixture = await buildTestCatalog({
        seed: 66,
        photos: [...LONG, ...SHORT, ...DRAFT, ...HIDDEN].map((photoId) => ({ id: photoId })),
        series: [
            {
                id: 'ser_fixture-long',
                slug: 'fixture-long',
                slugAliases: ['old-fixture-long'],
                photoIds: LONG,
                // One chapter starts on the second page, one on the third.
                chapters: [
                    { id: 'ch-one', title: 'Fixture chapter one', startPhotoId: LONG[149] },
                    { id: 'ch-two', title: 'Fixture chapter two', startPhotoId: LONG[219] },
                ],
            },
            { id: 'ser_fixture-short', slug: 'fixture-short', photoIds: SHORT },
            { id: 'ser_fixture-draft', slug: 'fixture-draft', photoIds: DRAFT, visibility: 'draft' },
            { id: 'ser_fixture-hidden', slug: 'fixture-hidden', photoIds: HIDDEN, visibility: 'hidden' },
        ],
    });
}, 60_000);

function readerOf(content: CatalogContent = fixture.content, revisionId = fixture.revisionId): CatalogReader {
    return createCatalogReader(content, { revisionId, revisionNumber: null });
}

function firstPage(reader: CatalogReader = readerOf(), slug = 'fixture-long'): PublishedSeriesPage {
    const result = reader.getSeriesPage(slug, routes);
    if (result.kind !== 'ok') throw new Error(`Expected the page, got ${result.kind}`);
    return result.page;
}

/** The cursor in a continuation path. */
const cursorOf = (href: string) => href.slice(href.lastIndexOf('/') + 1);

function continuation(href: string, reader: CatalogReader = readerOf(), slug = 'fixture-long'): SeriesContinuation {
    const result = reader.getSeriesContinuation(slug, cursorOf(href), routes);
    if (result.kind !== 'ok') throw new Error(`Expected a page, got ${result.kind}`);
    return result.page;
}

/** Every page of the series, the first included, by following nextHref. */
function allPages(reader: CatalogReader = readerOf()): { entries: SeriesEntry[]; nextHref: string | null }[] {
    const first = firstPage(reader);
    const pages: { entries: SeriesEntry[]; nextHref: string | null }[] = [{ entries: first.entries, nextHref: first.nextHref }];
    while (pages.at(-1)?.nextHref) pages.push(continuation(pages.at(-1)?.nextHref as string, reader));
    return pages;
}

const cursor = (offset: number, seriesId = 'ser_fixture-long', revisionId = fixture.revisionId) => encodeSeriesCursor({ revisionId, seriesId, offset });

describe('the first page', () => {
    it('holds the first SERIES_PAGE_SIZE entries, the whole count, every chapter, and the path to the second page', () => {
        expect(SERIES_PAGE_SIZE).toBe(100);
        const page = firstPage();
        expect(page.entries.map((entry) => entry.position)).toEqual(Array.from({ length: 100 }, (_, n) => n + 1));
        expect(page.total).toBe(250);
        expect(page.facts.photoCount.value).toBe(250);
        expect(page.chapters.map((chapter) => chapter.startPosition)).toEqual([150, 220]);
        expect(page.nextHref).toBe(seriesPagesPath('fixture-long', cursor(100)));
        expect(decodeSeriesCursor(cursorOf(page.nextHref as string))).toEqual({ revisionId: fixture.revisionId, seriesId: 'ser_fixture-long', offset: 100 });
    });

    it('has no continuation when one page holds the whole series', () => {
        const page = firstPage(readerOf(), 'fixture-short');
        expect([page.entries.length, page.total, page.nextHref]).toEqual([10, 10, null]);
    });

    it('keeps the cover\'s text when the cover is past the first page', () => {
        const content = structuredClone(fixture.content);
        content.series[0].cover = { photoId: LONG[199] };
        const page = firstPage(readerOf(content));
        const photo = content.photos.find((record) => record.id === LONG[199]);
        expect(page.cover?.position).toBe(200);
        expect(page.cover?.href).toBe(`/work/fixture-long/photo/${LONG[199]}`);
        expect(page.cover?.description).toBe(photo?.alt.kind === 'described' ? photo.alt.text : null);
        expect(page.entries.some((entry) => entry.photoId === LONG[199])).toBe(false);
    });
});

describe('seriesContinuationOf', () => {
    it('pages the series as 100, 100, and 50, in authored order with absolute positions, and ends with a null nextHref', () => {
        const pages = allPages();
        expect(pages.map((page) => page.entries.length)).toEqual([100, 100, 50]);
        expect(pages.at(-1)?.nextHref).toBeNull();
        const joined = pages.flatMap((page) => page.entries);
        expect(joined.map((entry) => entry.photoId)).toEqual(LONG);
        expect(joined.map((entry) => entry.position)).toEqual(LONG.map((_, n) => n + 1));
        expect(joined.every((entry, n) => entry.href === `/work/fixture-long/photo/${LONG[n]}`)).toBe(true);
    });

    it('builds each entry as the first page would: same fields, same allowlist', () => {
        const joined = allPages().flatMap((page) => page.entries);
        const first = firstPage();
        expect(joined.slice(0, 100)).toEqual(first.entries);
        for (const entry of joined) expect(Object.keys(entry).sort()).toEqual(['description', 'href', 'image', 'photoId', 'position', 'title']);
        const json = JSON.stringify(continuation(first.nextHref as string));
        for (const leak of ['technical', 'profileId', 'assetRevision', 'slugAliases', 'old-fixture-long', 'lqip', 'caption', 'credit']) expect(json).not.toContain(leak);
    });

    it('gives the same pages and the same nextHref strings on every read of one revision', () => {
        const once = allPages();
        const twice = allPages(readerOf(structuredClone(fixture.content)));
        expect(twice).toEqual(once);
    });

    it('skips members that resolve to nothing, so positions and the count agree with the Viewer', () => {
        const content = structuredClone(fixture.content);
        content.series[0].photoIds.splice(150, 0, id(999));
        const reader = readerOf(content);
        expect(firstPage(reader).total).toBe(250);
        const joined = allPages(reader).flatMap((page) => page.entries);
        expect(joined.map((entry) => entry.photoId)).toEqual(LONG);
        expect(joined.at(-1)?.position).toBe(250);
    });

    it('answers revision-changed for a cursor from another revision, whatever the slug, and never serves it', () => {
        const next = readerOf(fixture.content, REVISION_B);
        for (const slug of ['fixture-long', 'fixture-unknown', 'fixture-draft']) {
            expect(next.getSeriesContinuation(slug, cursor(100), routes), slug).toEqual({ kind: 'revision-changed' });
        }
        // The new revision's own cursors work, and name it.
        const page = firstPage(next);
        expect(decodeSeriesCursor(cursorOf(page.nextHref as string))?.revisionId).toBe(REVISION_B);
        expect(continuation(page.nextHref as string, next).revisionId).toBe(REVISION_B);
    });

    it('answers a cursor for another series, or an offset that is not a page in range, as a bad request', () => {
        const reader = readerOf();
        const cases: [string, string, string][] = [
            ['another series\' cursor', 'fixture-long', cursor(100, 'ser_fixture-short')],
            ['this series\' cursor on another slug', 'fixture-short', cursor(100)],
            ['an offset that is not a page start', 'fixture-long', cursor(150)],
            ['the offset at the end', 'fixture-long', cursor(250)],
            ['an offset past the end', 'fixture-long', cursor(300)],
            ['a malformed cursor', 'fixture-long', 'not-a-cursor'],
            ['an empty cursor', 'fixture-long', ''],
        ];
        for (const [name, slug, text] of cases) expect(reader.getSeriesContinuation(slug, text, routes), name).toEqual({ kind: 'bad-request' });
    });

    it('answers every slug #5 doesn\'t serve with the one not-found, and a former slug too', () => {
        const reader = readerOf();
        const answers = ['fixture-unknown', 'fixture-draft', 'fixture-hidden', 'old-fixture-long', 'Fixture-Long', '../fixture-long', 'a'.repeat(65)].map((slug) => [slug, reader.getSeriesContinuation(slug, cursor(100), routes)]);
        for (const [slug, answer] of answers) expect(answer, String(slug)).toEqual({ kind: 'not-found' });
    });

    it('answers not-found for a series with nothing to open, as the page does', () => {
        const content = structuredClone(fixture.content);
        content.series[0].derived.photoCount = 0;
        expect(readerOf(content).getSeriesContinuation('fixture-long', cursor(100), routes)).toEqual({ kind: 'not-found' });
    });

    it('takes hrefs from the route builder it\'s given', () => {
        const preview = createRouteBuilder({ basePath: '/curation/preview/fixture' });
        const result = seriesContinuationOf({ revisionId: fixture.revisionId, listSeries: () => fixture.content.series, seriesBySlug: (slug) => readerOf().seriesBySlug(slug), photosOf: (seriesId) => readerOf().photosOf(seriesId) }, 'fixture-long', cursor(100), preview);
        if (result.kind !== 'ok') throw new Error(result.kind);
        expect(result.page.entries[0].href).toBe(`/curation/preview/fixture/work/fixture-long/photo/${LONG[100]}`);
    });
});

describe('seriesContinuationFrom', () => {
    const served = (state: 'ok' | 'degraded' = 'ok'): SeriesActiveCatalog => ({ mode: 'catalog', state, reader: readerOf() });

    it('answers a malformed slug not-found and a malformed cursor as a bad request, before reading the catalog', async () => {
        const load = vi.fn(async () => served());
        expect(await seriesContinuationFrom(load, 'Fixture-Long', cursor(100), routes)).toEqual({ kind: 'not-found' });
        expect(await seriesContinuationFrom(load, 'fixture-long', 'A'.repeat(300), routes)).toEqual({ kind: 'bad-request' });
        expect(await seriesContinuationFrom(load, 'fixture-long', undefined, routes)).toEqual({ kind: 'bad-request' });
        expect(load).not.toHaveBeenCalled();
    });

    it('answers legacy mode not-found, as the page does, and passes an unavailable catalog on', async () => {
        expect(await seriesContinuationFrom(async () => ({ mode: 'legacy' }), 'fixture-long', cursor(100), routes)).toEqual({ kind: 'not-found' });
        expect(await seriesContinuationFrom(async () => ({ mode: 'catalog', state: 'unavailable', reason: 'revision-unreadable' }), 'fixture-long', cursor(100), routes)).toEqual({ kind: 'unavailable', reason: 'revision-unreadable' });
    });

    it('serves the page from the served revision, ok or degraded', async () => {
        for (const state of ['ok', 'degraded'] as const) {
            const result = await seriesContinuationFrom(async () => served(state), 'fixture-long', cursor(100), routes);
            expect(result, state).toEqual(readerOf().getSeriesContinuation('fixture-long', cursor(100), routes));
        }
    });
});
