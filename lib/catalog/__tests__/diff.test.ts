// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Registry } from '../../identity/types';
import { changeId, diffCatalog, movedIds, type CatalogChange, type ChangeCategory, type DiffInput } from '../diff';
import { hashValue } from '../review';
import { revisionIdOf } from '../schema';
import { createTestCatalog, type TestCatalog } from '../testing';
import type { AuthoredPhoto, AuthoredSeries, CandidateContent, FieldReview, RevisionFile, WorkingLayer } from '../types';

/**
 * #16's diff engine, pure: each category, several at once, order moves,
 * the empty diff, missing sources, provenance, and deterministic output.
 * Every case starts from one fixture whose working layer is published as
 * the active revision, then edits the candidate and the working layer the
 * way compile would see them.
 */

let catalog: TestCatalog;
let active: RevisionFile;

const COMPILED_AT = '2026-02-01T00:00:00.000Z';
const A = `sha256-${'a'.repeat(64)}`;
const B = `sha256-${'b'.repeat(64)}`;

interface World {
    candidate: CandidateContent;
    layer: WorkingLayer;
    registry: Registry;
}

/** The published fixture: the candidate equals the active revision, and every record is on it. */
function world(): World {
    const on = <T extends { baseRevisionId: string | null }>(record: T): T => ({ ...structuredClone(record), baseRevisionId: active.revisionId });
    return {
        candidate: structuredClone(catalog.content),
        layer: { site: on(catalog.site), series: catalog.series.map(on), photos: catalog.photos.map(on), problems: [] },
        registry: structuredClone(catalog.registry),
    };
}

const diff = (w: World, extra: Partial<DiffInput> = {}) => diffCatalog({ active, candidate: w.candidate, authored: w.layer, registry: w.registry, review: { bases: new Map(), inbox: new Map(), unreadable: new Set() }, ...extra });
const series = (w: World, index: number) => w.candidate.series[index];
const authoredSeries = (w: World, id: string) => w.layer.series.find((entry) => entry.id === id) as AuthoredSeries;
const authoredPhoto = (w: World, id: string) => w.layer.photos.find((entry) => entry.id === id) as AuthoredPhoto;
const photo = (w: World, id: string) => w.candidate.photos.find((entry) => entry.id === id) as CandidateContent['photos'][number];
const rows = (changes: CatalogChange[]) => changes.map((change) => [change.record.kind, change.record.id, change.field, change.category]);

/** Remove a photo from the candidate and its series, as compile would leave it out. */
function dropPhoto(w: World, photoId: string): void {
    w.candidate.photos = w.candidate.photos.filter((entry) => entry.id !== photoId);
    for (const entry of w.candidate.series) {
        entry.photoIds = entry.photoIds.filter((id) => id !== photoId);
        entry.derived.photoCount = entry.photoIds.length;
    }
    for (const entry of w.layer.series) entry.photoIds = entry.photoIds.filter((id) => id !== photoId);
}

beforeAll(async () => {
    catalog = await createTestCatalog({ photos: 6, series: 2 });
    const content = structuredClone(catalog.content) as RevisionFile['content'];
    active = { revisionId: revisionIdOf(content), schemaVersion: 1, baseRevisionId: null, compiledAt: COMPILED_AT, content };
});

afterAll(async () => {
    await catalog.cleanup();
});

