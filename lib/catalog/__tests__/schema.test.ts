// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../identity/ids';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../../identity/variants';
import {
    parseActivation,
    parseActivePointer,
    parseAuthoredRecord,
    parseCandidateFile,
    parseRevisionFile,
    revisionIdOf,
    REVISION_ID_RE,
} from '../schema';
import type { PublicPhotoRecord, RevisionContent, SeriesRecord } from '../types';

const PHOTO = 'ph_00000000-0000-4000-8000-000000000001';
const OTHER_PHOTO = 'ph_00000000-0000-4000-8000-000000000002';
const ASSET = `sha256-${'a'.repeat(64)}`;
const PROFILE = 'p_0123456789abcdef';
const REVISION = `rev_${'b'.repeat(64)}`;

function variants() {
    const ladder = {} as PublicPhotoRecord['variants'];
    for (const width of VARIANT_WIDTHS) {
        const pixels = Number(width.slice(1));
        ladder[width] = {} as PublicPhotoRecord['variants'][typeof width];
        for (const format of VARIANT_FORMATS) {
            ladder[width][format] = { url: `/media/${PHOTO}/${ASSET}/${PROFILE}/${width}.${format}`, width: pixels, height: Math.round(pixels / 1.5), bytes: 1000 };
        }
    }
    return ladder;
}

function photo(overrides: Partial<PublicPhotoRecord> = {}): PublicPhotoRecord {
    return {
        id: PHOTO,
        assetRevision: ASSET,
        profileId: PROFILE,
        width: 1920,
        height: 1280,
        aspectRatio: 1.5,
        variants: variants(),
        lqip: 'data:image/webp;base64,UklGRg==',
        alt: { kind: 'described', text: 'Fixture photograph one' },
        technical: { Make: 'Fixture Make', ISO: '100' },
        ...overrides,
    };
}

function series(overrides: Partial<SeriesRecord> = {}): SeriesRecord {
    return {
        id: 'ser_fixture-one',
        slug: 'fixture-one',
        slugAliases: [],
        title: 'Fixture series one',
        statement: 'Fixture statement for series one.',
        shortStatement: 'Fixture short statement one.',
        photoIds: [PHOTO],
        chapters: [],
        cover: { photoId: PHOTO },
        derived: { photoCount: 1 },
        ...overrides,
    };
}

function content(overrides: Partial<RevisionContent> = {}): RevisionContent {
    return { site: { featuredSeriesIds: ['ser_fixture-one'] }, series: [series()], photos: [photo()], ...overrides };
}

function revisionFile(body: RevisionContent = content()) {
    return { revisionId: revisionIdOf(body), schemaVersion: 1, baseRevisionId: null, compiledAt: '2026-01-01T00:00:00.000Z', content: body };
}

describe('revision files', () => {
    it('parse a complete revision', () => {
        const parsed = parseRevisionFile(revisionFile());
        expect(parsed).toMatchObject({ ok: true, value: { schemaVersion: 1, content: { series: [{ id: 'ser_fixture-one' }] } } });
    });

    it.each([
        ['an unknown key on a photo', (body: RevisionContent) => ({ ...body, photos: [{ ...body.photos[0], sourcePath: 'IMG_0001.jpg' }] }), 'content.photos[0]'],
        ['GPS on a photo', (body: RevisionContent) => ({ ...body, photos: [{ ...body.photos[0], gps: { latitude: 1, longitude: 2 } }] }), 'content.photos[0]'],
        ['a serial number in technical', (body: RevisionContent) => ({ ...body, photos: [{ ...body.photos[0], technical: { BodySerialNumber: '123' } }] }), 'content.photos[0].technical'],
        ['a pending alt', (body: RevisionContent) => ({ ...body, photos: [{ ...body.photos[0], alt: { kind: 'pending' } }] }), 'content.photos[0].alt.kind'],
        ['a described alt with no text', (body: RevisionContent) => ({ ...body, photos: [{ ...body.photos[0], alt: { kind: 'described', text: '' } }] }), 'content.photos[0].alt.text'],
        ['a missing variant', (body: RevisionContent) => {
            const partial: Partial<PublicPhotoRecord['variants']> = { ...body.photos[0].variants };
            delete partial.w1920;
            return { ...body, photos: [{ ...body.photos[0], variants: partial }] };
        }, 'content.photos[0].variants.w1920'],
        ['a focal point outside 0..1', (body: RevisionContent) => ({ ...body, photos: [{ ...body.photos[0], focalPoint: { x: 1.2, y: 0.5 } }] }), 'content.photos[0].focalPoint.x'],
        ['a capture date that is not YYYY-MM-DD', (body: RevisionContent) => ({ ...body, photos: [{ ...body.photos[0], capturedAt: '2024:01:01' }] }), 'content.photos[0].capturedAt'],
        ['an owner field on a series', (body: RevisionContent) => ({ ...body, series: [{ ...body.series[0], owner: 'someone' }] }), 'content.series[0]'],
        ['a null series cover', (body: RevisionContent) => ({ ...body, series: [{ ...body.series[0], cover: null }] }), 'content.series[0].cover'],
        ['a malformed photo ID in a series', (body: RevisionContent) => ({ ...body, series: [{ ...body.series[0], photoIds: ['IMG_0001'] }] }), 'content.series[0].photoIds[0]'],
    ])('reject %s, naming the field', (_label, mutate, field) => {
        const body = mutate(content()) as RevisionContent;
        const parsed = parseRevisionFile({ ...revisionFile(content()), content: body });
        expect(parsed.ok).toBe(false);
        if (parsed.ok) return;
        expect(parsed.error.reason).toBe('invalid');
        expect(parsed.error.issues.map((issue) => issue.path)).toContain(field);
    });

    it('reject a newer integer schemaVersion as unknown, and any other one, or a non-object, as invalid', () => {
        expect(parseRevisionFile({ ...revisionFile(), schemaVersion: 2 })).toMatchObject({ ok: false, error: { reason: 'unknown-schema-version', schemaVersion: 2 } });
        const unversioned: Record<string, unknown> = { ...revisionFile() };
        delete unversioned.schemaVersion;
        const others: Record<string, unknown>[] = [{ ...revisionFile(), schemaVersion: '1' }, { ...revisionFile(), schemaVersion: 0 }, { ...revisionFile(), schemaVersion: 1.5 }, unversioned];
        for (const value of others) {
            expect(parseRevisionFile(value), String(value.schemaVersion)).toMatchObject({ ok: false, error: { reason: 'invalid', issues: [{ path: 'schemaVersion' }] } });
        }
        expect(parseRevisionFile([])).toMatchObject({ ok: false, error: { reason: 'invalid' } });
    });

    it('let a candidate carry a pending alt, which a revision rejects', () => {
        const body = content({ photos: [photo({ alt: { kind: 'pending' } as unknown as PublicPhotoRecord['alt'] })] });
        expect(parseCandidateFile(revisionFile(body)).ok).toBe(true);
        expect(parseRevisionFile(revisionFile(body)).ok).toBe(false);
    });
});

