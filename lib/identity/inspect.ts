import fs from 'node:fs';
import path from 'node:path';
import sharp, { type Metadata } from 'sharp';
import { assetRevisionOf, pixelDigestOf, sha256, type Hasher } from './ids';
import { extractMetadataTiers, type CuratorOnlyMetadata, type DerivedMetadata } from './metadata';
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
 * orientation, and sort its metadata into tiers.
 */
export async function inspectEntry(root: string, entry: ScanEntry, { hasher = sha256 }: { hasher?: Hasher } = {}): Promise<Inspection> {
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
        metadata = await sharp(bytes).metadata();
    } catch {
        metadata = null;
    }
    const tiers = extractMetadataTiers(metadata?.exif);
    const sourceFormat = metadata?.format ?? FORMAT_BY_EXTENSION[path.extname(entry.path).toLowerCase()] ?? 'unknown';

    try {
        // The pixels as stored. Without keepIccProfile() Sharp converts them to sRGB first, so a copy whose profile
        // was stripped would hash differently from its original.
        const { data, info } = await sharp(bytes).autoOrient().keepIccProfile().raw().toBuffer({ resolveWithObject: true });
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
