// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { PHOTO_ID_RE } from '../../identity/ids';
import { encodeSeriesCursor } from '../cursor';
import { seriesPageFrom, seriesPagesPath, type PublishedSeriesPage, type SeriesActiveCatalog, type SeriesContinuation } from '../projections/series';
import { createCatalogReader, createRouteBuilder, type CatalogContent, type CatalogReader } from '../reader';
import { PHOTO_PARAM, photoParamOf } from '../routes';
import { buildTestCatalog, type TestCatalogContent } from '../testing';

// #6's deep entry (B5): `/work/<slug>?photo=<photoId>` renders the page
// that holds that photograph, resolved on the server against the served
// revision, with the page before it for Show earlier. Anything else in the
// parameter gets the plain series page. Continuation pages carry the page
// before them too, so Show earlier can walk back to position 1.

const routes = createRouteBuilder();
const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LONG = Array.from({ length: 250 }, (_, n) => id(n + 1));
const SHORT = Array.from({ length: 10 }, (_, n) => id(n + 301));
const DRAFT = [id(401)];
/** A photo record in no series. */
const LOOSE = id(402);

let fixture: TestCatalogContent;

beforeAll(async () => {
    fixture = await buildTestCatalog({
        seed: 67,
        photos: [...LONG, ...SHORT, ...DRAFT, LOOSE].map((photoId) => ({ id: photoId })),
        series: [
            {
                id: 'ser_fixture-long',
                slug: 'fixture-long',
                slugAliases: ['old-fixture-long'],
                photoIds: LONG,
                chapters: [{ id: 'ch-one', title: 'Fixture chapter one', startPhotoId: LONG[149] }],
            },
            { id: 'ser_fixture-short', slug: 'fixture-short', photoIds: SHORT },
            { id: 'ser_fixture-draft', slug: 'fixture-draft', photoIds: DRAFT, visibility: 'draft' },
        ],
    });
}, 60_000);

function readerOf(content: CatalogContent = fixture.content, revisionId = fixture.revisionId): CatalogReader {
    return createCatalogReader(content, { revisionId, revisionNumber: null });
}

function pageFor(photoId: unknown, slug = 'fixture-long', reader: CatalogReader = readerOf()): PublishedSeriesPage {
    const result = reader.getSeriesPage(slug, routes, { photoId });
    if (result.kind !== 'ok') throw new Error(`Expected the page, got ${result.kind}`);
    return result.page;
}

const cursor = (offset: number) => encodeSeriesCursor({ revisionId: fixture.revisionId, seriesId: 'ser_fixture-long', offset });
const pagePath = (offset: number) => seriesPagesPath('fixture-long', cursor(offset));
const cursorOf = (href: string) => href.slice(href.lastIndexOf('/') + 1);

function continuation(href: string, reader: CatalogReader = readerOf()): SeriesContinuation {
    const result = reader.getSeriesContinuation('fixture-long', cursorOf(href), routes);
    if (result.kind !== 'ok') throw new Error(`Expected a page, got ${result.kind}`);
    return result.page;
}

const positions = (page: { entries: { position: number }[] }) => [page.entries[0].position, page.entries.at(-1)?.position];

describe('the photo parameter', () => {
    it('is `photo`, and reads only one value that is a photo ID, never folded or trimmed', () => {
        expect(PHOTO_PARAM).toBe('photo');
        expect(photoParamOf(LONG[0])).toBe(LONG[0]);
        for (const bad of [undefined, null, '', 42, [LONG[0]], [LONG[0], LONG[1]], LONG[0].toUpperCase(), ` ${LONG[0]}`, `${LONG[0]} `, `${LONG[0]}x`, 'ph_x', '<script>alert(1)</script>', `${LONG[0]}"><img src=x>`, `../${LONG[0]}`]) {
            expect(photoParamOf(bad), JSON.stringify(bad)).toBeNull();
        }
    });

    it('matches #10\'s photo ID pattern exactly, without importing it into client code', () => {
        for (const value of [LONG[0], 'ph_12345678-1234-4123-8123-123456789abc', 'ph_12345678-1234-5123-8123-123456789abc', 'ph_12345678-1234-4123-7123-123456789abc', 'ph_ABCDEF01-1234-4123-8123-123456789abc']) {
            expect(photoParamOf(value) !== null, value).toBe(PHOTO_ID_RE.test(value));
        }
    });

    it('goes on a series href as `?photo=`, under a preview\'s basePath too, and only when it is a photo ID', () => {
        expect(routes.seriesHref('fixture-long', { focusPhotoId: LONG[149] })).toBe(`/work/fixture-long?photo=${LONG[149]}`);
        const preview = createRouteBuilder({ basePath: `/curation/preview/rev_${'b'.repeat(64)}/site` });
        expect(preview.seriesHref('fixture-long', { focusPhotoId: LONG[0] })).toBe(`${preview.basePath}/work/fixture-long?photo=${LONG[0]}`);
        expect(routes.seriesHref('fixture-long', { focusPhotoId: null })).toBe('/work/fixture-long');
        expect(routes.seriesHref('fixture-long', {})).toBe('/work/fixture-long');
        expect(routes.seriesHref('fixture-long', { focusPhotoId: 'a&b=<c>' })).toBe('/work/fixture-long');
    });
});

