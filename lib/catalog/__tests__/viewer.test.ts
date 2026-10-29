// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TECHNICAL_KEYS } from '../../identity/metadata';
import { DESCRIPTION_PENDING_COPY, viewerParams, viewerPhotoFrom, viewerPhotoOf, type PublishedViewerPhoto, type ViewerCatalog, type ViewerImage, type ViewerSource } from '../projections/viewer';
import { publish } from '../publish';
import { createCatalogReader } from '../reader';
import { createTestCatalog, type TestCatalog } from '../testing';
import type { CandidateContent, RevisionContent } from '../types';
import { readWorkingLayer } from '../working-layer';
import { writeAuthoredRecord } from '../working-layer-writer';
import { shippedLadder, VARIANT_BYTES } from './catalogFixtures';

const id = (n: number) => `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = Array.from({ length: 10 }, (_, n) => id(n + 1));
/** A UUID v4 with hex letters in it, for letter-case checks. */
const HEX_ID = 'abcdef01-abcd-4abc-8abc-abcdef012345';

/**
 * Series A (fixture-a, once old-fixture-a, accented) holds P[0] to P[4]: a
 * titled, captioned, accented photo with every optional field; a photo with
 * only its description; a decorative one; one whose description is pending;
 * and one with no camera facts or date. B holds only P[5]. The draft series
 * holds P[6], the hidden one P[7], and P[8] is in no series, so none of
 * those three is in the content.
 */
let catalog: TestCatalog;

beforeAll(async () => {
    catalog = await createTestCatalog({
        seed: 7,
        photos: [
            {
                id: P[0],
                title: 'Fixture title one',
                caption: 'Fixture caption one.',
                accent: '#c08040',
                credit: 'Fixture credit',
                location: 'Fixture location',
                focalPoint: { x: 0.25, y: 0.75 },
                crop: 'cover',
                capturedAt: '2023-03-04',
                sourcePath: 'private/fixture-source-one.jpg',
                // Out of allowlist order, so the projection's order is its own.
                technical: { ISO: '200', ExposureTime: '1/250', Model: 'Fixture Model', FNumber: '2.8', Make: 'Fixture Make', FocalLength: '35', LensModel: 'Fixture Lens' },
            },
            { id: P[1] },
            { id: P[2], alt: { kind: 'decorative' } },
            { id: P[3], alt: null },
            { id: P[4], technical: {}, capturedDate: null },
            { id: P[5] },
            { id: P[6] },
            { id: P[7] },
            { id: P[8] },
        ],
        series: [
            { id: 'ser_fixture-a', slug: 'fixture-a', slugAliases: ['old-fixture-a'], accent: '#a0b0c0', photoIds: P.slice(0, 5) },
            { id: 'ser_fixture-b', slug: 'fixture-b', photoIds: [P[5]] },
            { id: 'ser_fixture-draft', slug: 'fixture-draft', photoIds: [P[6]], visibility: 'draft' },
            { id: 'ser_fixture-hidden', slug: 'fixture-hidden', photoIds: [P[7]], visibility: 'hidden' },
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

function missing(): never {
    throw new Error('Missing fixture photo');
}

function viewer(result: ReturnType<typeof viewerPhotoOf>): PublishedViewerPhoto {
    if (result.kind !== 'ok') throw new Error(`Expected a photo, got ${JSON.stringify(result)}`);
    return result.viewer;
}

function image(photo: PublishedViewerPhoto['photo']): ViewerImage {
    if (photo.image === null) throw new Error(`Expected an image for ${photo.id}`);
    return photo.image;
}

/** A reader over the fixture's candidate, as a draft preview reads it. */
function draftReader() {
    return createCatalogReader(catalog.content, { revisionId: REVISION_B, revisionNumber: null });
}

/** A source that fails the test if anything reads it. */
function trap(): ViewerSource {
    const fail = () => {
        throw new Error('The catalog was read');
    };
    return { revisionId: REVISION_A, listSeries: fail, seriesBySlug: fail, photo: fail, photosOf: fail };
}

describe('viewerParams', () => {
    it('takes a slug in #13\'s shape and a photo ID in #10\'s', () => {
        expect(viewerParams('fixture-a', P[0])).toEqual({ slug: 'fixture-a', photoId: P[0] });
        expect(viewerParams('a', P[0])).toEqual({ slug: 'a', photoId: P[0] });
        expect(viewerParams('a'.repeat(64), P[0])).not.toBeNull();
        expect(viewerParams('fixture-a', `ph_${HEX_ID}`)).not.toBeNull();
    });

    it.each([
        ['an uppercase slug', 'Fixture-A', P[0]],
        ['a slug with a trailing hyphen', 'fixture-a-', P[0]],
        ['a slug with a double hyphen', 'fixture--a', P[0]],
        ['a dot segment', '..', P[0]],
        ['a slug holding a slash', 'fixture-a/..', P[0]],
        ['an encoded dot segment', '%2e%2e', P[0]],
        ['a slug with a space', 'fixture a', P[0]],
        ['an empty slug', '', P[0]],
        ['a slug over 64 characters', 'a'.repeat(65), P[0]],
        ['an uppercase photo ID', 'fixture-a', `ph_${HEX_ID.toUpperCase()}`],
        ['a photo ID without its prefix', 'fixture-a', P[0].slice(3)],
        ['a photo ID that isn\'t a UUID v4', 'fixture-a', 'ph_00000000-0000-1000-8000-000000000001'],
        ['a photo ID with a path after it', 'fixture-a', `${P[0]}/../x`],
        ['a photo ID with a trailing newline', 'fixture-a', `${P[0]}\n`],
        ['a filename', 'fixture-a', 'fixture-0001.jpg'],
        ['a slug array', ['fixture-a'], P[0]],
        ['a missing photo ID', 'fixture-a', undefined],
    ])('refuses %s', (_name, slug, photoId) => {
        expect(viewerParams(slug, photoId)).toBeNull();
    });
});

describe('viewerPhotoOf on a revision', () => {
    let content: RevisionContent;
    let reader: ReturnType<typeof createCatalogReader<RevisionContent>>;

    beforeAll(() => {
        content = revisionContent();
        reader = createCatalogReader(content, { revisionId: REVISION_A, revisionNumber: 3 });
    });

    it('resolves the canonical URL to the photo, its series, and its place in the series', () => {
        expect(reader.getViewerPhoto('fixture-a', P[1])).toEqual({
            kind: 'ok',
            viewer: {
                catalogRevision: REVISION_A,
                series: { id: 'ser_fixture-a', slug: 'fixture-a', title: 'Fixture series 01', accent: '#a0b0c0' },
                photo: {
                    id: P[1],
                    title: null,
                    description: 'Fixture description of photograph 0002.',
                    caption: null,
                    alt: 'Fixture description of photograph 0002.',
                    descriptionPending: false,
                    namedByPlace: false,
                    image: {
                        width: 1600,
                        height: 2400,
                        assetRevision: content.photos.find((photo) => photo.id === P[1])?.assetRevision,
                        lqip: content.photos.find((photo) => photo.id === P[1])?.lqip,
                        variants: shippedLadder(content.photos.find((photo) => photo.id === P[1])?.variants ?? missing()),
                    },
                    // The share file keeps its own height, from the record.
                    shareImage: (({ url, width, height }) => ({ url, width, height }))(content.photos.find((photo) => photo.id === P[1])?.variants.w1200.webp ?? missing()),
                    accent: null,
                    technical: { Make: 'Fixture Make', Model: 'Fixture Model', FocalLength: '35', FNumber: '2.8', ExposureTime: '1/250', ISO: '200' },
                },
                position: 2,
                total: 5,
                previousPhotoId: P[0],
                nextPhotoId: P[2],
            },
        });
    });

    it('stops at the first and last photograph, and a one-photo series has no neighbors', () => {
        const first = viewer(reader.getViewerPhoto('fixture-a', P[0]));
        expect([first.position, first.total, first.previousPhotoId, first.nextPhotoId]).toEqual([1, 5, null, P[1]]);
        const last = viewer(reader.getViewerPhoto('fixture-a', P[4]));
        expect([last.position, last.total, last.previousPhotoId, last.nextPhotoId]).toEqual([5, 5, P[3], null]);
        const only = viewer(reader.getViewerPhoto('fixture-b', P[5]));
        expect([only.position, only.total, only.previousPhotoId, only.nextPhotoId]).toEqual([1, 1, null, null]);
    });

    it('follows the authored order, not ID order', () => {
        const reordered = structuredClone(content);
        reordered.series[0].photoIds = [P[3], P[0], P[4], P[2], P[1]];
        const moved = createCatalogReader(reordered, { revisionId: REVISION_B, revisionNumber: 4 });
        const result = viewer(moved.getViewerPhoto('fixture-a', P[0]));
        expect([result.position, result.previousPhotoId, result.nextPhotoId]).toEqual([2, P[3], P[4]]);
    });

    it('counts only members that resolve, as the series page lists them', () => {
        const dangling = structuredClone(content);
        dangling.series[0].photoIds = [P[0], id(99), P[1]];
        const result = viewer(createCatalogReader(dangling, { revisionId: REVISION_B, revisionNumber: 4 }).getViewerPhoto('fixture-a', P[1]));
        expect([result.position, result.total, result.previousPhotoId, result.nextPhotoId]).toEqual([2, 2, P[0], null]);
    });

    it('redirects a prior slug to the canonical one, only for a photo that series holds', () => {
        expect(reader.getViewerPhoto('old-fixture-a', P[1])).toEqual({ kind: 'redirect', slug: 'fixture-a', photoId: P[1] });
        expect(reader.getViewerPhoto('old-fixture-a', P[5])).toEqual({ kind: 'not-found' });
        expect(reader.getViewerPhoto('old-fixture-a', P[6])).toEqual({ kind: 'not-found' });
    });

    it('answers not-found for a published photo under another series', () => {
        expect(reader.getViewerPhoto('fixture-b', P[0])).toEqual({ kind: 'not-found' });
        expect(reader.getViewerPhoto('fixture-a', P[5])).toEqual({ kind: 'not-found' });
    });

    it('answers not-found for unpublished photos and series, and unknown ones', () => {
        // P[6] is in a draft series, P[7] in a hidden one, and P[8] in none.
        for (const photoId of [P[6], P[7], P[8], id(99)]) {
            expect(reader.getViewerPhoto('fixture-a', photoId)).toEqual({ kind: 'not-found' });
            expect(reader.getViewerPhoto('fixture-b', photoId)).toEqual({ kind: 'not-found' });
        }
        expect(reader.getViewerPhoto('fixture-draft', P[6])).toEqual({ kind: 'not-found' });
        expect(reader.getViewerPhoto('fixture-hidden', P[7])).toEqual({ kind: 'not-found' });
        expect(reader.getViewerPhoto('fixture-draft', P[0])).toEqual({ kind: 'not-found' });
        expect(reader.getViewerPhoto('fixture-z', P[0])).toEqual({ kind: 'not-found' });
    });

    it('answers not-found in a series whose ID appears more than once, by slug or prior slug, as the series page does', () => {
        const repeated = structuredClone(content);
        // A hand-written revision: a second record under series A's ID, with its own slug and B's photo.
        repeated.series.push({ ...structuredClone(repeated.series[1]), id: 'ser_fixture-a', slug: 'fixture-a-again', slugAliases: [] });
        const twice = createCatalogReader(repeated, { revisionId: REVISION_B, revisionNumber: 4 });
        for (const [slug, photoId] of [['fixture-a', P[0]], ['fixture-a', P[1]], ['old-fixture-a', P[1]], ['fixture-a-again', P[0]], ['fixture-a-again', P[5]]]) {
            expect(twice.getViewerPhoto(slug, photoId), `${slug} ${photoId}`).toEqual({ kind: 'not-found' });
        }
        // Series B, held once, still resolves.
        expect(viewer(twice.getViewerPhoto('fixture-b', P[5])).series.id).toBe('ser_fixture-b');
    });

    it('answers not-found in a series with no positive published count, by slug or prior slug, as the series page does', () => {
        for (const photoCount of [0, -1, 1.5, Number.NaN, undefined]) {
            const uncounted = structuredClone(content);
            (uncounted.series[0].derived as { photoCount: unknown }).photoCount = photoCount;
            const counted = createCatalogReader(uncounted, { revisionId: REVISION_B, revisionNumber: 4 });
            expect(counted.getViewerPhoto('fixture-a', P[0]), String(photoCount)).toEqual({ kind: 'not-found' });
            expect(counted.getViewerPhoto('old-fixture-a', P[1]), String(photoCount)).toEqual({ kind: 'not-found' });
            expect(viewer(counted.getViewerPhoto('fixture-b', P[5])).series.id).toBe('ser_fixture-b');
        }
        // A series with no derived block at all reads the same.
        const underived = structuredClone(content);
        delete (underived.series[0] as { derived?: unknown }).derived;
        expect(createCatalogReader(underived, { revisionId: REVISION_B, revisionNumber: 4 }).getViewerPhoto('fixture-a', P[0])).toEqual({ kind: 'not-found' });
    });

    it('answers not-found in a series none of whose members resolve, as the series page does', () => {
        const empty = structuredClone(content);
        empty.series[1].photoIds = [id(99)];
        const reader = createCatalogReader(empty, { revisionId: REVISION_B, revisionNumber: 4 });
        expect(reader.getViewerPhoto('fixture-b', P[5])).toEqual({ kind: 'not-found' });
        expect(reader.getViewerPhoto('fixture-b', id(99))).toEqual({ kind: 'not-found' });
    });

    it('does not redirect a prior slug to a canonical slug the route would refuse', () => {
        const odd = structuredClone(content);
        odd.series[0].slug = 'Fixture_A';
        const reader = createCatalogReader(odd, { revisionId: REVISION_B, revisionNumber: 4 });
        expect(reader.getViewerPhoto('old-fixture-a', P[1])).toEqual({ kind: 'not-found' });
    });

    it('answers a letter-case variant and other malformed params not-found, without reading the catalog', () => {
        expect(reader.getViewerPhoto('Fixture-A', P[0])).toEqual({ kind: 'not-found' });
        expect(reader.getViewerPhoto('OLD-FIXTURE-A', P[0])).toEqual({ kind: 'not-found' });
        expect(reader.getViewerPhoto('fixture-a', P[0].replace('ph_', 'PH_'))).toEqual({ kind: 'not-found' });
        for (const [slug, photoId] of [['Fixture-A', P[0]], ['..', P[0]], ['fixture-a', '../registry.json'], ['fixture-a', 'fixture-0001.jpg'], [['fixture-a'], P[0]]]) {
            expect(viewerPhotoOf(trap(), slug, photoId)).toEqual({ kind: 'not-found' });
        }
        // The trap does fail once the params pass, so the checks above prove the catalog went unread.
        expect(() => viewerPhotoOf(trap(), 'fixture-a', P[0])).toThrow('The catalog was read');
    });
});

describe('the Viewer projection', () => {
    let content: RevisionContent;

    beforeAll(() => {
        content = revisionContent();
    });

    it('keeps authored copy apart from derived camera facts', () => {
        const reader = createCatalogReader(content, { revisionId: REVISION_A, revisionNumber: 3 });
        const full = viewer(reader.getViewerPhoto('fixture-a', P[0])).photo;
        expect([full.title, full.caption, full.description, full.alt]).toEqual([
            'Fixture title one',
            'Fixture caption one.',
            'Fixture description of photograph 0001.',
            'Fixture description of photograph 0001.',
        ]);
        expect(full.technical).toEqual({ Make: 'Fixture Make', Model: 'Fixture Model', LensModel: 'Fixture Lens', FocalLength: '35', FNumber: '2.8', ExposureTime: '1/250', ISO: '200' });
        expect(Object.keys(full.technical)).toEqual([...TECHNICAL_KEYS]);
        expect(full.accent).toBe('#c08040');

        // Camera facts never stand in for a missing title or caption.
        const plain = viewer(reader.getViewerPhoto('fixture-a', P[1])).photo;
        expect([plain.title, plain.caption]).toEqual([null, null]);
        expect(plain.technical.Model).toBe('Fixture Model');
    });

    it('gives a decorative photo no description and an empty alt', () => {
        const reader = createCatalogReader(content, { revisionId: REVISION_A, revisionNumber: 3 });
        const decorative = viewer(reader.getViewerPhoto('fixture-a', P[2])).photo;
        expect([decorative.description, decorative.alt, decorative.descriptionPending]).toEqual([null, '', false]);
    });

    it('drops missing metadata instead of filling it', () => {
        const reader = createCatalogReader(content, { revisionId: REVISION_A, revisionNumber: 3 });
        const bare = viewer(reader.getViewerPhoto('fixture-a', P[4])).photo;
        expect(Object.keys(bare.technical)).toEqual([]);
        expect([bare.title, bare.caption, bare.accent]).toEqual([null, null, null]);
        const noAccent = viewer(reader.getViewerPhoto('fixture-b', P[5]));
        expect(noAccent.series.accent).toBeNull();
    });

    it('returns only the approved fields: no credit, location, focal point, crop, date, profile, or source', () => {
        const reader = createCatalogReader(content, { revisionId: REVISION_A, revisionNumber: 3 });
        const result = viewer(reader.getViewerPhoto('fixture-a', P[0]));
        expect(Object.keys(result).sort()).toEqual(['catalogRevision', 'nextPhotoId', 'photo', 'position', 'previousPhotoId', 'series', 'total']);
        expect(Object.keys(result.series).sort()).toEqual(['accent', 'id', 'slug', 'title']);
        expect(Object.keys(result.photo).sort()).toEqual([
            'accent', 'alt', 'caption', 'description', 'descriptionPending', 'id', 'image', 'namedByPlace', 'shareImage', 'technical', 'title',
        ]);
        expect(Object.keys(image(result.photo)).sort()).toEqual(['assetRevision', 'height', 'lqip', 'variants', 'width']);
        expect(Object.keys(result.photo.shareImage ?? {}).sort()).toEqual(['height', 'url', 'width']);
        const json = JSON.stringify(result);
        for (const leak of ['Fixture credit', 'Fixture location', '2023-03-04', 'focalPoint', 'crop', 'profileId', 'fixture-source-one', 'statement', 'slugAliases', 'old-fixture-a']) {
            expect(json).not.toContain(leak);
        }
    });

    it('keeps out record fields and technical keys outside the allowlist, even when a record holds them', () => {
        const tampered = structuredClone(content) as unknown as { photos: Record<string, unknown>[]; series: Record<string, unknown>[] } & RevisionContent;
        const photo = tampered.photos.find((entry) => entry.id === P[0]) as Record<string, unknown> & { technical: Record<string, string>; variants: Record<string, Record<string, Record<string, unknown>>> };
        Object.assign(photo, { sourcePath: '/library/private/fixture-source-one.jpg', curatorOnly: { artist: 'Fixture artist' } });
        Object.assign(photo.technical, { SerialNumber: 'FIXTURE-SERIAL', GPSLatitude: '12.345', Artist: 'Fixture artist', Software: 'Fixture software', MakerNote: 'Fixture maker note' });
        photo.variants.w1200.webp.path = '/data/assets/private.webp';
        Object.assign(tampered.series[0], { visibility: 'published', internalNote: 'Fixture internal note' });
        const reader = createCatalogReader(tampered as RevisionContent, { revisionId: REVISION_A, revisionNumber: 3 });
        const result = viewer(reader.getViewerPhoto('fixture-a', P[0]));
        expect(Object.keys(result.photo.technical)).toEqual([...TECHNICAL_KEYS]);
        expect(Object.keys(image(result.photo).variants.w1200.webp).sort()).toEqual(['url', 'width']);
        const json = JSON.stringify(result);
        for (const leak of ['FIXTURE-SERIAL', '12.345', 'Fixture artist', 'Fixture software', 'Fixture maker note', '/library/', '/data/assets', 'internalNote', 'visibility']) {
            expect(json).not.toContain(leak);
        }
    });

    it('keeps a stored accent only in #rrggbb form', () => {
        // The last two pin each anchor: a valid accent with a declaration after it, and one with a prefix.
        for (const bad of ['red; background: url(https://example.test/x)', '#c0804', '#c08040; background: url(https://example.test/x)', 'x#c08040']) {
            const odd = structuredClone(content);
            odd.series[0].accent = bad;
            const photo = odd.photos.find((entry) => entry.id === P[0]);
            if (photo) photo.accent = bad;
            const result = viewer(createCatalogReader(odd, { revisionId: REVISION_A, revisionNumber: 3 }).getViewerPhoto('fixture-a', P[0]));
            expect([result.series.accent, result.photo.accent], bad).toEqual([null, null]);
        }
    });

    it('keeps the photo\'s set and drops an LQIP that isn\'t a WebP data URI', () => {
        const stored = content.photos.find((entry) => entry.id === P[0]);
        expect(stored?.lqip).toMatch(/^data:image\/webp;base64,/);
        const values: [string, string][] = [
            ['a trailing CSS injection', 'data:image/webp;base64,AAAA");background:url("/x'],
            ['a prefix before a valid data URI', '/x.png"),url("data:image/webp;base64,AAAA'],
            ['another image type', 'data:image/png;base64,AAAA'],
            ['a parenthesis in the base64', 'data:image/webp;base64,AA)AA'],
            ['a quote in the base64', "data:image/webp;base64,AA'AA"],
        ];
        for (const [name, bad] of values) {
            const odd = structuredClone(content);
            const photo = odd.photos.find((entry) => entry.id === P[0]);
            if (!photo) throw new Error('Missing fixture photo');
            photo.lqip = bad;
            const result = image(viewer(createCatalogReader(odd, { revisionId: REVISION_A, revisionNumber: 3 }).getViewerPhoto('fixture-a', P[0])).photo);
            expect(result, name).not.toHaveProperty('lqip');
            expect(result.variants, name).toEqual(stored && shippedLadder(stored.variants));
            expect([result.width, result.height, result.assetRevision], name).toEqual([stored?.width, stored?.height, stored?.assetRevision]);
        }
    });

    it('copies the variant ladder, so a caller can\'t edit the revision through it', () => {
        const reader = createCatalogReader(content, { revisionId: REVISION_A, revisionNumber: 3 });
        const result = viewer(reader.getViewerPhoto('fixture-a', P[0]));
        image(result.photo).variants.w1200.webp.url = '/elsewhere';
        expect(content.photos.find((photo) => photo.id === P[0])?.variants.w1200.webp.url).toMatch(/^\/media\//);
        expect(image(viewer(reader.getViewerPhoto('fixture-a', P[0])).photo).variants.w1200.webp.url).toMatch(/^\/media\//);
    });

    it('renders without its image, by slug or prior slug, a photo whose set isn\'t its own /media ladder with positive sizes', () => {
        type Odd = RevisionContent['photos'][number] & Record<string, unknown>;
        const stored = content.photos.find((entry) => entry.id === P[1]);
        if (!stored) throw new Error('Missing fixture photo');
        const other = content.photos.find((entry) => entry.id === P[0]);
        const intact = viewer(createCatalogReader(content, { revisionId: REVISION_A, revisionNumber: 3 }).getViewerPhoto('fixture-a', P[1]));
        const breaks: [string, (photo: Odd) => void][] = [
            ['an original file', (photo) => { photo.variants.w800.avif.url = '/library/private/fixture-source.jpg'; }],
            ['a foreign host', (photo) => { photo.variants.w400.webp.url = `https://example.test${stored.variants.w400.webp.url}`; }],
            ['another photo\'s file', (photo) => { photo.variants.w1920.webp.url = other?.variants.w1920.webp.url ?? ''; }],
            ['another width\'s file', (photo) => { photo.variants.w1200.webp.url = stored.variants.w800.webp.url; }],
            ['another format\'s file', (photo) => { photo.variants.w1200.avif.url = stored.variants.w1200.webp.url; }],
            ['an image optimizer URL', (photo) => { photo.variants.w400.avif.url = `/_next/image?url=${encodeURIComponent(stored.variants.w400.avif.url)}&w=400&q=75`; }],
            ['a missing file', (photo) => { delete (photo.variants.w1920 as Partial<typeof photo.variants.w1920>).avif; }],
            ['a missing width', (photo) => { delete (photo.variants as Partial<typeof photo.variants>).w400; }],
            ['no ladder', (photo) => { delete (photo as Partial<Odd>).variants; }],
            ['a zero file width', (photo) => { photo.variants.w400.webp.width = 0; }],
            ['a fractional file height', (photo) => { photo.variants.w800.webp.height = 533.5; }],
            ['a negative byte count', (photo) => { photo.variants.w1200.avif.bytes = -1; }],
            ['a byte count that isn\'t a number', (photo) => { (photo.variants.w1200.webp as Record<string, unknown>).bytes = '1000'; }],
            ['a bad asset revision', (photo) => { photo.assetRevision = '../private'; }],
            ['a bad profile', (photo) => { photo.profileId = 'p_../x'; }],
            ['a zero photo width', (photo) => { photo.width = 0; }],
            ['a photo height that isn\'t finite', (photo) => { photo.height = Number.POSITIVE_INFINITY; }],
        ];
        for (const [name, breakIt] of breaks) {
            const odd = structuredClone(content);
            const photo = odd.photos.find((entry) => entry.id === P[1]) as Odd | undefined;
            if (!photo) throw new Error('Missing fixture photo');
            breakIt(photo);
            const reader = createCatalogReader(odd, { revisionId: REVISION_A, revisionNumber: 3 });
            const result = reader.getViewerPhoto('fixture-a', P[1]);
            const broken = viewer(result);
            // The photo renders without its image: the same text, place, and neighbors as an intact one.
            expect(broken.photo.image, name).toBeNull();
            expect(broken.photo.shareImage, name).toBeNull();
            expect({ ...broken, photo: { ...broken.photo, image: intact.photo.image, shareImage: intact.photo.shareImage } }, name).toEqual(intact);
            // Nothing from the broken set ships.
            const json = JSON.stringify(result);
            for (const leak of ['/library/private', 'example.test', '_next/image', '../private', 'p_../x', '/media/', 'data:image']) expect(json, name).not.toContain(leak);
            // A prior slug still 308s, to a page that renders.
            expect(reader.getViewerPhoto('old-fixture-a', P[1]), name).toEqual({ kind: 'redirect', slug: 'fixture-a', photoId: P[1] });
            // Only that photo: its neighbors keep their sets and still count it, as the series page lists it.
            const before = viewer(reader.getViewerPhoto('fixture-a', P[0]));
            expect([before.nextPhotoId, before.photo.image?.variants], name).toEqual([P[1], other && shippedLadder(other.variants)]);
            expect(viewer(reader.getViewerPhoto('fixture-a', P[2])).previousPhotoId, name).toBe(P[1]);
        }
        expect(image(intact.photo).variants).toEqual(shippedLadder(stored.variants));
    });
});

