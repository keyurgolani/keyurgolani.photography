import { VARIANT_FORMATS, VARIANT_WIDTHS, type VariantFormat, type VariantWidth } from '../../identity/variants';
import { mediaUrl } from '../../media/url';
import type { CatalogContent, CatalogReader, RouteBuilder } from '../reader';
import { MAX_SLUG_LENGTH, SLUG_RE } from '../schema';
import type { Crop, FocalPoint, SeriesRecord } from '../types';

/**
 * #5's series page read model: one series on `/work/<slug>`, from one
 * compiled revision or candidate. Pure: no I/O and no Next. The content
 * already holds only published series and the photos they hold, so a draft,
 * hidden, or removed series and its former slugs are absent and resolve like
 * an unknown slug: one not-found, so the route can't tell a visitor which one
 * it was. Only the fields the page shows leave here: no `accent` (Chromatic
 * Chapters stays in the Viewer), `openingPhotoId`, `slugAliases`, caption,
 * credit, capture date per photo, camera facts, profile, or source path.
 * Every prop the page hands a client component ships to visitors, so this
 * allowlist bounds those props too.
 */

type Photo = CatalogContent['photos'][number];

/** One variant file, as `/media` serves it. */
export interface SeriesVariant {
    url: string;
    width: number;
    height: number;
    bytes: number;
}

/** One photograph's #10 derivative set, as ResponsivePhoto takes it. */
export interface SeriesImage {
    /** Oriented. */
    width: number;
    height: number;
    variants: Record<VariantWidth, Record<VariantFormat, SeriesVariant>>;
    /** Only on the cover, the one image the page paints first. */
    lqip?: string;
}

/** One photograph in the authored sequence. */
export interface SeriesEntry {
    photoId: string;
    /** 1-based, in the series' published order. Numbering runs across chapters. */
    position: number;
    /** Authored, or null. */
    title: string | null;
    /** The described text, or null for a decorative photo or one whose description is pending (a draft only). */
    description: string | null;
    /** #7's canonical Viewer link, from the route builder: `/work/<slug>/photo/<photoId>`. */
    href: string;
    /**
     * Null when the set can't be shown (a hand-built revision or a partial
     * set). The entry keeps its position, text, and Viewer link, and the page
     * shows its missing-image state, never another file. An image that fails
     * to load at runtime gets the same state on the page.
     */
    image: SeriesImage | null;
}

/** The series' authored cover, the page's one decisive photograph. */
export interface SeriesCover {
    photoId: string;
    /** The cover's place in the sequence, 1-based. */
    position: number;
    /** The cover's Viewer link. */
    href: string;
    image: SeriesImage;
    /** The series cover's focal point, else the photo's, else the center. 0 to 1. */
    focalPoint: FocalPoint;
    /** The photo's authored crop, `cover` by default. */
    crop: Crop;
}

/** An authored chapter label over the one sequence. It starts at `startPosition` and runs to the next chapter or the end. */
export interface SeriesChapter {
    id: string;
    title: string;
    /** 1-based, the position of the chapter's first photograph. */
    startPosition: number;
}

/** Where a derived fact came from, so the page labels it apart from authored copy. */
export type SeriesFactSource = 'published-sequence' | 'capture-dates' | 'photograph-records';

/**
 * Facts derived from the published photographs, never authored. Each names
 * its source. A fact with nothing behind it is null, never filled in.
 */
export interface SeriesFacts {
    /** Published photographs, from compile's `derived.photoCount`, the number Work shows. */
    photoCount: { value: number; source: 'published-sequence' };
    /**
     * The capture date range, from compile's `derived` (members' `capturedAt`:
     * EXIF `DateTimeOriginal` or an authored date, never a file time), with how
     * many entries carry a date. Null when none is dated.
     */
    captured: { from: string; to: string; datedCount: number; source: 'capture-dates' } | null;
    /** Distinct authored `location` values in sequence order. Null when no member has one. Never from GPS. */
    locations: { values: string[]; source: 'photograph-records' } | null;
}

/** What `generateMetadata` needs, with paths only: the page makes them absolute on the site origin, or leaves them out. */
export interface SeriesMetadataInputs {
    /** The canonical series path, from the route builder. */
    canonicalPath: string;
    /** The series title. The shell's template adds the site name. */
    title: string;
    /** The authored short statement, or null when blank. */
    description: string | null;
    /** The cover's 1200 px WebP, or null when there's no usable cover. */
    shareImage: { path: string; width: number; height: number; alt: string } | null;
}

