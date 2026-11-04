// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffCatalog, type CatalogChange } from '../diff';
import { AUTHORED_PHOTO_FIELDS, fieldClass, PHOTO_FIELDS, SERIES_FIELDS, SITE_FIELDS, type FieldRegistry } from '../fields';
import { candidatePhotoRecordSchema, publicPhotoRecordSchema, revisionIdOf, seriesRecordSchema, siteRecordSchema } from '../schema';
import { createTestCatalog, type TestCatalog } from '../testing';
import type { CandidateContent, RevisionFile, SeriesRecord, WorkingLayer } from '../types';

/**
 * #16's field registry (lib/catalog/fields.ts): every field of a published
 * record has a class, an unclassified one fails tsc, and every change to a
 * leaf below a field gives the ledger a row, so nothing a visitor sees
 * reaches a publish without a row that says so. A field the registry doesn't
 * know at run time needs a review, never passing as derived.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

let catalog: TestCatalog;
let active: RevisionFile;
let layer: WorkingLayer;

const COMPILED_AT = '2026-02-01T00:00:00.000Z';
const EMPTY_REVIEW = { bases: new Map(), inbox: new Map(), unreadable: new Set<string>() };

/** The fixture with every optional field filled in, so every leaf the schema allows is there to change. */
function filled(content: CandidateContent): CandidateContent {
    const out = structuredClone(content);
    const [first] = out.series;
    Object.assign(first, {
        slugAliases: ['fixture-old-slug'],
        chapters: [{ id: 'ch-1', title: 'Fixture chapter', startPhotoId: first.photoIds[1] }],
        openingPhotoId: first.photoIds[1],
        cover: { photoId: first.photoIds[0], focalPoint: { x: 0.5, y: 0.4 } },
        accent: '#204060',
        carryOver: true,
        derived: { ...first.derived, capturedFrom: '2024-01-01', capturedTo: '2024-01-09' },
    } satisfies Partial<SeriesRecord>);
    const photo = out.photos.find((entry) => entry.id === first.photoIds[0]);
    if (!photo) throw new Error('The fixture has no first photo');
    Object.assign(photo, {
        title: 'Fixture title',
        caption: 'Fixture caption',
        focalPoint: { x: 0.25, y: 0.75 },
        crop: 'contain',
        accent: '#806040',
        credit: 'Fixture credit',
        location: 'Fixture location',
        capturedAt: '2024-01-01',
        technical: { ...photo.technical, ISO: '200' },
    });
    return out;
}

/** Every path to a leaf value under `value`. */
function leaves(value: Json, path: (string | number)[] = []): (string | number)[][] {
    if (value === null || typeof value !== 'object') return [path];
    const entries: [string | number, Json][] = Array.isArray(value) ? value.map((entry, index) => [index, entry]) : Object.entries(value);
    return entries.length === 0 ? [path] : entries.flatMap(([key, entry]) => leaves(entry, [...path, key]));
}

/** `record` with the leaf at `path` changed: a string gets a suffix, a number goes up, a boolean flips. */
function changed<T>(record: T, path: (string | number)[]): T {
    const out = structuredClone(record) as Record<string | number, unknown>;
    let at: Record<string | number, unknown> = out;
    for (const key of path.slice(0, -1)) at = at[key] as Record<string | number, unknown>;
    const last = path[path.length - 1];
    const value = at[last];
    at[last] = typeof value === 'string' ? `${value}-changed` : typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value : 'changed';
    return out as T;
}

const diffOf = (candidate: CandidateContent, authored: WorkingLayer | null = layer) => diffCatalog({ active, candidate, authored, registry: catalog.registry, review: EMPTY_REVIEW });
/**
 * Whether a change covers `field` of the record the way its class says: an
 * authored or route field by its own row, a derived one in the derived row's
 * list, the photo order by a move, the bytes by an asset row, and the capture
 * date either way, since it's authored only while the record overrides it.
 */
function covers(change: CatalogChange, kind: 'site' | 'series' | 'photo', id: string, field: string): boolean {
    if (change.record.kind !== kind || change.record.id !== id) return false;
    const own = change.field === field;
    switch (fieldClass(kind, field)) {
        case 'authored':
            return own && change.category === 'authored';
        case 'route':
            return own && change.category === 'route';
        case 'members':
            return change.category === 'moved' && change.field.startsWith('photoIds[');
        case 'asset':
            return own && change.category === 'asset';
        case 'derived':
            // A series' `derived` is its own row, listing the counts and dates inside it.
            return change.category === 'derived' && (own || change.fields?.includes(field) === true);
        case 'capture':
            return (own && change.category === 'authored') || (change.category === 'derived' && change.fields?.includes(field) === true);
        default:
            return false;
    }
}

