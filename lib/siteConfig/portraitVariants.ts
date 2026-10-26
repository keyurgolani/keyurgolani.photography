import sharp from 'sharp';
import { encodeVariant, variantWidthFor } from '../identity/profile';
import { VARIANT_FILE_RE, VARIANT_FORMATS, VARIANT_PIXELS, VARIANT_WIDTHS, type VariantFormat, type VariantWidth } from '../identity/variants';
import { PORTRAIT_LIMITS, PORTRAIT_TOKEN_RE, readAboutPortrait, readPortraitSource, type AboutPortraitState, type FocalPoint } from './aboutPortrait';

/**
 * About's portrait derivatives: the same widths and formats as a `/media`
 * set, encoded by profile 1's encoder (upright, never enlarged, no EXIF, GPS,
 * XMP, or IPTC), kept in memory, never written to disk. They're served at
 * `/about/portrait/<token>/<variant>.<format>`, where the token hashes the
 * source and the profile, so a URL only ever names one file's pixels and can
 * be `immutable`.
 *
 * A token's set is encoded in the background the first time it's seen, one
 * variant at a time, most-requested first, from one read of the source. A
 * request for a variant waits for its own. Only the current token and the
 * one before it are kept, so a page rendered just before a swap still loads.
 */

type Logger = Pick<Console, 'warn'>;

/** The order a set encodes in: the widths a 1x to 3x screen asks for most, AVIF before WebP. */
const ENCODE_ORDER: VariantWidth[] = ['w1200', 'w800', 'w1920', 'w400'];

/** How many tokens' sets stay in memory. */
const KEPT_SETS = 2;

type PortraitSet = Map<string, Promise<Buffer | null>>;

const SETS = Symbol.for('keyurgolani.photography.aboutPortrait.sets');

function sets(): Map<string, PortraitSet> {
    const holder = globalThis as typeof globalThis & { [SETS]?: Map<string, PortraitSet> };
    holder[SETS] ??= new Map();
    return holder[SETS];
}

/** Drop every kept set. For tests. */
export function resetPortraitVariants(): void {
    sets().clear();
}

/** The bytes Sharp reports metadata for, which the encoder must never have kept. */
async function carriesMetadata(data: Buffer): Promise<boolean> {
    const metadata = await sharp(data).metadata();
    return Boolean(metadata.exif || metadata.xmp || metadata.iptc);
}

/** Encode `token`'s set. `onUnread` runs when the source no longer holds the token's bytes, so nothing is worth keeping. */
function startSet(token: string, logger: Logger, onUnread: () => void): PortraitSet {
    const set: PortraitSet = new Map();
    // Held only by the variants still to encode, so the bytes are let go once the last one is out.
    const source = readPortraitSource(token);
    void source.then((bytes) => {
        if (bytes === null) onUnread();
    });
    let previous: Promise<unknown> = source;
    for (const width of ENCODE_ORDER) {
        for (const format of VARIANT_FORMATS) {
            const name = `${width}.${format}`;
            const encoded = previous.then(async () => {
                const bytes = await source;
                if (bytes === null) return null;
                try {
                    const data = await encodeVariant(bytes, width, format, { limitInputPixels: PORTRAIT_LIMITS.maxPixels });
                    if (await carriesMetadata(data)) {
                        logger.warn(`[about] The portrait's ${name} kept metadata, so it isn't served.`);
                        return null;
                    }
                    return data;
                } catch (error) {
                    logger.warn(`[about] The portrait's ${name} couldn't be encoded: ${(error as Error).message}`);
                    return null;
                }
            });
            set.set(name, encoded);
            previous = encoded;
        }
    }
    return set;
}

/** The set for `token`, started if it's the current portrait's and not kept yet. Null for any other token. */
function setFor(token: string, current: AboutPortraitState, logger: Logger): PortraitSet | null {
    const kept = sets();
    const existing = kept.get(token);
    if (existing) return existing;
    if (current.state !== 'ready' || current.token !== token) return null;
    // A source that changed before it was read gives nothing to keep, so a later request reads it again.
    const set = startSet(token, logger, () => {
        if (kept.get(token) === set) kept.delete(token);
    });
    kept.set(token, set);
    while (kept.size > KEPT_SETS) kept.delete(kept.keys().next().value as string);
    return set;
}

