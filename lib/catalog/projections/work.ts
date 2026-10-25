import { VARIANT_FORMATS, VARIANT_WIDTHS, type VariantFormat, type VariantWidth } from '../../identity/variants';
import { mediaUrl } from '../../media/url';
import type { CatalogContent, CatalogReader, RouteBuilder } from '../reader';
import type { Crop, FocalPoint, SeriesRecord } from '../types';

/**
 * #3's Work read model: the series catalog on `/work`, from one compiled
 * revision or candidate. Pure: no I/O and no Next. The content already holds
 * only published series in authored Work order (compile walks the authored
 * `seriesOrder` and skips draft and hidden series), so this filters nothing
 * by visibility. It picks the fields an entry shows and nothing else: no
 * `photoIds`, `statement`, `slugAliases`, `chapters`, `accent`, `lqip`, alt
 * text, camera facts, or source paths. Leaving out `accent` keeps Chromatic
 * Chapters off Work. Every prop the page hands a client component ships to
 * visitors, so this allowlist bounds those props too.
 */

type Photo = CatalogContent['photos'][number];

/** One cover variant file, as `/media` serves it. */
export interface WorkCoverVariant {
    url: string;
    width: number;
    height: number;
    bytes: number;
}

/** A series' authored cover, as ResponsivePhoto takes it. Decorative on Work: the entry's title names the link. */
export interface WorkCover {
    photoId: string;
    /** Oriented, for the image's intrinsic size only. The entry's slot sets its box. */
    width: number;
    height: number;
    variants: Record<VariantWidth, Record<VariantFormat, WorkCoverVariant>>;
    /** The series cover's focal point, else the photo's, else the center. 0 to 1. */
    focalPoint: FocalPoint;
    /** The photo's authored crop, `cover` by default. */
    crop: Crop;
}

/** One entry on Work. */
export interface WorkSeriesSummary {
    /** The immutable series ID. */
    id: string;
    /** The current canonical slug. Former slugs never leave the revision. */
    slug: string;
    /** The stable series link, from the route builder, for example `/work/<slug>`. */
    href: string;
    /** Authored. */
    title: string;
    /** Authored plain text, never cut from the statement. Null only when blank, which a publish refuses. */
    shortStatement: string | null;
    /** Facts compile derives, kept apart from the authored copy above. */
    derived: {
        /** Published photographs in the series. */
        photoCount: number;
    };
    /** Null when the cover can't be shown, so the entry renders text-led with its link intact. */
    cover: WorkCover | null;
}

/** The approved sketch's Work payload: one revision, its series in authored Work order. */
export interface WorkCatalog {
    /** The revision (or candidate) every entry came from. */
    catalogRevision: string;
    /** Empty when nothing is published, which only a hand-written revision or a draft reader reaches. */
    series: WorkSeriesSummary[];
}

/** What workCatalogOf() reads. A CatalogReader has all of it. */
export interface WorkSource {
    revisionId: string;
    listSeries(): readonly SeriesRecord[];
    photosOf(seriesId: string): readonly Photo[];
}

const CENTER: FocalPoint = Object.freeze({ x: 0.5, y: 0.5 });

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

/**
 * The cover's variant ladder, field by field, when every file is the
 * `/media` URL #10 builds for this photo's set. A missing or foreign file
 * (a hand-written revision, a partial derivative set) gives null, so the
 * entry falls back instead of pointing anywhere else.
 */
function coverVariants(photo: Photo): WorkCover['variants'] | null {
    const ladder = photo.variants as Partial<Record<VariantWidth, Partial<Record<VariantFormat, Partial<WorkCoverVariant>>>>> | undefined;
    const projected = {} as WorkCover['variants'];
    for (const width of VARIANT_WIDTHS) {
        projected[width] = {} as Record<VariantFormat, WorkCoverVariant>;
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
            projected[width][format] = { url: file.url, width: file.width, height: file.height, bytes: file.bytes };
        }
    }
    return projected;
}

/**
 * The series' authored cover, or null when it can't be shown: no cover, a
 * cover outside the series' resolved members (#8's `order.cover` keeps it
 * inside at publish; a draft may have left it out), or an unusable set.
 */
