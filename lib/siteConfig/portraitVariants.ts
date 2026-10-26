import sharp from 'sharp';
import { encodeVariant, variantWidthFor } from '../identity/profile';
import { VARIANT_FILE_RE, VARIANT_FORMATS, VARIANT_PIXELS, VARIANT_WIDTHS, type VariantFormat, type VariantWidth } from '../identity/variants';
import { PORTRAIT_LIMITS, PORTRAIT_TOKEN_RE, readAboutPortrait, readPortraitSource, type AboutPortraitState, type FocalPoint } from './aboutPortrait';

/**
 * About's portrait derivatives: the same widths and formats as a `/media`
 * set, encoded by profile 1's encoder (upright, never enlarged, no EXIF, GPS,
 * XMP, IPTC, or ICC profile), kept in memory, never written to disk. They're
 * served at `/about/portrait/<token>/<variant>.<format>`, where the token
 * hashes the source and the profile, so a URL only ever names one file's
 * pixels and can be `immutable`.
 *
 * Only the current portrait's token is served. Once the file is removed,
 * refused, or swapped, its old URLs are a `no-store` 404 on the next request
 * and its set is dropped, so a photo taken down stops answering at once. A
 * page rendered just before a swap shows the name panel until it's reloaded.
 *
 * The set is encoded in the background the first time its token is seen,
 * one variant at a time, most-requested first, from one read of the source.
 * A request for a variant waits for its own. A variant that fails to encode
 * is a 404 and is tried again by a later request, after a wait that doubles
 * from ENCODE_RETRY.firstMs up to ENCODE_RETRY.maxMs, so a file that always
 * fails can't keep the encoder busy.
 */

type Logger = Pick<Console, 'warn'>;

/** The order a set encodes in: the widths a 1x to 3x screen asks for most, AVIF before WebP. */
const ENCODE_ORDER: VariantWidth[] = ['w1200', 'w800', 'w1920', 'w400'];

/** How long a variant that failed to encode waits before a request tries it again: doubling from `firstMs`, never over `maxMs`. */
export const ENCODE_RETRY = { firstMs: 10_000, maxMs: 10 * 60_000 } as const;

interface PortraitSet {
    token: string;
    variants: Map<string, Promise<Buffer | null>>;
    /** Variants whose last encode failed, waiting for `retryAt`. */
    failed: Set<string>;
    /** Retries so far, for the wait before the next one. */
    retries: number;
    retryAt: number;
}

interface Kept {
    /** The current portrait's set, or null. Never another token's. */
    set: PortraitSet | null;
    /** The token whose encode failure was logged, so a failing file logs once, not once a retry. */
    loggedFailure: string | null;
    /** The last encode queued. Every encode runs after it, one at a time across sets. */
    queue: Promise<unknown>;
}

const SETS = Symbol.for('keyurgolani.photography.aboutPortrait.sets');

function kept(): Kept {
    const holder = globalThis as typeof globalThis & { [SETS]?: Kept };
    holder[SETS] ??= { set: null, loggedFailure: null, queue: Promise.resolve() };
    return holder[SETS];
}

/** Drop the kept set and what was logged, once the encodes under way are done. For tests. */
export async function resetPortraitVariants(): Promise<void> {
    const state = kept();
    state.set = null;
    await state.queue;
    state.loggedFailure = null;
}

/** Whether Sharp reports metadata in the bytes, which the encoder must never have kept. */
async function carriesMetadata(data: Buffer): Promise<boolean> {
    const metadata = await sharp(data).metadata();
    return Boolean(metadata.exif || metadata.xmp || metadata.iptc || metadata.icc || metadata.tifftagPhotoshop || (metadata.comments && metadata.comments.length > 0));
}

/** A variant that failed: 404 until `retryAt`, then the next request for it encodes it again. */
function failed(set: PortraitSet, name: string, reason: string, logger: Logger): null {
    set.failed.add(name);
    set.retryAt = Date.now() + Math.min(ENCODE_RETRY.firstMs * 2 ** set.retries, ENCODE_RETRY.maxMs);
    const state = kept();
    if (state.loggedFailure !== set.token) {
        state.loggedFailure = set.token;
        logger.warn(`[about] The portrait's ${name} ${reason}, so it isn't served. A later request tries it again.`);
    }
    return null;
}

