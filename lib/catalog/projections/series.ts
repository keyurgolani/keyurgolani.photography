// A client bundle that reaches this fails the build. Client code takes only types from it (#3, #5).
import 'server-only';
import type { VariantFormat, VariantWidth } from '../../identity/variants';
import { decodeSeriesCursor, encodeSeriesCursor } from '../cursor';
import type { CatalogContent, CatalogReader, RouteBuilder } from '../reader';
import { MAX_SLUG_LENGTH, SLUG_RE } from '../schema';
import { sequenceSections, type SequenceSection } from '../series-sections';
import type { Crop, FocalPoint, SeriesRecord } from '../types';
import { ladderOf, type Ladder, type LadderVariant } from './ladder';

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
 *
 * The sequence comes in pages of SERIES_PAGE_SIZE (#6): the page model
 * holds the first, and seriesContinuationOf() each one after it, for
 * `/api/catalog/series/<slug>/pages/<cursor>`. Both build entries the same
 * way, so a continued entry is the entry the first page would have shown.
 */

type Photo = CatalogContent['photos'][number];

/**
 * Entries per page, the first server-rendered one and each continuation.
 * Within #6's approved bound (at most 100 photo records or 100 KiB
 * compressed); lib/perf's budget tests hold every page to both.
 */
export const SERIES_PAGE_SIZE = 100;

/** The continuation endpoint's path for one page. Server-made only: a client follows it and never builds one. */
export function seriesPagesPath(slug: string, cursor: string): string {
    return `/api/catalog/series/${encodeURIComponent(slug)}/pages/${cursor}`;
}

/** One variant file, as `/media` serves it and a `srcset` names it. */
export type SeriesVariant = LadderVariant;

/** One photograph's #10 derivative set, as ResponsivePhoto takes it. */
export interface SeriesImage {
    /** Oriented. */
    width: number;
    height: number;
    variants: Ladder;
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
    /** The cover's described text, as its entry carries it, so the alt holds when the entry isn't on the first page. */
    description: string | null;
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
     * The capture year range, from compile's `derived` (members' `capturedAt`:
     * EXIF `DateTimeOriginal` or an authored date, never a file time), with how
     * many entries carry a date. Years only: the Viewer withholds per-photo
     * dates, and a one-photo series would otherwise ship its exact day. Null
     * when none is dated.
     */
    captured: { fromYear: number; toYear: number; datedCount: number; source: 'capture-dates' } | null;
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
    /** The first page: up to SERIES_PAGE_SIZE of the members that resolve, in the series' `photoIds` order, from position 1. Never empty. */
    entries: SeriesEntry[];
    /** How many members resolve: the whole sequence, the count #7's Viewer gives as "of N". */
    total: number;
    /** The next page's continuation path, or null when `entries` is the whole sequence. */
    nextHref: string | null;
    /** Authored chapters over the whole sequence, in order, each starting after the last. Never a second order. */
    chapters: SeriesChapter[];
    metadata: SeriesMetadataInputs;
}

/** One continuation page, as the endpoint answers it. */
export interface SeriesContinuation {
    /** The revision the entries came from, the one the cursor named. */
    revisionId: string;
    /** Up to SERIES_PAGE_SIZE entries, built as the first page's are, with their absolute positions. */
    entries: SeriesEntry[];
    /** The page after this one, or null at the end of the sequence. */
    nextHref: string | null;
}

export type SeriesContinuationResult =
    | { kind: 'ok'; page: SeriesContinuation }
    /** A malformed cursor, one for another series, or an offset that isn't a page in range. */
    | { kind: 'bad-request' }
    /** The cursor names another revision than the one being served. Never served from it, never restarted. */
    | { kind: 'revision-changed' }
    /** #5's not-found set, plus a former slug, which an API doesn't redirect. */
    | { kind: 'not-found' };

export type SeriesPageResult =
    | { kind: 'ok'; page: PublishedSeriesPage }
    /** The slug is a former one. The route answers 308 to `location`, the canonical series path. */
    | { kind: 'redirect'; slug: string; location: string }
    /** Malformed, unknown, draft, hidden, removed, or empty. The route renders the one public not-found page. */
    | { kind: 'not-found' };

/** What seriesPageOf() reads. A CatalogReader has all of it. */
export interface SeriesSource {
    revisionId: string;
    listSeries(): readonly SeriesRecord[];
    seriesBySlug(slugOrAlias: string): { series: SeriesRecord; canonical: boolean } | null;
    photosOf(seriesId: string): readonly Photo[];
}

const NOT_FOUND = Object.freeze({ kind: 'not-found' as const });
const CENTER: FocalPoint = Object.freeze({ x: 0.5, y: 0.5 });
/** The shape the revision schema checks. ResponsivePhoto puts it in a CSS `url()`, so nothing else passes. */
const LQIP_RE = /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/;
/** The shape the revision schema's dates take. Checked whole, though only the year leaves here. */
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

