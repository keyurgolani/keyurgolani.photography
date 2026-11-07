import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_FOLDER, DERIVATIVE_FOLDERS } from '../derivativeFolders.mjs';
import { atomicWriteFile } from '../storage/atomicWrite';
import { hasErrorCode, PRIVATE_DIR_MODE } from '../storage/fsx';
import { LibraryRootMissingError, scanLibrary, SOURCE_EXTENSIONS, UNSUPPORTED_EXTENSIONS } from './scan';

/**
 * `photos legacy-derivatives` (#15, v2.0.0 A12): the manifest that says which
 * of the legacy folders a watcher before v1.7.0 wrote may move out of the
 * library, for scripts/host/legacy-move-aside.sh. Those folders carry no
 * marker of their own, and a name is never enough: on a case-insensitive disk
 * `medium` is also the owner's `Medium` album. So this reads the library,
 * read-only, and records only folders whose every file is one the v1.x
 * pipeline wrote for an original the scan sees at the library root, by name,
 * header and size. Its one write is `status/legacy-derivatives.json` in the
 * data root. It never writes the library.
 */

export const LEGACY_MANIFEST_SCHEMA_VERSION = 1;

/** The eight names, in lib/derivativeFolders.mjs's order. */
export const LEGACY_NAMES: readonly string[] = [...Object.keys(DERIVATIVE_FOLDERS), CACHE_FOLDER];

/** The widest output the v1.x pipeline wrote in each folder: it resized to fit inside these, never enlarging. */
const MAX_WIDTH: Readonly<Record<string, number>> = {
    thumbnails: 400,
    medium: 800,
    optimized: 1920,
    'thumbnails-avif': 400,
    'medium-avif': 800,
    'optimized-avif': 1920,
};

/** The removed /api/image route's cache: `cache/dynamic/<base>-<width>-<quality>.<format>`, at these widths. */
const CACHE_WIDTHS = new Set([400, 800, 1200, 1920]);
const CACHE_FILE = /^(.+)-(\d+)-(\d+)\.(webp|avif)$/;
const CACHE_DYNAMIC = 'dynamic';
/** Where the v1.x pipeline recorded each set's source: `cache/set-sources/<base>.json`. */
const CACHE_SET_SOURCES = 'set-sources';
const CACHE_SUBFOLDERS: ReadonlySet<string> = new Set([CACHE_DYNAMIC, CACHE_SET_SOURCES]);

/** The marker the v1.6 watcher wrote once per library after turning orientation-tagged photos upright. */
const CACHE_UPRIGHT = 'upright-rebuild.json';
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

/** How much of a file the header checks read. A set record is far smaller. */
const HEAD_BYTES = 64 * 1024;

/** The ruling's words for a folder whose files name originals that sit in series folders, not at the root. */
export const NESTED_REASON = 'its originals are nested, so nothing vouches for it';

/** Every extension the scan reads as an original, supported or not. */
const ORIGINAL_EXTENSIONS: ReadonlySet<string> = new Set([...SOURCE_EXTENSIONS, ...UNSUPPORTED_EXTENSIONS]);

export interface LegacyFile {
    /** Relative to the folder, POSIX, exactly as on disk. */
    path: string;
    size: number;
    /** Whole seconds since the epoch, as stat's st_mtime. */
    mtime: number;
}

export type LegacyFolder =
    | { name: string; moves: true; files: LegacyFile[]; dirs: string[] }
    | { name: string; moves: false; reason: string };

export interface LegacyManifest {
    schemaVersion: typeof LEGACY_MANIFEST_SCHEMA_VERSION;
    writtenAt: string;
    /** The library root's device and inode, as decimal strings. */
    library: { dev: string; ino: string };
    /** Only the names the library's root holds exactly, case-sensitively, in LEGACY_NAMES order. */
    folders: LegacyFolder[];
}