describe('the pending fallback in a draft preview', () => {
    it('marks a candidate photo whose description is pending, with an empty alt and no description', () => {
        const draft = draftReader();
        const pending = viewer(draft.getViewerPhoto('fixture-a', P[3])).photo;
        expect([pending.description, pending.alt, pending.descriptionPending]).toEqual([null, '', true]);
        expect(DESCRIPTION_PENDING_COPY).toBe('Description pending editorial review');
        expect(JSON.stringify(pending)).not.toContain(DESCRIPTION_PENDING_COPY);
    });

    it('treats a candidate\'s blank described text as pending, never as a description', () => {
        const blank = structuredClone(catalog.content) as CandidateContent;
        const photo = blank.photos.find((entry) => entry.id === P[1]);
        if (photo) photo.alt = { kind: 'described', text: '   ' };
        const result = viewer(createCatalogReader(blank, { revisionId: REVISION_B, revisionNumber: null }).getViewerPhoto('fixture-a', P[1])).photo;
        expect([result.description, result.alt, result.descriptionPending]).toEqual([null, '', true]);
    });

    it('never marks a reviewed or decorative photo pending', () => {
        const draft = draftReader();
        for (const photoId of [P[0], P[1], P[2], P[4]]) expect(viewer(draft.getViewerPhoto('fixture-a', photoId)).photo.descriptionPending).toBe(false);
    });
});

