import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { EXTRACTOR_VERSION, type TechnicalKey } from '../identity/metadata';
import { currentProfileId } from '../identity/profile';
import { writeRegistry } from '../identity/registry';
import { keyOf } from '../identity/scan';
import { emptyRegistry, type AssetManifest, type PhotoRecord, type Registry, type SourceHealth, type VariantFile } from '../identity/types';
import { VARIANT_FORMATS, VARIANT_PIXELS, VARIANT_WIDTHS, type VariantFormat, type VariantWidth } from '../identity/variants';
import { mediaUrl } from '../media/url';
import { DATA_ROOT_FILE, DATA_ROOT_SCHEMA_VERSION } from '../storage/config';
import { isInside, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, realpathLoose } from '../storage/fsx';
import { createCatalogReader, type CatalogReader, type ReaderMeta } from './reader';
import { parseAuthoredRecord, revisionIdOf, type AuthoredKind } from './schema';
import type {
    AuthoredAlt,
    AuthoredPhoto,
    AuthoredSeries,
    AuthoredSite,
    CandidateAlt,
    CandidateContent,
    CandidatePhotoRecord,
    Crop,
    FocalPoint,
    PublicationPolicy,
    SeriesRecord,
    Visibility,
} from './types';
import { authoredPaths, authoredRecordFile } from './working-layer';

/**
 * Test catalogs: a data root with a working layer, #10's registry, and
 * optionally derivative sets, built from a seed so the same options always
 * give the same bytes. Test-only; nothing in the app imports it. All copy
 * reads as an obvious fixture, since no real series titles, statements,
 * descriptions, or locations exist yet.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE_TIME = '2026-01-01T00:00:00.000Z';
/** A 10 px WebP, for content built without image files. */
const PLACEHOLDER_LQIP = 'data:image/webp;base64,UklGRlYAAABXRUJQVlA4IEoAAADQAQCdASoKAAoAAUAmJYgCdAEO9ACA/v9P9f96f1AAAAAAfQ==';
const DEFAULT_TECHNICAL: Partial<Record<TechnicalKey, string>> = {
    Make: 'Fixture Make',
    Model: 'Fixture Model',
    FocalLength: '35',
    FNumber: '2.8',
    ExposureTime: '1/250',
    ISO: '200',
};
/** Solid colors withAssets cycles through, so neighbors differ. */
const COLORS = [
    { r: 64, g: 92, b: 120 },
    { r: 140, g: 84, b: 60 },
    { r: 70, g: 118, b: 76 },
    { r: 120, g: 104, b: 140 },
] as const;

export type VariantByteTable = Record<VariantWidth, Record<VariantFormat, number>>;

export interface TestPhotoSpec {
    id?: string;
    /** The oriented source size. Defaults alternate 2400x1600 and 1600x2400. */
    width?: number;
    height?: number;
    /** Defaults to a reviewed fixture description. Null leaves it for the description rules. */
    alt?: AuthoredAlt;
    title?: string;
    caption?: string;
    focalPoint?: FocalPoint;
    crop?: Crop;
    accent?: string;
    credit?: string;
    location?: string;
    /** An authored capture date. */
    capturedAt?: string;
    /** #10's EXIF capture date. Defaults to 2024-01-01 plus one day per photo; null for undated. */
    capturedDate?: string | null;
    technical?: Partial<Record<TechnicalKey, string>>;
    /** The library-relative source path in the registry. Defaults to fixture-NNNN.jpg. */
    sourcePath?: string;
    sourceHealth?: SourceHealth;
    orientation?: number | null;
}

export interface TestSeriesSpec {
    id?: string;
    slug?: string;
    slugAliases?: string[];
    title?: string;
    statement?: string;
    shortStatement?: string;
    /** How many photos to take, in order, after earlier series took theirs. */
    photos?: number;
    /** Exact members, instead of `photos`. */
    photoIds?: string[];
    chapters?: { id: string; title: string; startPhotoId: string }[];
    openingPhotoId?: string;
    /** Defaults to the first member. */
    cover?: { photoId: string; focalPoint?: FocalPoint } | null;
    accent?: string;
    visibility?: Visibility;
    publicationPolicy?: PublicationPolicy;
}

