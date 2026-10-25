// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { seriesPageFrom, seriesPageOf, seriesParams, seriesSections, type PublishedSeriesPage, type SeriesActiveCatalog, type SeriesSource } from '../projections/series';
import { publish } from '../publish';
import { createCatalogReader, createRouteBuilder } from '../reader';
import { createTestCatalog, type TestCatalog } from '../testing';
import type { CandidateContent, RevisionContent } from '../types';
import { readWorkingLayer } from '../working-layer';
import { writeAuthoredRecord } from '../working-layer-writer';
import { VARIANT_BYTES } from './catalogFixtures';

const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = Array.from({ length: 12 }, (_, n) => id(n + 1));
const routes = createRouteBuilder();

/**
 * Series A (fixture-a, once old-fixture-a) holds P[0] to P[5] in authored
 * order P[0], P[3], P[1], P[2], P[4], P[5], so ID order and authored order
 * differ. Its cover is P[1], third in the sequence. It has a lead run and
 * two chapters, starting on P[1] and P[4]. P[0] is titled, located, and
 * captioned; P[3] is decorative; P[2] is pending in the candidate; P[4] is
 * undated and repeats P[0]'s location. B holds P[6] alone. The draft series
 * (once old-fixture-draft) holds P[7], the hidden one P[8], and P[9] is in
 * no series, so none of those three is in the content.
 */
const ORDER_A = [P[0], P[3], P[1], P[2], P[4], P[5]];
let catalog: TestCatalog;

beforeAll(async () => {
    catalog = await createTestCatalog({
        seed: 5,
        photos: [
            { id: P[0], title: 'Fixture title one', caption: 'Fixture caption one.', credit: 'Fixture credit', location: 'Fixture location one', capturedAt: '2023-03-04', focalPoint: { x: 0.25, y: 0.75 }, accent: '#c08040', sourcePath: 'private/fixture-source-one.jpg' },
            { id: P[1], location: '  Fixture location two  ', focalPoint: { x: 0.1, y: 0.9 }, crop: 'contain' },
            { id: P[2], alt: null },
            { id: P[3], alt: { kind: 'decorative' } },
            { id: P[4], capturedDate: null, location: 'Fixture location one' },
            { id: P[5] },
            { id: P[6] },
            { id: P[7] },
            { id: P[8] },
            { id: P[9] },
        ],
        series: [
            {
                id: 'ser_fixture-a',
                slug: 'fixture-a',
                slugAliases: ['old-fixture-a'],
                statement: 'Fixture statement, first paragraph.\nStill the first.\n\n  Second <b>paragraph</b> & more.  \n \n\n',
                accent: '#a0b0c0',
                photoIds: ORDER_A,
                cover: { photoId: P[1], focalPoint: { x: 0.4, y: 0.6 } },
                chapters: [
                    { id: 'ch-one', title: 'Fixture chapter one', startPhotoId: P[1] },
                    { id: 'ch-two', title: 'Fixture chapter two', startPhotoId: P[4] },
                ],
            },
            { id: 'ser_fixture-b', slug: 'fixture-b', photoIds: [P[6]] },
            { id: 'ser_fixture-draft', slug: 'fixture-draft', slugAliases: ['old-fixture-draft'], photoIds: [P[7]], visibility: 'draft' },
            { id: 'ser_fixture-hidden', slug: 'fixture-hidden', slugAliases: ['old-fixture-hidden'], photoIds: [P[8]], visibility: 'hidden' },
        ],
    });
});

