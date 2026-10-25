// The web process and the tests import this, never the CLI or a client
// module. A client bundle that reaches it fails the build (#3).
import 'server-only';
import { PHOTO_ID_RE } from '../../identity/ids';
import { TECHNICAL_KEYS, type TechnicalKey } from '../../identity/metadata';
import type { VariantFormat, VariantWidth } from '../../identity/variants';
import { sequencePosition } from '../order';
import type { CatalogContent, CatalogReader } from '../reader';
import { MAX_SLUG_LENGTH, SLUG_RE } from '../schema';
import type { SeriesRecord } from '../types';
import { ladderOf, type Ladder, type LadderVariant } from './ladder';

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

/** One variant file, as `/media` serves it and a `srcset` names it. */
export type ViewerVariant = LadderVariant;

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
 * The shape the revision schema checks, checked again because ResponsivePhoto
 * puts it in a CSS `url()`. The same check as #4's Home projection; one
 * shared helper once both land.
 */
const LQIP_RE = /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * The route params when both are well formed: a series slug in #13's shape
 * and a photo ID in #10's. Exact, so a letter-case variant fails. Nothing
 * here reads the catalog, and a param never reaches a path.
 */
export function viewerParams(slug: unknown, photoId: unknown): { slug: string; photoId: string } | null {
    if (typeof slug !== 'string' || typeof photoId !== 'string') return null;
    if (slug.length > MAX_SLUG_LENGTH || !SLUG_RE.test(slug)) return null;
    if (!PHOTO_ID_RE.test(photoId)) return null;
    return { slug, photoId };
}

/** Authored text only when it holds something. */
function text(value: unknown): string | null {
    return typeof value === 'string' && /\S/.test(value) ? value : null;
}

const dimension = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

function accent(value: unknown): string | null {
    return typeof value === 'string' && ACCENT_RE.test(value) ? value : null;
}


/**
 * The description, from the alt alone. Pending means a `pending` alt or blank
 * described text. The candidate carries no `reviewed` flag, so an unreviewed
 * suggestion reads as the description here; `description.required` stops it
 * at publish.
 */
function described(alt: Photo['alt']): Pick<PublishedViewerPhoto['photo'], 'description' | 'alt' | 'descriptionPending'> {
    if (alt.kind === 'decorative') return { description: null, alt: '', descriptionPending: false };
    const description = alt.kind === 'described' ? text(alt.text) : null;
    if (description === null) return { description: null, alt: '', descriptionPending: true };
    return { description, alt: description, descriptionPending: false };
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
 * The photo's set when the photo has positive integer dimensions and its
 * ladder is usable (see ladderOf(), the same check Home, Work, and Series
 * use), else null. ladderOf() copies field by field, so the Viewer gets only
 * what the set names and a caller can't edit the cached revision through it.
 */
function imageOf(photo: Photo): ViewerImage | null {
    if (!dimension(photo.width) || !dimension(photo.height)) return null;
    const variants = ladderOf(photo);
    if (variants === null) return null;
    const image: ViewerImage = { width: photo.width, height: photo.height, assetRevision: photo.assetRevision, variants };
    if (typeof photo.lqip === 'string' && LQIP_RE.test(photo.lqip)) image.lqip = photo.lqip;
    return image;
}

/** The share image: the 1200 px WebP, a published `/media` variant whose path carries the asset revision. */
const SHARE_WIDTH: VariantWidth = 'w1200';
const SHARE_FORMAT: VariantFormat = 'webp';

/** The share file, field by field, for a photo whose set imageOf() accepted, so every field is already checked. */
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
 * guards, copied, so a photo URL is not-found exactly when its series page
 * is, and #3's Work never links either. A photo without positive dimensions
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
    // Work and the series page leave out a series ID that appears more than once, so the Viewer does too.
    if (source.listSeries().filter((entry) => entry.id === series.id).length !== 1) return NOT_FOUND;
    if (!dimension(series.derived?.photoCount)) return NOT_FOUND;
    const record = source.photo(params.photoId);
    if (record === null) return NOT_FOUND;
    // Membership also covers the series page's other guard, a series with no member that resolves.
    const position = sequencePosition({ photoIds: source.photosOf(series.id).map((member) => member.id) }, record.id);
    if (position === null) return NOT_FOUND;
    if (!hit.canonical) {
        // The series page's rule: a 308 to a canonical slug the route refuses would point at a page that is always not-found.
        if (viewerParams(series.slug, record.id) === null) return NOT_FOUND;
        return { kind: 'redirect', slug: series.slug, photoId: record.id };
    }
    const image = imageOf(record);
    return {
        kind: 'ok',
        viewer: {
            catalogRevision: source.revisionId,
            series: { id: series.id, slug: series.slug, title: series.title, accent: accent(series.accent) },
            photo: {
                id: record.id,
                title: text(record.title),
                ...described(record.alt),
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

/**
 * The parts of #13's ActiveCatalog that viewerPhotoFrom() reads, so this
 * module stays clear of the server-only public reader.
 */
export type ViewerCatalog<Reason extends string = string> =
    | { mode: 'legacy' }
    | { mode: 'catalog'; state: 'ok' | 'degraded'; reader: Pick<CatalogReader, 'getViewerPhoto'> }
    | { mode: 'catalog'; state: 'unavailable'; reason: Reason };

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
