import 'server-only';
import { randomInt } from 'node:crypto';
import { photoImageAlt } from '../../a11y/photoName';
import { PHOTO_ID_RE } from '../../identity/ids';
import type { CatalogContent, CatalogReader, RouteBuilder } from '../reader';
import { REVISION_ID_RE, SERIES_ID_RE } from '../schema';
import type { Crop, FocalPoint, SeriesRecord, SiteRecord } from '../types';
import { imageOf, type Ladder } from './ladder';
import { CENTER, focal, openableSeries, seriesParams, text, type ScreenCatalog } from './shared';

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
 * `/api/catalog/home/series/<seriesId>/photos/<photoId>`
 * (homeSeriesPhotosOf()), bound to the revision it rendered.
 *
 * v1.5.0 plays every featured series that resolves as one loop, in
 * `featuredSeriesIds` order, each from its opening photograph through its
 * whole authored order and round to the photographs before the opening one,
 * then on into the next. Each render starts the loop on a series picked at
 * random (HomePick), so the first paint, its preload and hydration all come
 * from the one server render. One featured series gives the model today's
 * Home had, field for field.
 */

type Photo = CatalogContent['photos'][number];

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
    /** The photo's authored focal point, else the center. 0 to 1. Home cuts a cover crop on it. */
    focalPoint: FocalPoint;
    /** The photo's authored crop, `cover` by default. Home shows a `contain` one whole, on the theme's mat (#4). */
    crop: Crop;
    /** Null when the set can't be shown (a hand-built revision or a partial set), so Home shows its missing-image state, never another file. */
    image: HomeImage | null;
}

/** One featured series in Home's loop: what the chrome shows while one of its photographs is on screen, and the order they play in. */
export interface HomeLoopSeries {
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
    /** The series' `openingPhotoId` when it resolves (#8's `order.opening` keeps it in the series), else the first photograph. Always in `photoIds`. */
    openingPhotoId: string;
}

/** The featured series Home opens on, with the only records the page ships. */
export interface HomeSeries extends HomeLoopSeries {
    /**
     * Records for the opening photograph and its neighbor on each side in
     * Home's loop, wrapping as Home does, and nothing else (#6). With one
     * featured series both neighbors are its own; with more, the one before
     * may be the previous series' and the one after the next series'. Later
     * ones come from homeSeriesPhotosOf() as Home moves. `openingPhotoId` is
     * always among them.
     */
    records: HomePhoto[];
}

/**
 * Which featured series Home starts on: a whole number from 0 to `count - 1`,
 * for the `count` featured series that resolve. crypto.randomInt by default;
 * tests inject their own, and the e2e harness scripts one (lib/catalog/homePick.ts).
 */
export type HomePick = (count: number) => number;

/** The records Home asks for as it moves: one photograph and its neighbor on each side, from one revision. */
export interface HomePhotosWindow {
    revisionId: string;
    /** Previous, the named one, next, in Home's play order, wrapping, each once. No LQIP: only the opening photograph carries one. */
    photos: HomePhoto[];
}

export type HomePhotosResult =
    | { kind: 'ok'; window: HomePhotosWindow }
    /** No `revision`, or a malformed one. */
    | { kind: 'bad-request' }
    /** `revision` isn't the revision being served. */
    | { kind: 'revision-changed' }
    /** A malformed ID, a series that isn't featured and published, a photo it doesn't hold, or nothing featured. */
    | { kind: 'not-found' };

/**
 * The approved sketch's `PublishedHome`. `featuredSeries` null is the empty
 * state: nothing featured, or no featured series that resolves. A publish
 * refuses both (`refs.non-empty`, `order.empty-series`), so only a
 * hand-built revision or a draft reaches it.
 */
export interface PublishedHome {
    /** The revision (or candidate) every field below came from. */
    catalogRevision: string;
    /** The series Home opens on, picked at random among the featured series that resolve. */
    featuredSeries: HomeSeries | null;
    /**
     * The rest of the loop, in `featuredSeriesIds` order from the one after
     * `featuredSeries`, wrapping round to the ones before it. Absent when
     * nothing follows, so one featured series ships today's model exactly.
     */
    followingSeries?: HomeLoopSeries[];
}

/** What publishedHomeOf() reads. A CatalogReader has all of it. */
export interface HomeSource {
    revisionId: string;
    site(): SiteRecord;
    listSeries(): readonly SeriesRecord[];
    photosOf(seriesId: string): readonly Photo[];
}

/**
 * The alt, from the alt union and the photo's place in the featured series.
 * A draft's `pending` or blank text gives empty, never a made-up name. A
 * carried-over photo with no description yet (`position`) is named by its
 * place, "Photograph N of T", as the legacy site named it.
 */
function altOf(alt: Photo['alt'] | undefined, position: number, total: number): string {
    if (alt?.kind === 'position') return photoImageAlt({ position, total });
    return alt?.kind === 'described' ? text(alt.text) ?? '' : '';
}

