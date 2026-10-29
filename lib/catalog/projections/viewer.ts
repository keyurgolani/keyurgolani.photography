// The web process and the tests import this, never the CLI or a client
// module. A client bundle that reaches it fails the build (#3).
import 'server-only';
import { photoImageAlt } from '../../a11y/photoName';
import { PHOTO_ID_RE } from '../../identity/ids';
import { TECHNICAL_KEYS, type TechnicalKey } from '../../identity/metadata';
import type { VariantFormat, VariantWidth } from '../../identity/variants';
import { sequencePosition } from '../order';
import type { CatalogContent, CatalogReader } from '../reader';
import { REVISION_ID_RE } from '../schema';
import type { SeriesRecord } from '../types';
import { imageOf, type Ladder } from './ladder';
import { openableSeries, seriesParams, text, type ScreenCatalog } from './shared';

/**
 * #7's Viewer read model: one photograph in one series, from one compiled
 * revision or candidate. Pure: no I/O and no Next. It checks the route
 * params, resolves the series and the photo in the source it was handed,
 * and projects only the fields the Viewer shows. Nothing else from the
 * record leaves here: no credit, location, focal point, crop, capture date,
 * profile, or technical key outside #10's allowlist.
 */

type Photo = CatalogContent['photos'][number];

/** The neutral copy a draft preview shows while a photo's description is pending. A published revision never needs it. */
export const DESCRIPTION_PENDING_COPY = 'Description pending editorial review';

/** One photograph's #10 derivative set, as ResponsivePhoto takes it. #5's `SeriesImage`, with the asset revision. */
export interface ViewerImage {
    /** Oriented. */
    width: number;
    height: number;
    assetRevision: string;
    /** The stored WebP data URI. Absent when it isn't one, so nothing else reaches the CSS `url()` that ResponsivePhoto writes it into. */
    lqip?: string;
    /** Each file's `url` and `width`, the parts a `srcset` reads (see ladder.ts). */
    variants: Ladder;
}

/** The approved sketch's `PublishedViewerPhoto`, with the approved detail's title, and the variant ladder in place of one URL. */
export interface PublishedViewerPhoto {
    /** The revision (or candidate) every field below came from. */
    catalogRevision: string;
    series: {
        id: string;
        slug: string;
        title: string;
        /** The series' stored `#rrggbb` accent, or null. */
        accent: string | null;
    };
    photo: {
        id: string;
        /** Authored, or null. */
        title: string | null;
        /**
         * The accessible description of what is visible, or null when decorative,
         * pending, or blank. Compile drops the authored `reviewed` flag, so in a
         * draft preview an unreviewed #14 suggestion shows here as the description.
         * Visitors never see one, since `description.required` blocks the publish.
         */
        description: string | null;
        /** Authored narrative, or null. Never camera facts. */
        caption: string | null;
        /** The image's alt: the description, or empty for a decorative photo or a pending one. */
        alt: string;
        /**
         * True only in a draft preview, for a photo whose alt is `pending` or whose
         * described text is blank. The Viewer then shows DESCRIPTION_PENDING_COPY.
         * An unreviewed suggestion isn't pending here (see `description`).
         */
        descriptionPending: boolean;
        /**
         * A carried-over photo with no description yet (`position`): its alt
         * is its place, "Photograph N of T", so the Viewer names it there
         * alone, and drops the other places that say the position.
         */
        namedByPlace: boolean;
        /**
         * Null when the set can't be shown (a hand-written revision: a size
         * that isn't a positive integer, or a file that isn't this photo's own
         * `/media` URL). The photo keeps its text, position, and neighbors, and
         * the Viewer shows its missing-image state, never another file. None of
         * a broken set's fields ships, so nothing from it reaches the client.
         */
        image: ViewerImage | null;
        /**
         * The share image, the 1200 px WebP, with the file's own height from the
         * record, since the shipped ladder carries only `url` and `width`. Null
         * exactly when `image` is.
         */
        shareImage: { url: string; width: number; height: number } | null;
        /** The photo's stored `#rrggbb` accent, or null. */
        accent: string | null;
        /** Derived camera facts: only #10's allowlisted keys, in allowlist order. */
        technical: Partial<Record<TechnicalKey, string>>;
    };
    /** 1-based, in the series' published order. */
    position: number;
    total: number;
    /** Null at the first photograph. The Viewer stops there. */
    previousPhotoId: string | null;
    /** Null at the last photograph. */
    nextPhotoId: string | null;
}

