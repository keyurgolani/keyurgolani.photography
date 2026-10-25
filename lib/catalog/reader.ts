// Only the web process and the tests import this, never the CLI or a client
// module. A client bundle that reaches it fails the build (#3).
import 'server-only';
import type { PublicAssetProjection } from '../identity/metadata';
import { workCatalogOf, type WorkCatalog } from './projections/work';
import { viewerPhotoOf, type ViewerPhotoResult } from './projections/viewer';
import { seriesContinuationOf, seriesPageOf, type SeriesContinuationResult, type SeriesPageResult } from './projections/series';
import type { CandidateContent, RevisionContent, SeriesRecord, SiteRecord } from './types';

/**
 * Reads one compiled catalog, a published revision or a candidate, and
 * builds the routes to it. Pure: no I/O, no Next. Page projections (#4, #3,
 * #5, #7) go on createCatalogReader(), so a draft reader gets them too.
 */

export type CatalogContent = RevisionContent | CandidateContent;

export interface ReaderMeta {
    revisionId: string;
    /** Null for a candidate, which has no number until it is activated. */
    revisionNumber: number | null;
}

export interface CatalogReader<Photo = CatalogContent['photos'][number]> {
    revision(): ReaderMeta;
    site(): SiteRecord;
    /** Published series in Work order. */
    listSeries(): readonly SeriesRecord[];
    /** By slug (`canonical: true`) or by a former slug (`canonical: false`, so the caller redirects). Exact match only. */
    seriesBySlug(slugOrAlias: string): { series: SeriesRecord; canonical: boolean } | null;
    /** The published series holding the photo. A photo is in at most one. */
    seriesOfPhoto(photoId: string): SeriesRecord | null;
    photo(photoId: string): Photo | null;
    /** A series' photos in `photoIds` order, skipping entries that resolve to nothing, from `offset`. */
    photosOf(seriesId: string, offset?: number, limit?: number): Photo[];
    /** #3's Work read model for `/work`, from this reader's content alone. Hrefs from `routes`, the public ones by default. */
    getWorkSummaries(routes?: Pick<RouteBuilder, 'seriesHref'>): WorkCatalog;
    /** #7's Viewer read model for `/work/<slug>/photo/<photoId>`, from this reader's content alone. */
    getViewerPhoto(slug: string, photoId: string): ViewerPhotoResult;
    /** #5's series page read model for `/work/<slug>`, from this reader's content alone. Hrefs from `routes`, the public ones by default. */
    getSeriesPage(slug: string, routes?: Pick<RouteBuilder, 'seriesHref' | 'photoHref' | 'workHref'>): SeriesPageResult;
    /** #6's continuation page of `/work/<slug>` after its first, from this reader's content alone, when `cursor` names this revision. */
    getSeriesContinuation(slug: string, cursor: string, routes?: Pick<RouteBuilder, 'seriesHref' | 'photoHref' | 'workHref'>): SeriesContinuationResult;
}

interface Index {
    seriesById: Map<string, SeriesRecord>;
    seriesBySlug: Map<string, { series: SeriesRecord; canonical: boolean }>;
    seriesByPhoto: Map<string, SeriesRecord>;
    photoById: Map<string, CatalogContent['photos'][number]>;
    members: Map<string, CatalogContent['photos'][number][]>;
}

/** Built once per content object, so lookups never scan arrays. */
const indexes = new WeakMap<CatalogContent, Index>();

function indexOf(content: CatalogContent): Index {
    const cached = indexes.get(content);
    if (cached) return cached;
    const photoById = new Map(content.photos.map((photo) => [photo.id, photo] as const));
    const index: Index = { seriesById: new Map(), seriesBySlug: new Map(), seriesByPhoto: new Map(), photoById, members: new Map() };
    for (const series of content.series) {
        index.seriesById.set(series.id, series);
        index.seriesBySlug.set(series.slug, { series, canonical: true });
        const members = series.photoIds.flatMap((photoId) => photoById.get(photoId) ?? []);
        index.members.set(series.id, members);
        for (const photo of members) if (!index.seriesByPhoto.has(photo.id)) index.seriesByPhoto.set(photo.id, series);
    }
    // A current slug always wins over another series' alias, which route.collision forbids anyway.
    for (const series of content.series) {
        for (const alias of series.slugAliases) if (!index.seriesBySlug.has(alias)) index.seriesBySlug.set(alias, { series, canonical: false });
    }
    indexes.set(content, index);
    return index;
}

