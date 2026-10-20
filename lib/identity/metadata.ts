import exifReader from 'exif-reader';
import { mediaUrl } from '../media/url';
import type { AssetManifest, PhotoRecord } from './types';
import { VARIANT_FORMATS, VARIANT_WIDTHS, type VariantFormat, type VariantWidth } from './variants';

export { VARIANT_FORMATS, VARIANT_WIDTHS, type VariantFormat, type VariantWidth } from './variants';

/**
 * Metadata tiers. Extraction is an allowlist: only the fields named here are
 * ever read out of EXIF, so serial numbers, owner names, MakerNote,
 * UserComment, HostComputer, Software, ImageUniqueID, XMP, IPTC, and the
 * embedded thumbnail are never stored. Nothing here derives a caption, alt
 * text, or description; those are authored.
 */

/** Bump when extraction changes, so stored values say which rules produced them. */
export const EXTRACTOR_VERSION = 1;

export const TECHNICAL_KEYS = ['Make', 'Model', 'LensModel', 'FocalLength', 'FNumber', 'ExposureTime', 'ISO'] as const;
export type TechnicalKey = (typeof TECHNICAL_KEYS)[number];

/** A stored value and where it came from, such as `exif:Photo.ISOSpeedRatings`. */
export interface Provenanced<T> {
    value: T;
    source: string;
}

/** Public facts, safe for visitors. */
export interface DerivedMetadata {
    extractorVersion: number;
    technical: Partial<Record<TechnicalKey, Provenanced<string>>>;
    /** `YYYY-MM-DD` from DateTimeOriginal, null without one. */
    capturedDate: Provenanced<string> | null;
}

export interface GpsPosition {
    latitude: number;
    longitude: number;
    altitude?: number;
}

/** Facts for the curator only. GPS may feed #14's suggestions but never reaches a visitor. */
export interface CuratorOnlyMetadata {
    extractorVersion: number;
    /** DateTimeOriginal to the second, with OffsetTimeOriginal when the camera recorded one. */
    dateTimeOriginal?: Provenanced<string>;
    gps?: Provenanced<GpsPosition>;
    artist?: Provenanced<string>;
    copyright?: Provenanced<string>;
}

export interface MetadataTiers {
    derived: DerivedMetadata;
    curatorOnly: CuratorOnlyMetadata;
}

export interface PublicVariant {
    url: string;
    width: number;
    height: number;
    bytes: number;
}

/** What a visitor may see about one asset revision. */
export interface PublicAssetProjection {
    photoId: string;
    assetRevision: string;
    profileId: string;
    width: number;
    height: number;
    lqip: string;
    variants: Record<VariantWidth, Record<VariantFormat, PublicVariant>>;
    technical: Partial<Record<TechnicalKey, string>>;
    capturedDate: string | null;
}

/** The parsed EXIF shape exif-reader returns: IFD name to tag name to value. */
export type ParsedExif = Partial<Record<'Image' | 'Photo' | 'GPSInfo', Record<string, unknown> | null>>;

export function emptyTiers(): MetadataTiers {
    return {
        derived: { extractorVersion: EXTRACTOR_VERSION, technical: {}, capturedDate: null },
        curatorOnly: { extractorVersion: EXTRACTOR_VERSION },
    };
}

const MAX_TEXT = 200;

function text(value: unknown): string | undefined {
    let raw: string;
    if (typeof value === 'string') raw = value;
    else if (value instanceof Uint8Array) raw = Buffer.from(value).toString('utf8');
    else return undefined;
    // eslint-disable-next-line no-control-regex
    const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned && cleaned.length <= MAX_TEXT ? cleaned : undefined;
}

function positive(value: unknown): number | undefined {
    const first = Array.isArray(value) ? (value as unknown[])[0] : value;
    return typeof first === 'number' && Number.isFinite(first) && first > 0 ? first : undefined;
}

function decimal(value: number): string {
    return String(Number(value.toFixed(2)));
}

/** 1/200 for fractions of a second that are a whole reciprocal, else a decimal such as 0.3 or 2. */
function exposureTime(seconds: number): string {
    if (seconds >= 1) return decimal(seconds);
    const reciprocal = Math.round(1 / seconds);
    return Math.abs(1 / seconds - reciprocal) / reciprocal < 0.02 ? `1/${reciprocal}` : decimal(seconds);
}

/** exif-reader turns `YYYY:MM:DD HH:MM:SS` into a Date holding that wall-clock time as UTC. */
function wallClock(value: unknown): string | undefined {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) return undefined;
    // A zeroed "0000:00:00 00:00:00", which some cameras write, parses as 1899-11-30.
    const year = value.getUTCFullYear();
    if (year < 1900 || year > 2200) return undefined;
    return value.toISOString().slice(0, 19);
}

function dmsToDegrees(dms: unknown, ref: unknown, positiveRef: string, negativeRef: string, max: number): number | undefined {
    const parts = Array.isArray(dms) ? (dms as unknown[]) : [dms];
    const [degrees, minutes = 0, seconds = 0] = parts;
    if (![degrees, minutes, seconds].every((part) => typeof part === 'number' && Number.isFinite(part) && part >= 0)) return undefined;
    const magnitude = (degrees as number) + (minutes as number) / 60 + (seconds as number) / 3600;
    if (magnitude > max) return undefined;
    const direction = text(ref)?.toUpperCase();
    if (direction !== positiveRef && direction !== negativeRef) return undefined;
    return Number((direction === negativeRef ? -magnitude : magnitude).toFixed(6));
}