export function legacyManifestFile(dataRoot: string): string {
    return path.join(/*turbopackIgnore: true*/ dataRoot, 'status', 'legacy-derivatives.json');
}

/** Control characters as `?`, so no name in a reason reaches a terminal raw. */
export function clean(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}

/** A file name without its extension, as the legacy pipeline named a source's derivatives. */
function baseOf(name: string): string {
    return path.posix.basename(name, path.posix.extname(name));
}

/** The originals the scan sees: base names at the root, those in series folders, and the root ones by their NFC form. */
interface Originals {
    root: ReadonlySet<string>;
    nested: ReadonlySet<string>;
    rootByNfc: ReadonlyMap<string, string>;
}

/** Why `base` names no original at the root, or null when it names one exactly. */
function baseReason(shown: string, base: string, originals: Originals): string | null {
    if (originals.root.has(base)) return null;
    const sameForm = originals.rootByNfc.get(base.normalize('NFC'));
    if (sameForm !== undefined) return `${shown} names ${sameForm} in another Unicode form (NFC and NFD differ), so it isn't that original's`;
    if (originals.nested.has(base)) return NESTED_REASON;
    return `${shown} names no original (${base})`;
}

async function head(file: string): Promise<Buffer> {
    const handle = await fs.promises.open(/*turbopackIgnore: true*/ file, 'r');
    try {
        const buffer = Buffer.alloc(HEAD_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

/** A WebP's width from its first chunk, or null when the bytes aren't a WebP. */
export function webpWidth(bytes: Buffer): number | null {
    if (bytes.length < 30 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') return null;
    const chunk = bytes.toString('latin1', 12, 16);
    if (chunk === 'VP8 ') return bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a ? bytes.readUInt16LE(26) & 0x3fff : null;
    if (chunk === 'VP8L') return bytes[20] === 0x2f ? 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]) : null;
    if (chunk === 'VP8X') return 1 + bytes.readUIntLE(24, 3);
    return null;
}

/** An AVIF's width from its `ispe` property, or null when the bytes aren't an AVIF. */
export function avifWidth(bytes: Buffer): number | null {
    if (bytes.length < 16 || bytes.toString('latin1', 4, 8) !== 'ftyp') return null;
    const ftypSize = Math.min(bytes.readUInt32BE(0), bytes.length);
    const brands = [bytes.toString('latin1', 8, 12)];
    for (let at = 16; at + 4 <= ftypSize; at += 4) brands.push(bytes.toString('latin1', at, at + 4));
    if (!brands.includes('avif') && !brands.includes('avis')) return null;
    const ispe = bytes.indexOf('ispe', ftypSize, 'latin1');
    return ispe < 0 || ispe + 12 > bytes.length ? null : bytes.readUInt32BE(ispe + 8);
}

/** Why an image the pipeline would have written at most `max` px wide isn't one, or null when its header says it is. */
function imageReason(shown: string, bytes: Buffer, format: 'webp' | 'avif', max: number): string | null {
    const width = format === 'webp' ? webpWidth(bytes) : avifWidth(bytes);
    if (width === null) return `${shown} isn't a valid ${format === 'webp' ? 'WebP' : 'AVIF'} file`;
    if (width < 1 || width > max) return `${shown} is ${width} px wide, and the pipeline wrote it at most ${max} px wide`;
    return null;
}

/** Why `relative`, inside folder `name`, isn't a file the v1.x pipeline wrote for a root original, or null when it is one. */
async function notDerivative(top: string, name: string, relative: string, originals: Originals): Promise<string | null> {
    const shown = `${name}/${relative}`;
    const extension = path.posix.extname(relative).toLowerCase();
    const file = path.join(/*turbopackIgnore: true*/ top, relative);
    if (name === CACHE_FOLDER) {
        if (relative === CACHE_UPRIGHT) {
            // Exactly v1.6.0's writeUprightMarker(): {rebuiltAt, photos, retry?}, retry only when it lists something.
            let marker: unknown;
            try {
                marker = JSON.parse((await head(file)).toString('utf8'));
            } catch {
                marker = null;
            }
            const record = marker as { rebuiltAt?: unknown; photos?: unknown; retry?: unknown } | null;
            const valid = typeof marker === 'object' && marker !== null && !Array.isArray(marker)
                && Object.keys(marker).every((key) => key === 'rebuiltAt' || key === 'photos' || key === 'retry')
                && typeof record?.rebuiltAt === 'string' && ISO_TIME.test(record.rebuiltAt)
                && Number.isInteger(record.photos) && (record.photos as number) >= 0
                && (record.retry === undefined || (Array.isArray(record.retry) && record.retry.length > 0 && record.retry.every((entry) => typeof entry === 'string')));
            return valid ? null : `${shown} isn't the marker the v1.x pipeline wrote`;
        }
        const [folder, entry, ...deeper] = relative.split('/');
        if (deeper.length > 0 || entry === undefined || !CACHE_SUBFOLDERS.has(folder)) return `${shown} isn't in ${CACHE_FOLDER}/${CACHE_DYNAMIC}/ or ${CACHE_FOLDER}/${CACHE_SET_SOURCES}/, where the v1.x pipeline wrote`;
        if (folder === CACHE_SET_SOURCES) {
            if (!entry.endsWith('.json') || entry.startsWith('.')) return `${shown} isn't a set record the v1.x pipeline wrote`;
            const base = entry.slice(0, -'.json'.length);
            const why = baseReason(shown, base, originals);
            if (why !== null) return why;
            let record: unknown;
            try {
                record = JSON.parse((await head(file)).toString('utf8'));
            } catch {
                return `${shown} isn't a set record the v1.x pipeline wrote`;
            }
            const valid = typeof record === 'object' && record !== null && !Array.isArray(record)
                && Object.keys(record).every((key) => key === 'source' || key === 'complete')
                && typeof (record as { source?: unknown }).source === 'string'
                && baseOf((record as { source: string }).source) === base
                && ['undefined', 'boolean'].includes(typeof (record as { complete?: unknown }).complete);
            return valid ? null : `${shown} isn't a set record the v1.x pipeline wrote`;
        }
        const match = CACHE_FILE.exec(entry);
        if (match === null) {
            return ORIGINAL_EXTENSIONS.has(extension) && extension !== '.webp'
                ? `${shown} has an original's extension`
                : `${shown} isn't named as the old image route's cache named its files`;
        }
        const [, base, width, quality] = match;
        if (!CACHE_WIDTHS.has(Number(width)) || Number(quality) < 1 || Number(quality) > 100) return `${shown} isn't named as the old image route's cache named its files`;
        const why = baseReason(shown, base, originals);
        if (why !== null) return why;
        return imageReason(shown, await head(file), match[4] as 'webp' | 'avif', Number(width));
    }
    const own = (DERIVATIVE_FOLDERS as Record<string, string>)[name];
    if (ORIGINAL_EXTENSIONS.has(extension) && extension !== own) return `${shown} has an original's extension`;
    if (!relative.endsWith(own) || relative.length === own.length) return `${shown} isn't a ${own} file named for an original`;
    const why = baseReason(shown, relative.slice(0, -own.length), originals);
    if (why !== null) return why;
    const bytes = await head(file);
    if (own === '.txt') return bytes.toString('latin1', 0, 11) === 'data:image/' ? null : `${shown} doesn't start with data:image/, as a v1.x placeholder does`;
    return imageReason(shown, bytes, own === '.webp' ? 'webp' : 'avif', MAX_WIDTH[name]);
}

/** What one exactly-named root entry is: a folder that moves, with its full listing, or one that stays, and why. */
async function judgeFolder(library: string, name: string, originals: Originals): Promise<LegacyFolder> {
    const stays = (reason: string): LegacyFolder => ({ name, moves: false, reason: clean(reason) });
    const top = path.join(/*turbopackIgnore: true*/ library, name);
    const stat = await fs.promises.lstat(/*turbopackIgnore: true*/ top);
    if (stat.isSymbolicLink()) return stays(`${name} is a symlink`);
    if (!stat.isDirectory()) return stays(`${name} isn't a folder`);

    const files: LegacyFile[] = [];
    const dirs: string[] = [];
    const pending = [''];
    while (pending.length > 0) {
        const relativeDir = pending.pop() as string;
        let names: string[];
        try {
            names = await fs.promises.readdir(/*turbopackIgnore: true*/ path.join(top, relativeDir));
        } catch (error) {
            return stays(`${path.posix.join(name, relativeDir)} can't be read (${hasErrorCode(error, 'EACCES', 'EPERM') ? 'permission denied' : 'an error'})`);
        }
        for (const entry of names) {
            const relative = relativeDir === '' ? entry : `${relativeDir}/${entry}`;
            const shown = `${name}/${relative}`;
            let entryStat: fs.BigIntStats;
            try {
                entryStat = await fs.promises.lstat(/*turbopackIgnore: true*/ path.join(top, relative), { bigint: true });
            } catch {
                return stays(`${shown} can't be read`);
            }
            if (entryStat.isSymbolicLink()) return stays(`${shown} is a symlink`);
            if (entryStat.isDirectory()) {
                if (name === CACHE_FOLDER && CACHE_SUBFOLDERS.has(relative)) {
                    dirs.push(relative);
                    pending.push(relative);
                    continue;
                }
                return stays(`${shown} is a folder, and only ${CACHE_FOLDER}/${CACHE_DYNAMIC}/ and ${CACHE_FOLDER}/${CACHE_SET_SOURCES}/ may be one`);
            }
            if (!entryStat.isFile()) return stays(`${shown} isn't a regular file`);
            let reason: string | null;
            try {
                reason = await notDerivative(top, name, relative, originals);
            } catch {
                reason = `${shown} can't be read`;
            }
            if (reason !== null) return stays(reason);
            files.push({ path: relative, size: Number(entryStat.size), mtime: Number(entryStat.mtimeNs / BigInt(1_000_000_000)) });
        }
    }
    if (files.length === 0) return stays(`${name} holds no derivative`);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { name, moves: true, files, dirs: dirs.sort() };
}

/**
 * Read the library and judge each of the eight names its root holds exactly.
 * Reads only: readdir, lstat and the first bytes of files on the library,
 * and the identity scan.
 */
export async function buildLegacyManifest(library: string, { clock = Date.now }: { clock?: () => number } = {}): Promise<LegacyManifest> {
    let root: fs.BigIntStats;
    try {
        root = await fs.promises.stat(/*turbopackIgnore: true*/ library, { bigint: true });
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) throw new LibraryRootMissingError(library);
        throw error;
    }
    if (!root.isDirectory()) throw new LibraryRootMissingError(library);
    const scan = await scanLibrary(library, { clock });
    const sources = scan.entries.filter((entry) => entry.kind === 'source');
    const rootBases = sources.filter((entry) => !entry.path.includes('/')).map((entry) => baseOf(entry.path));
    const originals: Originals = {
        root: new Set(rootBases),
        nested: new Set(sources.filter((entry) => entry.path.includes('/')).map((entry) => baseOf(entry.path))),
        rootByNfc: new Map(rootBases.map((base) => [base.normalize('NFC'), base])),
    };
    // A real listing, so `Medium` is never taken for `medium`, as a stat of a constructed path would on a case-insensitive disk.
    const present = new Set(await fs.promises.readdir(/*turbopackIgnore: true*/ library));
    const folders: LegacyFolder[] = [];
    for (const name of LEGACY_NAMES) {
        if (present.has(name)) folders.push(await judgeFolder(library, name, originals));
    }
    return {
        schemaVersion: LEGACY_MANIFEST_SCHEMA_VERSION,
        writtenAt: new Date(clock()).toISOString(),
        library: { dev: String(root.dev), ino: String(root.ino) },
        folders,
    };
}

/**
 * The manifest file's text. The manifest itself is a JSON string inside it,
 * so its digest covers exact bytes that the script, in perl, can check
 * without re-serializing anything.
 */
export function sealLegacyManifest(manifest: LegacyManifest): string {
    const body = JSON.stringify(manifest);
    const digest = `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
    return `${JSON.stringify({ schemaVersion: LEGACY_MANIFEST_SCHEMA_VERSION, digest, manifest: body }, null, 2)}\n`;
}

export class LegacyManifestRefusedError extends Error {}

/**
 * Write `status/legacy-derivatives.json` atomically, mode 0644 so a copy can
 * be read, creating `status/` for its owner only. Refuses a `status/` that
 * is a symlink or not a folder, before writing anything.
 */
export async function writeLegacyManifest(dataRoot: string, manifest: LegacyManifest): Promise<string> {
    const file = legacyManifestFile(dataRoot);
    const status = path.dirname(file);
    let stat: fs.Stats | undefined;
    try {
        stat = await fs.promises.lstat(/*turbopackIgnore: true*/ status);
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) throw error;
    }
    if (stat === undefined) {
        try {
            await fs.promises.mkdir(/*turbopackIgnore: true*/ status, { mode: PRIVATE_DIR_MODE });
        } catch (error) {
            if (!hasErrorCode(error, 'EEXIST')) throw error;
        }
        stat = await fs.promises.lstat(/*turbopackIgnore: true*/ status);
    }
    if (stat.isSymbolicLink()) throw new LegacyManifestRefusedError("The data root's status/ is a symlink, so the manifest could land anywhere.");
    if (!stat.isDirectory()) throw new LegacyManifestRefusedError("The data root's status/ isn't a folder.");
    await atomicWriteFile(file, sealLegacyManifest(manifest), { mode: 0o644 });
    return file;
}

/** One line per folder, for the owner: what moves and what stays, and why. */
export function legacyManifestLines(manifest: LegacyManifest): string[] {
    if (manifest.folders.length === 0) return ['None of the eight legacy folders is at the top of the library, by its exact name. Nothing will move.'];
    return manifest.folders.map((folder) => clean(folder.moves
        ? `  ${folder.name} moves aside: ${folder.files.length} ${folder.files.length === 1 ? 'file' : 'files'}`
        : `  ${folder.name} stays: ${folder.reason}`));
}

/**
 * `photos legacy-derivatives [--stdout]`: build the manifest and write it.
 * With `stdout`, the manifest itself is the output, for the owner to save a
 * copy he can read, and the summary goes to `summary`.
 */
export async function runLegacyDerivativesCommand(
    { dataRoot, library, clock = Date.now, stdout = false }: { dataRoot: string; library: string; clock?: () => number; stdout?: boolean },
): Promise<{ exitCode: 0 | 1; output: string; summary: string }> {
    const manifest = await buildLegacyManifest(library, { clock });
    try {
        await writeLegacyManifest(dataRoot, manifest);
    } catch (error) {
        if (error instanceof LegacyManifestRefusedError) return { exitCode: 1, output: `[photos] ${error.message} Nothing was written.\n`, summary: '' };
        throw error;
    }
    const lines = [
        'The legacy folders at the top of the library, by exact name:',
        ...legacyManifestLines(manifest),
        '',
        'Wrote status/legacy-derivatives.json in the data root, and nothing else. The library was only read.',
        'It holds for 24 hours and one --apply. Save it with --stdout, then give that copy to scripts/host/legacy-move-aside.sh with --manifest, dry run first, as the README\'s "Moving the legacy derivatives aside" shows.',
    ];
    const summary = `${lines.join('\n')}\n`;
    return stdout ? { exitCode: 0, output: sealLegacyManifest(manifest), summary } : { exitCode: 0, output: summary, summary };
}
