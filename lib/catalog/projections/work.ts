// A client bundle that reaches this fails the build. Client code takes only types from it (#3).
import 'server-only';
import type { CatalogContent, CatalogReader, RouteBuilder } from '../reader';
import type { Crop, FocalPoint, SeriesRecord } from '../types';
import { imageOf, type Ladder } from './ladder';
import { CENTER, focal, openableSeries, text, type ScreenCatalog } from './shared';

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

/** A series' authored cover, as ResponsivePhoto takes it. Decorative on Work: the entry's title names the link. */
export interface WorkCover {
    photoId: string;
    /** Oriented, for the image's intrinsic size only. The entry's slot sets its box. */
    width: number;
    height: number;
    variants: Ladder;
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

/**
 * The series' authored cover, or null when it can't be shown: no cover, a
 * cover outside the series' resolved members (#8's `order.cover` keeps it
 * inside at publish; a draft may have left it out), or an unusable set.
 */
function coverOf(series: SeriesRecord, members: readonly Photo[]): WorkCover | null {
    const photoId = series.cover?.photoId;
    // Members are the series' photoIds that resolve, so a cover from anywhere else finds nothing.
    const photo = typeof photoId === 'string' ? members.find((member) => member.id === photoId) : undefined;
    const image = photo ? imageOf(photo, false) : null;
    if (!photo || image === null) return null;
    return {
        photoId: photo.id,
        ...image,
        focalPoint: { ...(focal(series.cover.focalPoint) ?? focal(photo.focalPoint) ?? CENTER) },
        crop: photo.crop === 'contain' ? 'contain' : 'cover',
    };
}

/**
 * The Work catalog of one source, in its series order. A series appears
 * only when openableSeries() says #5's page opens it: its ID once, a
 * positive published count, and at least one member that resolves. An
 * empty series is left out, as compile leaves it out, so no entry links to
 * an empty page, and a repeated ID is left out entirely. Hrefs come from
 * `routes`: #13's `publicRoutes` on the site, a preview's own builder in a
 * preview.
 */
export function workCatalogOf(source: WorkSource, routes: Pick<RouteBuilder, 'seriesHref'>): WorkCatalog {
    const series: WorkSeriesSummary[] = [];
    for (const record of source.listSeries()) {
        if (!openableSeries(source, record)) continue;
        const members = source.photosOf(record.id);
        series.push({
            id: record.id,
            slug: record.slug,
            href: routes.seriesHref(record.slug),
            title: record.title,
            shortStatement: text(record.shortStatement),
            derived: { photoCount: record.derived.photoCount },
            cover: coverOf(record, members),
        });
    }
    return { catalogRevision: source.revisionId, series };
}

/** The parts of #13's ActiveCatalog that workRouteOf() reads. */
export type WorkActiveCatalog<Reason extends string = string> = ScreenCatalog<Pick<CatalogReader, 'getWorkSummaries'>, Reason>;

export type WorkRouteResult<Reason extends string = string> =
    /** Render this. */
    | { kind: 'work'; work: WorkCatalog }
    /** The route throws CatalogUnavailableError, so #21's error page renders. */
    | { kind: 'unavailable'; reason: Reason };

/**
 * What `/work` answers for the site as it stands, for the page to call per
 * request with getActiveCatalog():
 *
 * | catalog                         | `/work`     |
 * | ------------------------------- | ----------- |
 * | ok or degraded                  | Work        |
 * | unavailable, not-published too  | unavailable |
 *
 * A degraded catalog serves its last revision. `/gallery`, the legacy
 * archive #13's slice E removed, is a 308 to `/work` in proxy.ts, in every
 * state, so it never reads the catalog. `routes` builds Work's links.
 */
export function workRouteOf<Reason extends string>(catalog: WorkActiveCatalog<Reason>, routes: RouteBuilder): WorkRouteResult<Reason> {
    if (catalog.state === 'unavailable') return { kind: 'unavailable', reason: catalog.reason };
    return { kind: 'work', work: catalog.reader.getWorkSummaries(routes) };
}
