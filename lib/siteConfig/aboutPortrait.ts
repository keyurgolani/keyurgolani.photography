import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp, { type Metadata } from 'sharp';
import { z } from 'zod';
import { currentProfileId } from '../identity/profile';
import { openRegularFile } from '../media/manifest';
import { servedFolderContaining } from '../storage/config';
import { hasErrorCode } from '../storage/fsx';
import { siteConfigDir } from './dir';

/**
 * About's portrait, read at run time from the site config folder
 * (lib/siteConfig/dir.ts), so the owner swaps it on the host without a
 * commit, a build, or a new image.
 *
 * The file is `about/portrait.jpg`, `.jpeg`, `.png`, or `.webp`, exactly one
 * of them, with an optional `about/portrait.json` beside it holding `alt` and
 * `focalPoint`. The names are fixed here: nothing a visitor sends picks a
 * path. The folder, `about/`, and each file must be what they look like: a
 * symlink at `about/` or at a file is refused, a file is opened without
 * following one, its bytes have to start with the magic of the format its
 * name says, and it has to fit PORTRAIT_LIMITS before Sharp decodes it.
 *
 * Each call stats the files and reads them again only when one changed, so a
 * swapped file shows on the next request, with no restart. A file that is
 * missing or refused gives `{ state: 'none' }`, and About renders its no-photo
 * layout. Every change of state logs one line naming the relative path and
 * the reason, never the folder's absolute path.
 */

export const PORTRAIT_DIR = 'about';
export const PORTRAIT_NAMES = ['portrait.jpg', 'portrait.jpeg', 'portrait.png', 'portrait.webp'] as const;
export const PORTRAIT_JSON = 'portrait.json';

export const PORTRAIT_LIMITS = {
    /** A 45 MP camera JPEG fits. A PNG that big rarely does, so export a JPEG. */
    maxBytes: 40 * 1024 * 1024,
    /** Either side, before orientation. */
    maxSide: 12_000,
    /** Width times height, which Sharp also enforces when it decodes. */
    maxPixels: 50_000_000,
    maxJsonBytes: 16 * 1024,
    maxAltLength: 1_000,
} as const;

export type PortraitFormat = 'jpeg' | 'png' | 'webp';

const FORMAT_BY_NAME: Record<(typeof PORTRAIT_NAMES)[number], PortraitFormat> = {
    'portrait.jpg': 'jpeg',
    'portrait.jpeg': 'jpeg',
    'portrait.png': 'png',
    'portrait.webp': 'webp',
};

export interface FocalPoint {
    /** Percent from the left, 0 to 100. */
    x: number;
    /** Percent from the top, 0 to 100. */
    y: number;
}

export type AboutPortraitState =
    | {
          state: 'ready';
          /** Relative to the site config folder, like `about/portrait.jpg`. */
          file: string;
          format: PortraitFormat;
          /** The source's SHA-256, hex. */
          sha256: string;
          /** The URL segment: the source and the derivative profile, hashed, so either changing gives new URLs. */
          token: string;
          /** Upright, after the EXIF orientation. */
          width: number;
          height: number;
          /** From portrait.json, or null for the page's default. */
          alt: string | null;
          focalPoint: FocalPoint | null;
      }
    | { state: 'none'; reason: string };

/** The URL token: 32 lowercase hex. */
export const PORTRAIT_TOKEN_RE = /^[0-9a-f]{32}$/;

export function portraitToken(sourceSha256: string, profileId: string = currentProfileId()): string {
    return createHash('sha256').update(`about-portrait\n${sourceSha256}\n${profileId}`).digest('hex').slice(0, 32);
}

const PortraitJson = z.strictObject({
    alt: z.string().trim().min(1).max(PORTRAIT_LIMITS.maxAltLength).optional(),
    focalPoint: z.strictObject({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) }).optional(),
});

type Logger = Pick<Console, 'log' | 'warn'>;

/** One read: the state, the key it's cached under, and whether portrait.json is older than the portrait. */
interface ReadResult {
    result: AboutPortraitState;
    key: string | null;
    staleJson?: boolean;
}