/** The approved data contract's published series, for one page. */
export interface PublishedSeriesPage {
    /** The revision (or candidate) every field below came from. */
    catalogRevision: string;
    /** The immutable series ID. */
    id: string;
    /** The current canonical slug. */
    slug: string;
    /** The stable series link, from the route builder. */
    href: string;
    /** The All work link at the end of the sequence. */
    workHref: string;
    /** Authored copy, plain text only. */
    authored: {
        title: string;
        /** The statement split on blank lines, each paragraph trimmed. Empty when blank. Plain text: never HTML or Markdown. */
        statement: string[];
    };
    /** Derived from the published photographs, apart from the authored copy. */
    facts: SeriesFacts;
    /** Null when the cover can't be shown, so the page opens text-led. */
    cover: SeriesCover | null;
    /** In the series' `photoIds` order, only members that resolve. Never empty. */
    entries: SeriesEntry[];
    /** Authored chapters over `entries`, in sequence order, each starting after the last. Never a second order. */
    chapters: SeriesChapter[];
    metadata: SeriesMetadataInputs;
}

export type SeriesPageResult =
    | { kind: 'ok'; page: PublishedSeriesPage }
    /** The slug is a former one. The route answers 308 to `location`, the canonical series path. */
    | { kind: 'redirect'; slug: string; location: string }
    /** Malformed, unknown, draft, hidden, removed, or empty. The route renders the one public not-found page. */
    | { kind: 'not-found' };

/** What seriesPageOf() reads. A CatalogReader has all of it. */
export interface SeriesSource {
    revisionId: string;
    seriesBySlug(slugOrAlias: string): { series: SeriesRecord; canonical: boolean } | null;
    photosOf(seriesId: string): readonly Photo[];
}

const NOT_FOUND: SeriesPageResult = Object.freeze({ kind: 'not-found' });
const CENTER: FocalPoint = Object.freeze({ x: 0.5, y: 0.5 });
/** The shape the revision schema checks. ResponsivePhoto puts it in a CSS `url()`, so nothing else passes. */
const LQIP_RE = /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/;
/** The shape the revision schema's dates take. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** The share image variant: wide enough for link previews, and a format every current one reads. */
const SHARE_WIDTH: VariantWidth = 'w1200';
const SHARE_FORMAT: VariantFormat = 'webp';

/**
 * The route's slug param when it is in #13's shape, the same check #7's
 * viewerParams() makes. Exact, so a letter-case variant fails. Nothing here
 * reads the catalog, and a param never reaches a path.
 */
export function seriesParams(slug: unknown): { slug: string } | null {
    if (typeof slug !== 'string') return null;
    if (slug.length > MAX_SLUG_LENGTH || !SLUG_RE.test(slug)) return null;
    return { slug };
}

/** Authored text only when it holds something. */
function text(value: unknown): string | null {
    return typeof value === 'string' && /\S/.test(value) ? value : null;
}

function focal(value: unknown): FocalPoint | null {
    if (typeof value !== 'object' || value === null) return null;
    const { x, y } = value as Record<string, unknown>;
    const unit = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
    return unit(x) && unit(y) ? { x, y } : null;
}

const dimension = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

/** The described text, from the alt union alone. Decorative, pending, or blank gives null. */
function descriptionOf(alt: Photo['alt'] | undefined): string | null {
    return alt?.kind === 'described' ? text(alt.text) : null;
}

/**
 * The photo's derivative set, field by field, when every file is the
 * `/media` URL #10 builds for this photo's set: #3's cover rule. Anything
 * else (a missing file, an original, a foreign URL) gives null, so the page
 * never points outside the revision's derivatives.
 */
function imageOf(photo: Photo, withLqip: boolean): SeriesImage | null {
    if (!dimension(photo.width) || !dimension(photo.height)) return null;
    const ladder = photo.variants as Partial<Record<VariantWidth, Partial<Record<VariantFormat, Partial<SeriesVariant>>>>> | undefined;
    const variants = {} as SeriesImage['variants'];
    for (const width of VARIANT_WIDTHS) {
        variants[width] = {} as Record<VariantFormat, SeriesVariant>;
        for (const format of VARIANT_FORMATS) {
            const file = ladder?.[width]?.[format];
            if (!file || !dimension(file.width) || !dimension(file.height) || !dimension(file.bytes)) return null;
            let expected: string;
            try {
                expected = mediaUrl({ photoId: photo.id, assetRevision: photo.assetRevision, profileId: photo.profileId }, width, format);
            } catch {
                return null;
            }
            if (file.url !== expected) return null;
            variants[width][format] = { url: file.url, width: file.width, height: file.height, bytes: file.bytes };
        }
    }
    const image: SeriesImage = { width: photo.width, height: photo.height, variants };
    if (withLqip && typeof photo.lqip === 'string' && LQIP_RE.test(photo.lqip)) image.lqip = photo.lqip;
    return image;
}

