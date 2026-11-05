// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
    homeRouteOf,
    homeSeriesPhotosFrom,
    homeSeriesPhotosOf,
    publishedHomeOf,
    type HomeActiveCatalog,
    type HomeLoopSeries,
    type HomePick,
    type HomeSource,
    type PublishedHome,
} from '../projections/home';
import { createCatalogReader, createRouteBuilder } from '../reader';
import { buildTestCatalog, type TestCatalogContent } from '../testing';
import type { CandidateContent, RevisionContent } from '../types';

// Home's loop of featured series: which one a load starts on, the order it
// plays them in, and the window the continuation route answers for a
// (series, photograph) pair. home.test.ts covers one featured series, which
// gives today's Home exactly.

const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const X = [id(1), id(2), id(3)];
const Y = [id(4), id(5)];
const Z = [id(6), id(7), id(8), id(9)];
const UNFEATURED = [id(10)];
const DRAFT = [id(11)];
const HIDDEN = [id(12)];
const routes = createRouteBuilder();
const REVISION_A = `rev_${'a'.repeat(64)}`;
const REVISION_B = `rev_${'b'.repeat(64)}`;

/**
 * Three featured series in featuredSeriesIds order X, Y, Z, which Work order
 * (Z, U, Y, X) disagrees with. X opens on its second photograph, Y has no
 * opening stored, so it opens on its first, and Z opens on its third. U is
 * published but not featured, and the draft and hidden series aren't in the
 * content at all.
 */
let fixture: TestCatalogContent;

beforeAll(async () => {
    fixture = await buildTestCatalog({
        seed: 31,
        photos: [...X, ...Y, ...Z, ...UNFEATURED, ...DRAFT, ...HIDDEN].map((photoId) => ({ id: photoId })),
        series: [
            { id: 'ser_loop-x', slug: 'loop-x', title: 'Loop series X', shortStatement: 'Statement X.', photoIds: X, openingPhotoId: X[1] },
            { id: 'ser_loop-y', slug: 'loop-y', title: 'Loop series Y', shortStatement: 'Statement Y.', photoIds: Y },
            { id: 'ser_loop-z', slug: 'loop-z', title: 'Loop series Z', shortStatement: 'Statement Z.', photoIds: Z, openingPhotoId: Z[2] },
            { id: 'ser_loop-u', slug: 'loop-u', title: 'Loop series U, unfeatured', photoIds: UNFEATURED },
            { id: 'ser_loop-draft', slug: 'loop-draft', photoIds: DRAFT, visibility: 'draft' },
            { id: 'ser_loop-hidden', slug: 'loop-hidden', photoIds: HIDDEN, visibility: 'hidden' },
        ],
        featuredSeriesIds: ['ser_loop-x', 'ser_loop-y', 'ser_loop-z'],
        seriesOrder: ['ser_loop-z', 'ser_loop-u', 'ser_loop-y', 'ser_loop-x', 'ser_loop-draft', 'ser_loop-hidden'],
    });
});

function content(): RevisionContent {
    return structuredClone(fixture.content) as RevisionContent;
}

const seriesIn = (held: CandidateContent, seriesId: string) => {
    const series = held.series.find((entry) => entry.id === seriesId);
    if (!series) throw new Error(`No ${seriesId}`);
    return series;
};

function source(from: CandidateContent = content(), revisionId = REVISION_A): HomeSource {
    const reader = createCatalogReader(from, { revisionId, revisionNumber: 3 });
    return { revisionId, site: reader.site, listSeries: reader.listSeries, photosOf: (seriesId) => reader.photosOf(seriesId) };
}

/** A random source that always answers `index`. */
const always = (index: number): HomePick => () => index;

function homeOf(pick: HomePick, from: CandidateContent = content()): PublishedHome {
    return publishedHomeOf(source(from), routes, pick);
}

/** The loop's series in play order: the one Home opens on, then the ones after it. */
const loopOf = (home: PublishedHome): HomeLoopSeries[] => (home.featuredSeries ? [home.featuredSeries, ...(home.followingSeries ?? [])] : []);
const loopIds = (home: PublishedHome) => loopOf(home).map((series) => series.id);

/** The window the continuation route gives for `photoId` in `seriesId`. */
function windowOf(seriesId: string, photoId: string, from: CandidateContent = content()) {
    const result = homeSeriesPhotosOf(source(from), seriesId, photoId);
    if (result.kind !== 'ok') throw new Error(`Expected a window around ${photoId} in ${seriesId}, got ${result.kind}`);
    return result.window;
}

