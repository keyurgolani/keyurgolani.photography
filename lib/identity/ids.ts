import { createHash, randomUUID } from 'node:crypto';

/** `ph_` plus a lowercase UUID v4. Minted once and never derived from path, bytes, time, or position. */
export const PHOTO_ID_RE = /^ph_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** `sha256-` plus 64 lowercase hex of the source bytes, so a metadata edit is a new revision. */
export const ASSET_REVISION_RE = /^sha256-[0-9a-f]{64}$/;
/** `sha256-` over the oriented raw pixels, dimensions, and channels. */
export const PIXEL_DIGEST_RE = /^sha256-[0-9a-f]{64}$/;
/** `p_` plus 16 hex of a SHA-256 over a derivative recipe and the Sharp and libvips versions. */
export const PROFILE_ID_RE = /^p_[0-9a-f]{16}$/;

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Digests content, returning 64 lowercase hex. Injectable so tests can force
 * collisions. Profile IDs always use real SHA-256.
 */
export type Hasher = (chunks: readonly Uint8Array[]) => string;

export const sha256: Hasher = (chunks) => {
    const hash = createHash('sha256');
    for (const chunk of chunks) hash.update(chunk);
    return hash.digest('hex');
};

function digest(hasher: Hasher, chunks: readonly Uint8Array[]): string {
    const hex = hasher(chunks);
    if (!HEX_64.test(hex)) throw new Error(`The hasher returned ${JSON.stringify(hex)}, not 64 lowercase hex.`);
    return `sha256-${hex}`;
}

/** Mint a new photo ID from a UUID v4 source. */
export function mintPhotoId(idGen: () => string = randomUUID): string {
    const photoId = `ph_${idGen().toLowerCase()}`;
    if (!PHOTO_ID_RE.test(photoId)) throw new Error(`The ID generator returned a value that is not a UUID v4: ${photoId}`);
    return photoId;
}

/** A UUID that `name` alone decides, the same each time (RFC 9562 version 8, from SHA-256). */
export function namedUuid(name: string): string {
    const bytes = createHash('sha256').update(name, 'utf8').digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function assetRevisionOf(bytes: Uint8Array, hasher: Hasher = sha256): string {
    return digest(hasher, [bytes]);
}

export interface RawPixels {
    data: Uint8Array;
    width: number;
    height: number;
    channels: number;
}

/** Digest decoded, already-oriented pixels together with their shape, so a crop or rotation never matches. */
export function pixelDigestOf({ data, width, height, channels }: RawPixels, hasher: Hasher = sha256): string {
    const header = new TextEncoder().encode(`pixels:${width}x${height}x${channels}:${data.length}\n`);
    return digest(hasher, [header, data]);
}

function canonicalize(value: unknown): unknown {
    if (typeof value === 'string') return value.normalize('NFC');
    if (Array.isArray(value)) return value.map(canonicalize);
    if (typeof value !== 'object' || value === null) return value;
    const entries = Object.entries(value)
        .filter(([, inner]) => inner !== undefined)
        .map(([key, inner]): [string, unknown] => [key.normalize('NFC'), canonicalize(inner)])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries);
}

/**
 * JSON with object keys sorted at every level, array order kept, absent
 * optionals left out, strings and keys in NFC, and no whitespace, so equal
 * values always serialize the same way.
 */
export function canonicalJson(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

export function profileIdOf(recipe: unknown, versions: { sharp: string; vips: string }): string {
    const hex = createHash('sha256').update(canonicalJson({ recipe, sharp: versions.sharp, vips: versions.vips })).digest('hex');
    return `p_${hex.slice(0, 16)}`;
}