beforeAll(async () => {
    catalog = await createTestCatalog({ photos: 6, series: 2 });
    const content = filled(catalog.content) as RevisionFile['content'];
    active = { revisionId: revisionIdOf(content), schemaVersion: 1, baseRevisionId: null, compiledAt: COMPILED_AT, content };
    const on = <T extends { baseRevisionId: string | null }>(record: T): T => ({ ...structuredClone(record), baseRevisionId: active.revisionId });
    layer = { site: on(catalog.site), series: catalog.series.map(on), photos: catalog.photos.map(on), problems: [] };
}, 60_000);

afterAll(async () => {
    await catalog.cleanup();
});

describe('the field registry', () => {
    it('classifies exactly the fields each published record has', () => {
        expect(Object.keys(PHOTO_FIELDS).sort()).toEqual(Object.keys(publicPhotoRecordSchema.shape).sort());
        expect(Object.keys(PHOTO_FIELDS).sort()).toEqual(Object.keys(candidatePhotoRecordSchema.shape).sort());
        expect(Object.keys(SERIES_FIELDS).sort()).toEqual(Object.keys(seriesRecordSchema.shape).sort());
        expect(Object.keys(SITE_FIELDS).sort()).toEqual(Object.keys(siteRecordSchema.shape).sort());
    });

    it('pins each class, so moving a field to another class fails here first', () => {
        expect(PHOTO_FIELDS).toEqual({
            id: 'id', assetRevision: 'asset',
            alt: 'authored', title: 'authored', caption: 'authored', focalPoint: 'authored', crop: 'authored', accent: 'authored', credit: 'authored', location: 'authored',
            capturedAt: 'capture',
            profileId: 'derived', width: 'derived', height: 'derived', aspectRatio: 'derived', variants: 'derived', lqip: 'derived', technical: 'derived',
        });
        expect(AUTHORED_PHOTO_FIELDS).toEqual(['alt', 'title', 'caption', 'focalPoint', 'crop', 'accent', 'credit', 'location']);
        expect(SERIES_FIELDS).toEqual({
            id: 'id', slug: 'route', slugAliases: 'route',
            title: 'authored', statement: 'authored', shortStatement: 'authored', chapters: 'authored', openingPhotoId: 'authored', cover: 'authored', accent: 'authored', carryOver: 'authored',
            photoIds: 'members', derived: 'derived',
        });
        expect(SITE_FIELDS).toEqual({ featuredSeriesIds: 'authored' });
    });

    it("is a mapped type, so a table that leaves a field out or adds one doesn't compile", () => {
        const { title: _title, ...withoutTitle } = SERIES_FIELDS;
        void _title;
        // @ts-expect-error: title has no class.
        const missing: FieldRegistry<SeriesRecord> = withoutTitle;
        // @ts-expect-error: the series record has no `extra` field.
        const extra: FieldRegistry<SeriesRecord> = { ...SERIES_FIELDS, extra: 'derived' };
        expect([missing, extra]).toHaveLength(2);
    });

    it('treats a field it does not list as authored, so it needs a review', () => {
        expect(fieldClass('photo', 'variants')).toBe('derived');
        expect(fieldClass('photo', 'somethingNew')).toBe('authored');
        expect(fieldClass('site', 'somethingNew')).toBe('authored');
    });
});