/** One featured series that resolves, with its members in authored order and where its opening photograph sits among them. */
interface LoopEntry {
    series: SeriesRecord;
    members: readonly Photo[];
    openingIndex: number;
}

/** One place in Home's loop: a photograph, and the entry it plays in. */
interface Slot {
    photo: Photo;
    entry: LoopEntry;
}

/**
 * The Home of one source. Every `featuredSeriesIds` entry #5's page would
 * open joins the loop, in that order: the source holds it, its ID appears
 * once, it has a positive published count and a member that resolves, and
 * the route takes its canonical slug. Any other entry is skipped, and none
 * left is the empty state. `pick` chooses the one Home opens on, and the
 * rest follow it. Each series' photographs are the members that resolve, in
 * `photoIds` order, the list #5 and #7 count, so the position Home shows
 * matches the series page. The href comes from `routes`: #13's
 * `publicRoutes` on the site, a preview's own builder in a preview.
 */
export function publishedHomeOf(source: HomeSource, routes: Pick<RouteBuilder, 'seriesHref'>, pick: HomePick = randomInt): PublishedHome {
    const loop = loopOf(source);
    if (loop.length === 0) return { catalogRevision: source.revisionId, featuredSeries: null };
    // One featured series has nothing to choose between, so the random source isn't asked.
    const picked = loop.length === 1 ? 0 : pick(loop.length);
    const start = Number.isInteger(picked) && picked >= 0 && picked < loop.length ? picked : 0;
    const ordered = [...loop.slice(start), ...loop.slice(0, start)];
    const slots = slotsOf(ordered);
    const opening = slots[0];
    const { openingPhotoId, ...series } = loopSeriesOf(opening.entry, routes);
    // v1.4.0's key order, which the JSON the page ships keeps: the records before the opening photograph.
    const records = windowOf(slots, 0).map((slot) => recordOf(slot, slot === opening));
    const home: PublishedHome = { catalogRevision: source.revisionId, featuredSeries: { ...series, records, openingPhotoId } };
    if (ordered.length > 1) home.followingSeries = ordered.slice(1).map((entry) => loopSeriesOf(entry, routes));
    return home;
}

/**
 * The featured series that resolve, in `featuredSeriesIds` order, as
 * publishedHomeOf() plays them. homeSeriesPhotosOf() reads the same, so it
 * never serves a photograph Home wouldn't show. A series featured twice
 * plays once, at its first place, and one that holds a photograph an earlier
 * one already plays is skipped, so no photograph is in the loop twice.
 * refs.featured and refs.membership refuse both, so only a hand-built
 * revision reaches either. refs.membership is a render gate, so no publish
 * and no preview ever holds a photograph in two featured series; the skip
 * only keeps a hand-built revision's loop from playing one twice.
 */
function loopOf(source: HomeSource): LoopEntry[] {
    const listed = source.listSeries();
    const seen = new Set<string>();
    const playing = new Set<string>();
    const loop: LoopEntry[] = [];
    for (const seriesId of source.site().featuredSeriesIds) {
        if (seen.has(seriesId)) continue;
        seen.add(seriesId);
        const series = listed.find((entry) => entry.id === seriesId);
        // The series page's own checks: openableSeries(), then the route's slug check on the canonical slug Home links.
        if (!series || !openableSeries(source, series) || seriesParams(series.slug) === null) continue;
        const members = source.photosOf(series.id);
        if (members.some((photo) => playing.has(photo.id))) continue;
        for (const photo of members) playing.add(photo.id);
        loop.push({ series, members, openingIndex: Math.max(0, members.findIndex((photo) => photo.id === series.openingPhotoId)) });
    }
    return loop;
}

/** The loop in play order: each series from its opening photograph to its last, then its first up to the one before the opening. */
function slotsOf(loop: readonly LoopEntry[]): Slot[] {
    return loop.flatMap((entry) => [...entry.members.slice(entry.openingIndex), ...entry.members.slice(0, entry.openingIndex)].map((photo) => ({ photo, entry })));
}

function loopSeriesOf({ series, members, openingIndex }: LoopEntry, routes: Pick<RouteBuilder, 'seriesHref'>): HomeLoopSeries {
    return {
        id: series.id,
        slug: series.slug,
        href: routes.seriesHref(series.slug),
        title: series.title,
        shortStatement: text(series.shortStatement),
        photoIds: members.map((photo) => photo.id),
        openingPhotoId: members[openingIndex].id,
    };
}

/** The slot at `index` and its neighbor on each side, wrapping, as #2's Home wraps from the last to the first. Each once. */
function windowOf<T>(slots: readonly T[], index: number): T[] {
    const count = slots.length;
    const picked = [index - 1, index, index + 1].map((at) => slots[((at % count) + count) % count]);
    return picked.filter((slot, at) => picked.indexOf(slot) === at);
}

/** A photograph's record. A carried-over one is named by its place in its own series. */
function recordOf({ photo, entry }: Slot, withLqip: boolean): HomePhoto {
    return {
        id: photo.id,
        alt: altOf(photo.alt, entry.members.indexOf(photo) + 1, entry.members.length),
        focalPoint: { ...(focal(photo.focalPoint) ?? CENTER) },
        crop: photo.crop === 'contain' ? 'contain' : 'cover',
        image: imageOf(photo, withLqip),
    };
}