describe('diffCatalog() categories', () => {
    const cases: { name: string; edit: (w: World) => void; expected: (w: World) => [string, string, string, ChangeCategory][] }[] = [
        {
            name: 'a series title is authored',
            edit: (w) => {
                series(w, 0).title = 'Fixture series retitled';
                authoredSeries(w, series(w, 0).id).title = 'Fixture series retitled';
            },
            expected: (w) => [['series', series(w, 0).id, 'title', 'authored']],
        },
        {
            name: 'a statement, short statement, cover, chapters, and accent are authored, one row each',
            edit: (w) => {
                const s = series(w, 0);
                const next = { statement: 'Fixture statement, edited.', shortStatement: 'Fixture short, edited.', cover: { photoId: s.photoIds[1] }, chapters: [{ id: 'ch-1', title: 'Fixture chapter', startPhotoId: s.photoIds[0] }], accent: '#e0c080' };
                Object.assign(s, next);
                Object.assign(authoredSeries(w, s.id), next);
            },
            expected: (w) => ['accent', 'chapters', 'cover', 'shortStatement', 'statement'].map((field) => ['series', series(w, 0).id, field, 'authored']),
        },
        {
            name: 'a caption and a description are authored, and a switch to decorative says so',
            edit: (w) => {
                const id = series(w, 0).photoIds[0];
                photo(w, id).caption = 'Fixture caption, new.';
                photo(w, id).alt = { kind: 'decorative' };
                Object.assign(authoredPhoto(w, id), { caption: 'Fixture caption, new.', alt: { kind: 'decorative' } });
            },
            expected: (w) => [['photo', series(w, 0).photoIds[0], 'alt', 'authored'], ['photo', series(w, 0).photoIds[0], 'caption', 'authored']],
        },
        {
            name: 'a slug and an alias are routes',
            edit: (w) => {
                const s = series(w, 1);
                s.slugAliases = [s.slug];
                s.slug = `${s.slug}-renamed`;
                Object.assign(authoredSeries(w, s.id), { slug: s.slug, slugAliases: s.slugAliases });
            },
            expected: (w) => [['series', series(w, 1).id, 'slug', 'route'], ['series', series(w, 1).id, 'slugAliases', 'route']],
        },
        {
            name: 'a hidden series is visibility, and its photographs leave the site',
            edit: (w) => {
                const s = series(w, 1);
                w.candidate.series = w.candidate.series.filter((entry) => entry.id !== s.id);
                w.candidate.photos = w.candidate.photos.filter((entry) => !s.photoIds.includes(entry.id));
                authoredSeries(w, s.id).visibility = 'hidden';
            },
            expected: () => [
                ['series', catalog.content.series[1].id, 'visibility', 'visibility'],
                ...[...catalog.content.series[1].photoIds].sort().map((id): [string, string, string, ChangeCategory] => ['photo', id, '', 'removed']),
            ],
        },
        {
            name: 'a series the working layer lost is removed',
            edit: (w) => {
                const s = series(w, 1);
                w.candidate.series = w.candidate.series.filter((entry) => entry.id !== s.id);
                w.candidate.photos = w.candidate.photos.filter((entry) => !s.photoIds.includes(entry.id));
                w.layer.series = w.layer.series.filter((entry) => entry.id !== s.id);
            },
            expected: () => [
                ['series', catalog.content.series[1].id, '', 'removed'],
                ...[...catalog.content.series[1].photoIds].sort().map((id): [string, string, string, ChangeCategory] => ['photo', id, '', 'removed']),
            ],
        },
        {
            name: 'a reorder moves only what left the longest kept run',
            edit: (w) => {
                const s = series(w, 0);
                s.photoIds = [s.photoIds[1], s.photoIds[2], s.photoIds[0]];
                authoredSeries(w, s.id).photoIds = [...s.photoIds];
            },
            expected: () => [['series', catalog.content.series[0].id, `photoIds[${catalog.content.series[0].photoIds[0]}]`, 'moved']],
        },
        {
            name: 'an insertion in the middle is new, with no spurious moves',
            edit: (w) => {
                const moved = series(w, 1).photoIds[0];
                // Take a photo from the other series' records into this one as if it were new: it leaves series 1 and enters series 0's middle.
                dropPhoto(w, moved);
                const record = structuredClone(catalog.content.photos.find((entry) => entry.id === moved)) as CandidateContent['photos'][number];
                const newId = 'ph_00000000-0000-4000-8000-000000000001';
                w.candidate.photos.push({ ...record, id: newId });
                w.candidate.photos.sort((a, b) => (a.id < b.id ? -1 : 1));
                const s = series(w, 0);
                s.photoIds.splice(1, 0, newId);
                s.derived.photoCount = s.photoIds.length;
                authoredSeries(w, s.id).photoIds = [...s.photoIds];
                w.layer.photos.push({ ...authoredPhoto(w, moved), id: newId });
            },
            expected: (w) => [
                ['series', series(w, 0).id, 'derived', 'derived'],
                ['series', series(w, 1).id, 'derived', 'derived'],
                ['photo', 'ph_00000000-0000-4000-8000-000000000001', '', 'new'],
                ['photo', catalog.content.series[1].photoIds[0], '', 'removed'],
            ],
        },
        {
            name: 'a photo in another series is one cross-series move, not a removal and an addition',
            edit: (w) => {
                const id = series(w, 1).photoIds[0];
                series(w, 1).photoIds = series(w, 1).photoIds.slice(1);
                series(w, 0).photoIds.push(id);
                series(w, 0).derived.photoCount += 1;
                series(w, 1).derived.photoCount -= 1;
                authoredSeries(w, series(w, 0).id).photoIds = [...series(w, 0).photoIds];
                authoredSeries(w, series(w, 1).id).photoIds = [...series(w, 1).photoIds];
            },
            expected: (w) => [
                ['series', series(w, 0).id, 'derived', 'derived'],
                ['series', series(w, 1).id, 'derived', 'derived'],
                ['photo', catalog.content.series[1].photoIds[0], 'series', 'moved'],
            ],
        },
        {
            name: 'new bytes under the same photo ID are an asset change, and their derivatives a derived row it caused',
            edit: (w) => {
                const id = series(w, 0).photoIds[0];
                Object.assign(photo(w, id), { assetRevision: A, width: 1200, height: 800, aspectRatio: 1.5 });
                authoredPhoto(w, id).assetRevision = A;
            },
            expected: (w) => [['photo', series(w, 0).photoIds[0], 'assetRevision', 'asset'], ['photo', series(w, 0).photoIds[0], 'derived', 'derived']],
        },
        {
            name: 'a derived-only change is one derived row per record',
            edit: (w) => {
                const id = series(w, 0).photoIds[1];
                photo(w, id).technical = { ...photo(w, id).technical, ISO: '400' };
                photo(w, id).lqip = 'data:image/webp;base64,AAAA';
            },
            expected: (w) => [['photo', series(w, 0).photoIds[1], 'derived', 'derived']],
        },
        {
            name: 'a Work reorder alone is one site row',
            edit: (w) => {
                w.candidate.series.reverse();
                w.layer.site = { ...(w.layer.site as NonNullable<WorkingLayer['site']>), seriesOrder: w.candidate.series.map((entry) => entry.id) };
            },
            expected: () => [['site', 'site', 'seriesOrder', 'moved']],
        },
        {
            name: 'Home\'s featured series are authored',
            edit: (w) => {
                w.candidate.site.featuredSeriesIds = [series(w, 1).id];
                (w.layer.site as NonNullable<WorkingLayer['site']>).featuredSeriesIds = [series(w, 1).id];
            },
            expected: () => [['site', 'site', 'featuredSeriesIds', 'authored']],
        },
        {
            name: 'a photograph taken out of its series leaves the site',
            edit: (w) => dropPhoto(w, series(w, 0).photoIds[2]),
            expected: () => [['series', catalog.content.series[0].id, 'derived', 'derived'], ['photo', catalog.content.series[0].photoIds[2], '', 'removed']],
        },
        {
            name: 'a published photo whose source is missing is source health, which visitors don\'t see',
            edit: (w) => {
                w.registry.photos[series(w, 0).photoIds[0]].sourceHealth = 'missing';
            },
            expected: (w) => [['photo', series(w, 0).photoIds[0], 'source', 'missing']],
        },
    ];

    it.each(cases)('$name', ({ edit, expected }) => {
        const w = world();
        edit(w);
        const result = diff(w);
        expect(rows(result.changes)).toEqual(expected(w));
        for (const change of result.changes) expect(change.id).toBe(changeId(change.record, change.field, change.category));
    });

    it('covers every category', () => {
        const seen = new Set<string>();
        for (const { edit } of cases) {
            const w = world();
            edit(w);
            for (const change of diff(w).changes) seen.add(change.category);
        }
        // `new` for a series is covered below, with its review fields.
        expect([...seen].sort()).toEqual(['asset', 'authored', 'derived', 'missing', 'moved', 'new', 'removed', 'route', 'visibility']);
    });

    it('lists a new series once, relying on its visibility, its place in the Work order, and every authored field it carries', () => {
        const w = world();
        const s = structuredClone(series(w, 1));
        const id = 'ser_fixture-new';
        const moved = s.photoIds[0];
        dropPhoto(w, moved);
        w.candidate.series.push({ ...s, id, slug: 'fixture-new', photoIds: [moved], cover: { photoId: moved }, derived: { ...s.derived, photoCount: 1 } });
        w.candidate.photos.push(structuredClone(catalog.content.photos.find((entry) => entry.id === moved)) as CandidateContent['photos'][number]);
        w.candidate.photos.sort((a, b) => (a.id < b.id ? -1 : 1));
        w.layer.series.push({ ...authoredSeries(w, s.id), id, slug: 'fixture-new', photoIds: [moved], cover: { photoId: moved }, visibility: 'published' });
        (w.layer.site as NonNullable<WorkingLayer['site']>).seriesOrder.push(id);
        const change = diff(w).changes.find((entry) => entry.record.id === id) as CatalogChange;
        expect(change).toMatchObject({ field: '', category: 'new', before: null, visible: true, provenance: 'authored' });
        const fields = change.review.fields.map((entry) => `${entry.record.kind}:${entry.field}`);
        expect(fields).toEqual(expect.arrayContaining(['site:seriesOrder', 'series:visibility', 'series:title', 'series:statement', 'series:shortStatement', 'series:photoIds', 'series:cover', 'series:slug']));
    });

    it('reports several changes at once, sorted by record kind, record ID, field, and category', () => {
        const w = world();
        for (const { edit } of [cases[0], cases[2], cases[9], cases[12]]) edit(w);
        const result = diff(w);
        const keys = result.changes.map((change) => `${['site', 'series', 'photo'].indexOf(change.record.kind)}|${change.record.id}|${change.field}|${change.category}`);
        expect(keys).toEqual([...keys].sort());
        expect(result.changes.map((change) => change.category)).toEqual(expect.arrayContaining(['authored', 'asset', 'derived']));
        expect(result.empty).toBe(false);
    });
});