export type ViewerPhotoResult =
    | { kind: 'ok'; viewer: PublishedViewerPhoto }
    /** The slug is a prior alias of the series holding the photo. The route answers 308 to the canonical URL. */
    | { kind: 'redirect'; slug: string; photoId: string }
    /**
     * Malformed, unknown, unpublished, outside that series, or in a series the
     * series page answers not-found. The route renders the one public
     * not-found page. A photo whose set fails the `/media` check isn't one of
     * these: it renders with `image: null`, as the series page lists it.
     */
    | { kind: 'not-found' };

/** What viewerPhotoOf() reads. A CatalogReader has all of it. */
export interface ViewerSource {
    revisionId: string;
    listSeries(): readonly SeriesRecord[];
    seriesBySlug(slugOrAlias: string): { series: SeriesRecord; canonical: boolean } | null;
    photo(photoId: string): Photo | null;
    photosOf(seriesId: string): readonly Photo[];
}

const NOT_FOUND: ViewerPhotoResult = Object.freeze({ kind: 'not-found' });
/** The shape accent.format checks at publish. A preview's candidate hasn't passed it yet. */
const ACCENT_RE = /^#[0-9a-f]{6}$/i;

/**
 * The route params when both are well formed: a series slug that
 * seriesParams() accepts, the series page's own check, and a photo ID in
 * #10's shape. Exact, so a letter-case variant fails. Nothing here reads the
 * catalog, and a param never reaches a path.
 */
export function viewerParams(slug: unknown, photoId: unknown): { slug: string; photoId: string } | null {
    const series = seriesParams(slug);
    if (series === null || typeof photoId !== 'string' || !PHOTO_ID_RE.test(photoId)) return null;
    return { slug: series.slug, photoId };
}

function accent(value: unknown): string | null {
    return typeof value === 'string' && ACCENT_RE.test(value) ? value : null;
}


/**
 * The description, from the alt alone. Pending means a `pending` alt or blank
 * described text. The candidate carries no `reviewed` flag, so an unreviewed
 * suggestion reads as the description here; `description.required` stops it
 * at publish.
 */
function described(alt: Photo['alt'], position: number, total: number): Pick<PublishedViewerPhoto['photo'], 'description' | 'alt' | 'descriptionPending' | 'namedByPlace'> {
    if (alt.kind === 'decorative') return { description: null, alt: '', descriptionPending: false, namedByPlace: false };
    // Carried over with no description yet: named by its place, once, as the legacy Gallery named it. Nothing is pending.
    if (alt.kind === 'position') return { description: null, alt: photoImageAlt({ position, total }), descriptionPending: false, namedByPlace: true };
    const description = alt.kind === 'described' ? text(alt.text) : null;
    if (description === null) return { description: null, alt: '', descriptionPending: true, namedByPlace: false };
    return { description, alt: description, descriptionPending: false, namedByPlace: false };
}

function technical(facts: Photo['technical']): Partial<Record<TechnicalKey, string>> {
    const projected: Partial<Record<TechnicalKey, string>> = {};
    for (const key of TECHNICAL_KEYS) {
        const value = text(facts[key]);
        if (value !== null) projected[key] = value;
    }
    return projected;
}

/**
 * The photo's set from imageOf(), the check Home, Work, and Series use, with
 * its LQIP and the asset revision, else null. ladderOf() copies field by
 * field, so the Viewer gets only what the set names and a caller can't edit
 * the cached revision through it.
 */