function checkPage(offset: number, limit: number): void {
    if (!Number.isInteger(offset) || offset < 0) throw new RangeError(`offset must be a non-negative integer, got ${offset}`);
    if (limit !== Infinity && (!Number.isInteger(limit) || limit < 0)) throw new RangeError(`limit must be a non-negative integer, got ${limit}`);
}

export function createCatalogReader<C extends CatalogContent>(content: C, meta: ReaderMeta): CatalogReader<C['photos'][number]> {
    type Photo = C['photos'][number];
    const index = indexOf(content);
    const revision = { revisionId: meta.revisionId, revisionNumber: meta.revisionNumber };
    const reader: CatalogReader<Photo> = {
        revision: () => ({ ...revision }),
        site: () => content.site,
        listSeries: () => content.series,
        seriesBySlug: (slugOrAlias) => index.seriesBySlug.get(slugOrAlias) ?? null,
        seriesOfPhoto: (photoId) => index.seriesByPhoto.get(photoId) ?? null,
        photo: (photoId) => (index.photoById.get(photoId) as Photo | undefined) ?? null,
        photosOf: (seriesId, offset = 0, limit = Infinity) => {
            checkPage(offset, limit);
            const members = (index.members.get(seriesId) ?? []) as Photo[];
            return members.slice(offset, limit === Infinity ? undefined : offset + limit);
        },
        getWorkSummaries: (routes = publicRoutes) => workCatalogOf(source, routes),
        getViewerPhoto: (slug, photoId) => viewerPhotoOf(source, slug, photoId),
        getSeriesPage: (slug, routes = publicRoutes) => seriesPageOf(source, slug, routes),
        getSeriesContinuation: (slug, cursor, routes = publicRoutes) => seriesContinuationOf(source, slug, cursor, routes),
    };
    // The reader itself is every projection's source (WorkSource, SeriesSource, ViewerSource), with the revision ID beside its lookups.
    const source = { ...reader, revisionId: revision.revisionId };
    return reader;
}

/**
 * The asset half of a photo record as #10's PublicAssetProjection, for
 * ResponsivePhoto. It reverses compile's renames: `id` back to `photoId`, and
 * `capturedAt` back to `capturedDate`.
 */
export function toAssetProjection(photo: CatalogContent['photos'][number]): PublicAssetProjection {
    return {
        photoId: photo.id,
        assetRevision: photo.assetRevision,
        profileId: photo.profileId,
        width: photo.width,
        height: photo.height,
        lqip: photo.lqip,
        variants: photo.variants,
        technical: photo.technical,
        capturedDate: photo.capturedAt ?? null,
    };
}

/** Builds the site's hrefs. Serializable as `{basePath}`, which is '' publicly and a prefix in a preview. */
export interface RouteBuilder {
    readonly basePath: string;
    homeHref(): string;
    workHref(): string;
    seriesHref(slug: string): string;
    photoHref(slug: string, photoId: string): string;
}

export function createRouteBuilder({ basePath = '' }: { basePath?: string } = {}): RouteBuilder {
    if (basePath !== '' && !/^\/[^/](?:.*[^/])?$/.test(basePath)) {
        throw new TypeError(`basePath must be '' or start with one / and not end with one, got ${JSON.stringify(basePath)}`);
    }
    const segment = encodeURIComponent;
    return {
        basePath,
        homeHref: () => basePath || '/',
        workHref: () => `${basePath}/work`,
        seriesHref: (slug) => `${basePath}/work/${segment(slug)}`,
        photoHref: (slug, photoId) => `${basePath}/work/${segment(slug)}/photo/${segment(photoId)}`,
    };
}

/**
 * The public routes: `/`, `/work`, `/work/<slug>`, and
 * `/work/<slug>/photo/<photoId>`. The reader's projections default to it,
 * and #13's public reader re-exports it, so the site has one builder.
 */
export const publicRoutes = createRouteBuilder();