function coverOf(series: SeriesRecord, members: readonly Photo[]): WorkCover | null {
    const photoId = series.cover?.photoId;
    if (typeof photoId !== 'string' || !series.photoIds.includes(photoId)) return null;
    const photo = members.find((member) => member.id === photoId);
    if (!photo || !dimension(photo.width) || !dimension(photo.height)) return null;
    const variants = coverVariants(photo);
    if (variants === null) return null;
    return {
        photoId: photo.id,
        width: photo.width,
        height: photo.height,
        variants,
        focalPoint: { ...(focal(series.cover.focalPoint) ?? focal(photo.focalPoint) ?? CENTER) },
        crop: photo.crop === 'contain' ? 'contain' : 'cover',
    };
}

/**
 * The Work catalog of one source, in its series order. A series appears
 * once (the first time, as compile keeps it), and only with something to
 * open: a positive published count and at least one member that resolves.
 * An empty series is left out, as compile leaves it out, so no entry links
 * to an empty page. Hrefs come from `routes`: #13's `publicRoutes` on the
 * site, a preview's own builder in a preview.
 */
export function workCatalogOf(source: WorkSource, routes: Pick<RouteBuilder, 'seriesHref'>): WorkCatalog {
    const seen = new Set<string>();
    const series: WorkSeriesSummary[] = [];
    for (const record of source.listSeries()) {
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        const photoCount = record.derived?.photoCount;
        if (!dimension(photoCount)) continue;
        const members = source.photosOf(record.id);
        if (members.length === 0) continue;
        series.push({
            id: record.id,
            slug: record.slug,
            href: routes.seriesHref(record.slug),
            title: record.title,
            shortStatement: text(record.shortStatement),
            derived: { photoCount },
            cover: coverOf(record, members),
        });
    }
    return { catalogRevision: source.revisionId, series };
}

/** The count line under an entry's statement: interface copy, not authored. */
export function photoCountLabel(count: number): string {
    return count === 1 ? '1 photograph' : `${count} photographs`;
}

/** The legacy archive route, until #13 slice E removes it. */
export const LEGACY_GALLERY_PATH = '/gallery';

/**
 * The parts of #13's ActiveCatalog that workRouteOf() reads, so this module
 * stays clear of the server-only public reader.
 */
export type WorkActiveCatalog<Reason extends string = string> =
    | { mode: 'legacy' }
    | { mode: 'catalog'; state: 'ok' | 'degraded'; reader: Pick<CatalogReader, 'getWorkSummaries'> }
    | { mode: 'catalog'; state: 'unavailable'; reason: Reason };

export type WorkRouteResult<Reason extends string = string> =
    /** `/work` in catalog mode: render this. */
    | { kind: 'work'; work: WorkCatalog }
    /** `/gallery` before the cutover: today's page, unchanged. */
    | { kind: 'legacy-gallery' }
    /** 307 is Next's redirect(), 308 its permanentRedirect(). The location is bare: nothing reads a query, and browsers keep the fragment. */
    | { kind: 'redirect'; location: string; status: 307 | 308 }
    /** The route throws CatalogUnavailableError, so #21's error page renders. */
    | { kind: 'unavailable'; reason: Reason };

/**
 * What `/work` and `/gallery` answer for the site as it stands, the
 * cutover matrix in one place, for each page to call per request with
 * getActiveCatalog():
 *
 * | catalog                  | `/work`          | `/gallery`       |
 * | ------------------------ | ---------------- | ---------------- |
 * | legacy                   | 307 to /gallery  | legacy page      |
 * | catalog, ok or degraded  | Work             | 308 to /work     |
 * | catalog, unavailable     | unavailable      | unavailable      |
 *
 * The 308 goes out only once a revision is being served. An unavailable
 * catalog may be one whose cutover couldn't be confirmed (#13's
 * `catalog-unreadable`, which catalogMode() doesn't remember), and a
 * browser caches a 308, so a permanent redirect there could pair with a
 * later legacy 307 into a loop. A degraded catalog serves its last revision.
 */
export function workRouteOf<Reason extends string>(route: 'work' | 'gallery', catalog: WorkActiveCatalog<Reason>, routes: RouteBuilder): WorkRouteResult<Reason> {
    if (catalog.mode === 'legacy') {
        return route === 'work' ? { kind: 'redirect', location: LEGACY_GALLERY_PATH, status: 307 } : { kind: 'legacy-gallery' };
    }
    if (catalog.state === 'unavailable') return { kind: 'unavailable', reason: catalog.reason };
    if (route === 'gallery') return { kind: 'redirect', location: routes.workHref(), status: 308 };
    return { kind: 'work', work: catalog.reader.getWorkSummaries(routes) };
}