function viewerImageOf(photo: Photo): ViewerImage | null {
    const image = imageOf(photo, true);
    if (image === null) return null;
    // The asset revision goes right after the size, where the Viewer has always shipped it.
    const { width, height, ...rest } = image;
    return { width, height, assetRevision: photo.assetRevision, ...rest };
}

/** The share image: the 1200 px WebP, a published `/media` variant whose path carries the asset revision. */
const SHARE_WIDTH: VariantWidth = 'w1200';
const SHARE_FORMAT: VariantFormat = 'webp';

/** The share file, field by field, for a photo whose set viewerImageOf() accepted, so every field is already checked. */
function shareOf(photo: Photo): NonNullable<PublishedViewerPhoto['photo']['shareImage']> {
    const file = photo.variants[SHARE_WIDTH][SHARE_FORMAT];
    return { url: file.url, width: file.width, height: file.height };
}

/**
 * Resolve `/work/<slug>/photo/<photoId>` in one source, in this order:
 * malformed params, an unknown slug, a series ID that appears more than
 * once, a series with no positive published count, an unknown photo, and a
 * photo the series doesn't hold are all not-found, and so is a prior slug
 * whose canonical slug the route would refuse; a prior slug redirects;
 * anything else is the projection. The series guards are #5's series page
 * guards, openableSeries() and the same redirect rule, so a photo URL is
 * not-found exactly when its series page is, and #3's Work never links
 * either. A photo without positive dimensions
 * or a set of its own `/media` files still resolves, with `image: null`, as
 * #5's series page lists it with its missing-image state. Compile never
 * writes a repeated ID, a zero count, or a bad set; only a hand-written
 * revision can. Position and neighbors come from #8's sequencePosition()
 * over the members that resolve, the list #5's series page shows, so the
 * two always agree.
 */
export function viewerPhotoOf(source: ViewerSource, slug: unknown, photoId: unknown): ViewerPhotoResult {
    const params = viewerParams(slug, photoId);
    if (params === null) return NOT_FOUND;
    const hit = source.seriesBySlug(params.slug);
    if (hit === null) return NOT_FOUND;
    const { series } = hit;
    if (!openableSeries(source, series)) return NOT_FOUND;
    const record = source.photo(params.photoId);
    if (record === null) return NOT_FOUND;
    const position = sequencePosition({ photoIds: source.photosOf(series.id).map((member) => member.id) }, record.id);
    if (position === null) return NOT_FOUND;
    if (!hit.canonical) {
        // The series page's rule: a 308 to a canonical slug the route refuses would point at a page that is always not-found.
        if (seriesParams(series.slug) === null) return NOT_FOUND;
        return { kind: 'redirect', slug: series.slug, photoId: record.id };
    }
    const image = viewerImageOf(record);
    return {
        kind: 'ok',
        viewer: {
            catalogRevision: source.revisionId,
            series: { id: series.id, slug: series.slug, title: series.title, accent: accent(series.accent) },
            photo: {
                id: record.id,
                title: text(record.title),
                ...described(record.alt, position.index + 1, position.total),
                caption: text(record.caption),
                // Compile never writes a bad set; a hand-written revision can. The Viewer never points outside the revision's derivatives.
                image,
                shareImage: image === null ? null : shareOf(record),
                accent: accent(record.accent),
                technical: technical(record.technical),
            },
            position: position.index + 1,
            total: position.total,
            previousPhotoId: position.previousPhotoId,
            nextPhotoId: position.nextPhotoId,
        },
    };
}

/** The parts of #13's ActiveCatalog that viewerPhotoFrom() reads. */
export type ViewerCatalog<Reason extends string = string> = ScreenCatalog<Pick<CatalogReader, 'getViewerPhoto'>, Reason>;

/**
 * The Viewer's answer for the site as it stands, for the route to call with
 * getActiveCatalog. Malformed params are not-found before `load` runs, so
 * they never read the catalog. A site with no active revision (legacy mode)
 * is not-found too, the same as an unknown photo. An unavailable catalog is
 * its own kind, for the route to throw CatalogUnavailableError. A degraded
 * catalog serves the last revision it loaded.
 */