describe('diffCatalog() empty, provenance, and output', () => {
    it('gives an explicit empty diff for a candidate equal to the active revision', () => {
        expect(diff(world())).toEqual({ activeRevisionId: active.revisionId, empty: true, changes: [] });
    });

    it('counts only source health as no visitor-visible change', () => {
        const w = world();
        w.registry.photos[series(w, 0).photoIds[0]].sourceHealth = 'missing';
        const result = diff(w);
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]).toMatchObject({ visible: false, provenance: 'derived', summary: 'Source missing; last published image kept.', review: { state: 'not-required' } });
        expect(result.empty).toBe(true);
    });

    it('diffs against nothing before the first activation: every series and photograph is new', () => {
        const result = diff(world(), { active: null });
        expect(result.activeRevisionId).toBeNull();
        expect(new Set(result.changes.map((change) => change.category))).toEqual(new Set(['new', 'authored']));
        expect(result.changes.filter((change) => change.category === 'new')).toHaveLength(catalog.content.series.length + catalog.content.photos.length);
    });

    it('labels derived rows derived and never needing review, and authored copy authored', () => {
        const w = world();
        cases_derivedAndCopy(w);
        const result = diff(w);
        const derived = result.changes.filter((change) => change.category === 'derived');
        expect(derived.length).toBeGreaterThan(0);
        for (const change of derived) expect(change).toMatchObject({ provenance: 'derived', review: { state: 'not-required', fields: [] } });
        const caption = result.changes.find((change) => change.field === 'caption') as CatalogChange;
        expect(caption).toMatchObject({ category: 'authored', provenance: 'authored', review: { state: 'reviewed' } });
    });

    it('labels a suggested description nobody reviewed as generated, and unreviewed', () => {
        const w = world();
        const id = series(w, 0).photoIds[0];
        photo(w, id).alt = { kind: 'described', text: 'Fixture suggested description.' };
        authoredPhoto(w, id).alt = { kind: 'described', text: 'Fixture suggested description.', reviewed: false };
        const change = diff(w).changes.find((entry) => entry.field === 'alt') as CatalogChange;
        expect(change).toMatchObject({ provenance: 'generated', review: { state: 'unreviewed' } });
        expect(change.review.fields[0]).toMatchObject({ reason: 'generated', origin: 'generated' });
    });

    it('needs no review between stored revisions', () => {
        const w = world();
        cases_derivedAndCopy(w);
        for (const change of diff(w, { authored: null }).changes) expect(change.review).toEqual({ state: 'not-required', fields: [] });
    });

    it('is deterministic: the same input in another order gives the same output, byte for byte', () => {
        const w = world();
        cases_derivedAndCopy(w);
        const first = JSON.stringify(diff(w));
        const shuffled = structuredClone(w);
        shuffled.layer.series.reverse();
        shuffled.layer.photos.reverse();
        shuffled.candidate.photos.reverse();
        expect(JSON.stringify(diff(shuffled))).toBe(first);
        expect(JSON.stringify(diff(w))).toBe(first);
    });

    it('keeps each change\'s ID stable across runs and inputs', () => {
        const w = world();
        cases_derivedAndCopy(w);
        const ids = diff(w).changes.map((change) => change.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/);
        expect(changeId({ kind: 'photo', id: 'ph_x' }, 'caption', 'authored')).toBe(changeId({ kind: 'photo', id: 'ph_x' }, 'caption', 'authored'));
        expect(changeId({ kind: 'photo', id: 'ph_x' }, 'caption', 'authored')).not.toBe(changeId({ kind: 'photo', id: 'ph_x' }, 'caption', 'derived'));
    });

    function cases_derivedAndCopy(w: World): void {
        const id = series(w, 0).photoIds[0];
        photo(w, id).caption = 'Fixture caption, new.';
        authoredPhoto(w, id).caption = 'Fixture caption, new.';
        Object.assign(photo(w, id), { assetRevision: B, width: 1000, aspectRatio: 0.625 });
        authoredPhoto(w, id).assetRevision = B;
    }
});