/** What was read last, by the stat signature of what it read. Shared through globalThis, since instrumentation and the routes are bundled apart. */
interface ReaderMemory {
    key: string | null;
    result: AboutPortraitState | null;
    /** The read under way, by the listing's key, so a burst of requests after a swap decodes the file once. */
    reading: { key: string; done: Promise<ReadResult> } | null;
    /** The last line logged for the portrait and for the JSON, so each is logged once per change, and the token the stale JSON was last logged for. */
    logged: { portrait: string | null; json: string | null; staleJson: string | null };
}

const MEMORY = Symbol.for('keyurgolani.photography.aboutPortrait.reader');

function memory(): ReaderMemory {
    const holder = globalThis as typeof globalThis & { [MEMORY]?: ReaderMemory };
    holder[MEMORY] ??= { key: null, result: null, reading: null, logged: { portrait: null, json: null, staleJson: null } };
    return holder[MEMORY];
}

/** Forget what was read and logged. For tests. */
export function resetAboutPortraitReader(): void {
    const state = memory();
    state.key = null;
    state.result = null;
    state.reading = null;
    state.logged = { portrait: null, json: null, staleJson: null };
}

const signature = (stats: fs.Stats | null) => (stats === null ? '-' : `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`);

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

async function lstatOrNull(target: string): Promise<fs.Stats | null> {
    try {
        return await fs.promises.lstat(/*turbopackIgnore: true*/ target);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return null;
        throw error;
    }
}

/** The format the bytes are, by their magic, or null. */
export function sniffFormat(bytes: Uint8Array): PortraitFormat | null {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length >= png.length && png.every((byte, index) => bytes[index] === byte)) return 'png';
    const ascii = (start: number, end: number) => Buffer.from(bytes.subarray(start, end)).toString('latin1');
    if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
    return null;
}

const PNG_IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

/**
 * Why the bytes stop short of the end their format writes, or null. A file
 * still being copied in place can decode before its last bytes land, so it
 * waits for a later request, which sees the new size and reads it again.
 * A JPEG's end isn't checked: a phone's motion photo and some cameras write
 * data after the end marker, and a JPEG cut short already fails the decode.
 */
export function incompleteReason(format: PortraitFormat, bytes: Uint8Array): string | null {
    if (format === 'png') {
        const tail = bytes.subarray(Math.max(0, bytes.length - PNG_IEND.length));
        return Buffer.from(tail).equals(PNG_IEND) ? null : "doesn't end with a PNG's IEND chunk, so it may still be copying";
    }
    if (format === 'webp') {
        const declared = bytes.length >= 8 ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).readUInt32LE(4) + 8 : -1;
        return declared === bytes.length ? null : `is ${bytes.length} bytes, but its RIFF header says ${declared}, so it may still be copying`;
    }
    return null;
}

/** What the folder holds now, without reading any file. */
type Listing =
    | { kind: 'problem'; reason: string }
    | { kind: 'files'; dir: string; name: (typeof PORTRAIT_NAMES)[number]; file: fs.Stats; json: fs.Stats | null };