describe('revision IDs', () => {
    it('are rev_ plus the sha256 of the canonical JSON of the schema version and content', () => {
        const body = content();
        const expected = createHash('sha256').update(canonicalJson({ schemaVersion: 1, ...body })).digest('hex');
        expect(revisionIdOf(body)).toBe(`rev_${expected}`);
        expect(revisionIdOf(body)).toMatch(REVISION_ID_RE);
    });

    it('ignore key order and absent optionals, and normalize strings to NFC', () => {
        const body = content();
        const reordered = { photos: body.photos.map((entry) => Object.fromEntries(Object.entries(entry).reverse())), series: body.series, site: body.site } as RevisionContent;
        expect(revisionIdOf(reordered)).toBe(revisionIdOf(body));
        expect(revisionIdOf(content({ photos: [photo({ title: undefined })] }))).toBe(revisionIdOf(body));
        const composed = content({ photos: [photo({ title: 'Caf\u00e9' })] });
        const decomposed = content({ photos: [photo({ title: 'Cafe\u0301' })] });
        expect(revisionIdOf(composed)).toBe(revisionIdOf(decomposed));
    });

    it('keep array order and every value', () => {
        const two = content({
            series: [series({ photoIds: [PHOTO, OTHER_PHOTO] })],
            photos: [photo(), photo({ id: OTHER_PHOTO })],
        });
        const swapped = content({ series: [series({ photoIds: [OTHER_PHOTO, PHOTO] })], photos: two.photos });
        expect(revisionIdOf(swapped)).not.toBe(revisionIdOf(two));
        expect(revisionIdOf(content({ photos: [photo({ width: 1921 })] }))).not.toBe(revisionIdOf(content()));
    });

    it('come from JSON with sorted keys and no whitespace', () => {
        expect(canonicalJson({ b: [2, { d: 1, c: 'x' }], a: undefined, e: 'Cafe\u0301' })).toBe('{"b":[2,{"c":"x","d":1}],"e":"Caf\u00e9"}');
    });
});