describe('an authored capture date', () => {
    it('shows dropping it as an authored change that needs review, not a recalculated derived fact', () => {
        const w = world();
        const id = series(w, 0).photoIds[0];
        const read = photo(w, id).capturedAt as string;
        // The active revision published the owner's override; the draft drops it, so compile falls back to #10's date.
        const content = structuredClone(active.content);
        (content.photos.find((entry) => entry.id === id) as RevisionFile['content']['photos'][number]).capturedAt = '2020-05-05';
        const overridden: RevisionFile = { ...active, revisionId: revisionIdOf(content), content };
        authoredPhoto(w, id).baseRevisionId = overridden.revisionId;
        const result = diff(w, { active: overridden });
        expect(rows(result.changes)).toEqual([['photo', id, 'capturedAt', 'authored']]);
        expect(result.changes[0]).toMatchObject({ before: '2020-05-05', after: read, provenance: 'authored', review: { state: 'reviewed' } });
        // Dropped by hand after the backfill, with a stamp that still holds the override, it needs a review.
        authoredPhoto(w, id).review = { fields: { capturedAt: { valueHash: hashValue('2020-05-05'), origin: 'curator', baseRevisionId: overridden.revisionId, actor: 'cli', reviewedAt: '2026-03-01T00:00:00.000Z' } } };
        expect(diff(w, { active: overridden }).changes[0].review).toMatchObject({ state: 'unreviewed', fields: [{ reason: 'edited' }] });
    });
});