async function list(): Promise<Listing> {
    const root = siteConfigDir();
    let rootStats: fs.Stats;
    try {
        rootStats = await fs.promises.stat(/*turbopackIgnore: true*/ root);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return { kind: 'problem', reason: 'the site config folder does not exist' };
        return { kind: 'problem', reason: `the site config folder can't be read (${(error as NodeJS.ErrnoException).code ?? 'error'})` };
    }
    if (!rootStats.isDirectory()) return { kind: 'problem', reason: 'the site config folder is not a folder' };
    // Next serves public/ as is, metadata and all, and the library scan would put a portrait there on Home.
    if (servedFolderContaining(root) !== null) return { kind: 'problem', reason: "the site config folder is inside the app's public folder or the photo library, so it isn't read" };

    const dir = path.join(/*turbopackIgnore: true*/ root, PORTRAIT_DIR);
    const dirStats = await lstatOrNull(dir);
    if (dirStats === null) return { kind: 'problem', reason: `${PORTRAIT_DIR}/ does not exist` };
    if (dirStats.isSymbolicLink()) return { kind: 'problem', reason: `${PORTRAIT_DIR}/ is a symlink, which isn't followed` };
    if (!dirStats.isDirectory()) return { kind: 'problem', reason: `${PORTRAIT_DIR} is not a folder` };
    // The folder itself may be reached through a symlink, as a mount can be, but nothing below it.
    const [realRoot, realDir] = await Promise.all([fs.promises.realpath(/*turbopackIgnore: true*/ root), fs.promises.realpath(/*turbopackIgnore: true*/ dir)]);
    if (realDir !== path.join(/*turbopackIgnore: true*/ realRoot, PORTRAIT_DIR)) return { kind: 'problem', reason: `${PORTRAIT_DIR}/ resolves outside the site config folder` };

    const entries = await fs.promises.readdir(/*turbopackIgnore: true*/ dir);
    const found = PORTRAIT_NAMES.filter((name) => entries.includes(name));
    if (found.length > 1) {
        return { kind: 'problem', reason: `there are ${found.length} portraits, ${found.map((name) => `${PORTRAIT_DIR}/${name}`).join(' and ')}. Keep one` };
    }
    if (found.length === 0) {
        const miscased = entries.find((entry) => /^portrait\.(jpe?g|png|webp)$/i.test(entry));
        if (miscased) return { kind: 'problem', reason: `${PORTRAIT_DIR}/${miscased} has to be named in lower case, like ${PORTRAIT_DIR}/${miscased.toLowerCase()}` };
        return { kind: 'problem', reason: `there is no ${PORTRAIT_DIR}/portrait.jpg, .jpeg, .png, or .webp` };
    }
    const [name] = found;
    const file = await lstatOrNull(path.join(/*turbopackIgnore: true*/ dir, name));
    if (file === null) return { kind: 'problem', reason: `${PORTRAIT_DIR}/${name} went away while it was read` };
    return { kind: 'files', dir, name, file, json: await lstatOrNull(path.join(/*turbopackIgnore: true*/ dir, PORTRAIT_JSON)) };
}

/** Read a fixed file without following a symlink, refusing one over `maxBytes`. */
async function readCapped(file: string, maxBytes: number): Promise<{ bytes: Buffer; stats: fs.Stats } | { problem: string }> {
    let opened: Awaited<ReturnType<typeof openRegularFile>>;
    try {
        opened = await openRegularFile(file);
    } catch (error) {
        return { problem: `can't be read (${(error as NodeJS.ErrnoException).code ?? 'error'})` };
    }
    if (opened === null) return { problem: "isn't a regular file" };
    try {
        const stats = await opened.handle.stat();
        if (stats.size > maxBytes) return { problem: `is ${megabytes(stats.size)}, over the ${megabytes(maxBytes)} limit` };
        const bytes = await opened.handle.readFile();
        if (bytes.length !== stats.size) return { problem: 'changed while it was read' };
        return { bytes, stats };
    } finally {
        await opened.handle.close();
    }
}

/** portrait.json, or why it's ignored. Missing is fine. */
async function readJson(dir: string, stats: fs.Stats | null): Promise<{ alt: string | null; focalPoint: FocalPoint | null; problem?: string }> {
    const none = { alt: null, focalPoint: null };
    const name = `${PORTRAIT_DIR}/${PORTRAIT_JSON}`;
    if (stats === null) return none;
    if (stats.isSymbolicLink()) return { ...none, problem: `${name} is a symlink, which isn't followed` };
    const read = await readCapped(path.join(/*turbopackIgnore: true*/ dir, PORTRAIT_JSON), PORTRAIT_LIMITS.maxJsonBytes);
    if ('problem' in read) return { ...none, problem: `${name} ${read.problem}` };
    let value: unknown;
    try {
        value = JSON.parse(read.bytes.toString('utf8'));
    } catch {
        return { ...none, problem: `${name} is not valid JSON` };
    }
    const parsed = PortraitJson.safeParse(value);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue.path.length > 0 ? issue.path.join('.') : 'it';
        const what = issue.code === 'unrecognized_keys' ? `has an unknown field ${issue.keys.map((key) => JSON.stringify(key)).join(', ')}` : `has an invalid ${where}`;
        return { ...none, problem: `${name} ${what}. It takes "alt", a string, and "focalPoint", { "x": 0 to 100, "y": 0 to 100 }` };
    }
    return { alt: parsed.data.alt ?? null, focalPoint: parsed.data.focalPoint ?? null };
}