/** The photo's derivative set when its ladder is usable (see ladderOf(), #3's cover rule), else null. */
function imageOf(photo: Photo, withLqip: boolean): SeriesImage | null {
    if (!dimension(photo.width) || !dimension(photo.height)) return null;
    const variants = ladderOf(photo);
    if (variants === null) return null;
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
        ? { fromYear: Number(from.slice(0, 4)), toYear: Number(to.slice(0, 4)), datedCount, source: 'capture-dates' as const }
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

type Routes = Pick<RouteBuilder, 'seriesHref' | 'photoHref' | 'workHref'>;

type Resolved =
    | { kind: 'ok'; series: SeriesRecord; canonical: boolean; members: readonly Photo[]; photoCount: number }
    | { kind: 'not-found' };

/**
 * The series `slug` names in one source, for the page and its continuation
 * alike, in this order: a malformed slug, an unknown one, a series ID that
 * appears more than once, and a series with nothing to open (no positive
 * published count or no member that resolves) are all not-found. Compile
 * never writes a repeated ID. Only a hand-written revision can, and the
 * reader indexes members by ID, so it would pair one record's copy with
 * another's photos. Members are the ones that resolve, in `photoIds` order,
 * the list #7's Viewer counts, so positions agree.
 */
function resolveSeries(source: SeriesSource, slug: unknown): Resolved {
    const params = seriesParams(slug);
    if (params === null) return NOT_FOUND;
    const hit = source.seriesBySlug(params.slug);
    if (hit === null) return NOT_FOUND;
    const { series } = hit;
    // Work leaves out a series ID that appears more than once, so the page does too.
    if (source.listSeries().filter((record) => record.id === series.id).length !== 1) return NOT_FOUND;
    const photoCount = series.derived?.photoCount;
    if (!dimension(photoCount)) return NOT_FOUND;
    // order.duplicate-photo blocks a repeated member at render, so no preview or revision holds one.
    const members = source.photosOf(series.id);
    if (members.length === 0) return NOT_FOUND;
    return { kind: 'ok', series, canonical: hit.canonical, members, photoCount };
}

/** The entries of one page, from member `offset` on, with their absolute positions. */
function pageOf(series: SeriesRecord, members: readonly Photo[], offset: number, routes: Routes): SeriesEntry[] {
    return members.slice(offset, offset + SERIES_PAGE_SIZE).map((photo, index) => ({
        photoId: photo.id,
        position: offset + index + 1,
        title: text(photo.title),
        description: descriptionOf(photo.alt),
        href: routes.photoHref(series.slug, photo.id),
        image: imageOf(photo, false),
    }));
}

/** The continuation path of the page starting at member `offset`, or null when nothing is left. */
function nextHrefOf(revisionId: string, series: SeriesRecord, offset: number, total: number): string | null {
    if (offset >= total) return null;
    return seriesPagesPath(series.slug, encodeSeriesCursor({ revisionId, seriesId: series.id, offset }));
}

/**
 * Resolve `/work/<slug>` in one source: resolveSeries()'s not-found cases,
 * then a former slug whose canonical slug the route would refuse, the series
 * #3's Work leaves out, so Work never links a missing page and the page never
 * serves a series Work hides; a former slug redirects; anything else is the
 * projection, with the first page of entries and the path to the next.
 * Hrefs come from `routes`: #13's `publicRoutes` on the site, a preview's own
 * builder in a preview. The continuation path always names the public
 * endpoint, which serves only the active revision.
 */
export function seriesPageOf(source: SeriesSource, slug: unknown, routes: Routes): SeriesPageResult {
    const resolved = resolveSeries(source, slug);
    if (resolved.kind === 'not-found') return NOT_FOUND;
    const { series, members, photoCount } = resolved;
    if (!resolved.canonical) {
        // Only route.slug-format, at render, checks a canonical slug's shape. If the route's own check would refuse it, the
        // 308 would be permanent and point at a page that is always not-found, so a series the route can't serve has no former slugs.
        if (seriesParams(series.slug) === null) return NOT_FOUND;
        return { kind: 'redirect', slug: series.slug, location: routes.seriesHref(series.slug) };
    }

    const coverId = series.cover?.photoId;
    const entries = pageOf(series, members, 0, routes);
    // Members are the series' photoIds that resolve, so a cover from anywhere else finds nothing (#3's rule).
    const coverIndex = typeof coverId === 'string' ? members.findIndex((photo) => photo.id === coverId) : -1;
    const coverPhoto = coverIndex === -1 ? null : members[coverIndex];
    const coverImage = coverPhoto ? imageOf(coverPhoto, true) : null;
    const cover: SeriesCover | null = coverPhoto && coverImage
        ? {
            photoId: coverPhoto.id,
            position: coverIndex + 1,
            href: routes.photoHref(series.slug, coverPhoto.id),
            image: coverImage,
            focalPoint: { ...(focal(series.cover.focalPoint) ?? focal(coverPhoto.focalPoint) ?? CENTER) },
            crop: coverPhoto.crop === 'contain' ? 'contain' : 'cover',
            description: descriptionOf(coverPhoto.alt),
        }
        : null;
    // The shipped ladder drops each file's height, so the share image's comes from the record ladderOf() checked.
    const share = cover && coverPhoto ? coverPhoto.variants[SHARE_WIDTH][SHARE_FORMAT] : undefined;
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
            total: members.length,
            nextHref: nextHrefOf(source.revisionId, series, SERIES_PAGE_SIZE, members.length),
            chapters: chaptersOf(series, members),
            metadata: {
                canonicalPath: href,
                title: series.title,
                description: text(series.shortStatement),
                shareImage: cover && share && coverPhoto
                    ? { path: share.url, width: share.width, height: share.height, alt: cover.description ?? `${series.title}, cover photograph` }
                    : null,
            },
        },
    };
}