describe('a capture date #10 read', () => {
    it('stays derived when new bytes bring another date, though the backfill stamped the absent override, and needs no review after a rollback away and back', () => {
        const w = world();
        const id = series(w, 0).photoIds[0];
        const record = authoredPhoto(w, id);
        // As after the backfill and a tool write: the absent capturedAt stamped as a hash of null, reviewed against a revision a rollback left behind.
        const base = structuredClone(active.content);
        (base.photos.find((entry) => entry.id === id) as RevisionFile['content']['photos'][number]).capturedAt = '2019-01-01';
        const baseId = revisionIdOf(base);
        record.review = { fields: { capturedAt: { valueHash: hashValue(null), origin: 'migration', baseRevisionId: baseId, actor: 'migration', reviewedAt: '2026-03-01T00:00:00.000Z' } } };
        record.assetRevision = A;
        Object.assign(photo(w, id), { assetRevision: A, capturedAt: '2025-06-06' });
        const result = diff(w, { review: { bases: new Map([[baseId, base]]), inbox: new Map(), unreadable: new Set() } });
        expect(rows(result.changes)).toEqual([['photo', id, 'assetRevision', 'asset'], ['photo', id, 'derived', 'derived']]);
        expect(result.changes[1]).toMatchObject({ fields: ['capturedAt'], provenance: 'derived', review: { state: 'not-required' } });
    });
});

