// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { publishedHomeOf } from '../projections/home';
import { imageOf, lqipOf } from '../projections/ladder';
import { seriesPageOf } from '../projections/series';
import { openableSeries } from '../projections/shared';
import { viewerPhotoOf } from '../projections/viewer';
import { workCatalogOf } from '../projections/work';
import { createCatalogReader, createRouteBuilder, type CatalogContent } from '../reader';
import { buildTestCatalog, type TestCatalogContent } from '../testing';
import type { RevisionContent } from '../types';

// The helpers every screen projection shares (projections/shared.ts and
// ladder.ts), and the rule they exist for: Home, Work, the series page, and
// the Viewer agree on which series open, so no screen links a page that
// answers not-found.

const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = [id(1), id(2), id(3)];
const B = [id(4), id(5)];
const REVISION = `rev_${'d'.repeat(64)}`;
const routes = createRouteBuilder();

let fixture: TestCatalogContent;

beforeAll(async () => {
    fixture = await buildTestCatalog({
        seed: 92,
        photos: [...A, ...B].map((photoId) => ({ id: photoId })),
        series: [
            { id: 'ser_shared-a', slug: 'shared-a', slugAliases: ['old-shared-a'], photoIds: A },
            { id: 'ser_shared-b', slug: 'shared-b', photoIds: B },
        ],
        featuredSeriesIds: ['ser_shared-a', 'ser_shared-b'],
    });
});

function content(): RevisionContent {
    return structuredClone(fixture.content) as RevisionContent;
}

function sourceOf(held: CatalogContent) {
    const reader = createCatalogReader(held, { revisionId: REVISION, revisionNumber: 1 });
    return { ...reader, revisionId: REVISION };
}

/** Hand-written revisions of featured series A. Compile writes none of them. */
const HAND_WRITTEN: Record<string, (held: RevisionContent) => void> = {
    'its ID twice': (held) => {
        held.series.push({ ...structuredClone(held.series[0]), slug: 'shared-a-again', slugAliases: [] });
    },
    'a zero count': (held) => {
        held.series[0].derived.photoCount = 0;
    },
    'a fractional count': (held) => {
        held.series[0].derived.photoCount = 1.5;
    },
    'no count': (held) => {
        delete (held.series[0] as { derived?: unknown }).derived;
    },
    'no member that resolves': (held) => {
        held.series[0].photoIds = [id(99)];
    },
    'a slug the route refuses': (held) => {
        held.series[0].slug = 'Shared-A';
    },
};

describe('openableSeries', () => {
    it('opens a series whose ID appears once, with a positive count and a member that resolves', () => {
        const held = content();
        expect(openableSeries(sourceOf(held), held.series[0])).toBe(true);
        // The count needn't match the members that resolve.
        held.series[0].derived.photoCount = 1;
        expect(openableSeries(sourceOf(held), held.series[0])).toBe(true);
    });

    it.each([
        ['its ID twice', HAND_WRITTEN['its ID twice']],
        ['a zero count', HAND_WRITTEN['a zero count']],
        ['a fractional count', HAND_WRITTEN['a fractional count']],
        ['no count', HAND_WRITTEN['no count']],
        ['no member that resolves', HAND_WRITTEN['no member that resolves']],
    ])('refuses a series with %s', (_name, edit) => {
        const held = content();
        edit(held);
        expect(openableSeries(sourceOf(held), held.series[0])).toBe(false);
        // Series B, untouched, still opens.
        expect(openableSeries(sourceOf(held), held.series[1])).toBe(true);
    });

    it.each([-5, Number.NaN, '5', null, undefined])('refuses a count of %s', (photoCount) => {
        const held = content();
        (held.series[0].derived as { photoCount: unknown }).photoCount = photoCount;
        expect(openableSeries(sourceOf(held), held.series[0])).toBe(false);
    });
});