/** Validate the portrait's bytes: magic, the name's format, header dimensions, then one small decode. */
async function inspect(name: (typeof PORTRAIT_NAMES)[number], bytes: Buffer): Promise<{ width: number; height: number } | { problem: string }> {
    const expected = FORMAT_BY_NAME[name];
    const sniffed = sniffFormat(bytes);
    if (sniffed === null) return { problem: "isn't a JPEG, PNG, or WebP file" };
    if (sniffed !== expected) return { problem: `holds ${sniffed.toUpperCase()} data, but its name says ${expected.toUpperCase()}` };
    const incomplete = incompleteReason(expected, bytes);
    if (incomplete !== null) return { problem: incomplete };
    let metadata: Metadata;
    try {
        metadata = await sharp(bytes, { limitInputPixels: false }).metadata();
    } catch {
        return { problem: "can't be read as an image" };
    }
    const { width, height, format } = metadata;
    if (format !== expected) return { problem: `decodes as ${format}, but its name says ${expected}` };
    if (!width || !height) return { problem: 'has no dimensions' };
    if (width > PORTRAIT_LIMITS.maxSide || height > PORTRAIT_LIMITS.maxSide) return { problem: `is ${width} x ${height} px, over the ${PORTRAIT_LIMITS.maxSide} px limit on a side` };
    if (width * height > PORTRAIT_LIMITS.maxPixels) return { problem: `is ${((width * height) / 1e6).toFixed(1)} megapixels, over the ${PORTRAIT_LIMITS.maxPixels / 1e6} megapixel limit` };
    try {
        // A whole decode, shrunk, with the encoder's own strictness, so a truncated or corrupt file is refused here rather than on a visitor's request.
        await sharp(bytes, { limitInputPixels: PORTRAIT_LIMITS.maxPixels }).resize(64, 64, { fit: 'inside' }).raw().toBuffer();
    } catch {
        return { problem: "can't be decoded" };
    }
    const turned = (metadata.orientation ?? 1) >= 5;
    return turned ? { width: height, height: width } : { width, height };
}

async function readState(listing: Extract<Listing, { kind: 'files' }>, logger: Logger): Promise<ReadResult> {
    const relative = `${PORTRAIT_DIR}/${listing.name}`;
    if (listing.file.isSymbolicLink()) return { result: { state: 'none', reason: `${relative} is a symlink, which isn't followed` }, key: null };
    if (!listing.file.isFile()) return { result: { state: 'none', reason: `${relative} isn't a regular file` }, key: null };
    if (listing.file.size > PORTRAIT_LIMITS.maxBytes) {
        return { result: { state: 'none', reason: `${relative} is ${megabytes(listing.file.size)}, over the ${megabytes(PORTRAIT_LIMITS.maxBytes)} limit` }, key: keyOf(listing) };
    }
    const read = await readCapped(path.join(/*turbopackIgnore: true*/ listing.dir, listing.name), PORTRAIT_LIMITS.maxBytes);
    if ('problem' in read) return { result: { state: 'none', reason: `${relative} ${read.problem}` }, key: null };
    // Keyed on what was opened, so a file swapped between the listing and the open is read again next time.
    const key = keyOf({ ...listing, file: read.stats });
    const size = await inspect(listing.name, read.bytes);
    if ('problem' in size) return { result: { state: 'none', reason: `${relative} ${size.problem}` }, key };
    const json = await readJson(listing.dir, listing.json);
    logOnce('json', json.problem ? `[about] ${json.problem}, so About uses the default alt text and a centered crop.` : null, logger);
    const sha256 = createHash('sha256').update(read.bytes).digest('hex');
    // A photo swapped without its portrait.json keeps the old alt text and crop.
    const staleJson = !json.problem && listing.json !== null && listing.json.mtimeMs < read.stats.mtimeMs;
    return {
        result: { state: 'ready', file: relative, format: FORMAT_BY_NAME[listing.name], sha256, token: portraitToken(sha256), ...size, alt: json.alt, focalPoint: json.focalPoint },
        key,
        staleJson,
    };
}