/** Paragraphs split on blank lines, each trimmed, blanks dropped. */
function paragraphs(value: unknown): string[] {
    if (typeof value !== 'string') return [];
    return value.split(/\r?\n[ \t]*(?:\r?\n[ \t]*)+/).map((paragraph) => paragraph.trim()).filter((paragraph) => paragraph !== '');
}

/**
 * Chapters over the resolved members. A chapter keeps its place only when
 * its start resolves, comes after the chapter above it, and its title and ID
 * hold something, with each ID once. #8's `order.chapter-anchor` and #13's
 * chapter rules block anything else at publish, so the fallback (drop the
 * chapter, its photographs stay under the one above) only meets a draft or
 * a hand-built revision. It never reorders a photograph.
 */
function chaptersOf(series: SeriesRecord, members: readonly Photo[]): SeriesChapter[] {
    const position = new Map(members.map((photo, index) => [photo.id, index + 1] as const));
    const seen = new Set<string>();
    const chapters: SeriesChapter[] = [];
    let previous = 0;
    for (const chapter of Array.isArray(series.chapters) ? series.chapters : []) {
        const id = text(chapter?.id);
        const title = text(chapter?.title);
        const at = typeof chapter?.startPhotoId === 'string' ? position.get(chapter.startPhotoId) : undefined;
        if (id === null || title === null || at === undefined || at <= previous || seen.has(id)) continue;
        seen.add(id);
        previous = at;
        chapters.push({ id, title, startPosition: at });
    }
    return chapters;
}

function factsOf(series: SeriesRecord, members: readonly Photo[], photoCount: number): SeriesFacts {
    const from = series.derived?.capturedFrom;
    const to = series.derived?.capturedTo;
    const datedCount = members.filter((photo) => typeof photo.capturedAt === 'string' && DATE_RE.test(photo.capturedAt)).length;
    const captured = typeof from === 'string' && typeof to === 'string' && DATE_RE.test(from) && DATE_RE.test(to) && from <= to && datedCount > 0
        ? { from, to, datedCount, source: 'capture-dates' as const }
        : null;
    const values: string[] = [];
    for (const photo of members) {
        const location = text(photo.location)?.trim();
        if (location && !values.includes(location)) values.push(location);
    }
    return {
        photoCount: { value: photoCount, source: 'published-sequence' },
        captured,
        locations: values.length ? { values, source: 'photograph-records' } : null,
    };
}

/**
 * Resolve `/work/<slug>` in one source, in this order: a malformed slug, an
 * unknown one, and a series with nothing to open (no positive published
 * count or no member that resolves, which Work leaves out too) are all
 * not-found; a former slug redirects; anything else is the projection.
 * Entries are the members that resolve, in `photoIds` order, the list #7's
 * Viewer counts, so positions agree. Hrefs come from `routes`: #13's
 * `publicRoutes` on the site, a preview's own builder in a preview.
 */