describe('every leaf change gives a ledger row', () => {
    it('for each leaf of a photo record but its ID', () => {
        const photoId = active.content.series[0].photoIds[0];
        const index = active.content.photos.findIndex((entry) => entry.id === photoId);
        const record = active.content.photos[index] as unknown as Json;
        const paths = leaves(record).filter((path) => path[0] !== 'id');
        expect(paths.length).toBeGreaterThan(20);
        const fields = new Set(paths.map((path) => String(path[0])));
        expect([...fields].sort()).toEqual(Object.keys(PHOTO_FIELDS).filter((field) => field !== 'id').sort());
        for (const path of paths) {
            const candidate = structuredClone(active.content) as CandidateContent;
            candidate.photos[index] = changed(candidate.photos[index], path);
            const result = diffOf(candidate);
            expect(result.changes.some((change) => covers(change, 'photo', photoId, String(path[0]))), `photo ${path.join('.')}`).toBe(true);
        }
    });

    it('for each leaf of a series record but its ID, and a reorder of its photos', () => {
        const series = active.content.series[0];
        const paths = leaves(series as unknown as Json).filter((path) => path[0] !== 'id' && path[0] !== 'photoIds');
        const fields = new Set([...paths.map((path) => String(path[0])), 'photoIds']);
        expect([...fields].sort()).toEqual(Object.keys(SERIES_FIELDS).filter((field) => field !== 'id').sort());
        for (const path of paths) {
            const candidate = structuredClone(active.content) as CandidateContent;
            candidate.series[0] = changed(candidate.series[0], path);
            expect(diffOf(candidate).changes.some((change) => covers(change, 'series', series.id, String(path[0]))), `series ${path.join('.')}`).toBe(true);
        }
        const candidate = structuredClone(active.content) as CandidateContent;
        candidate.series[0].photoIds = [...candidate.series[0].photoIds].reverse();
        expect(diffOf(candidate).changes.some((change) => covers(change, 'series', series.id, 'photoIds'))).toBe(true);
    });

    it('for each leaf of the site record', () => {
        const paths = leaves(active.content.site as unknown as Json);
        expect(new Set(paths.map((path) => String(path[0])))).toEqual(new Set(Object.keys(SITE_FIELDS)));
        for (const path of paths) {
            const candidate = structuredClone(active.content) as CandidateContent;
            candidate.site = changed(candidate.site, path);
            expect(diffOf(candidate).changes.some((change) => covers(change, 'site', 'site', String(path[0]))), `site ${path.join('.')}`).toBe(true);
        }
    });

    it('for each optional field that goes away', () => {
        const series = active.content.series[0];
        const photoId = series.photoIds[0];
        const optional = (shape: Record<string, { safeParse: (value: unknown) => { success: boolean } }>) => Object.keys(shape).filter((field) => shape[field].safeParse(undefined).success);
        for (const field of optional(candidatePhotoRecordSchema.shape)) {
            const candidate = structuredClone(active.content) as CandidateContent;
            delete (candidate.photos.find((entry) => entry.id === photoId) as Record<string, unknown>)[field];
            expect(diffOf(candidate).changes.some((change) => covers(change, 'photo', photoId, field)), `photo ${field}`).toBe(true);
        }
        for (const field of optional(seriesRecordSchema.shape)) {
            const candidate = structuredClone(active.content) as CandidateContent;
            delete (candidate.series[0] as Record<string, unknown>)[field];
            expect(diffOf(candidate).changes.some((change) => covers(change, 'series', series.id, field)), `series ${field}`).toBe(true);
        }
    });
});

describe('a field the registry does not know fails closed', () => {
    it('is an authored photo row that needs a review, not a derived one', () => {
        const photoId = active.content.series[0].photoIds[1];
        const candidate = structuredClone(active.content) as CandidateContent;
        Object.assign(candidate.photos.find((entry) => entry.id === photoId) as object, { somethingNew: 'shown to visitors' });
        const rows = diffOf(candidate).changes.filter((change) => change.record.id === photoId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ field: 'somethingNew', category: 'authored', provenance: 'authored', visible: true, review: { state: 'unreviewed' } });
    });

    it('gives a new site field its own row', () => {
        const candidate = structuredClone(active.content) as CandidateContent;
        Object.assign(candidate.site, { somethingNew: ['shown on Home'] });
        const rows = diffOf(candidate).changes.filter((change) => change.record.kind === 'site');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ field: 'somethingNew', category: 'authored', provenance: 'authored', review: { state: 'unreviewed' } });
    });

    it('stays authored for a series, as before', () => {
        const series = active.content.series[1];
        const candidate = structuredClone(active.content) as CandidateContent;
        Object.assign(candidate.series[1], { somethingNew: 'shown on Work' });
        expect(diffOf(candidate).changes.filter((change) => change.record.id === series.id)).toMatchObject([{ field: 'somethingNew', category: 'authored', review: { state: 'unreviewed' } }]);
    });
});