describe('movedIds()', () => {
    it.each([
        { name: 'no change', before: ['a', 'b', 'c'], after: ['a', 'b', 'c'], moved: [] },
        { name: 'one to the end', before: ['a', 'b', 'c', 'd'], after: ['b', 'c', 'd', 'a'], moved: ['a'] },
        { name: 'a swap moves one', before: ['a', 'b', 'c'], after: ['b', 'a', 'c'], moved: ['a'] },
        { name: 'a reversal keeps one', before: ['a', 'b', 'c', 'd'], after: ['d', 'c', 'b', 'a'], moved: ['a', 'b', 'c'] },
        { name: 'an insertion moves nothing', before: ['a', 'b', 'c'], after: ['a', 'x', 'b', 'c'], moved: [] },
        { name: 'a removal moves nothing', before: ['a', 'b', 'c'], after: ['a', 'c'], moved: [] },
    ])('$name', ({ before, after, moved }) => {
        expect([...movedIds(before, after)].sort()).toEqual(moved);
    });
});

describe('review state in the diff', () => {
    const stamp = (value: unknown, extra: Partial<FieldReview> = {}): FieldReview => ({
        valueHash: hashValue(value), origin: 'curator', baseRevisionId: active.revisionId, actor: 'cli', reviewedAt: '2026-03-01T00:00:00.000Z', ...extra,
    });

    function captionEdit(w: World, review?: FieldReview | null): { id: string; record: AuthoredPhoto } {
        const id = series(w, 0).photoIds[0];
        photo(w, id).caption = 'Fixture caption, reviewed.';
        const record = authoredPhoto(w, id);
        record.caption = 'Fixture caption, reviewed.';
        if (review !== undefined) record.review = { fields: review === null ? {} : { caption: review } };
        return { id, record };
    }
    const captionReview = (w: World, extra: Partial<DiffInput> = {}) => (diff(w, extra).changes.find((change) => change.field === 'caption') as CatalogChange).review;

    it('reads a record no tool has written since stamps as backfilled: reviewed by migration', () => {
        const w = world();
        captionEdit(w);
        expect(captionReview(w)).toMatchObject({ state: 'reviewed', fields: [{ state: 'reviewed', origin: 'migration', by: 'migration' }] });
    });

    it('is reviewed with a stamp for the value against the active revision', () => {
        const w = world();
        captionEdit(w, stamp('Fixture caption, reviewed.'));
        expect(captionReview(w)).toMatchObject({ state: 'reviewed', fields: [{ state: 'reviewed', origin: 'curator', by: 'cli' }] });
    });

    it('is unreviewed when the value changed by hand since its stamp, or has none', () => {
        const w = world();
        captionEdit(w, stamp('Fixture caption, before the hand edit.'));
        expect(captionReview(w)).toMatchObject({ state: 'unreviewed', fields: [{ reason: 'edited' }] });
        const v = world();
        captionEdit(v, null);
        expect(captionReview(v)).toMatchObject({ state: 'unreviewed', fields: [{ reason: 'no-stamp' }] });
    });

    it('goes stale when the active revision moved and publishes the field differently from what it was reviewed against', () => {
        const w = world();
        const id = series(w, 0).photoIds[0];
        const base = structuredClone(active.content);
        (base.photos.find((entry) => entry.id === id) as RevisionFile['content']['photos'][number]).caption = 'Fixture caption, published before.';
        const baseId = revisionIdOf(base);
        captionEdit(w, stamp('Fixture caption, reviewed.', { baseRevisionId: baseId }));
        expect(captionReview(w, { review: { bases: new Map([[baseId, base]]), inbox: new Map(), unreadable: new Set() } })).toMatchObject({ state: 'stale', fields: [{ reason: 'active-moved' }] });
    });

    it('stays reviewed when the active revision moved but publishes the field as it did', () => {
        const w = world();
        const id = series(w, 0).photoIds[1];
        const base = structuredClone(active.content);
        (base.photos.find((entry) => entry.id === id) as RevisionFile['content']['photos'][number]).title = 'Fixture title, elsewhere.';
        const baseId = revisionIdOf(base);
        captionEdit(w, stamp('Fixture caption, reviewed.', { baseRevisionId: baseId }));
        expect(captionReview(w, { review: { bases: new Map([[baseId, base]]), inbox: new Map(), unreadable: new Set() } })).toMatchObject({ state: 'reviewed' });
    });

    it('goes stale when the revision it was reviewed against can\'t be read', () => {
        const w = world();
        captionEdit(w, stamp('Fixture caption, reviewed.', { baseRevisionId: `rev_${'9'.repeat(64)}` }));
        expect(captionReview(w)).toMatchObject({ state: 'stale', fields: [{ reason: 'base-unreadable' }] });
    });

    it('goes stale for a field that describes the image once the record pins other bytes, and not for one that doesn\'t', () => {
        const w = world();
        const { id, record } = captionEdit(w);
        const pinned = record.assetRevision;
        record.credit = 'Fixture credit.';
        photo(w, id).credit = 'Fixture credit.';
        record.review = { fields: { caption: stamp('Fixture caption, reviewed.', { assetRevision: pinned }), credit: stamp('Fixture credit.', { assetRevision: pinned }), assetRevision: stamp(A) } };
        record.assetRevision = A;
        photo(w, id).assetRevision = A;
        const changes = diff(w).changes;
        expect((changes.find((change) => change.field === 'caption') as CatalogChange).review).toMatchObject({ state: 'stale', fields: [{ reason: 'asset-replaced' }] });
        expect((changes.find((change) => change.field === 'caption') as CatalogChange).stale).toBe(true);
        expect((changes.find((change) => change.field === 'credit') as CatalogChange).review.state).toBe('reviewed');
        expect((changes.find((change) => change.field === 'assetRevision') as CatalogChange).review.state).toBe('reviewed');
    });

    it('goes stale for a cover once its photo record pins other bytes', () => {
        const w = world();
        const s = series(w, 0);
        const cover = { photoId: s.photoIds[1] };
        s.cover = cover;
        const record = authoredSeries(w, s.id);
        record.cover = cover;
        record.review = { fields: { cover: stamp(cover, { assetRevision: authoredPhoto(w, cover.photoId).assetRevision }) } };
        expect((diff(w).changes.find((change) => change.field === 'cover') as CatalogChange).review.state).toBe('reviewed');
        authoredPhoto(w, cover.photoId).assetRevision = A;
        expect((diff(w).changes.find((change) => change.field === 'cover') as CatalogChange).review).toMatchObject({ state: 'stale', fields: [{ reason: 'cover-replaced' }] });
    });

    describe('the inbox item a review settled', () => {
        const EVENT = 'evt_000000000000000000000001';
        const NEWER = 'evt_000000000000000000000002';
        const item = (id: string, status: string, photoId: string, lastObservedAt: string, type = 'replacement') => [id, { id, type, photoId, status, lastObservedAt }] as const;
        function settled(w: World): { id: string } {
            const { id, record } = captionEdit(w);
            record.review = { fields: { caption: stamp('Fixture caption, reviewed.', { event: { id: EVENT, version: 1 }, assetRevision: record.assetRevision }) } };
            return { id };
        }

        it.each([
            { name: 'settled and nothing newer: reviewed', inbox: (id: string) => [item(EVENT, 'approved', id, '2026-02-01T00:00:00.000Z')], state: 'reviewed', reason: undefined },
            { name: 'reopened: stale', inbox: (id: string) => [item(EVENT, 'open', id, '2026-02-01T00:00:00.000Z')], state: 'stale', reason: 'item-reopened' },
            {
                name: 'a newer replacement waits for the curator: stale',
                inbox: (id: string) => [item(EVENT, 'approved', id, '2026-02-01T00:00:00.000Z'), item(NEWER, 'open', id, '2026-03-02T00:00:00.000Z')],
                state: 'stale',
                reason: 'newer-item',
            },
            {
                name: 'a newer replacement left in draft: reviewed',
                inbox: (id: string) => [item(EVENT, 'approved', id, '2026-02-01T00:00:00.000Z'), item(NEWER, 'deferred', id, '2026-03-02T00:00:00.000Z')],
                state: 'reviewed',
                reason: undefined,
            },
            {
                name: 'an open replacement observed before the review: reviewed',
                inbox: (id: string) => [item(EVENT, 'approved', id, '2026-02-01T00:00:00.000Z'), item(NEWER, 'open', id, '2026-02-15T00:00:00.000Z')],
                state: 'reviewed',
                reason: undefined,
            },
            {
                name: 'a newer missing item: reviewed, since source health is #8\'s',
                inbox: (id: string) => [item(EVENT, 'approved', id, '2026-02-01T00:00:00.000Z'), item(NEWER, 'open', id, '2026-03-02T00:00:00.000Z', 'missing')],
                state: 'reviewed',
                reason: undefined,
            },
            { name: 'the item is gone: stale', inbox: () => [], state: 'stale', reason: 'item-unreadable' },
        ])('$name', ({ inbox, state, reason }) => {
            const w = world();
            const { id } = settled(w);
            const review = captionReview(w, { review: { bases: new Map(), inbox: new Map(inbox(id)), unreadable: new Set() } });
            expect(review.state).toBe(state);
            expect(review.fields[0].reason).toBe(reason);
        });

        it('reads as stale when the item can\'t be read, or the inbox wasn\'t', () => {
            const w = world();
            const { id } = settled(w);
            expect(captionReview(w, { review: { bases: new Map(), inbox: new Map([item(EVENT, 'approved', id, '2026-02-01T00:00:00.000Z')]), unreadable: new Set([EVENT]) } }).fields[0].reason).toBe('item-unreadable');
            expect(captionReview(w, { review: undefined }).fields[0].reason).toBe('inbox-unread');
        });
    });
});
