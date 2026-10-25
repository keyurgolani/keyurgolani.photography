import 'server-only';
import { PHOTO_ID_RE } from '../../identity/ids';
import type { CatalogContent, CatalogReader, RouteBuilder } from '../reader';
import { MAX_SLUG_LENGTH, REVISION_ID_RE, SLUG_RE } from '../schema';
import type { FocalPoint, SeriesRecord, SiteRecord } from '../types';
import { ladderOf, type Ladder, type LadderVariant } from './ladder';

/**
 * #4's Home read model: the featured series' authored sequence, from one
 * compiled revision or candidate. Pure: no I/O and no Next. The content
 * already holds only published series and the photos they hold, so nothing
 * unpublished can reach Home. Order comes only from the series'
 * `photoIds`, never from `content.photos` (sorted by ID), a capture date, a
 * file name, or a registry field, so new files or changed EXIF never move
 * it. Only the fields Home shows leave here: no `statement`, `slugAliases`,
 * `chapters`, `accent` (Chromatic Chapters stays in the Viewer), caption,
 * credit, location, camera facts, or source paths. Every prop the page
 * hands a client component ships to visitors, so this allowlist bounds them.
 * It's server-only: app/page.tsx runs it, and client components import its
 * types alone, so the build fails if one ever imports it at runtime.
 *
 * #6 narrows it to the ordered IDs plus records for the opening photograph
 * and its neighbors only. Home loads the rest as it moves, from
 * `/api/catalog/home/photos/<photoId>` (homePhotosOf()), bound to the
 * revision it rendered.
 */

type Photo = CatalogContent['photos'][number];

/** One variant file, as `/media` serves it and a `srcset` names it. */
export type HomeVariant = LadderVariant;

/** One photograph's #10 derivative set, as ResponsivePhoto takes it. */
export interface HomeImage {
    /** Oriented. */
    width: number;
    height: number;
    variants: Ladder;
    /** Only on the opening photograph, the one a first visit paints first. */
    lqip?: string;
}

/** One photograph in the featured sequence. */
export interface HomePhoto {
    id: string;
    /** The described text, or empty for a decorative photo or one whose description is pending (a draft only). */
    alt: string;
    /** The photo's authored focal point, else the center. 0 to 1. */
    focalPoint: FocalPoint;
    /** Null when the set can't be shown (a hand-built revision or a partial set), so Home shows its missing-image state, never another file. */
    image: HomeImage | null;
}

/** The featured series as Home shows it. */
export interface HomeSeries {
    id: string;
    /** The current canonical slug. */
    slug: string;
    /** "Enter the series": the stable series link from the route builder, for example `/work/<slug>`. */
    href: string;
    /** Authored plain text. */
    title: string;
    /** Authored plain text, never cut from the long statement. Null only when blank, which a publish refuses. */
    shortStatement: string | null;
    /** The whole authored order: the series' `photoIds` that resolve, in order. Never empty. */
    photoIds: string[];
    /**
     * Records for the opening photograph and its neighbor on each side, wrapping
     * as Home does, and nothing else (#6). Later ones come from
     * homePhotosOf() as Home moves.
     */
    records: HomePhoto[];
    /** The series' `openingPhotoId` when it resolves (#8's `order.opening` keeps it in the series), else the first photograph. Always in `photoIds` and `records`. */
    openingPhotoId: string;
}

/** The records Home asks for as it moves: one photograph and its neighbor on each side, from one revision. */
export interface HomePhotosWindow {
    revisionId: string;
    /** Previous, the named one, next, in authored order, wrapping, each once. No LQIP: only the opening photograph carries one. */
    photos: HomePhoto[];
}

export type HomePhotosResult =
    | { kind: 'ok'; window: HomePhotosWindow }
    /** No `revision`, or a malformed one. */
    | { kind: 'bad-request' }
    /** `revision` isn't the revision being served. */
    | { kind: 'revision-changed' }
    /** A malformed photo ID, one the featured series doesn't hold, or nothing featured. */
    | { kind: 'not-found' };

/**
 * The approved sketch's `PublishedHome`. `featuredSeries` null is the empty
 * state: nothing featured, or a featured series with no photograph that
 * resolves. A publish refuses both (`refs.non-empty`, `order.empty-series`),
 * so only a hand-built revision or a draft reaches it.
 */
export interface PublishedHome {
    /** The revision (or candidate) every field below came from. */
    catalogRevision: string;
    featuredSeries: HomeSeries | null;
}

/** What publishedHomeOf() reads. A CatalogReader has all of it. */
export interface HomeSource {
    revisionId: string;
    site(): SiteRecord;
    listSeries(): readonly SeriesRecord[];
    photosOf(seriesId: string): readonly Photo[];
}