describe('catalog revision consistency', () => {
    it('answers from the reader\'s own content, so two revisions never mix', () => {
        const a = revisionContent();
        const b = structuredClone(a);
        // Revision B moves P[1] to series B, captions P[0] anew, and renames series A.
        b.series[0].photoIds = [P[0], P[2], P[3], P[4]];
        b.series[0].title = 'Fixture series 01, renamed';
        b.series[1].photoIds = [P[5], P[1]];
        const captioned = b.photos.find((photo) => photo.id === P[0]);
        if (captioned) captioned.caption = 'Fixture caption one, revised.';
        const readerA = createCatalogReader(a, { revisionId: REVISION_A, revisionNumber: 3 });
        const readerB = createCatalogReader(b, { revisionId: REVISION_B, revisionNumber: 4 });

        const fromA = viewer(readerA.getViewerPhoto('fixture-a', P[0]));
        const fromB = viewer(readerB.getViewerPhoto('fixture-a', P[0]));
        expect([fromA.catalogRevision, fromA.series.title, fromA.photo.caption, fromA.total, fromA.nextPhotoId]).toEqual([REVISION_A, 'Fixture series 01', 'Fixture caption one.', 5, P[1]]);
        expect([fromB.catalogRevision, fromB.series.title, fromB.photo.caption, fromB.total, fromB.nextPhotoId]).toEqual([REVISION_B, 'Fixture series 01, renamed', 'Fixture caption one, revised.', 4, P[2]]);

        expect(readerA.getViewerPhoto('fixture-a', P[1]).kind).toBe('ok');
        expect(readerB.getViewerPhoto('fixture-a', P[1])).toEqual({ kind: 'not-found' });
        const moved = viewer(readerB.getViewerPhoto('fixture-b', P[1]));
        expect([moved.position, moved.total, moved.previousPhotoId]).toEqual([2, 2, P[5]]);
    });
});