function keyOf(listing: Extract<Listing, { kind: 'files' }>): string {
    return `${siteConfigDir()}\0${listing.name}\0${signature(listing.file)}\0${signature(listing.json)}`;
}

function logOnce(channel: 'portrait' | 'json', line: string | null, logger: Logger, level: 'log' | 'warn' = 'warn'): void {
    const state = memory();
    if (state.logged[channel] === line) return;
    state.logged[channel] = line;
    if (line !== null) logger[level](line);
}

/**
 * About's portrait as the site config folder holds it now. Stats on every
 * call and reads only on a change. Never throws: anything unexpected is a
 * `none` with its reason, so About renders its no-photo layout instead of a 500.
 */
export async function readAboutPortrait({ logger = console }: { logger?: Logger } = {}): Promise<AboutPortraitState> {
    const state = memory();
    let result: AboutPortraitState;
    let staleJson = false;
    try {
        const listing = await list();
        if (listing.kind === 'problem') {
            state.key = null;
            result = { state: 'none', reason: listing.reason };
        } else {
            const key = keyOf(listing);
            if (state.key === key && state.result !== null) return state.result;
            if (state.reading?.key !== key) {
                const reading = { key, done: readState(listing, logger) };
                state.reading = reading;
                // Cleared once settled, unless a newer read took its place.
                void reading.done.finally(() => {
                    if (state.reading === reading) state.reading = null;
                }).catch(() => undefined);
            }
            const read = await state.reading.done;
            state.key = read.key;
            result = read.result;
            staleJson = read.staleJson === true;
        }
    } catch (error) {
        state.key = null;
        result = { state: 'none', reason: `the portrait can't be read (${(error as NodeJS.ErrnoException).code ?? 'an unexpected error'})` };
    }
    state.result = result;
    if (result.state === 'ready') {
        logOnce('portrait', `[about] About shows ${result.file}, ${result.width} x ${result.height} px, sha256 ${result.sha256.slice(0, 12)}.`, logger, 'log');
        if (staleJson && state.logged.staleJson !== result.token) {
            state.logged.staleJson = result.token;
            logger.warn(`[about] ${PORTRAIT_DIR}/${PORTRAIT_JSON} is older than ${result.file}, so its alt text and crop may describe the previous photo. Update it for this one, or remove it.`);
        }
    } else {
        logOnce('json', null, logger);
        logOnce('portrait', `[about] No portrait: ${result.reason}, so About shows the name instead.`, logger);
    }
    return result;
}

/** At server start: read the portrait once, which logs what About shows and why. */
export async function checkAboutPortrait(options: { logger?: Logger } = {}): Promise<void> {
    await readAboutPortrait(options);
}

/** The source bytes for `token`, read again and checked against it, or null once the file holds something else. */
export async function readPortraitSource(token: string): Promise<Buffer | null> {
    const current = await readAboutPortrait();
    if (current.state !== 'ready' || current.token !== token) return null;
    const read = await readCapped(path.join(/*turbopackIgnore: true*/ siteConfigDir(), current.file), PORTRAIT_LIMITS.maxBytes).catch(() => null);
    if (read === null || 'problem' in read) return null;
    return createHash('sha256').update(read.bytes).digest('hex') === current.sha256 ? read.bytes : null;
}