const CENTER: FocalPoint = Object.freeze({ x: 0.5, y: 0.5 });
/** The shape the revision schema checks. ResponsivePhoto puts it in a CSS `url()`, so nothing else passes. */
const LQIP_RE = /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/;

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

/** The alt, from the alt union alone. A draft's `pending` or blank text gives empty, never a made-up name. */
function altOf(alt: Photo['alt'] | undefined): string {
    return alt?.kind === 'described' ? text(alt.text) ?? '' : '';
}

/** The photo's derivative set when its ladder is usable (see ladderOf()), else null. */
function imageOf(photo: Photo, withLqip: boolean): HomeImage | null {
    if (!dimension(photo.width) || !dimension(photo.height)) return null;
    const variants = ladderOf(photo);
    if (variants === null) return null;
    const image: HomeImage = { width: photo.width, height: photo.height, variants };
    if (withLqip && typeof photo.lqip === 'string' && LQIP_RE.test(photo.lqip)) image.lqip = photo.lqip;
    return image;
}

/**
 * Whether #5's series page would open this series, by the same checks #5
 * and #7 make: its ID appears once, its published count is positive, and
 * its canonical slug is one the route accepts. Compile never writes
 * anything else, so only a hand-written revision fails, and Home then shows
 * its empty state instead of linking a series page that answers not-found.
 * The members that resolve are checked by the caller.
 */
function openable(series: SeriesRecord, listed: readonly SeriesRecord[]): boolean {
    if (listed.filter((record) => record.id === series.id).length !== 1) return false;
    if (!dimension(series.derived?.photoCount)) return false;
    return typeof series.slug === 'string' && series.slug.length <= MAX_SLUG_LENGTH && SLUG_RE.test(series.slug);
}

/**
 * The Home of one source. The featured series is the first
 * `featuredSeriesIds` entry the source holds, as #8's featuredSeries()
 * reads it, and never rotates. One #5's page wouldn't open (a repeated
 * ID, no positive published count, or a slug the route refuses) gives the
 * empty state, never the next entry. Its photographs are the members that
 * resolve, in `photoIds` order, the list #5 and #7 count, so the position
 * Home shows matches the series page. The href comes from `routes`: #13's
 * `publicRoutes` on the site, a preview's own builder in a preview.
 */
export function publishedHomeOf(source: HomeSource, routes: Pick<RouteBuilder, 'seriesHref'>): PublishedHome {
    const empty: PublishedHome = { catalogRevision: source.revisionId, featuredSeries: null };
    const featured = featuredOf(source);
    if (featured === null) return empty;
    const { series, members } = featured;
    const openingIndex = Math.max(0, members.findIndex((photo) => photo.id === series.openingPhotoId));
    const opening = members[openingIndex];
    return {
        catalogRevision: source.revisionId,
        featuredSeries: {
            id: series.id,
            slug: series.slug,
            href: routes.seriesHref(series.slug),
            title: series.title,
            shortStatement: text(series.shortStatement),
            photoIds: members.map((photo) => photo.id),
            records: windowOf(members, openingIndex).map((photo) => recordOf(photo, photo === opening)),
            openingPhotoId: opening.id,
        },
    };
}

/**
 * The featured series and its members that resolve, as publishedHomeOf()
 * picks them, or null for Home's empty state. homePhotosOf() reads the same,
 * so it never serves a photograph Home wouldn't show.
 */
function featuredOf(source: HomeSource): { series: SeriesRecord; members: readonly Photo[] } | null {
    const listed = source.listSeries();
    const series = source.site().featuredSeriesIds.map((seriesId) => listed.find((entry) => entry.id === seriesId)).find((entry) => entry !== undefined);
    if (!series || !openable(series, listed)) return null;
    // order.duplicate-photo blocks a repeated member at render, so no preview or revision holds one.
    const members = source.photosOf(series.id);
    return members.length === 0 ? null : { series, members };
}

/** The member at `index` and its neighbor on each side, wrapping, as #2's Home wraps from the last to the first. Each once. */
function windowOf(members: readonly Photo[], index: number): Photo[] {
    const count = members.length;
    const picked = [index - 1, index, index + 1].map((at) => members[((at % count) + count) % count]);
    return picked.filter((photo, at) => picked.indexOf(photo) === at);
}

function recordOf(photo: Photo, withLqip: boolean): HomePhoto {
    return {
        id: photo.id,
        alt: altOf(photo.alt),
        focalPoint: { ...(focal(photo.focalPoint) ?? CENTER) },
        image: imageOf(photo, withLqip),
    };
}