describe('viewerPhotoFrom', () => {
    const okCatalog = (state: 'ok' | 'degraded' = 'ok'): ViewerCatalog => ({
        mode: 'catalog',
        state,
        reader: createCatalogReader(revisionContent(), { revisionId: REVISION_A, revisionNumber: 3 }),
    });

    it('answers malformed params not-found without loading the catalog', async () => {
        const load = vi.fn(async () => okCatalog());
        for (const [slug, photoId] of [['Fixture-A', P[0]], ['fixture-a', 'nope'], [undefined, P[0]], ['fixture-a', `${P[0]}.jpg`]]) {
            expect(await viewerPhotoFrom(load, slug, photoId)).toEqual({ kind: 'not-found' });
        }
        expect(load).not.toHaveBeenCalled();
        expect((await viewerPhotoFrom(load, 'fixture-a', P[0])).kind).toBe('ok');
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('answers a site with no active revision not-found, like an unknown photo', async () => {
        expect(await viewerPhotoFrom(async () => ({ mode: 'legacy' }), 'fixture-a', P[0])).toEqual({ kind: 'not-found' });
    });

    it('reports an unavailable catalog for the route to throw', async () => {
        const unavailable: ViewerCatalog<'active-unreadable'> = { mode: 'catalog', state: 'unavailable', reason: 'active-unreadable' };
        expect(await viewerPhotoFrom(async () => unavailable, 'fixture-a', P[0])).toEqual({ kind: 'unavailable', reason: 'active-unreadable' });
    });

    it('serves a degraded catalog\'s revision', async () => {
        const result = await viewerPhotoFrom(async () => okCatalog('degraded'), 'fixture-a', P[0]);
        expect(result.kind === 'ok' && result.viewer.catalogRevision).toBe(REVISION_A);
    });
});

describe('the Viewer on published revisions', { timeout: 60_000 }, () => {
    it('resolves within the active revision, which a publish replaces', async () => {
        const published = await createTestCatalog({ variantBytes: VARIANT_BYTES, seed: 17, photos: 4, series: [{ slug: 'fixture-a', slugAliases: ['old-fixture-a'] }, { slug: 'fixture-b' }] });
        cleanups.push(() => published.cleanup());
        const root = published.root;
        const logger = { log: () => undefined };
        vi.resetModules();
        const { loadActiveCatalog } = await import('../public-reader');
        const [first, second] = published.series[0].photoIds;

        expect(await viewerPhotoFrom(() => loadActiveCatalog(root), 'fixture-a', first)).toEqual({ kind: 'not-found' });

        const one = await publish({ dataRoot: root, actor: 'test', confirmLaunch: true, logger });
        expect(one.outcome).toBe('PUBLISHED');
        const atOne = await viewerPhotoFrom(() => loadActiveCatalog(root), 'fixture-a', first);
        if (atOne.kind !== 'ok') throw new Error(`Expected a photo, got ${JSON.stringify(atOne)}`);
        expect([atOne.viewer.catalogRevision, atOne.viewer.photo.caption, atOne.viewer.nextPhotoId]).toEqual([one.revisionId, null, second]);
        expect(await viewerPhotoFrom(() => loadActiveCatalog(root), 'old-fixture-a', first)).toEqual({ kind: 'redirect', slug: 'fixture-a', photoId: first });
        expect(await viewerPhotoFrom(() => loadActiveCatalog(root), 'fixture-b', first)).toEqual({ kind: 'not-found' });

        const record = (await readWorkingLayer(root)).photos.find((photo) => photo.id === first);
        if (!record) throw new Error('The first photo has no record');
        await writeAuthoredRecord({ ...structuredClone(record), caption: 'A fixture caption for revision two.' }, { expectedVersion: record.version, root });
        const two = await publish({ dataRoot: root, actor: 'test', confirmLaunch: true, logger });
        expect(two.outcome).toBe('PUBLISHED');
        expect(two.revisionId).not.toBe(one.revisionId);
        const atTwo = await viewerPhotoFrom(() => loadActiveCatalog(root), 'fixture-a', first);
        if (atTwo.kind !== 'ok') throw new Error(`Expected a photo, got ${JSON.stringify(atTwo)}`);
        expect([atTwo.viewer.catalogRevision, atTwo.viewer.photo.caption]).toEqual([two.revisionId, 'A fixture caption for revision two.']);
    });
});