describe('?photo= on the series page', () => {
    it('renders the page that holds the photograph, with the page before it and after it, and names it to focus', () => {
        const page = pageFor(LONG[149]);
        expect(positions(page)).toEqual([101, 200]);
        expect(page.focusPhotoId).toBe(LONG[149]);
        expect(page.prevHref).toBe(pagePath(0));
        expect(page.nextHref).toBe(pagePath(200));
        expect(page.total).toBe(250);
        expect(page.chapters.map((chapter) => chapter.startPosition)).toEqual([150]);
    });

    it('serves the last page for a photograph on it, with no page after', () => {
        const page = pageFor(LONG[249]);
        expect(positions(page)).toEqual([201, 250]);
        expect(page.prevHref).toBe(pagePath(100));
        expect(page.nextHref).toBeNull();
    });

    it.each([[1], [100]])('serves the first page for photograph %i, with nothing before it, as the plain page does', (position) => {
        const page = pageFor(LONG[position - 1]);
        const plain = pageFor(undefined);
        expect(page.focusPhotoId).toBe(LONG[position - 1]);
        expect(page.prevHref).toBeNull();
        expect({ ...page, focusPhotoId: null }).toEqual(plain);
    });

    it('cuts pages at the same edges the continuation does: 100 and 101, 200 and 201', () => {
        expect(positions(pageFor(LONG[99]))).toEqual([1, 100]);
        expect(positions(pageFor(LONG[100]))).toEqual([101, 200]);
        expect(positions(pageFor(LONG[199]))).toEqual([101, 200]);
        expect(positions(pageFor(LONG[200]))).toEqual([201, 250]);
    });

    it('builds the deep page\'s entries as the continuation does', () => {
        expect(pageFor(LONG[149]).entries).toEqual(continuation(pagePath(100)).entries);
    });

    it.each([
        ['a photo in another series', SHORT[0]],
        ['a draft series\' photo', DRAFT[0]],
        ['a photo in no series', LOOSE],
        ['an ID no photo has', id(999)],
        ['an upper-case ID', LONG[149].toUpperCase()],
        ['an ID with a space after it', `${LONG[149]} `],
        ['two values', [LONG[149], LONG[1]]],
        ['markup', '"><script>alert(1)</script>'],
        ['nothing', undefined],
        ['an empty value', ''],
    ])('gives the plain series page, focusing nothing, for %s', (_case, photoId) => {
        const page = pageFor(photoId);
        expect(page).toEqual(pageFor(undefined));
        expect(page.focusPhotoId).toBeNull();
        expect(page.prevHref).toBeNull();
        expect(positions(page)).toEqual([1, 100]);
        expect(JSON.stringify(page)).not.toContain('script');
    });

    it('resolves against the served revision: a photograph that left the series is the plain page', () => {
        const content = structuredClone(fixture.content);
        content.series[0].photoIds = content.series[0].photoIds.filter((photoId) => photoId !== LONG[149]);
        const page = pageFor(LONG[149], 'fixture-long', readerOf(content, `rev_${'c'.repeat(64)}`));
        expect(page.focusPhotoId).toBeNull();
        expect(positions(page)).toEqual([1, 100]);
        expect(page.total).toBe(249);
    });

    it('follows a photograph that moved within the series to the page that holds it now', () => {
        const content = structuredClone(fixture.content);
        const ids = content.series[0].photoIds;
        content.series[0].photoIds = [ids[149], ...ids.filter((photoId) => photoId !== ids[149])];
        const page = pageFor(LONG[149], 'fixture-long', readerOf(content, `rev_${'d'.repeat(64)}`));
        expect(positions(page)).toEqual([1, 100]);
        expect(page.entries[0].photoId).toBe(LONG[149]);
    });

    it('keeps the canonical path and the share metadata free of the parameter', () => {
        const page = pageFor(LONG[149]);
        expect(page.metadata).toEqual(pageFor(undefined).metadata);
        expect(page.metadata.canonicalPath).toBe('/work/fixture-long');
        expect(page.href).toBe('/work/fixture-long');
    });

    it('answers a former slug or a letter-case variant with the same redirect, the parameter or not', () => {
        for (const slug of ['old-fixture-long', 'Fixture-Long']) {
            expect(readerOf().getSeriesPage(slug, routes, { photoId: LONG[149] })).toEqual(readerOf().getSeriesPage(slug, routes));
        }
    });

    it('takes the parameter through seriesPageFrom()', async () => {
        const load = async () => ({ state: 'ok', reader: readerOf() }) as unknown as SeriesActiveCatalog;
        const result = await seriesPageFrom(load, 'fixture-long', routes, { photoId: LONG[249] });
        expect(result.kind === 'ok' && positions(result.page)).toEqual([201, 250]);
    });
});

describe('the page before each continuation page', () => {
    it('is on every continuation page, null on the first', () => {
        expect(continuation(pagePath(0)).prevHref).toBeNull();
        expect(continuation(pagePath(100)).prevHref).toBe(pagePath(0));
        expect(continuation(pagePath(200)).prevHref).toBe(pagePath(100));
        expect(pageFor(undefined).prevHref).toBeNull();
    });

    it('walks back from the last page to position 1 in authored order, with no gap or repeat', () => {
        const pages = [pageFor(LONG[249]) as { entries: PublishedSeriesPage['entries']; prevHref: string | null }];
        while (pages[0].prevHref) pages.unshift(continuation(pages[0].prevHref));
        expect(pages.flatMap((page) => page.entries).map((entry) => entry.photoId)).toEqual(LONG);
    });
});