describe('every screen agrees on which series open', () => {
    it.each(Object.entries(HAND_WRITTEN))('with %s, Home links the series page only when it opens', (_name, edit) => {
        const held = content();
        edit(held);
        const source = sourceOf(held);
        const home = publishedHomeOf(source, routes);
        const page = seriesPageOf(source, held.series[0].slug, routes);
        // Home never falls through to B, so a refused A is the empty state.
        expect(home.featuredSeries).toBeNull();
        expect(page.kind).toBe('not-found');
        // A canonical slug in the wrong shape is no param at all, so the Viewer can't be asked. Work doesn't check the slug's
        // shape yet; that gap is deferred, since this change keeps Work's output as it was.
        if (/^[a-z0-9-]+$/.test(held.series[0].slug)) {
            expect(workCatalogOf(source, routes).series.map((entry) => entry.id)).not.toContain('ser_shared-a');
            expect(viewerPhotoOf(source, held.series[0].slug, A[0]).kind).toBe('not-found');
        }
    });

    it('with an untouched revision, every screen opens A', () => {
        const source = sourceOf(content());
        const home = publishedHomeOf(source, routes);
        expect(home.featuredSeries?.href).toBe('/work/shared-a');
        expect(seriesPageOf(source, 'shared-a', routes).kind).toBe('ok');
        expect(workCatalogOf(source, routes).series.map((entry) => entry.href)).toEqual(['/work/shared-a', '/work/shared-b']);
        expect(viewerPhotoOf(source, 'shared-a', A[0]).kind).toBe('ok');
    });

    it('never redirects a former slug to a canonical slug the route refuses, on the series page or in the Viewer', () => {
        const held = content();
        held.series[0].slug = 'Shared-A';
        const source = sourceOf(held);
        expect(seriesPageOf(source, 'old-shared-a', routes)).toEqual({ kind: 'not-found' });
        expect(viewerPhotoOf(source, 'old-shared-a', A[0])).toEqual({ kind: 'not-found' });
        // With the canonical slug in shape, both redirect.
        const fine = sourceOf(content());
        expect(seriesPageOf(fine, 'old-shared-a', routes)).toEqual({ kind: 'redirect', slug: 'shared-a', location: '/work/shared-a' });
        expect(viewerPhotoOf(fine, 'old-shared-a', A[0])).toEqual({ kind: 'redirect', slug: 'shared-a', photoId: A[0] });
    });
});

describe('lqipOf and imageOf', () => {
    const photo = () => content().photos[0];

    it('passes only a WebP data URI', () => {
        const held = photo();
        held.lqip = 'data:image/webp;base64,UklGRg+/AA==';
        expect(lqipOf(held)).toBe('data:image/webp;base64,UklGRg+/AA==');
        for (const lqip of ['data:image/png;base64,AAAA', 'data:image/webp;base64,AA)AA', "data:image/webp;base64,AA'AA", 'data:image/webp;base64,AAAA\n', 'data:image/webp;base64,', ' data:image/webp;base64,AAAA', 42, null, undefined]) {
            (held as { lqip: unknown }).lqip = lqip;
            expect(lqipOf(held), String(lqip)).toBeUndefined();
        }
    });

    it('carries the LQIP only when asked, and only one lqipOf() passes', () => {
        const held = photo();
        held.lqip = 'data:image/webp;base64,AAAA';
        expect(imageOf(held, true)).toHaveProperty('lqip', 'data:image/webp;base64,AAAA');
        expect(imageOf(held, false)).not.toHaveProperty('lqip');
        held.lqip = 'data:image/png;base64,AAAA';
        expect(imageOf(held, true)).not.toHaveProperty('lqip');
        expect(Object.keys(imageOf(held, true) ?? {})).toEqual(['width', 'height', 'variants']);
    });

    it('is null without positive integer dimensions or a usable ladder', () => {
        for (const [field, value] of [['width', 0], ['height', -1], ['width', 2.5], ['height', '1600']] as const) {
            const held = photo();
            (held as Record<string, unknown>)[field] = value;
            expect(imageOf(held, true), `${field} ${String(value)}`).toBeNull();
        }
        const foreign = photo();
        foreign.variants.w400.avif.url = '/assets/photos/elsewhere.avif';
        expect(imageOf(foreign, false)).toBeNull();
    });
});