export async function viewerPhotoFrom<Reason extends string>(
    load: () => Promise<ViewerCatalog<Reason>>,
    slug: unknown,
    photoId: unknown,
): Promise<ViewerPhotoResult | { kind: 'unavailable'; reason: Reason }> {
    const params = viewerParams(slug, photoId);
    if (params === null) return NOT_FOUND;
    const catalog = await load();
    if (catalog.mode === 'legacy') return NOT_FOUND;
    if (catalog.state === 'unavailable') return { kind: 'unavailable', reason: catalog.reason };
    return catalog.reader.getViewerPhoto(params.slug, params.photoId);
}

/**
 * A neighbor's photograph as the Viewer shows it peeking in beside the one
 * under the finger (9a): its set and the accent the Viewer paints its rules
 * with, nothing else. The Viewer asks for it only once a visitor touches the
 * photograph, so a first load still ships one photograph (#6).
 */
export interface ViewerPeek {
    revisionId: string;
    photoId: string;
    /** The same set the photo's own Viewer ships, or null when it has none, so the peek shows the missing-image state. */
    image: ViewerImage | null;
    /** The photo's accent, else the series', already checked as `#rrggbb`, or null. */
    accent: string | null;
}

export type ViewerPeekResult =
    | { kind: 'ok'; peek: ViewerPeek }
    /** Whatever the Viewer route answers not-found, and a former slug too: the Viewer only asks with the canonical one. */
    | { kind: 'not-found' }
    /** No `revision`, more than one, or a malformed one. */
    | { kind: 'bad-request' }
    /** The revision isn't the one being served, so the Viewer never peeks at a photo from another one. */
    | { kind: 'revision-changed' };

/** The peek of one Viewer answer: the set and the accent, field by field from the projection, which checked both. */
export function viewerPeekOf(viewer: PublishedViewerPhoto): ViewerPeek {
    return {
        revisionId: viewer.catalogRevision,
        photoId: viewer.photo.id,
        image: viewer.photo.image,
        accent: viewer.photo.accent ?? viewer.series.accent,
    };
}

/**
 * The peek endpoint's answer for the site as it stands, for
 * `/api/catalog/series/<slug>/photos/<photoId>?revision=<revisionId>`. As
 * homePhotosFrom() does: malformed params are not-found and a missing or
 * malformed revision a bad request, both before the catalog is read; legacy
 * mode is not-found; an unavailable catalog is unavailable, for a 503; a
 * revision other than the one served is revision-changed, checked before
 * the photo, so neither answer says whether a photo it doesn't publish
 * exists. Anything else is viewerPhotoOf()'s answer on the served revision,
 * so a peek is not-found exactly when the photo's Viewer is (a former slug
 * included, which the Viewer never asks with).
 */
export async function viewerPeekFrom<Reason extends string>(
    load: () => Promise<ScreenCatalog<Pick<CatalogReader, 'revision' | 'getViewerPhoto'>, Reason>>,
    slug: unknown,
    photoId: unknown,
    revisionId: string | null,
): Promise<ViewerPeekResult | { kind: 'unavailable'; reason: Reason }> {
    const params = viewerParams(slug, photoId);
    if (params === null) return { kind: 'not-found' };
    if (revisionId === null || !REVISION_ID_RE.test(revisionId)) return { kind: 'bad-request' };
    const catalog = await load();
    if (catalog.mode === 'legacy') return { kind: 'not-found' };
    if (catalog.state === 'unavailable') return { kind: 'unavailable', reason: catalog.reason };
    const { reader } = catalog;
    if (reader.revision().revisionId !== revisionId) return { kind: 'revision-changed' };
    const result = reader.getViewerPhoto(params.slug, params.photoId);
    if (result.kind !== 'ok') return { kind: 'not-found' };
    return { kind: 'ok', peek: viewerPeekOf(result.viewer) };
}