export interface TestCatalogOptions {
    /** A count or one spec per photo. Defaults to 6. */
    photos?: number | TestPhotoSpec[];
    /** A count or one spec per series. Defaults to 2. Series without `photos` or `photoIds` split what's left. */
    series?: number | TestSeriesSpec[];
    /** Defaults to the first published series. */
    featuredSeriesIds?: string[];
    /** Work order. Defaults to every series in spec order. */
    seriesOrder?: string[];
    seed?: number;
    /** An empty or absent folder outside this repository. Defaults to a new temp folder. */
    root?: string;
    /** Write decodable WebP and AVIF files at each variant's size, and mark the profile ready. */
    withAssets?: boolean;
    /** Write each variant as a sparse file of this size instead, and mark the profile ready. */
    variantBytes?: VariantByteTable;
    /** Defaults to #10's current profile. */
    profileId?: string;
}

export interface TestCatalog {
    root: string;
    seed: number;
    profileId: string;
    site: AuthoredSite;
    series: AuthoredSeries[];
    photos: AuthoredPhoto[];
    registry: Registry;
    /** What compile would produce: published series in Work order with their photos, sorted by ID. */
    content: CandidateContent;
    revisionId: string;
    /** A reader over `content`, with no revision number, as for a candidate. */
    reader(meta?: Partial<ReaderMeta>): CatalogReader<CandidatePhotoRecord>;
    /** Removes the root, unless the caller named it. */
    cleanup(): Promise<void>;
}