function gpsPosition(gps: Record<string, unknown>): GpsPosition | undefined {
    const latitude = dmsToDegrees(gps.GPSLatitude, gps.GPSLatitudeRef, 'N', 'S', 90);
    const longitude = dmsToDegrees(gps.GPSLongitude, gps.GPSLongitudeRef, 'E', 'W', 180);
    if (latitude === undefined || longitude === undefined) return undefined;
    const position: GpsPosition = { latitude, longitude };
    const altitude = gps.GPSAltitude;
    if (typeof altitude === 'number' && Number.isFinite(altitude) && altitude >= 0) {
        position.altitude = Number((gps.GPSAltitudeRef === 1 ? -altitude : altitude).toFixed(2));
    }
    return position;
}

/** Sort parsed EXIF into the public and curator-only tiers. Exported for parsed-EXIF fixtures. */
export function tiersFromParsedExif(parsed: ParsedExif | null): MetadataTiers {
    const tiers = emptyTiers();
    if (!parsed) return tiers;
    const image = parsed.Image ?? {};
    const photo = parsed.Photo ?? {};
    const { technical } = tiers.derived;

    const make = text(image.Make);
    if (make) technical.Make = { value: make, source: 'exif:Image.Make' };
    const model = text(image.Model);
    if (model) technical.Model = { value: model, source: 'exif:Image.Model' };
    const lens = text(photo.LensModel);
    if (lens) technical.LensModel = { value: lens, source: 'exif:Photo.LensModel' };
    const focal = positive(photo.FocalLength);
    if (focal !== undefined) technical.FocalLength = { value: decimal(focal), source: 'exif:Photo.FocalLength' };
    const fNumber = positive(photo.FNumber);
    if (fNumber !== undefined) technical.FNumber = { value: decimal(fNumber), source: 'exif:Photo.FNumber' };
    const exposure = positive(photo.ExposureTime);
    if (exposure !== undefined) technical.ExposureTime = { value: exposureTime(exposure), source: 'exif:Photo.ExposureTime' };
    const iso = positive(photo.ISOSpeedRatings);
    if (iso !== undefined) technical.ISO = { value: String(Math.round(iso)), source: 'exif:Photo.ISOSpeedRatings' };

    const original = wallClock(photo.DateTimeOriginal);
    if (original) {
        tiers.derived.capturedDate = { value: original.slice(0, 10), source: 'exif:Photo.DateTimeOriginal' };
        const offset = text(photo.OffsetTimeOriginal);
        const withOffset = offset && /^[+-]\d{2}:\d{2}$/.test(offset) ? `${original}${offset}` : original;
        tiers.curatorOnly.dateTimeOriginal = {
            value: withOffset,
            source: withOffset === original ? 'exif:Photo.DateTimeOriginal' : 'exif:Photo.DateTimeOriginal+OffsetTimeOriginal',
        };
    }
    if (parsed.GPSInfo) {
        const position = gpsPosition(parsed.GPSInfo);
        if (position) tiers.curatorOnly.gps = { value: position, source: 'exif:GPSInfo' };
    }
    const artist = text(image.Artist);
    if (artist) tiers.curatorOnly.artist = { value: artist, source: 'exif:Image.Artist' };
    const copyright = text(image.Copyright);
    if (copyright) tiers.curatorOnly.copyright = { value: copyright, source: 'exif:Image.Copyright' };
    return tiers;
}

/** Extract the tiers from a raw EXIF block, as Sharp's metadata() returns it. Unparseable EXIF yields empty tiers. */
export function extractMetadataTiers(exif: Uint8Array | undefined | null): MetadataTiers {
    if (!exif || exif.length === 0) return emptyTiers();
    let parsed: ParsedExif;
    try {
        parsed = exifReader(Buffer.from(exif)) as ParsedExif;
    } catch {
        return emptyTiers();
    }
    return tiersFromParsedExif(parsed);
}

/**
 * Project one ready revision for visitors: dimensions, the LQIP, every
 * variant's `/media` URL, the allowlisted technical fields, and the capture
 * date. Never paths, curator-only facts, or anything else in the registry.
 */
export function toPublicAsset(photo: PhotoRecord, assetRevision: string, profileId: string, manifest: AssetManifest): PublicAssetProjection {
    const revision = photo.revisions[assetRevision];
    if (!revision || revision.reassignedTo) throw new Error(`${assetRevision} is not a revision of ${photo.photoId}`);
    if (manifest.photoId !== photo.photoId || manifest.assetRevision !== assetRevision || manifest.profileId !== profileId) {
        throw new Error(`The manifest is for ${manifest.photoId}/${manifest.assetRevision}/${manifest.profileId}, not ${photo.photoId}/${assetRevision}/${profileId}`);
    }
    if (revision.width === null || revision.height === null) throw new Error(`${photo.photoId}/${assetRevision} has no decoded dimensions`);

    const ref = { photoId: photo.photoId, assetRevision, profileId };
    const variants = {} as Record<VariantWidth, Record<VariantFormat, PublicVariant>>;
    for (const width of VARIANT_WIDTHS) {
        const formats = {} as Record<VariantFormat, PublicVariant>;
        for (const format of VARIANT_FORMATS) {
            const file = manifest.variants[width][format];
            formats[format] = { url: mediaUrl(ref, width, format), width: file.width, height: file.height, bytes: file.bytes };
        }
        variants[width] = formats;
    }

    const technical: Partial<Record<TechnicalKey, string>> = {};
    for (const key of TECHNICAL_KEYS) {
        const entry = revision.derived.technical[key];
        if (entry) technical[key] = entry.value;
    }

    return {
        photoId: photo.photoId,
        assetRevision,
        profileId,
        width: revision.width,
        height: revision.height,
        lqip: manifest.lqip,
        variants,
        technical,
        capturedDate: revision.derived.capturedDate?.value ?? null,
    };
}
