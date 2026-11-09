import fs from 'node:fs';
import path from 'node:path';
import sharp, { type Metadata } from 'sharp';
import { assetRevisionOf, pixelDigestOf, sha256, type Hasher } from './ids';
import { extractMetadataTiers, type CuratorOnlyMetadata, type DerivedMetadata } from './metadata';
import { MAX_SOURCE_PIXELS } from './profile';
import type { ScanEntry } from './scan';

export interface ImageInspection {
    kind: 'image';
    assetRevision: string;
    sourceBytes: number;
    /** Null when the file can't be decoded. Such a file matches by bytes only. */
    pixelDigest: string | null;
    sourceFormat: string;
    width: number | null;
    height: number | null;
    orientation: number | null;
    derived: DerivedMetadata;
    curatorOnly: CuratorOnlyMetadata;
    decodeError?: string;
}

export interface UnsupportedInspection {
    kind: 'unsupported';
    assetRevision: string;
    sourceBytes: number;
}

export interface UnreadableInspection {
    kind: 'unreadable';
    error: string;
}

/** The file changed while it was read. It waits like a just-written file. */
export interface ChangedInspection {
    kind: 'changed';
}

export type Inspection = ImageInspection | UnsupportedInspection | UnreadableInspection | ChangedInspection;

const FORMAT_BY_EXTENSION: Record<string, string> = { '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.webp': 'webp' };

function errorText(error: unknown): string {
    if (typeof error === 'object' && error !== null && typeof (error as NodeJS.ErrnoException).code === 'string') {
        return (error as NodeJS.ErrnoException).code as string;
    }
    return error instanceof Error ? error.message : String(error);
}

/**
 * Read a scanned file once: digest its bytes, then for an image decode it
 * upright to digest its pixels, record its oriented dimensions and raw
 * orientation, and sort its metadata into tiers. A6 review: a file whose
 * header says it is over `maxPixels` (MAX_SOURCE_PIXELS) is never decoded.
 * It keeps its header's size and no pixel digest, so it matches by bytes
 * only, and its build fails as `too-large`. Every raw decode gets the cap as
 * `limitInputPixels`.
 */
export async function inspectEntry(root: string, entry: ScanEntry, { hasher = sha256, maxPixels = MAX_SOURCE_PIXELS }: { hasher?: Hasher; maxPixels?: number } = {}): Promise<Inspection> {
    const absolute = path.join(root, entry.path);
    let bytes: Buffer;
    try {
        bytes = await fs.promises.readFile(absolute);
    } catch (error) {
        return { kind: 'unreadable', error: errorText(error) };
    }
    try {
        // The stat cache's signature. ctime catches an in-place rewrite that kept the size and restored the mtime.
        const after = await fs.promises.lstat(absolute);
        if (bytes.length !== entry.size || after.size !== entry.size || after.mtimeMs !== entry.mtimeMs ||
            after.ctimeMs !== entry.ctimeMs || after.ino !== entry.ino) {
            return { kind: 'changed' };
        }
    } catch {
        return { kind: 'changed' };
    }

    const assetRevision = assetRevisionOf(bytes, hasher);
    if (entry.kind === 'unsupported') return { kind: 'unsupported', assetRevision, sourceBytes: bytes.length };

    let metadata: Metadata | null = null;
    try {
        // The header only: Sharp reads no pixels for metadata(), so the cap can wait for the size it gives.
        metadata = await sharp(bytes, { limitInputPixels: false }).metadata();
    } catch {
        metadata = null;
    }
    const tiers = extractMetadataTiers(metadata?.exif);
    const sourceFormat = metadata?.format ?? FORMAT_BY_EXTENSION[path.extname(entry.path).toLowerCase()] ?? 'unknown';

    if (metadata?.width && metadata.height && metadata.width * metadata.height > maxPixels) {
        const turned = (metadata.orientation ?? 1) >= 5;
        return {
            kind: 'image',
            assetRevision,
            sourceBytes: bytes.length,
            pixelDigest: null,
            sourceFormat,
            width: turned ? metadata.height : metadata.width,
            height: turned ? metadata.width : metadata.height,
            orientation: metadata.orientation ?? null,
            ...tiers,
            decodeError: `too-large: ${metadata.width}x${metadata.height} is over the ${maxPixels}-pixel cap`,
        };
    }

    try {
        // The pixels as stored. Without keepIccProfile() Sharp converts them to sRGB first, so a copy whose profile
        // was stripped would hash differently from its original. A CMYK JPEG is the exception: Sharp converts it to
        // sRGB whatever the flag, so its digest is of the converted pixels.
        const { data, info } = await sharp(bytes, { limitInputPixels: maxPixels }).autoOrient().keepIccProfile().raw().toBuffer({ resolveWithObject: true });
        return {
            kind: 'image',
            assetRevision,
            sourceBytes: bytes.length,
            pixelDigest: pixelDigestOf({ data, width: info.width, height: info.height, channels: info.channels }, hasher),
            sourceFormat,
            width: info.width,
            height: info.height,
            orientation: metadata?.orientation ?? null,
            ...tiers,
        };
    } catch (error) {
        return {
            kind: 'image',
            assetRevision,
            sourceBytes: bytes.length,
            pixelDigest: null,
            sourceFormat,
            width: null,
            height: null,
            orientation: null,
            ...tiers,
            decodeError: error instanceof Error ? error.message : String(error),
        };
    }
}
