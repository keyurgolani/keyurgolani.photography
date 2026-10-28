// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../../identity/variants';
import { createCatalogReader, createRouteBuilder, toAssetProjection } from '../reader';
import { stripBasePath } from '../routes';
import type { CandidateContent, PublicPhotoRecord, RevisionContent, SeriesRecord } from '../types';

const ASSET = `sha256-${'a'.repeat(64)}`;
const PROFILE = 'p_0123456789abcdef';
const REVISION = `rev_${'c'.repeat(64)}`;
const ids = Array.from({ length: 6 }, (_, index) => `ph_00000000-0000-4000-8000-00000000000${index + 1}`);

function photo(id: string, extra: Partial<PublicPhotoRecord> = {}): PublicPhotoRecord {
    const variants = {} as PublicPhotoRecord['variants'];
    for (const width of VARIANT_WIDTHS) {
        variants[width] = {} as PublicPhotoRecord['variants'][typeof width];
        for (const format of VARIANT_FORMATS) {
            variants[width][format] = { url: `/media/${id}/${ASSET}/${PROFILE}/${width}.${format}`, width: 400, height: 267, bytes: 100 };
        }
    }
    return {
        id,
        assetRevision: ASSET,
        profileId: PROFILE,
        width: 1920,
        height: 1280,
        aspectRatio: 1.5,
        variants,
        lqip: 'data:image/webp;base64,UklGRg==',
        alt: { kind: 'described', text: `Fixture photograph ${id.slice(-1)}` },
        technical: { Model: 'Fixture Model' },
        ...extra,
    };
}

function series(id: string, photoIds: string[], extra: Partial<SeriesRecord> = {}): SeriesRecord {
    return {
        id,
        slug: id.slice(4),
        slugAliases: [],
        title: `Fixture ${id}`,
        statement: 'Fixture statement.',
        shortStatement: 'Fixture short statement.',
        photoIds,
        chapters: [],
        cover: { photoId: photoIds[0] },
        derived: { photoCount: photoIds.length },
        ...extra,
    };
}

// Work order puts ser_fixture-b first, apart from ID order. ids[5] is in no series, and ids[9] in ser_fixture-a resolves to nothing.
const content: RevisionContent = {
    site: { featuredSeriesIds: ['ser_fixture-a'] },
    series: [
        series('ser_fixture-b', [ids[3], ids[4]], { slugAliases: ['old-fixture-b'] }),
        series('ser_fixture-a', [ids[2], ids[0], 'ph_00000000-0000-4000-8000-000000000009', ids[1]]),
    ],
    photos: ids.map((id) => photo(id)),
};

describe('createCatalogReader', () => {
    const reader = createCatalogReader(content, { revisionId: REVISION, revisionNumber: 4 });

    it('reports its revision, the site, and the series in Work order', () => {
        expect(reader.revision()).toEqual({ revisionId: REVISION, revisionNumber: 4 });
        expect(reader.site()).toEqual({ featuredSeriesIds: ['ser_fixture-a'] });
        expect(reader.listSeries().map((entry) => entry.id)).toEqual(['ser_fixture-b', 'ser_fixture-a']);
    });

    it('finds a series by its slug as canonical and by an alias as not', () => {
        expect(reader.seriesBySlug('fixture-b')).toEqual({ series: content.series[0], canonical: true });
        expect(reader.seriesBySlug('old-fixture-b')).toEqual({ series: content.series[0], canonical: false });
        expect(reader.seriesBySlug('Fixture-B')).toBeNull();
        expect(reader.seriesBySlug('fixture-c')).toBeNull();
    });

    it('finds photos and the series holding them', () => {
        expect(reader.photo(ids[0])).toBe(content.photos[0]);
        expect(reader.photo('ph_00000000-0000-4000-8000-000000000009')).toBeNull();
        expect(reader.seriesOfPhoto(ids[4])?.id).toBe('ser_fixture-b');
        expect(reader.seriesOfPhoto(ids[5])).toBeNull();
    });

    it('lists a series\' photos in photoIds order, skipping unresolved entries, a page at a time', () => {
        const order = (entries: PublicPhotoRecord[]) => entries.map((entry) => entry.id);
        expect(order(reader.photosOf('ser_fixture-a'))).toEqual([ids[2], ids[0], ids[1]]);
        expect(order(reader.photosOf('ser_fixture-a', 1, 1))).toEqual([ids[0]]);
        expect(order(reader.photosOf('ser_fixture-a', 2, 10))).toEqual([ids[1]]);
        expect(reader.photosOf('ser_fixture-a', 5, 10)).toEqual([]);
        expect(reader.photosOf('ser_fixture-z')).toEqual([]);
        expect(() => reader.photosOf('ser_fixture-a', -1, 1)).toThrow(RangeError);
        expect(() => reader.photosOf('ser_fixture-a', 0, 1.5)).toThrow(RangeError);
    });

    it('reads a candidate, pending alt included, with no revision number', () => {
        const candidate: CandidateContent = { ...content, photos: [photo(ids[0], { alt: { kind: 'pending' } as unknown as PublicPhotoRecord['alt'] }), ...content.photos.slice(1)] };
        const draft = createCatalogReader(candidate, { revisionId: REVISION, revisionNumber: null });
        expect(draft.revision().revisionNumber).toBeNull();
        expect(draft.photo(ids[0])?.alt).toEqual({ kind: 'pending' });
    });

    it('gives two readers over one content the same answers', () => {
        const again = createCatalogReader(content, { revisionId: REVISION, revisionNumber: 4 });
        expect(again.photosOf('ser_fixture-b')).toEqual(reader.photosOf('ser_fixture-b'));
        expect(again.seriesBySlug('old-fixture-b')).toEqual(reader.seriesBySlug('old-fixture-b'));
    });
});