describe('activations and the active pointer', () => {
    const activation = {
        schemaVersion: 1,
        activationId: 'act_00000000-0000-4000-8000-000000000001',
        sequence: 1,
        kind: 'publish',
        status: 'pending',
        revisionId: REVISION,
        revisionNumber: 1,
        previousRevisionId: null,
        previousActivationId: null,
        actor: 'fixture-actor',
        reason: 'publish',
        startedAt: '2026-01-01T00:00:00.000Z',
        validation: { rulesetVersion: 'c'.repeat(64), errors: 0, warnings: 2, diagnosticsDigest: 'd'.repeat(64) },
        acceptedRules: [],
        lockTakeover: null,
    };

    it('parse an activation record, pending and committed', () => {
        expect(parseActivation(activation).ok).toBe(true);
        expect(parseActivation({ ...activation, status: 'committed', committedAt: '2026-01-01T00:00:01.000Z' }).ok).toBe(true);
        expect(parseActivation({ ...activation, lockTakeover: { previousOwner: 'owner', previousAcquiredAt: '2026-01-01T00:00:00.000Z' } }).ok).toBe(true);
    });

    it.each([
        ['an unknown kind', { kind: 'import' }],
        ['an unknown status', { status: 'done' }],
        ['a malformed activation ID', { activationId: 'act_1' }],
        ['a sequence of 0', { sequence: 0 }],
        ['an extra key', { host: 'example' }],
    ])('reject an activation with %s', (_label, change) => {
        expect(parseActivation({ ...activation, ...change }).ok).toBe(false);
    });

    it('parse the active pointer and reject anything else in it', () => {
        const pointer = { schemaVersion: 1, version: 3, revisionId: REVISION, activationId: activation.activationId };
        expect(parseActivePointer(pointer)).toEqual({ ok: true, value: pointer });
        expect(parseActivePointer({ ...pointer, revisionId: 'rev_1' }).ok).toBe(false);
        expect(parseActivePointer({ ...pointer, path: '/data' }).ok).toBe(false);
        // Its version is the number of the file it was read from.
        expect(parseActivePointer({ ...pointer, version: 0 }).ok).toBe(false);
        expect(parseActivePointer({ schemaVersion: 1, revisionId: REVISION, activationId: activation.activationId }).ok).toBe(false);
    });
});

describe('authored records', () => {
    const base = { schemaVersion: 1, version: 3, baseRevisionId: null };

    it('parse a site with its featured list and Work order', () => {
        const site = { ...base, kind: 'site', featuredSeriesIds: ['ser_fixture-one'], seriesOrder: ['ser_fixture-one', 'ser_fixture-two'] };
        // A site without a base Work order, as every one written before the field is, has an unknown one.
        expect(parseAuthoredRecord('site', site)).toEqual({ ok: true, value: { ...site, baseSeriesOrder: null } });
        const rebased = { ...site, baseSeriesOrder: ['ser_fixture-two', 'ser_fixture-one'] };
        expect(parseAuthoredRecord('site', rebased)).toEqual({ ok: true, value: rebased });
        expect(parseAuthoredRecord('site', { ...site, baseSeriesOrder: [''] }).ok).toBe(false);
    });

    it('default a series to review-required with empty copy, and allow a null cover', () => {
        const parsed = parseAuthoredRecord('series', { ...base, kind: 'series', id: 'ser_fixture-draft', slug: 'fixture-draft', visibility: 'draft', cover: null });
        expect(parsed).toEqual({
            ok: true,
            value: {
                ...base,
                kind: 'series',
                id: 'ser_fixture-draft',
                slug: 'fixture-draft',
                slugAliases: [],
                title: '',
                statement: '',
                shortStatement: '',
                photoIds: [],
                chapters: [],
                cover: null,
                visibility: 'draft',
                publicationPolicy: 'review-required',
            },
        });
    });

    it('parse a photo with a null, reviewed, unreviewed, or decorative alt, and conflicts', () => {
        const record = { ...base, kind: 'photo', id: PHOTO, assetRevision: ASSET };
        for (const alt of [null, { kind: 'described', text: 'Fixture description', reviewed: true }, { kind: 'described', text: 'Suggested', reviewed: false }, { kind: 'decorative' }]) {
            expect(parseAuthoredRecord('photo', { ...record, alt }).ok).toBe(true);
        }
        const conflicted = { ...record, alt: null, conflicts: [{ field: 'title', base: 'Fixture A', active: 'Fixture B' }] };
        expect(parseAuthoredRecord('photo', conflicted)).toEqual({ ok: true, value: conflicted });
    });

    it.each([
        ['a series with an unknown visibility', 'series', { kind: 'series', id: 'ser_fixture', slug: 'fixture', visibility: 'public' }],
        ['a series with an unknown policy', 'series', { kind: 'series', id: 'ser_fixture', slug: 'fixture', visibility: 'draft', publicationPolicy: 'auto-publish' }],
        ['a photo with a described alt missing reviewed', 'photo', { kind: 'photo', id: PHOTO, assetRevision: ASSET, alt: { kind: 'described', text: 'x' } }],
        ['a photo with a malformed asset revision', 'photo', { kind: 'photo', id: PHOTO, assetRevision: 'abc', alt: null }],
        ['a photo with GPS', 'photo', { kind: 'photo', id: PHOTO, assetRevision: ASSET, alt: null, gps: { latitude: 1 } }],
        ['a record of the wrong kind', 'site', { kind: 'series', featuredSeriesIds: [], seriesOrder: [] }],
        ['a version of 0', 'site', { kind: 'site', featuredSeriesIds: [], seriesOrder: [], version: 0 }],
    ] as const)('reject %s', (_label, kind, record) => {
        expect(parseAuthoredRecord(kind, { ...base, ...record }).ok).toBe(false);
    });

    it('reject an unknown schemaVersion as such', () => {
        expect(parseAuthoredRecord('site', { ...base, schemaVersion: 7, kind: 'site', featuredSeriesIds: [], seriesOrder: [] }))
            .toMatchObject({ ok: false, error: { reason: 'unknown-schema-version', schemaVersion: 7 } });
    });
});