/** Queue `names` to encode into `set`, from one read of its source. */
function encodeInto(set: PortraitSet, names: string[], logger: Logger): void {
    // Held only by the variants still to encode, so the bytes are let go once the last one is out.
    const source = readPortraitSource(set.token);
    void source.then((bytes) => {
        // The source changed before it was read: nothing is worth keeping, so a later request reads it again.
        if (bytes === null && kept().set === set) kept().set = null;
    });
    let previous: Promise<unknown> = kept().queue.then(() => source);
    for (const name of names) {
        const [width, format] = name.split('.') as [VariantWidth, VariantFormat];
        const encoded = previous.then(async () => {
            const bytes = await source;
            // A set dropped since, by a swap or a removal, encodes nothing more.
            if (bytes === null || kept().set !== set) return null;
            try {
                const data = await encodeVariant(bytes, width, format, { limitInputPixels: PORTRAIT_LIMITS.maxPixels });
                if (await carriesMetadata(data)) return failed(set, name, 'kept metadata', logger);
                return data;
            } catch (error) {
                return failed(set, name, `couldn't be encoded (${(error as Error).message})`, logger);
            }
        });
        set.variants.set(name, encoded);
        previous = encoded;
    }
    kept().queue = previous.catch(() => undefined);
}

/** Start `token`'s set. */
function startSet(token: string, logger: Logger): PortraitSet {
    const set: PortraitSet = { token, variants: new Map(), failed: new Set(), retries: 0, retryAt: 0 };
    encodeInto(
        set,
        ENCODE_ORDER.flatMap((width) => VARIANT_FORMATS.map((format) => `${width}.${format}`)),
        logger,
    );
    return set;
}

/**
 * The set for `token` while it's the current portrait's, started if it isn't
 * yet. Null for any other token. A kept set that's no longer current, since
 * the file was removed, refused, or swapped, is dropped here.
 */
function setFor(token: string | null, current: AboutPortraitState, logger: Logger): PortraitSet | null {
    const state = kept();
    const currentToken = current.state === 'ready' ? current.token : null;
    if (state.set !== null && state.set.token !== currentToken) state.set = null;
    if (currentToken === null || currentToken !== token) return null;
    state.set ??= startSet(currentToken, logger);
    return state.set;
}

/** Start encoding the current portrait's set, if there is one, so the first visitor after a start or a swap doesn't wait. */
export async function warmPortraitVariants({ logger = console }: { logger?: Logger } = {}): Promise<void> {
    const current = await readAboutPortrait();
    if (current.state === 'ready') setFor(current.token, current, logger);
}

/** One variant's bytes, or null when the token isn't the current portrait's, or the variant couldn't be encoded. */
export async function portraitVariant(token: string, variant: VariantWidth, format: VariantFormat, { logger = console }: { logger?: Logger } = {}): Promise<Buffer | null> {
    if (!PORTRAIT_TOKEN_RE.test(token)) return null;
    const set = setFor(token, await readAboutPortrait(), logger);
    if (set === null) return null;
    const name = `${variant}.${format}`;
    if (set.failed.has(name) && Date.now() >= set.retryAt) {
        const names = [...set.failed];
        set.failed.clear();
        set.retries += 1;
        encodeInto(set, names, logger);
    }
    const data = (await set.variants.get(name)) ?? null;
    if (data === null) return null;
    // The file can be removed or swapped while a variant encodes. Check again, so nothing answers for it after.
    return setFor(token, await readAboutPortrait(), logger) === set ? data : null;
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
    // Also drops a set that's no longer current, so a removed photo's bytes don't wait for the next variant request.
    setFor(portrait.state === 'ready' ? portrait.token : null, portrait, logger);
    if (portrait.state !== 'ready') return null;
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
 * portrait's token, or a variant file name other than the ten `/media`
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