/**
 * Walks the loop `steps` photographs from the opening one, as Next does,
 * taking each next photograph from the window the route gives for the one
 * on screen, and the series it belongs to from the model Home rendered.
 */
function walk(home: PublishedHome, steps: number, from: CandidateContent = content(), direction: 1 | -1 = 1): string[] {
    const seriesOf = new Map(loopOf(home).flatMap((series) => series.photoIds.map((photoId) => [photoId, series.id] as const)));
    let at = home.featuredSeries!.openingPhotoId;
    const seen = [at];
    for (let step = 0; step < steps; step++) {
        const photos = windowOf(seriesOf.get(at)!, at, from).photos.map((photo) => photo.id);
        at = direction === 1 ? photos[photos.indexOf(at) + 1] : photos[photos.indexOf(at) - 1];
        seen.push(at);
    }
    return seen;
}

describe('the series a load starts on', () => {
    it('can be each featured series that resolves, as the random source picks', () => {
        expect(loopIds(homeOf(always(0)))).toEqual(['ser_loop-x', 'ser_loop-y', 'ser_loop-z']);
        expect(loopIds(homeOf(always(1)))).toEqual(['ser_loop-y', 'ser_loop-z', 'ser_loop-x']);
        expect(loopIds(homeOf(always(2)))).toEqual(['ser_loop-z', 'ser_loop-x', 'ser_loop-y']);
    });

    it('opens on the picked series\' own opening photograph, with its records, title and link', () => {
        const openings = { 0: X[1], 1: Y[0], 2: Z[2] } as const;
        for (const [index, opening] of Object.entries(openings)) {
            const series = homeOf(always(Number(index))).featuredSeries!;
            expect(series.openingPhotoId, index).toBe(opening);
            expect(series.records.map((photo) => photo.id), index).toContain(opening);
        }
        const z = homeOf(always(2)).featuredSeries!;
        expect([z.title, z.shortStatement, z.href, z.photoIds]).toEqual(['Loop series Z', 'Statement Z.', '/work/loop-z', Z]);
    });

    it('asks the random source once, for the number of featured series that resolve', () => {
        const pick = vi.fn<HomePick>(() => 1);
        const held = content();
        held.site.featuredSeriesIds = ['ser_loop-draft', 'ser_loop-x', 'ser_loop-hidden', 'ser_loop-y', 'ser_unknown', 'ser_loop-z'];
        expect(loopIds(homeOf(pick, held))).toEqual(['ser_loop-y', 'ser_loop-z', 'ser_loop-x']);
        expect(pick.mock.calls).toEqual([[3]]);
    });

    it('opens on the first one when the source answers anything but a position in range', () => {
        for (const answer of [-1, 3, 1.5, Number.NaN]) expect(loopIds(homeOf(always(answer)))[0], String(answer)).toBe('ser_loop-x');
    });

    it('defaults to crypto.randomInt, which starts every featured series over many loads', () => {
        const starts = new Map<string, number>();
        for (let load = 0; load < 300; load++) {
            const first = publishedHomeOf(source(), routes).featuredSeries!.id;
            starts.set(first, (starts.get(first) ?? 0) + 1);
        }
        // Each of the three misses all 300 loads with probability (2/3)^300, about 10^-53.
        expect([...starts.keys()].sort()).toEqual(['ser_loop-x', 'ser_loop-y', 'ser_loop-z']);
        // Roughly even: each lands within 100 ± 45, which a fair pick misses with probability under 10^-6.
        for (const [seriesId, count] of starts) expect(Math.abs(count - 100), seriesId).toBeLessThan(45);
    });

    it('spreads an even random source evenly over the featured series', () => {
        let next = 0;
        const counts = [0, 0, 0];
        const cycling: HomePick = (count) => next++ % count;
        for (let load = 0; load < 30; load++) counts[['ser_loop-x', 'ser_loop-y', 'ser_loop-z'].indexOf(homeOf(cycling).featuredSeries!.id)] += 1;
        expect(counts).toEqual([10, 10, 10]);
    });
});