/** Start encoding the current portrait's set, if there is one, so the first visitor after a start or a swap doesn't wait. */
export async function warmPortraitVariants({ logger = console }: { logger?: Logger } = {}): Promise<void> {
    const current = await readAboutPortrait();
    if (current.state === 'ready') setFor(current.token, current, logger);
}

/** One variant's bytes, or null when the token isn't the current or the kept portrait's, or it couldn't be encoded. */
export async function portraitVariant(token: string, variant: VariantWidth, format: VariantFormat, { logger = console }: { logger?: Logger } = {}): Promise<Buffer | null> {
    if (!PORTRAIT_TOKEN_RE.test(token)) return null;
    const set = setFor(token, await readAboutPortrait(), logger);
    if (set === null) return null;
    return (await set.get(`${variant}.${format}`)) ?? null;
}

/** The URL of one variant. */
export function portraitUrl(token: string, variant: VariantWidth, format: VariantFormat): string {
    if (!PORTRAIT_TOKEN_RE.test(token)) throw new Error(`Invalid portrait token: ${token}`);
    return `/about/portrait/${token}/${variant}.${format}`;
}

/** What ResponsivePhoto reads: the upright size and every variant's URL and pixel width. */
export interface PortraitAsset {
    width: number;
    height: number;
    variants: Record<VariantWidth, Record<VariantFormat, { url: string; width: number }>>;
}

export function portraitAsset(portrait: Extract<AboutPortraitState, { state: 'ready' }>): PortraitAsset {
    const variants = {} as PortraitAsset['variants'];
    for (const width of VARIANT_WIDTHS) {
        const pixels = variantWidthFor(portrait.width, portrait.height, VARIANT_PIXELS[width]);
        variants[width] = { avif: { url: portraitUrl(portrait.token, width, 'avif'), width: pixels }, webp: { url: portraitUrl(portrait.token, width, 'webp'), width: pixels } };
    }
    return { width: portrait.width, height: portrait.height, variants };
}

/** What About renders for its portrait. */
export interface AboutPortraitView {
    asset: PortraitAsset;
    alt: string;
    focalPoint: FocalPoint;
}

/** The alt text when portrait.json gives none. */
export const defaultPortraitAlt = (name: string) => `Portrait of ${name}`;

/**
 * About's portrait as the page renders it, or null for the no-photo layout:
 * portrait.json's alt, or one from the artist's name, and its focal point, or
 * the center. Starts the set's encoding, so its variants are ready sooner.
 */
export async function aboutPortraitView(name: string, { logger = console }: { logger?: Pick<Console, 'log' | 'warn'> } = {}): Promise<AboutPortraitView | null> {
    const portrait = await readAboutPortrait({ logger });
    if (portrait.state !== 'ready') return null;
    setFor(portrait.token, portrait, logger);
    return { asset: portraitAsset(portrait), alt: portrait.alt ?? defaultPortraitAlt(name), focalPoint: portrait.focalPoint ?? { x: 50, y: 50 } };
}

const IMMUTABLE = 'public, max-age=31536000, immutable';

function notFound(): Response {
    return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export interface PortraitRouteContext {
    params: Promise<{ token: string; variant: string }>;
}

/**
 * `GET /about/portrait/<token>/<variant>.<format>`. Anything but the current
 * or kept portrait's token, or a variant file name other than the ten `/media`
 * uses, is a `no-store` 404. A hit is `immutable`, since its URL changes with
 * the source.
 */
export function createPortraitHandler({ logger = console }: { logger?: Logger } = {}): (request: Request, context: PortraitRouteContext) => Promise<Response> {
    return async (request, { params }) => {
        const { token, variant } = await params;
        const match = VARIANT_FILE_RE.exec(variant);
        if (!PORTRAIT_TOKEN_RE.test(token) || !match) return notFound();
        const width = `w${match[1]}` as VariantWidth;
        const format = match[2] as VariantFormat;
        const etag = `"${token}-${width}-${format}"`;
        const headers = { 'Cache-Control': IMMUTABLE, ETag: etag, 'X-Content-Type-Options': 'nosniff' };
        const data = await portraitVariant(token, width, format, { logger });
        if (data === null) return notFound();
        const ifNoneMatch = request.headers.get('if-none-match');
        if (ifNoneMatch !== null && ifNoneMatch.split(',').some((tag) => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag)) {
            return new Response(null, { status: 304, headers });
        }
        return new Response(data as Uint8Array<ArrayBuffer>, { status: 200, headers: { ...headers, 'Content-Type': `image/${format}`, 'Content-Length': String(data.length) } });
    };
}