/** mulberry32: a small seeded PRNG, so IDs repeat for a seed. */
function prng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function uuidFrom(random: () => number): string {
    const bytes = Array.from({ length: 16 }, () => Math.floor(random() * 256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex');
const pad = (index: number, width = 4) => String(index + 1).padStart(width, '0');
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function dateAfter(days: number): string {
    return new Date(Date.UTC(2024, 0, 1 + days)).toISOString().slice(0, 10);
}

const zeroDigests = new Map<number, string>();
const ZEROS = Buffer.alloc(64 * 1024);

/** The SHA-256 of `bytes` zero bytes, which is what a sparse file of that size reads as. */
function zeroDigest(bytes: number): string {
    const cached = zeroDigests.get(bytes);
    if (cached) return cached;
    const hash = createHash('sha256');
    for (let left = bytes; left > 0; left -= ZEROS.length) hash.update(left >= ZEROS.length ? ZEROS : ZEROS.subarray(0, left));
    const digest = hash.digest('hex');
    zeroDigests.set(bytes, digest);
    return digest;
}

/** A plausible size for a variant when no file backs it. */
function estimatedBytes(width: number, height: number, format: VariantFormat): number {
    return Math.max(1, Math.round(width * height * (format === 'avif' ? 0.08 : 0.11)));
}

function variantSize(variant: VariantWidth, width: number, height: number): { width: number; height: number } {
    const scaled = Math.min(VARIANT_PIXELS[variant], width);
    return { width: scaled, height: Math.max(1, Math.round((scaled * height) / width)) };
}

const encoded = new Map<string, Buffer>();

async function solidImage(width: number, height: number, color: (typeof COLORS)[number], format: VariantFormat | 'lqip'): Promise<Buffer> {
    const key = `${format}:${width}x${height}:${color.r},${color.g},${color.b}`;
    const cached = encoded.get(key);
    if (cached) return cached;
    const image = sharp({ create: { width, height, channels: 3, background: color } });
    const buffer = await (format === 'avif' ? image.avif({ quality: 50, effort: 0 }) : image.webp({ quality: format === 'lqip' ? 20 : 80 })).toBuffer();
    encoded.set(key, buffer);
    return buffer;
}

async function writeFileIn(file: string, data: string | Buffer): Promise<void> {
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
    await fs.promises.writeFile(file, data, { mode: PRIVATE_FILE_MODE });
}

/** Run `tasks` a few at a time, so thousands of small writes don't open thousands of files at once. */
async function inBatches<T>(items: readonly T[], task: (item: T) => Promise<void>, size = 64): Promise<void> {
    for (let start = 0; start < items.length; start += size) await Promise.all(items.slice(start, start + size).map(task));
}

function assertOutsideRepository(root: string): void {
    const target = realpathLoose(root);
    for (const forbidden of new Set([REPO_ROOT, process.cwd()])) {
        if (isInside(target, realpathLoose(forbidden))) throw new Error(`A test catalog must live outside ${forbidden}, not at ${root}. Use a temp folder.`);
    }
}

type AuthoredOf<K extends AuthoredKind> = K extends 'site' ? AuthoredSite : K extends 'series' ? AuthoredSeries : AuthoredPhoto;

function validated<K extends AuthoredKind>(kind: K, record: Record<string, unknown>): AuthoredOf<K> {
    const parsed = parseAuthoredRecord(kind, record);
    if (!parsed.ok) throw new Error(`The fixture ${kind} record is invalid: ${parsed.error.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`);
    return parsed.value as AuthoredOf<K>;
}

function publicAlt(alt: AuthoredAlt): CandidateAlt {
    if (alt === null) return { kind: 'pending' };
    return alt.kind === 'decorative' ? { kind: 'decorative' } : { kind: 'described', text: alt.text };
}

/** Copy an authored text field onto a public record only when it holds something, as compile does. */
function present(value: string | undefined): string | undefined {
    return value !== undefined && /\S/.test(value) ? value : undefined;
}

/**
 * Build a test catalog. Writes `data-root.json`, `authored/`, and
 * `identity/registry.json`, plus `assets/<photoId>/<assetRevision>/<profileId>/`
 * with `withAssets` or `variantBytes`. Without either, the profile is
 * `pending` and no asset files exist, but `content` still describes the
 * variants as #10 would write them.
 */
export async function createTestCatalog(options: TestCatalogOptions = {}): Promise<TestCatalog> {
    const seed = options.seed ?? 1;
    const random = prng(seed);
    const profileId = options.profileId ?? currentProfileId();
    const assets: 'files' | 'sparse' | 'none' = options.withAssets ? 'files' : options.variantBytes ? 'sparse' : 'none';

    let created: string | null = null;
    let root: string;
    if (options.root) {
        root = path.resolve(options.root);
        assertOutsideRepository(root);
        if (fs.existsSync(root) && fs.readdirSync(root).length > 0) throw new Error(`${root} is not empty.`);
    } else {
        created = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-fixture-'));
        root = path.join(created, 'data');
        assertOutsideRepository(root);
    }
    await fs.promises.mkdir(root, { recursive: true, mode: PRIVATE_DIR_MODE });
    await writeFileIn(path.join(root, DATA_ROOT_FILE), `${JSON.stringify({ schemaVersion: DATA_ROOT_SCHEMA_VERSION, initializedAt: FIXTURE_TIME }, null, 2)}\n`);

    const photoSpecs: TestPhotoSpec[] = Array.isArray(options.photos) ? options.photos : Array.from({ length: options.photos ?? 6 }, () => ({}));
    const seriesSpecs: TestSeriesSpec[] = Array.isArray(options.series) ? options.series : Array.from({ length: options.series ?? 2 }, () => ({}));

    // Photos: authored records, registry records, and the asset half of their public records.
    const registry = emptyRegistry();
    const photos: AuthoredPhoto[] = [];
    const assetHalves = new Map<string, Omit<CandidatePhotoRecord, 'alt'> & { capturedDate: string | null }>();
    const manifests: { dir: string; manifest: AssetManifest; files: { name: string; data: Buffer | null; bytes: number }[] }[] = [];
    for (const [index, spec] of photoSpecs.entries()) {
        const id = spec.id ?? `ph_${uuidFrom(random)}`;
        const assetRevision = `sha256-${sha256Hex(`fixture-asset:${seed}:${index}`)}`;
        const width = spec.width ?? (index % 2 === 0 ? 2400 : 1600);
        const height = spec.height ?? (index % 2 === 0 ? 1600 : 2400);
        const capturedDate = spec.capturedDate === undefined ? dateAfter(index) : spec.capturedDate;
        const technical = spec.technical ?? DEFAULT_TECHNICAL;
        const sourcePath = spec.sourcePath ?? `fixture-${pad(index)}.jpg`;
        const health = spec.sourceHealth ?? 'present';
        const color = COLORS[index % COLORS.length];

        const variants = {} as CandidatePhotoRecord['variants'];
        const manifestVariants = {} as AssetManifest['variants'];
        const files: { name: string; data: Buffer | null; bytes: number }[] = [];
        for (const variant of VARIANT_WIDTHS) {
            const size = variantSize(variant, width, height);
            variants[variant] = {} as CandidatePhotoRecord['variants'][VariantWidth];
            manifestVariants[variant] = {} as Record<VariantFormat, VariantFile>;
            for (const format of VARIANT_FORMATS) {
                let data: Buffer | null = null;
                let bytes: number;
                let digest: string;
                if (assets === 'files') {
                    data = await solidImage(size.width, size.height, color, format);
                    bytes = data.length;
                    digest = createHash('sha256').update(data).digest('hex');
                } else {
                    bytes = options.variantBytes?.[variant][format] ?? estimatedBytes(size.width, size.height, format);
                    digest = zeroDigest(bytes);
                }
                files.push({ name: `${variant}.${format}`, data, bytes });
                manifestVariants[variant][format] = { ...size, bytes, sha256: digest };
                variants[variant][format] = { url: mediaUrl({ photoId: id, assetRevision, profileId }, variant, format), ...size, bytes };
            }
        }
        let lqip = PLACEHOLDER_LQIP;
        if (assets === 'files') {
            const scale = 20 / Math.max(width, height);
            const small = await solidImage(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), color, 'lqip');
            lqip = `data:image/webp;base64,${small.toString('base64')}`;
        }

        assetHalves.set(id, {
            id,
            assetRevision,
            profileId,
            width,
            height,
            aspectRatio: Math.round((width / height) * 10_000) / 10_000,
            variants,
            lqip,
            technical,
            capturedDate,
        });
        if (assets !== 'none') {
            manifests.push({
                dir: path.join(root, 'assets', id, assetRevision, profileId),
                manifest: { schemaVersion: 1, photoId: id, assetRevision, profileId, variants: manifestVariants, lqip, createdAt: FIXTURE_TIME },
                files,
            });
        }

        const record: PhotoRecord = {
            photoId: id,
            createdAt: FIXTURE_TIME,
            source: { path: sourcePath, key: keyOf(sourcePath), present: health === 'present', observedRevision: assetRevision, lastSeenAt: FIXTURE_TIME },
            sourceHealth: health,
            duplicateOf: null,
            revisions: {
                [assetRevision]: {
                    assetRevision,
                    pixelDigest: `sha256-${sha256Hex(`fixture-pixels:${seed}:${index}`)}`,
                    firstSeenAt: FIXTURE_TIME,
                    firstSeenPath: sourcePath,
                    sourceBytes: 1_000_000 + index,
                    sourceFormat: 'jpeg',
                    width,
                    height,
                    orientation: spec.orientation ?? null,
                    derived: {
                        extractorVersion: EXTRACTOR_VERSION,
                        technical: Object.fromEntries(Object.entries(technical).map(([key, value]) => [key, { value, source: 'fixture' }])),
                        capturedDate: capturedDate === null ? null : { value: capturedDate, source: 'fixture' },
                    },
                    curatorOnly: { extractorVersion: EXTRACTOR_VERSION },
                    profiles: { [profileId]: assets === 'none' ? { state: 'pending', attempts: 0 } : { state: 'ready', attempts: 1, readyAt: FIXTURE_TIME } },
                },
            },
        };
        registry.photos[id] = record;

        photos.push(validated('photo', {
            schemaVersion: 1,
            version: 1,
            baseRevisionId: null,
            kind: 'photo',
            id,
            assetRevision,
            alt: spec.alt === undefined ? { kind: 'described', text: `Fixture description of photograph ${pad(index)}.`, reviewed: true } : spec.alt,
            ...Object.fromEntries(
                (['title', 'caption', 'focalPoint', 'crop', 'accent', 'credit', 'location', 'capturedAt'] as const)
                    .filter((key) => spec[key] !== undefined)
                    .map((key) => [key, spec[key]]),
            ),
        }));
    }

    // Series: members in order, then those without a count split what's left.
    const queue = photos.map((photo) => photo.id);
    const fixed = seriesSpecs.reduce((sum, spec) => sum + (spec.photoIds ? 0 : spec.photos ?? 0), 0);
    const open = seriesSpecs.filter((spec) => !spec.photoIds && spec.photos === undefined).length;
    const left = Math.max(0, photos.length - fixed);
    let openIndex = 0;
    const series: AuthoredSeries[] = seriesSpecs.map((spec, index) => {
        const id = spec.id ?? `ser_fixture-${pad(index, 2)}`;
        let members: string[];
        if (spec.photoIds) {
            members = spec.photoIds;
        } else {
            const count = spec.photos ?? Math.floor(left / open) + (openIndex++ < left % open ? 1 : 0);
            members = queue.splice(0, count);
        }
        const number = pad(index, 2);
        return validated('series', {
            schemaVersion: 1,
            version: 1,
            baseRevisionId: null,
            kind: 'series',
            id,
            slug: spec.slug ?? id.slice('ser_'.length),
            slugAliases: spec.slugAliases ?? [],
            title: spec.title ?? `Fixture series ${number}`,
            statement: spec.statement ?? `Fixture statement for series ${number}. Not real copy.`,
            shortStatement: spec.shortStatement ?? `Fixture short statement for series ${number}.`,
            photoIds: members,
            chapters: spec.chapters ?? [],
            ...(spec.openingPhotoId ? { openingPhotoId: spec.openingPhotoId } : {}),
            cover: spec.cover === undefined ? (members[0] ? { photoId: members[0] } : null) : spec.cover,
            ...(spec.accent ? { accent: spec.accent } : {}),
            visibility: spec.visibility ?? 'published',
            publicationPolicy: spec.publicationPolicy ?? 'review-required',
        });
    });
    const firstPublished = series.find((entry) => entry.visibility === 'published');
    const site = validated('site', {
        schemaVersion: 1,
        version: 1,
        baseRevisionId: null,
        kind: 'site',
        featuredSeriesIds: options.featuredSeriesIds ?? (firstPublished ? [firstPublished.id] : []),
        seriesOrder: options.seriesOrder ?? series.map((entry) => entry.id),
    });

    // Content: what compile would make of this working layer.
    const authoredById = new Map(photos.map((photo) => [photo.id, photo]));
    const seriesById = new Map(series.map((entry) => [entry.id, entry]));
    const publicPhotos = new Map<string, CandidatePhotoRecord>();
    const contentSeries: SeriesRecord[] = [];
    for (const seriesId of site.seriesOrder) {
        const authored = seriesById.get(seriesId);
        if (!authored || authored.visibility !== 'published' || !authored.cover) continue;
        const members = authored.photoIds.filter((photoId) => authoredById.has(photoId) && assetHalves.has(photoId));
        if (members.length === 0) continue;
        for (const photoId of members) {
            if (publicPhotos.has(photoId)) continue;
            const { capturedDate, ...asset } = assetHalves.get(photoId) as NonNullable<ReturnType<typeof assetHalves.get>>;
            const authoredPhoto = authoredById.get(photoId) as AuthoredPhoto;
            const record: CandidatePhotoRecord = { ...asset, alt: publicAlt(authoredPhoto.alt) };
            for (const key of ['title', 'caption', 'credit', 'location'] as const) {
                const value = present(authoredPhoto[key]);
                if (value !== undefined) record[key] = value;
            }
            if (authoredPhoto.focalPoint) record.focalPoint = authoredPhoto.focalPoint;
            if (authoredPhoto.crop) record.crop = authoredPhoto.crop;
            if (authoredPhoto.accent) record.accent = authoredPhoto.accent;
            const capturedAt = authoredPhoto.capturedAt ?? capturedDate ?? undefined;
            if (capturedAt) record.capturedAt = capturedAt;
            publicPhotos.set(photoId, record);
        }
        const dates = members.map((photoId) => publicPhotos.get(photoId)?.capturedAt).filter((value): value is string => Boolean(value)).sort(compare);
        contentSeries.push({
            id: authored.id,
            slug: authored.slug,
            slugAliases: authored.slugAliases,
            title: authored.title,
            statement: authored.statement,
            shortStatement: authored.shortStatement,
            photoIds: members,
            chapters: authored.chapters,
            ...(authored.openingPhotoId ? { openingPhotoId: authored.openingPhotoId } : {}),
            cover: authored.cover,
            ...(authored.accent ? { accent: authored.accent } : {}),
            derived: { photoCount: members.length, ...(dates.length ? { capturedFrom: dates[0], capturedTo: dates[dates.length - 1] } : {}) },
        });
    }
    const content: CandidateContent = {
        site: { featuredSeriesIds: site.featuredSeriesIds },
        series: contentSeries,
        photos: [...publicPhotos.values()].sort((a, b) => compare(a.id, b.id)),
    };
    const revisionId = revisionIdOf(content);

    // Write everything.
    const written = await writeRegistry(root, registry, 0);
    const paths = authoredPaths(root);
    await writeFileIn(paths.site, `${JSON.stringify(site, null, 2)}\n`);
    await inBatches(series, (entry) => writeFileIn(authoredRecordFile(root, 'series', entry.id), `${JSON.stringify(entry, null, 2)}\n`));
    await inBatches(photos, (photo) => writeFileIn(authoredRecordFile(root, 'photo', photo.id), `${JSON.stringify(photo, null, 2)}\n`));
    await inBatches(manifests, async ({ dir, manifest, files }) => {
        await fs.promises.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
        for (const file of files) {
            const target = path.join(dir, file.name);
            if (file.data) {
                await fs.promises.writeFile(target, file.data, { mode: PRIVATE_FILE_MODE });
            } else {
                // A sparse file: its declared size, read back as zeros, using no disk space.
                const handle = await fs.promises.open(target, 'w', PRIVATE_FILE_MODE);
                try {
                    await handle.truncate(file.bytes);
                } finally {
                    await handle.close();
                }
            }
        }
        await fs.promises.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
    });

    return {
        root,
        seed,
        profileId,
        site,
        series,
        photos,
        registry: written,
        content,
        revisionId,
        reader: (meta = {}) => createCatalogReader(content, { revisionId, revisionNumber: null, ...meta }),
        cleanup: async () => {
            if (created) await fs.promises.rm(created, { recursive: true, force: true });
        },
    };
}