describe('one featured series', () => {
    it('gives today\'s model exactly, with no loop after it, and never asks the random source', () => {
        const pick = vi.fn<HomePick>(() => 0);
        const held = content();
        held.site.featuredSeriesIds = ['ser_loop-z'];
        const home = homeOf(pick, held);
        expect(pick).not.toHaveBeenCalled();
        expect(home).not.toHaveProperty('followingSeries');
        expect(Object.keys(home).sort()).toEqual(['catalogRevision', 'featuredSeries']);
        const series = home.featuredSeries!;
        // Byte for byte, key order included, since the page ships it as JSON.
        expect(JSON.stringify({ ...series, records: series.records.map((photo) => photo.id) })).toBe(
            JSON.stringify({
                id: 'ser_loop-z',
                slug: 'loop-z',
                href: '/work/loop-z',
                title: 'Loop series Z',
                shortStatement: 'Statement Z.',
                photoIds: Z,
                // The opening photograph and its neighbor on each side, in the series' own order.
                records: [Z[1], Z[2], Z[3]],
                openingPhotoId: Z[2],
            }),
        );
        expect(series.records.map((photo) => Object.keys(photo))).toEqual(Array(3).fill(['id', 'alt', 'focalPoint', 'crop', 'image']));
        // Its windows stay inside the series, wrapping, as today.
        expect(windowOf('ser_loop-z', Z[3], held).photos.map((photo) => photo.id)).toEqual([Z[2], Z[3], Z[0]]);
        expect(windowOf('ser_loop-z', Z[0], held).photos.map((photo) => photo.id)).toEqual([Z[3], Z[0], Z[1]]);
    });

    it('is the same whatever the random source would answer', () => {
        const held = content();
        held.site.featuredSeriesIds = ['ser_loop-x'];
        expect(homeOf(always(2), held)).toEqual(homeOf(always(0), held));
    });

    it('is the one left when the others don\'t resolve', () => {
        const held = content();
        held.site.featuredSeriesIds = ['ser_loop-draft', 'ser_loop-y', 'ser_loop-hidden'];
        const home = homeOf(always(5), held);
        expect(loopIds(home)).toEqual(['ser_loop-y']);
        expect(home).not.toHaveProperty('followingSeries');
    });
});