/**
 * The window Home asks for as it moves: `photoId` and its neighbors in the
 * featured series of one source, built as publishedHomeOf() builds its
 * records, or not-found for a photo ID out of shape, one the featured series
 * doesn't hold, and an empty Home.
 */
export function homePhotosOf(source: HomeSource, photoId: unknown): HomePhotosResult {
    if (typeof photoId !== 'string' || !PHOTO_ID_RE.test(photoId)) return { kind: 'not-found' };
    const featured = featuredOf(source);
    if (featured === null) return { kind: 'not-found' };
    const index = featured.members.findIndex((photo) => photo.id === photoId);
    if (index === -1) return { kind: 'not-found' };
    return { kind: 'ok', window: { revisionId: source.revisionId, photos: windowOf(featured.members, index).map((photo) => recordOf(photo, false)) } };
}

/**
 * The parts of #13's ActiveCatalog that homeRouteOf() reads, so this
 * module stays clear of the server-only public reader.
 */
export type HomeActiveCatalog<Reason extends string = string> =
    | { mode: 'legacy' }
    | { mode: 'catalog'; state: 'ok' | 'degraded'; reader: Pick<CatalogReader, 'revision' | 'site' | 'listSeries' | 'photosOf'> }
    | { mode: 'catalog'; state: 'unavailable'; reason: Reason };

export type HomeRouteResult<Reason extends string = string> =
    /** Before the cutover: today's Home, unchanged. */
    | { kind: 'legacy' }
    /** After it: the catalog Home, which renders its empty state when `home.featuredSeries` is null. */
    | { kind: 'home'; home: PublishedHome }
    /** The page throws CatalogUnavailableError, so #21's error page renders. */
    | { kind: 'unavailable'; reason: Reason };

/**
 * What `/` renders for the site as it stands, for the page to call per
 * request with getActiveCatalog():
 *
 * | catalog                  | `/`              |
 * | ------------------------ | ---------------- |
 * | legacy                   | legacy Home      |
 * | catalog, ok or degraded  | catalog Home     |
 * | catalog, unavailable     | unavailable      |
 *
 * The legacy Home serves only before the cutover, never as a fallback after
 * it: its shuffled filesystem scan would show photographs no revision
 * published. An unavailable catalog may be one whose cutover couldn't be
 * confirmed (#13's `catalog-unreadable`), so it gets neither Home. A
 * degraded catalog serves the last revision it loaded, read once here, so
 * the whole Home comes from that one revision.
 */
export function homeRouteOf<Reason extends string>(catalog: HomeActiveCatalog<Reason>, routes: Pick<RouteBuilder, 'seriesHref'>): HomeRouteResult<Reason> {
    if (catalog.mode === 'legacy') return { kind: 'legacy' };
    if (catalog.state === 'unavailable') return { kind: 'unavailable', reason: catalog.reason };
    return { kind: 'home', home: publishedHomeOf(homeSourceOf(catalog.reader), routes) };
}

type HomeReader = Extract<HomeActiveCatalog, { reader: unknown }>['reader'];

function homeSourceOf(reader: HomeReader): HomeSource {
    return { revisionId: reader.revision().revisionId, site: () => reader.site(), listSeries: () => reader.listSeries(), photosOf: (seriesId) => reader.photosOf(seriesId) };
}

/**
 * The Home records endpoint's answer for the site as it stands, for
 * `/api/catalog/home/photos/<photoId>?revision=<revisionId>`. A malformed
 * photo ID is not-found and a missing or malformed revision a bad request,
 * both before the catalog is read; legacy mode is not-found; an unavailable
 * catalog is unavailable, for a 503. A revision other than the one being
 * served is revision-changed, so Home replaces its sequence instead of
 * mixing two revisions; anything else is homePhotosOf() on the served one.
 */
export async function homePhotosFrom<Reason extends string>(
    load: () => Promise<HomeActiveCatalog<Reason>>,
    photoId: unknown,
    revisionId: string | null,
): Promise<HomePhotosResult | { kind: 'unavailable'; reason: Reason }> {
    if (typeof photoId !== 'string' || !PHOTO_ID_RE.test(photoId)) return { kind: 'not-found' };
    if (revisionId === null || !REVISION_ID_RE.test(revisionId)) return { kind: 'bad-request' };
    const catalog = await load();
    if (catalog.mode === 'legacy') return { kind: 'not-found' };
    if (catalog.state === 'unavailable') return { kind: 'unavailable', reason: catalog.reason };
    const { reader } = catalog;
    if (reader.revision().revisionId !== revisionId) return { kind: 'revision-changed' };
    return homePhotosOf(homeSourceOf(reader), photoId);
}