afterAll(async () => {
    await catalog.cleanup();
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The fixture's candidate as a published revision would hold it: the pending photo described, as the description rules require. */
function revisionContent(): RevisionContent {
    const content = structuredClone(catalog.content);
    for (const photo of content.photos) if (photo.alt.kind === 'pending') photo.alt = { kind: 'described', text: 'Fixture description, reviewed.' };
    return content as RevisionContent;
}

const REVISION_A = `rev_${'a'.repeat(64)}`;
const REVISION_B = `rev_${'b'.repeat(64)}`;

function readerOf(content: CatalogContentLike, revisionId = REVISION_A) {
    return createCatalogReader(content, { revisionId, revisionNumber: 3 });
}
type CatalogContentLike = RevisionContent | CandidateContent;

function page(result: ReturnType<typeof seriesPageOf>): PublishedSeriesPage {
    if (result.kind !== 'ok') throw new Error(`Expected a page, got ${JSON.stringify(result)}`);
    return result.page;
}

/** A source that fails the test if anything reads it. */
function trap(): SeriesSource {
    const fail = () => {
        throw new Error('The catalog was read');
    };
    return { revisionId: REVISION_A, listSeries: fail, seriesBySlug: fail, photosOf: fail };
}

const photoOf = (content: CatalogContentLike, photoId: string) => {
    const photo = content.photos.find((entry) => entry.id === photoId);
    if (!photo) throw new Error(`No ${photoId} in the content`);
    return photo;
};

describe('seriesParams', () => {
    it('takes a slug in #13\'s shape', () => {
        expect(seriesParams('fixture-a')).toEqual({ slug: 'fixture-a' });
        expect(seriesParams('a')).toEqual({ slug: 'a' });
        expect(seriesParams('a'.repeat(64))).toEqual({ slug: 'a'.repeat(64) });
        expect(seriesParams('2024-a1')).toEqual({ slug: '2024-a1' });
    });

    it.each([
        ['an uppercase slug', 'Fixture-A'],
        ['a slug with a trailing hyphen', 'fixture-a-'],
        ['a slug with a leading hyphen', '-fixture-a'],
        ['a slug with a double hyphen', 'fixture--a'],
        ['a dot segment', '..'],
        ['a slug holding a slash', 'fixture-a/..'],
        ['an encoded dot segment', '%2e%2e'],
        ['a slug with a space', 'fixture a'],
        ['a slug with a trailing newline', 'fixture-a\n'],
        ['an empty slug', ''],
        ['a slug over 64 characters', 'a'.repeat(65)],
        ['a filename', 'fixture-0001.jpg'],
        ['a slug array', ['fixture-a']],
        ['a missing slug', undefined],
        ['a number', 7],
    ])('refuses %s', (_name, slug) => {
        expect(seriesParams(slug)).toBeNull();
    });
});

describe('seriesPageOf on a revision', () => {
    let content: RevisionContent;
    let reader: ReturnType<typeof readerOf>;

    beforeAll(() => {
        content = revisionContent();
        reader = readerOf(content);
    });

    it('resolves the canonical slug to the series, its copy, facts, cover, sequence, chapters, and metadata inputs', () => {
        const cover = photoOf(content, P[1]);
        const entryImage = (photoId: string) => {
            const photo = photoOf(content, photoId);
            return { width: photo.width, height: photo.height, variants: photo.variants };
        };
        const described = (photoId: string) => {
            const { alt } = photoOf(content, photoId);
            return alt.kind === 'described' ? alt.text : null;
        };
        expect(reader.getSeriesPage('fixture-a')).toEqual({
            kind: 'ok',
            page: {
                catalogRevision: REVISION_A,
                id: 'ser_fixture-a',
                slug: 'fixture-a',
                href: '/work/fixture-a',
                workHref: '/work',
                authored: {
                    title: 'Fixture series 01',
                    statement: ['Fixture statement, first paragraph.\nStill the first.', 'Second <b>paragraph</b> & more.'],
                },
                facts: {
                    photoCount: { value: 6, source: 'published-sequence' },
                    captured: { from: content.series[0].derived.capturedFrom, to: content.series[0].derived.capturedTo, datedCount: 5, source: 'capture-dates' },
                    locations: { values: ['Fixture location one', 'Fixture location two'], source: 'photograph-records' },
                },
                cover: {
                    photoId: P[1],
                    position: 3,
                    href: `/work/fixture-a/photo/${P[1]}`,
                    image: { width: cover.width, height: cover.height, variants: cover.variants, lqip: cover.lqip },
                    focalPoint: { x: 0.4, y: 0.6 },
                    crop: 'contain',
                },
                entries: ORDER_A.map((photoId, index) => ({
                    photoId,
                    position: index + 1,
                    title: photoId === P[0] ? 'Fixture title one' : null,
                    description: described(photoId),
                    href: `/work/fixture-a/photo/${photoId}`,
                    image: entryImage(photoId),
                })),
                chapters: [
                    { id: 'ch-one', title: 'Fixture chapter one', startPosition: 3 },
                    { id: 'ch-two', title: 'Fixture chapter two', startPosition: 5 },
                ],
                metadata: {
                    canonicalPath: '/work/fixture-a',
                    title: 'Fixture series 01',
                    description: 'Fixture short statement for series 01.',
                    shareImage: { path: cover.variants.w1200.webp.url, width: cover.variants.w1200.webp.width, height: cover.variants.w1200.webp.height, alt: described(P[1]) },
                },
            },
        });
        expect(described(P[3])).toBeNull();
    });

    it('follows the authored order, not ID order, and renumbers when it changes', () => {
        expect(page(reader.getSeriesPage('fixture-a')).entries.map((entry) => entry.photoId)).toEqual(ORDER_A);
        const reordered = structuredClone(content);
        reordered.series[0].photoIds = [P[5], P[4], P[3], P[2], P[1], P[0]];
        reordered.series[0].chapters = [];
        const moved = page(readerOf(reordered, REVISION_B).getSeriesPage('fixture-a'));
        expect(moved.entries.map((entry) => [entry.position, entry.photoId])).toEqual([[1, P[5]], [2, P[4]], [3, P[3]], [4, P[2]], [5, P[1]], [6, P[0]]]);
        expect(moved.cover?.position).toBe(5);
    });

    it('stops at the last photograph: one sequence, no wrap and no next series', () => {
        const result = page(reader.getSeriesPage('fixture-a'));
        expect(result.entries.at(-1)?.position).toBe(result.entries.length);
        expect(JSON.stringify(result)).not.toContain('fixture-b');
        expect(result.workHref).toBe('/work');
    });

    it('redirects a former slug to the canonical one, with its path', () => {
        expect(reader.getSeriesPage('old-fixture-a')).toEqual({ kind: 'redirect', slug: 'fixture-a', location: '/work/fixture-a' });
    });

    it('lets a current slug win over another series\' alias', () => {
        const clash = structuredClone(content);
        clash.series[1].slugAliases = ['fixture-a'];
        const result = page(readerOf(clash).getSeriesPage('fixture-a'));
        expect(result.id).toBe('ser_fixture-a');
    });

    it('answers draft, hidden, removed, and unknown series and their former slugs with the one not-found', () => {
        const removed = structuredClone(content);
        removed.series = removed.series.filter((series) => series.id !== 'ser_fixture-b');
        const removedReader = readerOf(removed, REVISION_B);
        const answers = [
            reader.getSeriesPage('fixture-draft'),
            reader.getSeriesPage('old-fixture-draft'),
            reader.getSeriesPage('fixture-hidden'),
            reader.getSeriesPage('old-fixture-hidden'),
            reader.getSeriesPage('fixture-z'),
            reader.getSeriesPage('ser-fixture-a'),
            reader.getSeriesPage('ser_fixture-a'),
            reader.getSeriesPage('work'),
            removedReader.getSeriesPage('fixture-b'),
        ];
        for (const answer of answers) expect(answer).toEqual({ kind: 'not-found' });
        // One frozen value, so no not-found can differ from another by a field.
        expect(new Set(answers).size).toBe(1);
        expect(Object.isFrozen(answers[0])).toBe(true);
        expect(answers[0]).toBe(reader.getSeriesPage('Fixture-A'));
    });

    it('answers a series with nothing to open not-found, as Work leaves it out', () => {
        const empty = structuredClone(content);
        empty.series[1].photoIds = [id(99)];
        expect(readerOf(empty).getSeriesPage('fixture-b')).toEqual({ kind: 'not-found' });
        const uncounted = structuredClone(content);
        uncounted.series[1].derived.photoCount = 0;
        expect(readerOf(uncounted).getSeriesPage('fixture-b')).toEqual({ kind: 'not-found' });
        // The alias of an empty series doesn't redirect to a page that is not there.
        const emptyAliased = structuredClone(empty);
        emptyAliased.series[1].slugAliases = ['old-fixture-b'];
        expect(readerOf(emptyAliased).getSeriesPage('old-fixture-b')).toEqual({ kind: 'not-found' });
    });

    it('answers a series whose ID appears more than once not-found, by slug or former slug, as Work leaves it out', () => {
        const repeated = structuredClone(content);
        // A hand-written revision: a second record under series A's ID, with its own slug and B's photo.
        repeated.series.push({ ...structuredClone(repeated.series[1]), id: 'ser_fixture-a', slug: 'fixture-a-again', slugAliases: [] });
        const reader = readerOf(repeated);
        for (const slug of ['fixture-a', 'old-fixture-a', 'fixture-a-again']) expect(reader.getSeriesPage(slug), slug).toEqual({ kind: 'not-found' });
        // Series B, held once, still resolves.
        expect(page(reader.getSeriesPage('fixture-b')).id).toBe('ser_fixture-b');
    });

    it('answers a letter-case variant and other malformed slugs not-found, without reading the catalog', () => {
        expect(reader.getSeriesPage('Fixture-A')).toEqual({ kind: 'not-found' });
        expect(reader.getSeriesPage('OLD-FIXTURE-A')).toEqual({ kind: 'not-found' });
        for (const slug of ['Fixture-A', '..', 'fixture-a/', 'fixture-a.json', ['fixture-a'], undefined, 'a'.repeat(65)]) {
            expect(seriesPageOf(trap(), slug, routes)).toEqual({ kind: 'not-found' });
        }
        // The trap does fail once the slug passes, so the checks above prove the catalog went unread.
        expect(() => seriesPageOf(trap(), 'fixture-a', routes)).toThrow('The catalog was read');
    });
});

describe('chapters over the one order', () => {
    let content: RevisionContent;

    beforeAll(() => {
        content = revisionContent();
    });

    const withChapters = (chapters: RevisionContent['series'][number]['chapters']) => {
        const changed = structuredClone(content);
        changed.series[0].chapters = chapters;
        return page(readerOf(changed).getSeriesPage('fixture-a'));
    };

    it('cuts sections from the one list at each chapter, numbering across them', () => {
        const result = page(readerOf(content).getSeriesPage('fixture-a'));
        const sections = seriesSections(result);
        expect(sections.map((section) => [section.chapter?.id ?? null, section.entries.map((entry) => entry.position)])).toEqual([
            [null, [1, 2]],
            ['ch-one', [3, 4]],
            ['ch-two', [5, 6]],
        ]);
        // Every entry once, in order: chapters never make a second order.
        expect(sections.flatMap((section) => section.entries)).toEqual(result.entries);
    });

    it('has no lead section when the first chapter starts on the first photograph, and one section without chapters', () => {
        const first = withChapters([{ id: 'ch-zero', title: 'Fixture chapter zero', startPhotoId: P[0] }]);
        expect(seriesSections(first).map((section) => [section.chapter?.id ?? null, section.entries.length])).toEqual([['ch-zero', 6]]);
        const none = withChapters([]);
        expect(none.chapters).toEqual([]);
        expect(seriesSections(none)).toEqual([{ chapter: null, entries: none.entries }]);
    });

    it('starts a chapter on the last photograph as a one-entry section', () => {
        const last = withChapters([{ id: 'ch-last', title: 'Fixture chapter last', startPhotoId: P[5] }]);
        expect(seriesSections(last).map((section) => [section.chapter?.id ?? null, section.entries.map((entry) => entry.photoId)])).toEqual([
            [null, ORDER_A.slice(0, 5)],
            ['ch-last', [P[5]]],
        ]);
    });

    it('drops a chapter it can\'t place, and its photographs stay in order under the one above', () => {
        const result = withChapters([
            { id: 'ch-one', title: 'Fixture chapter one', startPhotoId: P[1] },
            { id: 'ch-outside', title: 'Starts outside the series', startPhotoId: P[6] },
            { id: 'ch-unknown', title: 'Starts on nothing', startPhotoId: id(99) },
            { id: 'ch-back', title: 'Starts before the one above', startPhotoId: P[3] },
            { id: 'ch-same', title: 'Starts with the one above', startPhotoId: P[1] },
            { id: 'ch-blank', title: '   ', startPhotoId: P[2] },
            { id: 'ch-one', title: 'A repeated ID', startPhotoId: P[2] },
            { id: 'ch-two', title: 'Fixture chapter two', startPhotoId: P[4] },
        ]);
        expect(result.chapters).toEqual([
            { id: 'ch-one', title: 'Fixture chapter one', startPosition: 3 },
            { id: 'ch-two', title: 'Fixture chapter two', startPosition: 5 },
        ]);
        expect(result.entries.map((entry) => entry.photoId)).toEqual(ORDER_A);
    });

    it('places a chapter on the members that resolve, so a dangling photo shifts it with the rest', () => {
        const dangling = structuredClone(content);
        dangling.series[0].photoIds = [P[0], id(99), P[3], P[1], P[2], P[4], P[5]];
        const result = page(readerOf(dangling).getSeriesPage('fixture-a'));
        expect(result.chapters.map((chapter) => chapter.startPosition)).toEqual([3, 5]);
    });
});

describe('missing photographs and images', () => {
    let content: RevisionContent;

    beforeAll(() => {
        content = revisionContent();
    });

    it('skips a member that resolves to nothing and renumbers the rest, as the Viewer counts them', () => {
        const dangling = structuredClone(content);
        dangling.series[0].photoIds = [P[0], id(99), P[3]];
        dangling.series[0].chapters = [];
        dangling.series[0].cover = { photoId: P[0] };
        const result = page(readerOf(dangling).getSeriesPage('fixture-a'));
        expect(result.entries.map((entry) => [entry.position, entry.photoId])).toEqual([[1, P[0]], [2, P[3]]]);
        expect(JSON.stringify(result)).not.toContain(id(99));
    });

    it('keeps an entry with an unusable image set, with its position, text, and Viewer link, and no other file', () => {
        const broken = structuredClone(content);
        photoOf(broken, P[0]).variants.w800.avif.url = 'https://example.test/elsewhere.avif';
        photoOf(broken, P[3]).variants.w400.webp.url = `/media/${P[9]}/x/y/w400.webp`;
        (photoOf(broken, P[4]).variants as Record<string, unknown>).w1920 = undefined;
        photoOf(broken, P[5]).width = 0;
        const result = page(readerOf(broken).getSeriesPage('fixture-a'));
        const byId = new Map(result.entries.map((entry) => [entry.photoId, entry]));
        for (const photoId of [P[0], P[3], P[4], P[5]]) {
            const entry = byId.get(photoId);
            expect(entry?.image, photoId).toBeNull();
            expect(entry?.href).toBe(`/work/fixture-a/photo/${photoId}`);
            expect(entry?.position).toBe(ORDER_A.indexOf(photoId) + 1);
        }
        expect(byId.get(P[0])?.title).toBe('Fixture title one');
        expect(byId.get(P[1])?.image).not.toBeNull();
        expect(JSON.stringify(result)).not.toContain('example.test');
    });

    it('gives no cover, and no share image, when the cover is outside the sequence or its set is unusable', () => {
        const outside = structuredClone(content);
        outside.series[0].cover = { photoId: P[6] };
        const fromOutside = page(readerOf(outside).getSeriesPage('fixture-a'));
        expect([fromOutside.cover, fromOutside.metadata.shareImage]).toEqual([null, null]);
        expect(fromOutside.entries).toHaveLength(6);

        const unusable = structuredClone(content);
        photoOf(unusable, P[1]).variants.w1200.webp.url = '/originals/fixture.jpg';
        const fromUnusable = page(readerOf(unusable).getSeriesPage('fixture-a'));
        expect([fromUnusable.cover, fromUnusable.metadata.shareImage]).toEqual([null, null]);
        expect(fromUnusable.entries.find((entry) => entry.photoId === P[1])?.image).toBeNull();
    });

    it('keeps an LQIP only on the cover, and only in the schema\'s shape', () => {
        const result = page(readerOf(content).getSeriesPage('fixture-a'));
        expect(result.cover?.image.lqip).toMatch(/^data:image\/webp;base64,/);
        for (const entry of result.entries) expect(entry.image && 'lqip' in entry.image).toBe(false);
        const odd = structuredClone(content);
        photoOf(odd, P[1]).lqip = 'data:image/webp;base64,AAAA"); background: url(https://example.test/x';
        expect(page(readerOf(odd).getSeriesPage('fixture-a')).cover?.image).not.toHaveProperty('lqip');
    });

    it('takes the cover\'s focal point, else the photo\'s, else the center, and its crop', () => {
        const photoFocal = structuredClone(content);
        photoFocal.series[0].cover = { photoId: P[0] };
        const fromPhoto = page(readerOf(photoFocal).getSeriesPage('fixture-a')).cover;
        expect([fromPhoto?.focalPoint, fromPhoto?.crop]).toEqual([{ x: 0.25, y: 0.75 }, 'cover']);
        const center = structuredClone(content);
        center.series[0].cover = { photoId: P[5], focalPoint: { x: 2, y: 0.5 } };
        expect(page(readerOf(center).getSeriesPage('fixture-a')).cover?.focalPoint).toEqual({ x: 0.5, y: 0.5 });
    });

    it('copies the image set, so a caller can\'t edit the revision through it', () => {
        const reader = readerOf(content);
        const result = page(reader.getSeriesPage('fixture-a'));
        if (!result.cover) throw new Error('No cover');
        result.cover.image.variants.w1200.webp.url = '/elsewhere';
        result.cover.focalPoint.x = 0.99;
        expect(photoOf(content, P[1]).variants.w1200.webp.url).toMatch(/^\/media\//);
        expect(page(reader.getSeriesPage('fixture-a')).cover?.image.variants.w1200.webp.url).toMatch(/^\/media\//);
        expect(content.series[0].cover.focalPoint?.x).toBe(0.4);
    });
});

describe('canonical Viewer links', () => {
    it('link every entry and the cover to #7\'s canonical route from the builder', () => {
        const result = page(readerOf(revisionContent()).getSeriesPage('fixture-a'));
        for (const entry of result.entries) expect(entry.href).toBe(routes.photoHref('fixture-a', entry.photoId));
        expect(result.cover?.href).toBe(routes.photoHref('fixture-a', P[1]));
    });

    it('take a preview\'s builder, and a redirect goes to the canonical slug inside it', () => {
        const preview = createRouteBuilder({ basePath: '/curation/preview/fixture' });
        const reader = readerOf(revisionContent());
        const result = page(reader.getSeriesPage('fixture-a', preview));
        expect([result.href, result.workHref, result.metadata.canonicalPath]).toEqual(['/curation/preview/fixture/work/fixture-a', '/curation/preview/fixture/work', '/curation/preview/fixture/work/fixture-a']);
        expect(result.entries[0].href).toBe(`/curation/preview/fixture/work/fixture-a/photo/${P[0]}`);
        expect(reader.getSeriesPage('old-fixture-a', preview)).toEqual({ kind: 'redirect', slug: 'fixture-a', location: '/curation/preview/fixture/work/fixture-a' });
    });

    it('use the canonical slug, never the former one the visitor typed', () => {
        const reader = readerOf(revisionContent());
        expect(JSON.stringify(reader.getSeriesPage('fixture-a'))).not.toContain('old-fixture-a');
    });
});

describe('derived facts', () => {
    let content: RevisionContent;

    beforeAll(() => {
        content = revisionContent();
    });

    it('take the count and the date range from compile\'s derived record, and count the dated entries', () => {
        const result = page(readerOf(content).getSeriesPage('fixture-a'));
        expect(content.series[0].derived.capturedFrom).toBe('2023-03-04');
        expect(result.facts.captured).toEqual({ from: '2023-03-04', to: content.series[0].derived.capturedTo, datedCount: 5, source: 'capture-dates' });
        const changed = structuredClone(content);
        changed.series[0].derived = { photoCount: 6, capturedFrom: '2019-05-01', capturedTo: '2021-07-02' };
        expect(page(readerOf(changed).getSeriesPage('fixture-a')).facts.captured).toEqual({ from: '2019-05-01', to: '2021-07-02', datedCount: 5, source: 'capture-dates' });
    });

    it('leave the date range out when nothing is dated or the record is malformed', () => {
        const undated = structuredClone(content);
        undated.series[0].derived = { photoCount: 6 };
        for (const photo of undated.photos) delete photo.capturedAt;
        expect(page(readerOf(undated).getSeriesPage('fixture-a')).facts.captured).toBeNull();
        // Dates the members don't carry are left out too: compile derives the range from them.
        const unbacked = structuredClone(undated);
        unbacked.series[0].derived = { photoCount: 6, capturedFrom: '2021-01-01', capturedTo: '2021-02-01' };
        expect(page(readerOf(unbacked).getSeriesPage('fixture-a')).facts.captured).toBeNull();
        for (const derived of [{ photoCount: 6, capturedFrom: '2021-01-01' }, { photoCount: 6, capturedFrom: '2019', capturedTo: '2021-01-01' }, { photoCount: 6, capturedFrom: '2019-01-01', capturedTo: '2021-01-01T00:00:00Z' }, { photoCount: 6, capturedFrom: '2022-01-01', capturedTo: '2021-01-01' }, { photoCount: 6, capturedFrom: 'yesterday', capturedTo: '2021-01-01' }]) {
            const odd = structuredClone(content);
            odd.series[0].derived = derived;
            expect(page(readerOf(odd).getSeriesPage('fixture-a')).facts.captured, JSON.stringify(derived)).toBeNull();
        }
    });

    it('list each authored location once, trimmed, in sequence order, and none when no member has one', () => {
        expect(page(readerOf(content).getSeriesPage('fixture-a')).facts.locations).toEqual({ values: ['Fixture location one', 'Fixture location two'], source: 'photograph-records' });
        expect(page(readerOf(content).getSeriesPage('fixture-b')).facts.locations).toBeNull();
    });

    it('show the published count Work shows', () => {
        const result = page(readerOf(content).getSeriesPage('fixture-b'));
        expect(result.facts.photoCount).toEqual({ value: 1, source: 'published-sequence' });
    });

    it('stay apart from the authored copy', () => {
        const result = page(readerOf(content).getSeriesPage('fixture-a'));
        expect(Object.keys(result.authored).sort()).toEqual(['statement', 'title']);
        expect(Object.keys(result.facts).sort()).toEqual(['captured', 'locations', 'photoCount']);
        expect(JSON.stringify(result.authored)).not.toMatch(/Fixture location|2023-03-04/);
    });
});

describe('the authored copy and metadata inputs', () => {
    let content: RevisionContent;

    beforeAll(() => {
        content = revisionContent();
    });

    it('keeps the statement as plain-text paragraphs, markup and all, and empty when blank', () => {
        expect(page(readerOf(content).getSeriesPage('fixture-a')).authored.statement[1]).toBe('Second <b>paragraph</b> & more.');
        const blank = structuredClone(content);
        blank.series[0].statement = ' \n\n \t ';
        expect(page(readerOf(blank).getSeriesPage('fixture-a')).authored.statement).toEqual([]);
        const crlf = structuredClone(content);
        crlf.series[0].statement = 'One.\r\n\r\nTwo.';
        expect(page(readerOf(crlf).getSeriesPage('fixture-a')).authored.statement).toEqual(['One.', 'Two.']);
    });

    it('names a decorative cover by the series title in the share image, and gives no description for a blank short statement', () => {
        const decorative = structuredClone(content);
        decorative.series[0].cover = { photoId: P[3] };
        decorative.series[0].shortStatement = '  ';
        const result = page(readerOf(decorative).getSeriesPage('fixture-a'));
        expect(result.metadata.shareImage?.alt).toBe('Fixture series 01, cover photograph');
        expect(result.metadata.shareImage?.path).toBe(photoOf(content, P[3]).variants.w1200.webp.url);
        expect(result.metadata.description).toBeNull();
    });

    it('gives paths only, never an origin, so the page makes them absolute or leaves them out', () => {
        const json = JSON.stringify(page(readerOf(content).getSeriesPage('fixture-a')).metadata);
        expect(json).not.toMatch(/https?:|localhost|\/\/[a-z]/);
        expect(page(readerOf(content).getSeriesPage('fixture-a')).metadata.shareImage?.path).toMatch(/^\/media\/ph_[^/]+\/sha256-[0-9a-f]{64}\/p_[0-9a-f]{16}\/w1200\.webp$/);
    });
});

describe('the allowlist', () => {
    it('returns only the approved fields: no accent, aliases, caption, credit, per-photo date, camera facts, profile, or source', () => {
        const result = page(readerOf(revisionContent()).getSeriesPage('fixture-a'));
        expect(Object.keys(result).sort()).toEqual(['authored', 'catalogRevision', 'chapters', 'cover', 'entries', 'facts', 'href', 'id', 'metadata', 'slug', 'workHref']);
        expect(Object.keys(result.entries[0]).sort()).toEqual(['description', 'href', 'image', 'photoId', 'position', 'title']);
        expect(Object.keys(result.cover ?? {}).sort()).toEqual(['crop', 'focalPoint', 'href', 'image', 'photoId', 'position']);
        expect(Object.keys(result.metadata).sort()).toEqual(['canonicalPath', 'description', 'shareImage', 'title']);
        const json = JSON.stringify(result);
        for (const leak of ['#a0b0c0', '#c08040', 'accent', 'old-fixture-a', 'slugAliases', 'Fixture caption', 'Fixture credit', 'Fixture Make', 'Fixture Model', 'technical', 'profileId', 'assetRevision', 'fixture-source-one', 'openingPhotoId', 'ser_fixture-b', 'fixture-draft', 'fixture-hidden', P[7], P[8], P[9]]) {
            expect(json).not.toContain(leak);
        }
    });

    it('keeps out record fields a tampered revision adds', () => {
        const tampered = structuredClone(revisionContent()) as unknown as { photos: Record<string, unknown>[]; series: Record<string, unknown>[] } & RevisionContent;
        const photo = photoOf(tampered, P[1]) as unknown as Record<string, unknown> & { variants: Record<string, Record<string, Record<string, unknown>>> };
        Object.assign(photo, { sourcePath: '/library/private/fixture-source.jpg', gps: '12.345' });
        photo.variants.w1200.webp.path = '/data/assets/private.webp';
        Object.assign(tampered.series[0], { visibility: 'published', internalNote: 'Fixture internal note' });
        (tampered.series[0].chapters[0] as Record<string, unknown>).note = 'Fixture chapter note';
        const result = page(readerOf(tampered as RevisionContent).getSeriesPage('fixture-a'));
        expect(Object.keys(result.cover?.image.variants.w1200.webp ?? {}).sort()).toEqual(['bytes', 'height', 'url', 'width']);
        const json = JSON.stringify(result);
        for (const leak of ['/library/', '12.345', '/data/assets', 'internalNote', 'visibility', 'Fixture chapter note']) expect(json).not.toContain(leak);
    });
});

describe('in a draft preview', () => {
    it('gives a pending photo no description and keeps its entry', () => {
        const draft = createCatalogReader(catalog.content, { revisionId: REVISION_B, revisionNumber: null });
        const result = page(draft.getSeriesPage('fixture-a'));
        const pending = result.entries.find((entry) => entry.photoId === P[2]);
        expect([pending?.description, pending?.position, pending?.href]).toEqual([null, 4, `/work/fixture-a/photo/${P[2]}`]);
        expect(result.catalogRevision).toBe(REVISION_B);
    });

    it('treats a blank description as none', () => {
        const blank = structuredClone(catalog.content);
        const photo = photoOf(blank, P[0]);
        photo.alt = { kind: 'described', text: '  ' };
        const result = page(createCatalogReader(blank, { revisionId: REVISION_B, revisionNumber: null }).getSeriesPage('fixture-a'));
        expect(result.entries[0].description).toBeNull();
    });
});

describe('catalog revision consistency', () => {
    it('answers from the reader\'s own content, so two revisions never mix', () => {
        const a = revisionContent();
        const b = structuredClone(a);
        // Revision B renames series A's slug (keeping the old one), retitles it, drops P[5], and moves its cover.
        b.series[0].slug = 'fixture-a-renamed';
        b.series[0].slugAliases = ['old-fixture-a', 'fixture-a'];
        b.series[0].title = 'Fixture series 01, renamed';
        b.series[0].photoIds = ORDER_A.slice(0, 5);
        b.series[0].derived.photoCount = 5;
        b.series[0].cover = { photoId: P[0] };
        const readerA = readerOf(a, REVISION_A);
        const readerB = readerOf(b, REVISION_B);

        const fromA = page(readerA.getSeriesPage('fixture-a'));
        expect([fromA.catalogRevision, fromA.authored.title, fromA.entries.length, fromA.facts.photoCount.value, fromA.cover?.photoId]).toEqual([REVISION_A, 'Fixture series 01', 6, 6, P[1]]);
        expect(readerB.getSeriesPage('fixture-a')).toEqual({ kind: 'redirect', slug: 'fixture-a-renamed', location: '/work/fixture-a-renamed' });
        expect(readerB.getSeriesPage('old-fixture-a')).toEqual({ kind: 'redirect', slug: 'fixture-a-renamed', location: '/work/fixture-a-renamed' });
        const fromB = page(readerB.getSeriesPage('fixture-a-renamed'));
        expect([fromB.catalogRevision, fromB.authored.title, fromB.entries.length, fromB.facts.photoCount.value, fromB.cover?.photoId, fromB.metadata.title]).toEqual([REVISION_B, 'Fixture series 01, renamed', 5, 5, P[0], 'Fixture series 01, renamed']);
        expect(fromB.entries.every((entry) => entry.href.startsWith('/work/fixture-a-renamed/photo/'))).toBe(true);
        expect(fromB.id).toBe(fromA.id);
        expect(readerA.getSeriesPage('fixture-a-renamed')).toEqual({ kind: 'not-found' });
    });
});

describe('seriesPageFrom', () => {
    const okCatalog = (state: 'ok' | 'degraded' = 'ok'): SeriesActiveCatalog => ({ mode: 'catalog', state, reader: readerOf(revisionContent()) });

    it('answers a malformed slug not-found without loading the catalog', async () => {
        const load = vi.fn(async () => okCatalog());
        for (const slug of ['Fixture-A', '..', undefined, ['fixture-a'], 'fixture-a.json']) {
            expect(await seriesPageFrom(load, slug, routes)).toEqual({ kind: 'not-found' });
        }
        expect(load).not.toHaveBeenCalled();
        expect((await seriesPageFrom(load, 'fixture-a', routes)).kind).toBe('ok');
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('answers a site with no active revision not-found, like an unknown series, and never redirects there', async () => {
        expect(await seriesPageFrom(async () => ({ mode: 'legacy' }), 'fixture-a', routes)).toEqual({ kind: 'not-found' });
        expect(await seriesPageFrom(async () => ({ mode: 'legacy' }), 'old-fixture-a', routes)).toEqual({ kind: 'not-found' });
    });

    it('reports an unavailable catalog for the route to throw, never a not-found or a redirect', async () => {
        const unavailable: SeriesActiveCatalog<'active-unreadable'> = { mode: 'catalog', state: 'unavailable', reason: 'active-unreadable' };
        expect(await seriesPageFrom(async () => unavailable, 'fixture-a', routes)).toEqual({ kind: 'unavailable', reason: 'active-unreadable' });
        expect(await seriesPageFrom(async () => unavailable, 'old-fixture-a', routes)).toEqual({ kind: 'unavailable', reason: 'active-unreadable' });
        expect(await seriesPageFrom(async () => unavailable, 'fixture-draft', routes)).toEqual({ kind: 'unavailable', reason: 'active-unreadable' });
    });

    it('serves a degraded catalog\'s revision, redirects included', async () => {
        const result = await seriesPageFrom(async () => okCatalog('degraded'), 'fixture-a', routes);
        expect(result.kind === 'ok' && result.page.catalogRevision).toBe(REVISION_A);
        expect(await seriesPageFrom(async () => okCatalog('degraded'), 'old-fixture-a', routes)).toEqual({ kind: 'redirect', slug: 'fixture-a', location: '/work/fixture-a' });
    });

    it('passes the builder through', async () => {
        const preview = createRouteBuilder({ basePath: '/curation/preview/fixture' });
        const result = await seriesPageFrom(async () => okCatalog(), 'fixture-a', preview);
        expect(result.kind === 'ok' && result.page.href).toBe('/curation/preview/fixture/work/fixture-a');
    });
});

describe('the series page on published revisions', { timeout: 60_000 }, () => {
    it('resolves within the active revision, which a publish replaces, and a slug change leaves a redirect', async () => {
        const published = await createTestCatalog({
            variantBytes: VARIANT_BYTES,
            seed: 15,
            photos: 4,
            series: [{ slug: 'fixture-a' }, { slug: 'fixture-b' }, { slug: 'fixture-draft', photos: 0, photoIds: [], cover: null, visibility: 'draft' }],
        });
        cleanups.push(() => published.cleanup());
        const root = published.root;
        const logger = { log: () => undefined };
        vi.resetModules();
        const { loadActiveCatalog } = await import('../public-reader');
        const load = () => loadActiveCatalog(root);

        expect(await seriesPageFrom(load, 'fixture-a', routes)).toEqual({ kind: 'not-found' });

        const one = await publish({ dataRoot: root, actor: 'test', confirmLaunch: true, logger });
        expect(one.outcome).toBe('PUBLISHED');
        const atOne = await seriesPageFrom(load, 'fixture-a', routes);
        if (atOne.kind !== 'ok') throw new Error(`Expected a page, got ${JSON.stringify(atOne)}`);
        expect([atOne.page.catalogRevision, atOne.page.entries.map((entry) => entry.photoId)]).toEqual([one.revisionId, published.series[0].photoIds]);
        expect(atOne.page.cover?.photoId).toBe(published.series[0].photoIds[0]);
        expect(await seriesPageFrom(load, 'fixture-draft', routes)).toEqual({ kind: 'not-found' });

        const layer = await readWorkingLayer(root);
        const record = layer.series.find((series) => series.id === published.series[0].id);
        if (!record) throw new Error('No series A record');
        await writeAuthoredRecord({ ...structuredClone(record), slug: 'fixture-a-renamed', slugAliases: ['fixture-a'], title: 'Fixture series 01, renamed' }, { expectedVersion: record.version, root });
        const two = await publish({ dataRoot: root, actor: 'test', confirmLaunch: true, logger });
        expect(two.outcome).toBe('PUBLISHED');
        expect(two.revisionId).not.toBe(one.revisionId);
        expect(await seriesPageFrom(load, 'fixture-a', routes)).toEqual({ kind: 'redirect', slug: 'fixture-a-renamed', location: '/work/fixture-a-renamed' });
        const atTwo = await seriesPageFrom(load, 'fixture-a-renamed', routes);
        if (atTwo.kind !== 'ok') throw new Error(`Expected a page, got ${JSON.stringify(atTwo)}`);
        expect([atTwo.page.catalogRevision, atTwo.page.id, atTwo.page.authored.title]).toEqual([two.revisionId, published.series[0].id, 'Fixture series 01, renamed']);
    });
});