describe('the loop', () => {
    it('plays each series from its opening photograph through its order, wraps to the ones before it, then crosses into the next series, and after the last goes back to the first', () => {
        const fromX = [X[1], X[2], X[0], Y[0], Y[1], Z[2], Z[3], Z[0], Z[1]];
        expect(walk(homeOf(always(0)), 9)).toEqual([...fromX, X[1]]);
        // Starting on Z, the order is the same loop from Z's opening photograph.
        expect(walk(homeOf(always(2)), 9)).toEqual([...fromX.slice(5), ...fromX.slice(0, 5), Z[2]]);
    });

    it('steps backwards across the same boundaries with Previous', () => {
        expect(walk(homeOf(always(0)), 9, content(), -1)).toEqual([X[1], Z[1], Z[0], Z[3], Z[2], Y[1], Y[0], X[0], X[2], X[1]]);
    });

    it('keeps the curated order inside each series', () => {
        for (const index of [0, 1, 2]) {
            for (const series of loopOf(homeOf(always(index)))) expect(series.photoIds, series.id).toEqual(seriesIn(fixture.content, series.id).photoIds);
        }
    });

    it('ships every series\' order and opening, but records only around the opening photograph, across the boundary before it', () => {
        const home = homeOf(always(1));
        // Y opens on its first photograph: the one before it in the loop is X's last to play, X[0].
        expect(home.featuredSeries!.records.map((photo) => photo.id)).toEqual([X[0], Y[0], Y[1]]);
        expect(home.followingSeries!.map((series) => [series.id, series.openingPhotoId, series.photoIds])).toEqual([
            ['ser_loop-z', Z[2], Z],
            ['ser_loop-x', X[1], X],
        ]);
        for (const series of home.followingSeries!) {
            expect(Object.keys(series).sort(), series.id).toEqual(['href', 'id', 'openingPhotoId', 'photoIds', 'shortStatement', 'slug', 'title']);
        }
        // The LQIP rides on the opening photograph alone.
        expect(home.featuredSeries!.records.map((photo) => photo.image !== null && 'lqip' in photo.image)).toEqual([false, true, false]);
    });

    it('skips a featured series that doesn\'t resolve, and plays the rest in featuredSeriesIds order', () => {
        const cases: [string, (held: RevisionContent) => void][] = [
            ['not in the revision', (held) => (held.site.featuredSeriesIds = ['ser_loop-x', 'ser_loop-draft', 'ser_loop-y', 'ser_unknown', 'ser_loop-hidden', 'ser_loop-z'])],
            ['no member that resolves', (held) => (seriesIn(held, 'ser_loop-u').photoIds = [id(99)])],
            ['a zero count', (held) => (seriesIn(held, 'ser_loop-u').derived.photoCount = 0)],
            ['a slug the route refuses', (held) => (seriesIn(held, 'ser_loop-u').slug = 'Loop-U')],
            ['its ID twice', (held) => held.series.push({ ...structuredClone(seriesIn(held, 'ser_loop-u')), slug: 'loop-u-again', slugAliases: [] })],
            // A hand-written revision only: refs.membership keeps a photograph in one published series.
            ['a photograph an earlier featured series holds', (held) => (seriesIn(held, 'ser_loop-u').photoIds = [UNFEATURED[0], X[0]])],
        ];
        for (const [name, edit] of cases) {
            const held = content();
            held.site.featuredSeriesIds = ['ser_loop-x', 'ser_loop-u', 'ser_loop-y', 'ser_loop-z'];
            edit(held);
            const home = homeOf(always(0), held);
            expect(loopIds(home), name).toEqual(['ser_loop-x', 'ser_loop-y', 'ser_loop-z']);
            // X's last photograph to play crosses straight into Y.
            expect(walk(home, 3, held)[3], name).toBe(Y[0]);
            expect(homeSeriesPhotosOf(source(held), 'ser_loop-u', UNFEATURED[0]), name).toEqual({ kind: 'not-found' });
        }
    });

    it('plays a series featured twice once, at its first place', () => {
        const held = content();
        held.site.featuredSeriesIds = ['ser_loop-x', 'ser_loop-y', 'ser_loop-x', 'ser_loop-z'];
        const pick = vi.fn<HomePick>(() => 2);
        expect(loopIds(homeOf(pick, held))).toEqual(['ser_loop-z', 'ser_loop-x', 'ser_loop-y']);
        expect(pick.mock.calls).toEqual([[3]]);
    });

    it('is the empty state when no featured series resolves', () => {
        const held = content();
        held.site.featuredSeriesIds = ['ser_loop-draft', 'ser_loop-hidden', 'ser_unknown'];
        expect(homeOf(always(0), held)).toEqual({ catalogRevision: REVISION_A, featuredSeries: null });
    });

    it('holds nothing from an unfeatured, draft or hidden series', () => {
        const serialized = JSON.stringify([0, 1, 2].map((index) => homeOf(always(index))));
        for (const outside of [...UNFEATURED, ...DRAFT, ...HIDDEN, 'Loop series U', 'loop-u', 'loop-draft', 'loop-hidden']) expect(serialized).not.toContain(outside);
    });

    it('names a photograph that carries its place by its place in its own series', () => {
        const held = content();
        for (const photo of held.photos) if (Z.includes(photo.id)) photo.alt = { kind: 'position' };
        const window = windowOf('ser_loop-y', Y[1], held);
        expect(window.photos.map((photo) => [photo.id, photo.alt])).toEqual([
            [Y[0], expect.any(String)],
            [Y[1], expect.any(String)],
            [Z[2], 'Photograph 3 of 4'],
        ]);
    });
});