describe('toAssetProjection', () => {
    it('turns a photo back into #10\'s asset projection, with capturedAt as capturedDate', () => {
        const record = photo(ids[0], { title: 'Fixture title', capturedAt: '2024-05-06', focalPoint: { x: 0.2, y: 0.8 } });
        expect(toAssetProjection(record)).toEqual({
            photoId: ids[0],
            assetRevision: ASSET,
            profileId: PROFILE,
            width: 1920,
            height: 1280,
            lqip: record.lqip,
            variants: record.variants,
            technical: { Model: 'Fixture Model' },
            capturedDate: '2024-05-06',
        });
        expect(toAssetProjection(photo(ids[1])).capturedDate).toBeNull();
    });
});

describe('createRouteBuilder', () => {
    it('builds the public routes', () => {
        const routes = createRouteBuilder();
        expect([routes.homeHref(), routes.workHref(), routes.seriesHref('fixture-a'), routes.photoHref('fixture-a', ids[0])])
            .toEqual(['/', '/work', '/work/fixture-a', `/work/fixture-a/photo/${ids[0]}`]);
    });

    it('prefixes a base path, as a preview does', () => {
        const routes = createRouteBuilder({ basePath: '/curation/preview/rev_x/site' });
        expect(routes.basePath).toBe('/curation/preview/rev_x/site');
        expect([routes.homeHref(), routes.workHref(), routes.seriesHref('fixture-a')])
            .toEqual(['/curation/preview/rev_x/site', '/curation/preview/rev_x/site/work', '/curation/preview/rev_x/site/work/fixture-a']);
    });

    it('encodes segments and refuses a malformed base path', () => {
        expect(createRouteBuilder().seriesHref('a b/c')).toBe('/work/a%20b%2Fc');
        for (const basePath of ['preview', '/preview/', '//preview', '/\\preview', '/pre view', '/preview//site']) expect(() => createRouteBuilder({ basePath })).toThrow(TypeError);
    });

    it('builds About, the catalog endpoints, and /media the same way (#16)', () => {
        const media = '/media/ph_1/sha256-a/p1/w400.avif';
        const pub = createRouteBuilder();
        expect([pub.aboutHref(), pub.catalogApiHref('series/a/pages/c'), pub.mediaHref(media)]).toEqual(['/about', '/api/catalog/series/a/pages/c', media]);
        const preview = createRouteBuilder({ basePath: '/curation/preview/rev_x/site' });
        expect([preview.aboutHref(), preview.catalogApiHref('home/photos/p?revision=r'), preview.mediaHref(media)])
            .toEqual(['/curation/preview/rev_x/site/about', '/curation/preview/rev_x/site/api/catalog/home/photos/p?revision=r', `/curation/preview/rev_x/site${media}`]);
    });

    it('strips a base path from a pathname, and only a whole one', () => {
        const base = '/curation/preview/rev_x/site';
        expect([stripBasePath('/work', ''), stripBasePath(base, base), stripBasePath(`${base}/work/a`, base), stripBasePath(`${base}x/work`, base), stripBasePath('/work', base)])
            .toEqual(['/work', '/', '/work/a', null, null]);
    });
});