/**
 * The window Home asks for as it moves: `photoId` and its neighbors in
 * Home's loop of one source, built as publishedHomeOf() builds its records.
 * The neighbors don't depend on which series Home started on, since the loop
 * is a circle. Anything but a series that is featured and resolves, and one
 * of its own photographs, is not-found: a draft, hidden, unfeatured or
 * unknown series, an ID out of shape, and an empty Home. So the route can
 * never list a series Home doesn't play.
 */
export function homeSeriesPhotosOf(source: HomeSource, seriesId: unknown, photoId: unknown): HomePhotosResult {
    if (typeof seriesId !== 'string' || !SERIES_ID_RE.test(seriesId)) return { kind: 'not-found' };
    if (typeof photoId !== 'string' || !PHOTO_ID_RE.test(photoId)) return { kind: 'not-found' };
    const slots = slotsOf(loopOf(source));
    const index = slots.findIndex((slot) => slot.entry.series.id === seriesId && slot.photo.id === photoId);
    if (index === -1) return { kind: 'not-found' };
    return { kind: 'ok', window: { revisionId: source.revisionId, photos: windowOf(slots, index).map((slot) => recordOf(slot, false)) } };
}

/** The parts of #13's ActiveCatalog that homeRouteOf() and homeSeriesPhotosFrom() read. */
export type HomeActiveCatalog<Reason extends string = string> = ScreenCatalog<Pick<CatalogReader, 'revision' | 'site' | 'listSeries' | 'photosOf'>, Reason>;

export type HomeRouteResult<Reason extends string = string> =
    /** The catalog Home, which renders its empty state when `home.featuredSeries` is null. */
    | { kind: 'home'; home: PublishedHome }
    /** The page throws CatalogUnavailableError, so #21's error page renders. */
    | { kind: 'unavailable'; reason: Reason };

/**
 * What `/` renders for the site as it stands, for the page to call per
 * request with getActiveCatalog():
 *
 * | catalog                         | `/`          |
 * | ------------------------------- | ------------ |
 * | ok or degraded                  | catalog Home |
 * | unavailable, not-published too  | unavailable  |
 *
 * There is no legacy Home since #13's slice E, so a site that has published
 * nothing gets the unavailable state, never a listing of the library: its
 * shuffled filesystem scan would show photographs no revision published. A
 * degraded catalog serves the last revision it loaded, read once here, so
 * the whole Home comes from that one revision.
 */
export function homeRouteOf<Reason extends string>(catalog: HomeActiveCatalog<Reason>, routes: Pick<RouteBuilder, 'seriesHref'>, pick: HomePick = randomInt): HomeRouteResult<Reason> {
    if (catalog.state === 'unavailable') return { kind: 'unavailable', reason: catalog.reason };
    return { kind: 'home', home: publishedHomeOf(homeSourceOf(catalog.reader), routes, pick) };
}

type HomeReader = Extract<HomeActiveCatalog, { reader: unknown }>['reader'];

function homeSourceOf(reader: HomeReader): HomeSource {
    return { revisionId: reader.revision().revisionId, site: () => reader.site(), listSeries: () => reader.listSeries(), photosOf: (seriesId) => reader.photosOf(seriesId) };
}

/**
 * The Home records endpoint's answer for the site as it stands, for
 * `/api/catalog/home/series/<seriesId>/photos/<photoId>?revision=<revisionId>`.
 * A malformed series or photo ID is not-found and a missing or malformed
 * revision a bad request, all before the catalog is read; an unavailable
 * catalog, one that has published nothing too, is unavailable, for a 503. A revision
 * other than the one being served is revision-changed, whatever the series,
 * so Home replaces its sequence instead of mixing two revisions; anything
 * else is homeSeriesPhotosOf() on the served one, which answers only for a
 * series that is featured and published in it.
 */
export async function homeSeriesPhotosFrom<Reason extends string>(
    load: () => Promise<HomeActiveCatalog<Reason>>,
    seriesId: unknown,
    photoId: unknown,
    revisionId: string | null,
): Promise<HomePhotosResult | { kind: 'unavailable'; reason: Reason }> {
    if (typeof seriesId !== 'string' || !SERIES_ID_RE.test(seriesId)) return { kind: 'not-found' };
    if (typeof photoId !== 'string' || !PHOTO_ID_RE.test(photoId)) return { kind: 'not-found' };
    if (revisionId === null || !REVISION_ID_RE.test(revisionId)) return { kind: 'bad-request' };
    const catalog = await load();
    if (catalog.state === 'unavailable') return { kind: 'unavailable', reason: catalog.reason };
    const { reader } = catalog;
    if (reader.revision().revisionId !== revisionId) return { kind: 'revision-changed' };
    return homeSeriesPhotosOf(homeSourceOf(reader), seriesId, photoId);
}