describe('homeSeriesPhotosOf, the window for a (series, photograph) pair', () => {
    it('gives the photograph and its neighbors in loop order, from the source\'s revision, with no LQIP', () => {
        const window = windowOf('ser_loop-x', X[0]);
        expect(window.revisionId).toBe(REVISION_A);
        expect(window.photos.map((photo) => photo.id)).toEqual([X[2], X[0], Y[0]]);
        for (const seriesId of ['ser_loop-x', 'ser_loop-y', 'ser_loop-z']) {
            for (const photoId of seriesIn(fixture.content, seriesId).photoIds) {
                for (const photo of windowOf(seriesId, photoId).photos) expect(photo.image === null || !('lqip' in photo.image), photoId).toBe(true);
            }
        }
    });

    it('lists each record once when the whole loop is shorter than a window', () => {
        const held = content();
        held.site.featuredSeriesIds = ['ser_loop-u', 'ser_loop-y'];
        seriesIn(held, 'ser_loop-y').photoIds = [Y[0]];
        expect(windowOf('ser_loop-u', UNFEATURED[0], held).photos.map((photo) => photo.id)).toEqual([Y[0], UNFEATURED[0]]);
        held.site.featuredSeriesIds = ['ser_loop-u'];
        expect(windowOf('ser_loop-u', UNFEATURED[0], held).photos.map((photo) => photo.id)).toEqual([UNFEATURED[0]]);
    });

    it('answers not-found for an unfeatured, draft, hidden or unknown series, and for a photograph its series doesn\'t hold', () => {
        const cases: [string, string][] = [
            ['ser_loop-u', UNFEATURED[0]],
            ['ser_loop-draft', DRAFT[0]],
            ['ser_loop-hidden', HIDDEN[0]],
            ['ser_unknown', X[0]],
            // Another featured series' photograph, and one in no featured series.
            ['ser_loop-x', Y[0]],
            ['ser_loop-x', UNFEATURED[0]],
            // Malformed IDs.
            ['ser_loop-x', 'ph_x'],
            ['loop-x', X[0]],
            ['ser_LOOP-X', X[0]],
            ['', X[0]],
        ];
        for (const [seriesId, photoId] of cases) expect(homeSeriesPhotosOf(source(), seriesId, photoId), `${seriesId} ${photoId}`).toEqual({ kind: 'not-found' });
    });

    it('answers not-found for a series a draft or a hidden series would be, even when the site lists it as featured', () => {
        const held = content();
        held.site.featuredSeriesIds = ['ser_loop-x', 'ser_loop-draft', 'ser_loop-hidden'];
        for (const [seriesId, photoId] of [['ser_loop-draft', DRAFT[0]], ['ser_loop-hidden', HIDDEN[0]]]) {
            expect(homeSeriesPhotosOf(source(held), seriesId, photoId), seriesId).toEqual({ kind: 'not-found' });
        }
    });

    it('answers not-found when the series stops being featured', () => {
        const held = content();
        held.site.featuredSeriesIds = ['ser_loop-x'];
        expect(homeSeriesPhotosOf(source(held), 'ser_loop-y', Y[0])).toEqual({ kind: 'not-found' });
        held.site.featuredSeriesIds = [];
        expect(homeSeriesPhotosOf(source(held), 'ser_loop-x', X[0])).toEqual({ kind: 'not-found' });
    });
});

describe('homeSeriesPhotosFrom, the continuation route\'s answer', () => {
    const served = (state: 'ok' | 'degraded' = 'ok'): HomeActiveCatalog => ({ state, reader: createCatalogReader(content(), { revisionId: REVISION_A, revisionNumber: 3 }) });

    it('answers a malformed series or photo ID not-found and a missing or malformed revision as a bad request, before reading the catalog', async () => {
        const load = vi.fn(async () => served());
        expect(await homeSeriesPhotosFrom(load, 'loop-x', X[0], REVISION_A)).toEqual({ kind: 'not-found' });
        expect(await homeSeriesPhotosFrom(load, 'ser_loop-x', 'ph_x', REVISION_A)).toEqual({ kind: 'not-found' });
        for (const revision of [null, '', 'rev_a', REVISION_A.toUpperCase()]) {
            expect(await homeSeriesPhotosFrom(load, 'ser_loop-x', X[0], revision), String(revision)).toEqual({ kind: 'bad-request' });
        }
        expect(load).not.toHaveBeenCalled();
    });

    it('passes an unavailable catalog on', async () => {
        expect(await homeSeriesPhotosFrom(async () => ({ state: 'unavailable', reason: 'active-unreadable' }), 'ser_loop-x', X[0], REVISION_A)).toEqual({
            kind: 'unavailable',
            reason: 'active-unreadable',
        });
    });

    it('answers revision-changed for any revision but the served one, whatever the series', async () => {
        for (const [seriesId, photoId] of [['ser_loop-x', X[0]], ['ser_loop-draft', DRAFT[0]], ['ser_unknown', X[0]]]) {
            expect(await homeSeriesPhotosFrom(async () => served(), seriesId, photoId, REVISION_B), seriesId).toEqual({ kind: 'revision-changed' });
        }
    });

    it('serves the window from the served revision, ok or degraded', async () => {
        for (const state of ['ok', 'degraded'] as const) {
            expect(await homeSeriesPhotosFrom(async () => served(state), 'ser_loop-z', Z[1], REVISION_A), state).toEqual(homeSeriesPhotosOf(source(), 'ser_loop-z', Z[1]));
        }
    });
});

describe('homeRouteOf with a random source', () => {
    it('hands the pick to the projection, so the page and its test can choose the start', () => {
        const reader = createCatalogReader(content(), { revisionId: REVISION_A, revisionNumber: 3 });
        for (const index of [0, 1, 2]) {
            const result = homeRouteOf({ state: 'ok', reader }, routes, always(index));
            expect(result.kind === 'home' && result.home, String(index)).toEqual(homeOf(always(index)));
        }
    });
});