const BAD_REQUEST: SeriesContinuationResult = Object.freeze({ kind: 'bad-request' });
const REVISION_CHANGED: SeriesContinuationResult = Object.freeze({ kind: 'revision-changed' });

/**
 * One continuation page of `/work/<slug>` in one source, checked in this
 * order: a malformed slug is not-found; a cursor that doesn't decode is a
 * bad request; a cursor from another revision is revision-changed, whatever
 * the slug, so a stale cursor says nothing about which series exist; then
 * resolveSeries()'s not-found cases and a former slug; then a cursor for
 * another series, or an offset that isn't the start of a page in range, is
 * a bad request. A cursor never pins its revision: the page always comes
 * from this source, and only when the source is the revision it named.
 */
export function seriesContinuationOf(source: SeriesSource, slug: unknown, cursor: unknown, routes: Routes): SeriesContinuationResult {
    if (seriesParams(slug) === null) return NOT_FOUND;
    const position = decodeSeriesCursor(cursor);
    if (position === null) return BAD_REQUEST;
    if (position.revisionId !== source.revisionId) return REVISION_CHANGED;
    const resolved = resolveSeries(source, slug);
    if (resolved.kind === 'not-found' || !resolved.canonical) return NOT_FOUND;
    const { series, members } = resolved;
    if (position.seriesId !== series.id) return BAD_REQUEST;
    if (position.offset % SERIES_PAGE_SIZE !== 0 || position.offset >= members.length) return BAD_REQUEST;
    return {
        kind: 'ok',
        page: {
            revisionId: source.revisionId,
            entries: pageOf(series, members, position.offset, routes),
            nextHref: nextHrefOf(source.revisionId, series, position.offset + SERIES_PAGE_SIZE, members.length),
        },
    };
}

/** One run of entries under one heading: the photographs before the first chapter (`chapter: null`), then each chapter's. */
export type SeriesSection = SequenceSection;

/**
 * The sections of the entries a page holds, cut at each chapter's start, so
 * every entry appears once, in order, and numbering runs across chapters.
 * See sequenceSections(), which the client's SeriesSequence runs as pages
 * append.
 */
export function seriesSections(page: Pick<PublishedSeriesPage, 'entries' | 'chapters'>): SeriesSection[] {
    return sequenceSections(page.entries, page.chapters);
}

/**
 * The parts of #13's ActiveCatalog that seriesPageFrom() and
 * seriesContinuationFrom() read, so this module stays clear of the
 * server-only public reader.
 */
export type SeriesActiveCatalog<Reason extends string = string> =
    | { mode: 'legacy' }
    | { mode: 'catalog'; state: 'ok' | 'degraded'; reader: Pick<CatalogReader, 'getSeriesPage' | 'getSeriesContinuation'> }
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
    routes: Routes,
): Promise<SeriesPageResult | { kind: 'unavailable'; reason: Reason }> {
    const params = seriesParams(slug);
    if (params === null) return NOT_FOUND;
    const catalog = await load();
    if (catalog.mode === 'legacy') return NOT_FOUND;
    if (catalog.state === 'unavailable') return { kind: 'unavailable', reason: catalog.reason };
    return catalog.reader.getSeriesPage(params.slug, routes);
}

/**
 * The continuation endpoint's answer for the site as it stands. A malformed
 * slug or cursor is answered before the catalog is read; legacy mode is
 * not-found, as the page is; an unavailable catalog is unavailable, for a
 * 503; anything else is seriesContinuationOf() on the served revision (a
 * degraded catalog's last loaded one).
 */
export async function seriesContinuationFrom<Reason extends string>(
    load: () => Promise<SeriesActiveCatalog<Reason>>,
    slug: unknown,
    cursor: unknown,
    routes: Routes,
): Promise<SeriesContinuationResult | { kind: 'unavailable'; reason: Reason }> {
    const params = seriesParams(slug);
    if (params === null) return NOT_FOUND;
    if (decodeSeriesCursor(cursor) === null) return BAD_REQUEST;
    const catalog = await load();
    if (catalog.mode === 'legacy') return NOT_FOUND;
    if (catalog.state === 'unavailable') return { kind: 'unavailable', reason: catalog.reason };
    return catalog.reader.getSeriesContinuation(params.slug, cursor as string, routes);
}