export function seriesPageOf(source: SeriesSource, slug: unknown, routes: Pick<RouteBuilder, 'seriesHref' | 'photoHref' | 'workHref'>): SeriesPageResult {
    const params = seriesParams(slug);
    if (params === null) return NOT_FOUND;
    const hit = source.seriesBySlug(params.slug);
    if (hit === null) return NOT_FOUND;
    const { series } = hit;
    const photoCount = series.derived?.photoCount;
    if (!dimension(photoCount)) return NOT_FOUND;
    // order.duplicate-photo blocks a repeated member at render, so no preview or revision holds one.
    const members = source.photosOf(series.id);
    if (members.length === 0) return NOT_FOUND;
    if (!hit.canonical) return { kind: 'redirect', slug: series.slug, location: routes.seriesHref(series.slug) };

    const coverId = series.cover?.photoId;
    const entries: SeriesEntry[] = members.map((photo, index) => ({
        photoId: photo.id,
        position: index + 1,
        title: text(photo.title),
        description: descriptionOf(photo.alt),
        href: routes.photoHref(series.slug, photo.id),
        image: imageOf(photo, false),
    }));
    // Members are the series' photoIds that resolve, so a cover from anywhere else finds nothing (#3's rule).
    const coverIndex = typeof coverId === 'string' ? members.findIndex((photo) => photo.id === coverId) : -1;
    const coverPhoto = coverIndex === -1 ? null : members[coverIndex];
    const coverImage = coverPhoto ? imageOf(coverPhoto, true) : null;
    const cover: SeriesCover | null = coverPhoto && coverImage
        ? {
            photoId: coverPhoto.id,
            position: coverIndex + 1,
            href: entries[coverIndex].href,
            image: coverImage,
            focalPoint: { ...(focal(series.cover.focalPoint) ?? focal(coverPhoto.focalPoint) ?? CENTER) },
            crop: coverPhoto.crop === 'contain' ? 'contain' : 'cover',
        }
        : null;
    const share = cover?.image.variants[SHARE_WIDTH][SHARE_FORMAT];
    const href = routes.seriesHref(series.slug);

    return {
        kind: 'ok',
        page: {
            catalogRevision: source.revisionId,
            id: series.id,
            slug: series.slug,
            href,
            workHref: routes.workHref(),
            authored: { title: series.title, statement: paragraphs(series.statement) },
            facts: factsOf(series, members, photoCount),
            cover,
            entries,
            chapters: chaptersOf(series, members),
            metadata: {
                canonicalPath: href,
                title: series.title,
                description: text(series.shortStatement),
                shareImage: cover && share && coverPhoto
                    ? { path: share.url, width: share.width, height: share.height, alt: descriptionOf(coverPhoto.alt) ?? `${series.title}, cover photograph` }
                    : null,
            },
        },
    };
}

/** One run of entries under one heading: the photographs before the first chapter (`chapter: null`), then each chapter's. */
export interface SeriesSection {
    chapter: SeriesChapter | null;
    entries: SeriesEntry[];
}

/**
 * The page's sections, cut from the one entry list at each chapter's start,
 * so every entry appears once, in order, and numbering runs across chapters.
 * The lead section appears only when the first chapter starts after the
 * first photograph, or there are no chapters.
 */
export function seriesSections(page: Pick<PublishedSeriesPage, 'entries' | 'chapters'>): SeriesSection[] {
    const sections: SeriesSection[] = [];
    const starts = page.chapters.map((chapter) => chapter.startPosition - 1);
    const lead = page.entries.slice(0, starts[0] ?? page.entries.length);
    if (lead.length) sections.push({ chapter: null, entries: lead });
    page.chapters.forEach((chapter, index) => {
        sections.push({ chapter, entries: page.entries.slice(starts[index], starts[index + 1] ?? page.entries.length) });
    });
    return sections;
}

/**
 * The parts of #13's ActiveCatalog that seriesPageFrom() reads, so this
 * module stays clear of the server-only public reader.
 */
export type SeriesActiveCatalog<Reason extends string = string> =
    | { mode: 'legacy' }
    | { mode: 'catalog'; state: 'ok' | 'degraded'; reader: Pick<CatalogReader, 'getSeriesPage'> }
    | { mode: 'catalog'; state: 'unavailable'; reason: Reason };

/**
 * The series page's answer for the site as it stands, for the route and its
 * `generateMetadata` to call with getActiveCatalog(), which reads one
 * revision per request:
 *
 * | catalog                  | `/work/<slug>`                      |
 * | ------------------------ | ----------------------------------- |
 * | malformed slug           | not-found, the catalog unread       |
 * | legacy                   | not-found: no series before cutover |
 * | catalog, ok or degraded  | the page, a 308, or not-found       |
 * | catalog, unavailable     | unavailable, for a 500, never a 404 |
 *
 * The 308 goes out only while a revision is being served, so nothing
 * permanent is sent from a catalog that can't be read. A degraded catalog
 * serves the last revision it loaded.
 */
export async function seriesPageFrom<Reason extends string>(
    load: () => Promise<SeriesActiveCatalog<Reason>>,
    slug: unknown,
    routes: Pick<RouteBuilder, 'seriesHref' | 'photoHref' | 'workHref'>,
): Promise<SeriesPageResult | { kind: 'unavailable'; reason: Reason }> {
    const params = seriesParams(slug);
    if (params === null) return NOT_FOUND;
    const catalog = await load();
    if (catalog.mode === 'legacy') return NOT_FOUND;
    if (catalog.state === 'unavailable') return { kind: 'unavailable', reason: catalog.reason };
    return catalog.reader.getSeriesPage(params.slug, routes);
}
