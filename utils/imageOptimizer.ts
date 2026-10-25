import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { CACHE_FOLDER, DERIVATIVE_FOLDERS } from '../lib/derivativeFolders.mjs';
import { foldName } from '../lib/foldName';
import { keyOf } from '../lib/identity/scan';
import { libraryRoot } from '../lib/storage/config';
import { hasErrorCode } from '../lib/storage/fsx';

/** A derivative folder's name under the library root, such as `thumbnails-avif`. */
type DerivativeFolder = keyof typeof DERIVATIVE_FOLDERS;

/** `thumbnails-avif` as `thumbnailsAvif`: a folder's key in LibraryPaths. */
type KeyOf<Folder extends string> = Folder extends `${infer Head}-${infer Tail}` ? `${Head}${Capitalize<KeyOf<Tail>>}` : Folder;

type DerivativeDir = KeyOf<DerivativeFolder>;

/** The derivative folders in the order the pipeline writes them. */
const FOLDERS = Object.keys(DERIVATIVE_FOLDERS) as DerivativeFolder[];

const keyOfFolder = (folder: DerivativeFolder) => folder.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()) as DerivativeDir;

/** Each derivative folder's name, by its key. */
const FOLDER_OF = Object.fromEntries(FOLDERS.map((folder) => [keyOfFolder(folder), folder])) as Record<DerivativeDir, DerivativeFolder>;

export type LibraryPaths = { root: string } & Record<DerivativeDir, string> & {
    /** Written only by the removed `/api/image` route. Nothing reads it now. */
    dynamicCache: string;
};

/**
 * Resolve the library root and its derivative folders. libraryRoot() reads
 * PHOTOGRAPHY_LIBRARY_DIR on every call, so tests and tools can point the
 * pipeline at another root without reloading this module.
 */
export function libraryPaths(): LibraryPaths {
    const root = libraryRoot();
    const folders = Object.fromEntries(FOLDERS.map((folder) => [keyOfFolder(folder), path.join(root, folder)])) as Record<DerivativeDir, string>;
    return { root, ...folders, dynamicCache: path.join(root, CACHE_FOLDER, 'dynamic') };
}

const THUMBNAIL_WIDTH = 400;
const MEDIUM_WIDTH = 800;
const OPTIMIZED_WIDTH = 1920;
const LQIP_SIZE = 20;

/**
 * WebP can't encode a side over 16383 px, and AVIF (HEIF) one over 16384, so
 * every resize fits inside 16383 on both sides. A tall panorama still gets its
 * seven outputs.
 */
const MAX_SIDE = 16383;

/** `images:cleanup` deletes a leftover temp file only once it is this old, so it never races a running job. */
export const STALE_TEMP_FILE_MS = 10 * 60 * 1000;

const SOURCE_FILE = /\.(jpg|jpeg|png|webp)$/i;

/**
 * Matches the `.<base hash>.<pid>.<random>.tmp` files writeVariants() stages
 * beside each output. Hashing the base name keeps the length fixed, so a long
 * but valid photo name never makes the temp name too long.
 */
const TEMP_FILE = /^\.[0-9a-f]{16}\.\d+\.[0-9a-f]{8}\.tmp$/;

/** `/api/image` cached files as `<base>-<width>-<quality>.<format>`. */
const DYNAMIC_CACHE_FILE = /^(.+)-\d+-\d+\.(avif|webp|jpeg)$/;

/** The `code` writeVariants() throws with when its source changed or went away mid-job. */
export const SOURCE_CHANGED = 'SOURCE_CHANGED';

export interface ProcessedImagePaths {
    original: string;
    thumbnail: string;
    medium: string;
    optimized: string;
    thumbnailAvif: string;
    mediumAvif: string;
    optimizedAvif: string;
    lqip: string;
    hasThumbnail: boolean;
    hasMedium: boolean;
    hasOptimized: boolean;
    hasThumbnailAvif: boolean;
    hasMediumAvif: boolean;
    hasOptimizedAvif: boolean;
    hasLqip: boolean;
}

type Encoder = (input: Buffer) => Promise<Buffer | string>;

interface Variant {
    dir: DerivativeDir;
    ext: (typeof DERIVATIVE_FOLDERS)[DerivativeFolder];
    encode: Encoder;
}

/**
 * autoOrient() is rotate() without an angle. It turns the pixels upright by
 * the EXIF Orientation, since the outputs carry no EXIF for a browser to
 * apply. Without it, a photo stored sideways shows sideways. `width` is the
 * upright width, and both upright sides stay within MAX_SIDE.
 */
function resized(input: Buffer, width: number) {
    return sharp(input).autoOrient().resize(Math.min(width, MAX_SIDE), MAX_SIDE, {
        fit: 'inside',
        withoutEnlargement: true,
    });
}

/**
 * The Low Quality Image Placeholder, a tiny WebP as a data URL, upright like
 * the other outputs. Takes the image bytes or a file path.
 */
export async function encodeLqip(input: Buffer | string): Promise<string> {
    const lqipBuffer = await sharp(input)
        .autoOrient()
        .resize(LQIP_SIZE, LQIP_SIZE, { fit: 'inside' })
        .webp({ quality: 20 })
        .toBuffer();
    return `data:image/webp;base64,${lqipBuffer.toString('base64')}`;
}

/** Each derivative folder's encoder settings. Typed by the shared list, so a folder can't be missing or extra. */
const ENCODERS: Record<DerivativeFolder, Encoder> = {
    thumbnails: (input) => resized(input, THUMBNAIL_WIDTH).webp({ quality: 80 }).toBuffer(),
    medium: (input) => resized(input, MEDIUM_WIDTH).webp({ quality: 85 }).toBuffer(),
    optimized: (input) => resized(input, OPTIMIZED_WIDTH).webp({ quality: 85 }).toBuffer(),
    'thumbnails-avif': (input) => resized(input, THUMBNAIL_WIDTH).avif({ quality: 60, effort: 4 }).toBuffer(),
    'medium-avif': (input) => resized(input, MEDIUM_WIDTH).avif({ quality: 60, effort: 4 }).toBuffer(),
    'optimized-avif': (input) => resized(input, OPTIMIZED_WIDTH).avif({ quality: 60, effort: 4 }).toBuffer(),
    lqip: encodeLqip,
};

// The seven outputs and their encoder settings, in the order they are written.
const VARIANTS: readonly Variant[] = FOLDERS.map((folder) => ({ dir: keyOfFolder(folder), ext: DERIVATIVE_FOLDERS[folder], encode: ENCODERS[folder] }));

/** The seven derivative folders' keys. */
const DERIVATIVE_DIRS: readonly DerivativeDir[] = VARIANTS.map((variant) => variant.dir);

/** A derivative's file name for a base name, such as `IMG_1.webp` in thumbnails. */
const outputName = (dir: DerivativeDir, baseName: string) => `${baseName}${DERIVATIVE_FOLDERS[FOLDER_OF[dir]]}`;

/** Folder names directly under the library root that hold generated files, never sources. */
export function generatedFolderNames(): string[] {
    const paths = libraryPaths();
    return [...DERIVATIVE_DIRS.map((dir) => paths[dir]), path.dirname(paths.dynamicCache)]
        .map((folder) => path.relative(paths.root, folder));
}

export function libraryRootExists(root: string = libraryPaths().root): boolean {
    try {
        const stat = fs.statSync(root);
        // A host folder deleted from under a bind mount still stats as a directory, with no links left
        return stat.isDirectory() && stat.nlink > 0;
    } catch {
        return false;
    }
}

/** A photo the pipeline processes. Dot-files, such as macOS `._*` AppleDouble files, never count. */
export function isSourceFile(filename: string): boolean {
    const name = path.basename(filename);
    return !name.startsWith('.') && SOURCE_FILE.test(name);
}

/** A source's name without its extension. Its derivatives share it, so `a.jpg` and `a.png` share one set. */
export function baseNameOf(filename: string): string {
    return path.basename(filename, path.extname(filename));
}

/** The shared errno check, re-exported for callers of the image pipeline. */
export { hasErrorCode };

/**
 * Create the derivative folders inside an existing library root. Never creates
 * the root itself: a missing root means the library is unmounted or gone, and
 * recreating it would hide that.
 */
export function ensureDirectories(paths: LibraryPaths = libraryPaths()): void {
    if (!libraryRootExists(paths.root)) {
        throw new Error(`Library root not found: ${paths.root}`);
    }
    
    for (const dir of DERIVATIVE_DIRS) {
        try {
            fs.mkdirSync(paths[dir]);
        } catch (error) {
            if (!hasErrorCode(error, 'EEXIST')) throw error;
        }
    }
}

/**
 * The names in `dir`, or none when it doesn't exist. Any other error throws:
 * read as empty, a folder that can't be listed would make every photo's set
 * look incomplete, and the Gallery would cache an empty list.
 */
function listNames(dir: string): string[] {
    try {
        return fs.readdirSync(dir);
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return [];
        throw error;
    }
}

/**
 * The names in each derivative folder, read once. Lookups match names exactly,
 * even on a case-insensitive disk, where `existsSync('Beach.webp')` finds
 * `beach.webp` but the public file lookup in production doesn't.
 */
export type DerivativeIndex = ReadonlyMap<DerivativeDir, ReadonlySet<string>>;

export function readDerivativeIndex(paths: LibraryPaths = libraryPaths()): DerivativeIndex {
    return new Map(DERIVATIVE_DIRS.map((dir) => [dir, new Set(listNames(paths[dir]))]));
}

/**
 * Get file paths for all versions of an image
 */
export function getImagePaths(
    filename: string,
    paths: LibraryPaths = libraryPaths(),
    index: DerivativeIndex = readDerivativeIndex(paths),
): ProcessedImagePaths {
    const baseName = baseNameOf(filename);
    const has = (dir: DerivativeDir) => index.get(dir)?.has(outputName(dir, baseName)) ?? false;
    // The file name is one encoded path segment, so a % or # in it reaches the file instead of breaking the URL.
    const url = (dir: DerivativeDir) => `/assets/photos/${FOLDER_OF[dir]}/${encodeURIComponent(outputName(dir, baseName))}`;

    return {
        original: `/assets/photos/${encodeURIComponent(filename)}`,
        thumbnail: url('thumbnails'),
        medium: url('medium'),
        optimized: url('optimized'),
        thumbnailAvif: url('thumbnailsAvif'),
        mediumAvif: url('mediumAvif'),
        optimizedAvif: url('optimizedAvif'),
        lqip: url('lqip'),
        hasThumbnail: has('thumbnails'),
        hasMedium: has('medium'),
        hasOptimized: has('optimized'),
        hasThumbnailAvif: has('thumbnailsAvif'),
        hasMediumAvif: has('mediumAvif'),
        hasOptimizedAvif: has('optimizedAvif'),
        hasLqip: has('lqip'),
    };
}

/** Whether all seven outputs exist under the source's exact base name. */
export function isCompleteSet(outputs: ProcessedImagePaths): boolean {
    return outputs.hasThumbnail && outputs.hasMedium && outputs.hasOptimized &&
        outputs.hasThumbnailAvif && outputs.hasMediumAvif && outputs.hasOptimizedAvif && outputs.hasLqip;
}

/** The start of every temp file name writeVariants() uses for `baseName`. */
export function tempFilePrefix(baseName: string): string {
    return `.${createHash('sha256').update(baseName).digest('hex').slice(0, 16)}.`;
}

function tempPathFor(target: string, baseName: string): string {
    const name = `${tempFilePrefix(baseName)}${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    return path.join(path.dirname(target), name);
}

async function removeQuietly(files: string[]): Promise<void> {
    await Promise.all(files.map((file) => fs.promises.rm(file, { force: true }).catch(() => undefined)));
}

function sameFileVersion(before: fs.Stats, after: fs.Stats | undefined): boolean {
    return after !== undefined &&
        after.dev === before.dev &&
        after.ino === before.ino &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs;
}

function sourceChanged(filename: string): Error {
    return Object.assign(
        new Error(`${filename} changed or was removed while it was processed, so its new outputs were discarded.`),
        { code: SOURCE_CHANGED },
    );
}

/**
 * Whether two paths are one file, as when a case-insensitive disk resolves two
 * spellings of a name to one entry. Null when lstat fails for a reason other
 * than a missing entry, since then it can't tell.
 */
function sameFile(a: string, b: string): boolean | null {
    try {
        const first = fs.lstatSync(a, { throwIfNoEntry: false });
        const second = fs.lstatSync(b, { throwIfNoEntry: false });
        return first !== undefined && second !== undefined && first.dev === second.dev && first.ino === second.ino;
    } catch {
        return null;
    }
}

/**
 * Give an existing output that differs from `target` only in case or Unicode
 * form the target's exact name, when the disk resolves both names to that one
 * file. Renaming the new output over it could keep the old spelling, and the
 * public file lookup in production matches names exactly. On a case-sensitive
 * disk the other name is a different photo's output, so it stays.
 */
async function matchSpelling(target: string, names: ReadonlySet<string> | undefined): Promise<void> {
    const name = path.basename(target);
    if (!names || names.has(name)) return;
    for (const existing of names) {
        if (foldName(existing) !== foldName(name)) continue;
        const other = path.join(path.dirname(target), existing);
        if (sameFile(other, target) === true) await fs.promises.rename(other, target);
    }
}

/**
 * Generate an image's derivatives without exposing a partial set. Reads the
 * source once, encodes each needed output (all seven with `overwrite`, else
 * only the missing ones), writes it to a temp file beside its target with
 * fsync, and renames the temp files over the targets only after every one is
 * written. On failure it removes this attempt's temp files and rethrows, so
 * the previous outputs stay as they were. If the source changed or went away,
 * as in a takedown, it discards the attempt the same way and throws an error
 * with `code` SOURCE_CHANGED. After a full regeneration it also deletes the
 * photo's `/api/image` cache files, which would still serve the old version.
 *
 * Returns the paths it replaced or created.
 */
export async function writeVariants(
    filename: string,
    { overwrite, paths = libraryPaths() }: { overwrite: boolean; paths?: LibraryPaths },
): Promise<string[]> {
    ensureDirectories(paths);
    const baseName = baseNameOf(filename);
    const sourcePath = path.join(paths.root, filename);
    const index = readDerivativeIndex(paths);
    const needed = VARIANTS
        .filter((variant) => overwrite || !index.get(variant.dir)?.has(`${baseName}${variant.ext}`))
        .map((variant) => ({ variant, target: path.join(paths[variant.dir], `${baseName}${variant.ext}`) }));
    if (needed.length === 0) return [];

    // Held open from the read until after the second check, so a disk that numbers
    // files as it goes, such as FAT or CIFS, can't hand this inode to another file
    let source: fs.promises.FileHandle;
    try {
        source = await fs.promises.open(sourcePath, 'r');
    } catch (error) {
        throw hasErrorCode(error, 'ENOENT') ? sourceChanged(filename) : error;
    }

    const staged: { temp: string; target: string; dir: DerivativeDir }[] = [];
    try {
        const before = await source.stat();
        const input = await source.readFile();
        for (const { variant, target } of needed) {
            const data = await variant.encode(input);
            const temp = tempPathFor(target, baseName);
            const handle = await fs.promises.open(temp, 'wx');
            staged.push({ temp, target, dir: variant.dir });
            try {
                await handle.writeFile(data);
                await handle.sync();
            } finally {
                await handle.close();
            }
        }

        // A takedown or a newer save may have landed while this job encoded
        const after = await fs.promises.stat(sourcePath).catch(() => undefined);
        if (!sameFileVersion(before, after)) throw sourceChanged(filename);
    } catch (error) {
        await removeQuietly(staged.map(({ temp }) => temp));
        throw error;
    } finally {
        await source.close();
    }

    // The thumbnail goes last. isSourceNewer() compares the source with it, so a
    // swap interrupted before it leaves the old one, and the next run redoes the set.
    const order = [
        ...staged.filter(({ dir }) => dir !== 'thumbnails'),
        ...staged.filter(({ dir }) => dir === 'thumbnails'),
    ];

    let renamed = 0;
    try {
        for (const { temp, target, dir } of order) {
            await matchSpelling(target, index.get(dir));
            await fs.promises.rename(temp, target);
            renamed++;
        }
    } catch (error) {
        builtFrom.delete(builtKey(filename, paths));
        await removeQuietly(order.slice(renamed).map(({ temp }) => temp));
        console.error(
            `[imageOptimizer] Renaming ${filename}'s new outputs failed after replacing ${renamed} of ${order.length}.` +
            (renamed > 0 ? ' Its derivatives may mix old and new versions until it is processed again.' : ''),
        );
        throw error;
    }

    // A fill of only the missing outputs leaves a set some other source may have built the rest of.
    if (order.length === VARIANTS.length) builtFrom.set(builtKey(filename, paths), filename);
    else builtFrom.delete(builtKey(filename, paths));
    if (overwrite) purgeDynamicCache(baseName, paths);
    return order.map(({ target }) => target);
}

/**
 * Delete `/api/image`'s cached copies of one photo, which still serve its
 * previous version as static files. Matches the cached file's base exactly, so
 * `landscape` leaves `landscape-edited` alone, and never follows a symlinked
 * cache folder out of the library.
 */
function purgeDynamicCache(baseName: string, paths: LibraryPaths): void {
    if (guardState([path.dirname(paths.dynamicCache), paths.dynamicCache]).state !== 'ok') return;
    let names: string[];
    try {
        names = listNames(paths.dynamicCache);
    } catch {
        return; // Best effort, after the new set is in place. images:cleanup lists what's left.
    }
    for (const name of names) {
        if (DYNAMIC_CACHE_FILE.exec(name)?.[1] !== baseName) continue;
        try {
            fs.unlinkSync(path.join(paths.dynamicCache, name));
        } catch {
            // Gone already, or not removable. images:cleanup lists what's left.
        }
    }
}

/**
 * Process a single image: generate whichever of its outputs are missing
 */
export async function processImage(filename: string): Promise<ProcessedImagePaths> {
    await writeVariants(filename, { overwrite: false });
    return getImagePaths(filename);
}

/**
 * Get list of all photo files in the directory
 */
export function getPhotoFiles(root: string = libraryPaths().root): string[] {
    if (!libraryRootExists(root)) {
        return [];
    }
    
    return fs.readdirSync(root).filter((file) => {
        if (!isSourceFile(file)) return false;
        try {
            return !fs.statSync(path.join(root, file)).isDirectory();
        } catch {
            return false; // Removed between readdir and stat
        }
    });
}

/**
 * Check if source file is newer than processed versions (for cache-busting)
 */
function isSourceNewer(filename: string, paths: LibraryPaths): boolean {
    const sourcePath = path.join(paths.root, filename);
    const baseName = baseNameOf(filename);
    const thumbnailPath = path.join(paths.thumbnails, `${baseName}.webp`);
    
    // A file removed mid-check counts as missing instead of throwing
    const source = fs.statSync(sourcePath, { throwIfNoEntry: false });
    if (!source) return false;
    const thumbnail = fs.statSync(thumbnailPath, { throwIfNoEntry: false });
    if (!thumbnail) return true;
    
    return source.mtimeMs > thumbnail.mtimeMs;
}
    
/**
 * Whether a source's outputs need regenerating: when any of the seven is
 * missing by exact name, or when the source is newer than its thumbnail.
 */
export function needsRefresh(
    filename: string,
    paths: LibraryPaths = libraryPaths(),
    index: DerivativeIndex = readDerivativeIndex(paths),
): boolean {
    return !isCompleteSet(getImagePaths(filename, paths, index)) || isSourceNewer(filename, paths);
}

/**
 * Get list of files that need processing
 */
export function getUnprocessedFiles(): string[] {
    const paths = libraryPaths();
    ensureDirectories(paths);
    const index = readDerivativeIndex(paths);
    return getPhotoFiles(paths.root).filter((file) => needsRefresh(file, paths, index));
}

/**
 * A source's base name, folded as the identity scan folds paths. Sources that
 * may write one set of derivatives share it, so the watcher runs their jobs in
 * turn. Whether they do share one is sharesSet()'s call.
 */
export function setKeyOf(filename: string): string {
    return keyOf(baseNameOf(filename));
}

/**
 * Whether two sources write one set of derivatives: when their base names
 * match, such as IMG_1.jpg and IMG_1.png, or differ only in case or Unicode
 * form and the disk resolves both spellings to one file, as a case-insensitive
 * disk does with Beach.jpg and beach.png. On a case-sensitive disk those two
 * have a set each. The rule sourceSet() uses for cleanup: when lstat can't
 * tell, they count as one.
 */
export function sharesSet(a: string, b: string, root: string = libraryPaths().root): boolean {
    const baseA = baseNameOf(a);
    const baseB = baseNameOf(b);
    if (baseA === baseB) return true;
    if (setKeyOf(a) !== setKeyOf(b)) return false;
    return sameFile(path.join(root, b), path.join(root, `${baseA}${path.extname(b)}`)) !== false;
}

/** Sources grouped by the set they write, each group in path order. */
export function setGroups(files: string[], root: string = libraryPaths().root): string[][] {
    const groups: string[][] = [];
    const byKey = new Map<string, string[][]>();
    for (const file of [...files].sort()) {
        const candidates = byKey.get(setKeyOf(file)) ?? [];
        const group = candidates.find((members) => sharesSet(members[0], file, root));
        if (group) {
            group.push(file);
            continue;
        }
        const created = [file];
        byKey.set(setKeyOf(file), [...candidates, created]);
        groups.push(created);
    }
    return groups;
}

/** The library's sources that write `filename`'s set, in path order, `filename` among them while it exists. */
export function setMembers(filename: string, paths: LibraryPaths = libraryPaths()): string[] {
    return getPhotoFiles(paths.root).filter((file) => sharesSet(filename, file, paths.root)).sort();
}

/** What decodes() found for each path, kept while the file keeps its inode, size, and times. */
const decoded = new Map<string, { version: string; ok: boolean }>();

/**
 * The source that last wrote each set whole, by library root and set key.
 * Kept in memory only, so a set written by another process, or before a
 * restart, has no known builder.
 */
const builtFrom = new Map<string, string>();

const builtKey = (filename: string, paths: LibraryPaths) => `${paths.root}\0${setKeyOf(filename)}`;

/**
 * The source that last wrote `owner`'s set whole in this process, or null
 * when that's unknown, as after a partial fill, a rename that failed, or a
 * restart. A builder that only shares the set's key, as two spellings do on a
 * case-sensitive disk, doesn't count.
 */
export function lastBuiltFrom(owner: string, paths: LibraryPaths = libraryPaths()): string | null {
    const builder = builtFrom.get(builtKey(owner, paths));
    return builder !== undefined && sharesSet(builder, owner, paths.root) ? builder : null;
}

/**
 * Whether a source decodes whole. The header alone isn't enough: a truncated
 * file can keep an intact one, and then every encode fails. Reads the bytes
 * itself, since libvips caches what it loads by file name.
 */
async function decodes(file: string, paths: LibraryPaths): Promise<boolean> {
    const filePath = path.join(paths.root, file);
    let version: string;
    try {
        const { dev, ino, size, mtimeMs, ctimeMs } = await fs.promises.stat(filePath);
        version = `${dev}:${ino}:${size}:${mtimeMs}:${ctimeMs}`;
    } catch {
        return false;
    }
    const cached = decoded.get(filePath);
    if (cached?.version === version) return cached.ok;
    let ok: boolean;
    try {
        await sharp(await fs.promises.readFile(filePath)).resize(8).toBuffer();
        ok = true;
    } catch {
        ok = false;
    }
    decoded.set(filePath, { version, ok });
    return ok;
}

/**
 * Which source of a group owns its set: the first by path that decodes, or
 * the first when none does. The Gallery lists only the owner and the watcher
 * builds only from it, so the set always shows the photo the Gallery names.
 * Also returns the sources before the owner, which didn't decode.
 */
export async function pickOwner(group: string[], paths: LibraryPaths = libraryPaths()): Promise<{ owner: string; undecodable: string[] }> {
    if (group.length > 1) {
        for (const [index, file] of group.entries()) {
            if (await decodes(file, paths)) return { owner: file, undecodable: group.slice(0, index) };
        }
    }
    return { owner: group[0], undecodable: [] };
}

/**
 * The source that owns a removed source's set now, when the set may have been
 * the removed one's and so shows its pixels: when another source shares the
 * set and the removed one came before it by path. Null otherwise.
 */
export async function ownerAfterRemoval(removed: string, paths: LibraryPaths = libraryPaths()): Promise<string | null> {
    const group = setMembers(removed, paths).filter((file) => file !== removed);
    if (group.length === 0) return null;
    const { owner } = await pickOwner(group, paths);
    return removed < owner ? owner : null;
}

/**
 * The source that owns `filename`'s set among the library's sources now, or
 * `filename` when it is the only one. Pass the setMembers() a caller already
 * has as `members` to skip listing the library again.
 */
export async function ownerOf(filename: string, paths: LibraryPaths = libraryPaths(), members: string[] = setMembers(filename, paths)): Promise<string> {
    return members.includes(filename) ? (await pickOwner(members, paths)).owner : filename;
}

/**
 * Regenerate all seven outputs from the current source bytes. The old outputs
 * keep serving until every new one is written. A source whose set another
 * source owns writes nothing.
 */
export async function reprocessImage(filename: string): Promise<ProcessedImagePaths> {
    const paths = libraryPaths();
    if (await ownerOf(filename, paths) === filename) await writeVariants(filename, { overwrite: true, paths });
    return getImagePaths(filename, paths);
}

export interface SourcePlan {
    /** The owners whose sets need building: all of them with `force`, else those needsRefresh() names. */
    files: string[];
    /** The sources left out because another one owns their set, and whether each was passed over for not decoding. */
    shared: { file: string; owner: string; undecodable: boolean }[];
}

/** What the watcher's startup batch builds, and which sources it leaves out. Throws on a missing root. */
export async function planSources({ force = false }: { force?: boolean } = {}): Promise<SourcePlan> {
    const paths = libraryPaths();
    ensureDirectories(paths);
    const plan: SourcePlan = { files: [], shared: [] };
    const index = force ? null : readDerivativeIndex(paths);
    for (const group of setGroups(getPhotoFiles(paths.root), paths.root)) {
        const { owner, undecodable } = await pickOwner(group, paths);
        for (const file of group) if (file !== owner) plan.shared.push({ file, owner, undecodable: undecodable.includes(file) });
        if (index === null || needsRefresh(owner, paths, index)) plan.files.push(owner);
    }
    return plan;
}

/**
 * The sources the watcher's startup batch works on: the owner of each set,
 * every one with `force`, else the unprocessed ones. Both throw on a missing root.
 */
export async function filesToProcess({ force = false }: { force?: boolean } = {}): Promise<string[]> {
    return (await planSources({ force })).files;
}

/**
 * The overwrite rule the startup batch and a live `add` use: regenerate all
 * seven outputs when forced or when needsRefresh() says so, and otherwise do
 * nothing. A missing one next to existing ones may come from a different
 * version, so filling in only the gap could leave a mixed set. A source whose
 * set another source owns writes nothing. `owns` skips that check, for a
 * caller that just made it.
 *
 * Returns the paths it replaced, none when the set was already current.
 */
export async function refreshImage(filename: string, { force = false, owns = false }: { force?: boolean; owns?: boolean } = {}): Promise<string[]> {
    const paths = libraryPaths();
    if (!owns && await ownerOf(filename, paths) !== filename) return [];
    if (!force && !needsRefresh(filename, paths)) return [];
    return writeVariants(filename, { overwrite: true, paths });
}

export type OrphanReason =
    | `no source named ${string}.*`
    | `rebuilt from ${string} when the watcher starts`
    | 'stale temp file'
    | 'unused since /api/image was removed';

export interface OrphanEntry {
    path: string;
    /** POSIX path relative to the library root, for display */
    relativePath: string;
    reason: OrphanReason;
    bytes: number;
}

export interface OrphanCleanupOptions {
    /** Plan a library with no sources, where every derivative counts as an orphan. */
    allowEmptyLibrary?: boolean;
    /**
     * Limit the plan to one photo's set, for a takedown. An exact base name wins.
     * Otherwise a source extension is stripped, so `landscape.jpg` means `landscape`.
     */
    only?: string | null;
}

export interface UnreadableSource {
    name: string;
    code: string;
}

export interface OrphanCleanupPlan {
    root: string;
    allowEmptyLibrary: boolean;
    /** The base name `only` resolved to */
    only: string | null;
    entries: OrphanEntry[];
    /** Temp files kept because a running job may still own them */
    youngTempFiles: string[];
    /** Folders cleanup didn't enter because they are symlinks, not folders, or can't be listed */
    skippedFolders: string[];
    /**
     * With `only`, the skipped folders it couldn't look that photo's files up
     * in by name, so some may be left there. In a folder it can't list but can
     * search, its derivatives are looked up by their exact names instead.
     */
    uncheckedFolders: string[];
    /** Sources lstat can see but stat can't read. Their sets are kept. */
    unreadableSources: UnreadableSource[];
    /** With `only` and no file under that exact name, the names that differ from it only in case or Unicode form */
    onlyVariants: string[];
    /** With `only`, the other sets with no source, which may be earlier names of the same photo */
    otherOrphans: string[];
    /** Short hash of what the plan deletes. `images:cleanup --apply` needs it, so only a reviewed plan runs. */
    hash: string;
}

export interface OrphanCleanupResult {
    deleted: OrphanEntry[];
    /** Entries that no longer qualified when re-checked right before deletion */
    skipped: OrphanEntry[];
    failed: { entry: OrphanEntry; error: Error }[];
}

export class CleanupRefusedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CleanupRefusedError';
    }
}

type Verdict =
    | { kind: 'delete'; reason: OrphanReason; bytes: number }
    | { kind: 'young-temp' }
    | { kind: 'keep' };

const KEEP: Verdict = { kind: 'keep' };

/**
 * The sources cleanup protects. An entry lstat can see but stat can't, such as
 * a dangling symlink or one that fails with EACCES, ELOOP, or EIO, still
 * counts, so its set is kept.
 */
function cleanupSources(root: string): { files: string[]; unreadable: UnreadableSource[] } {
    const files: string[] = [];
    const unreadable: UnreadableSource[] = [];
    for (const name of fs.readdirSync(root)) {
        if (!isSourceFile(name)) continue;
        const file = path.join(root, name);
        try {
            if (!fs.statSync(file).isDirectory()) files.push(name);
        } catch (error) {
            let present = true;
            try {
                present = fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
            } catch {
                // Can't tell, so it counts
            }
            if (!present) continue; // Removed since readdir
            files.push(name);
            unreadable.push({ name, code: (error as NodeJS.ErrnoException).code ?? 'unknown error' });
        }
    }
    return { files, unreadable };
}

interface SourceSet {
    any: boolean;
    /** The sources a derivative named `base` belongs to. */
    of(base: string): string[];
}

/**
 * Sources by base name. A derivative belongs to a source with exactly its base
 * name. On a case-sensitive disk `Beach.jpg` and `beach.jpg` are different
 * photos, so a name that differs in case or Unicode form counts only when the
 * disk resolves both names to the same file, or when lstat can't tell.
 */
function sourceSet(root: string, sourceFiles: string[]): SourceSet {
    const exact = new Map<string, string[]>();
    const folded = new Map<string, string[]>();
    for (const file of sourceFiles) {
        const base = baseNameOf(file);
        exact.set(base, [...(exact.get(base) ?? []), file]);
        folded.set(foldName(base), [...(folded.get(foldName(base)) ?? []), file]);
    }
    return {
        any: sourceFiles.length > 0,
        of: (base) => {
            const matches = exact.get(base);
            if (matches) return matches;
            return (folded.get(foldName(base)) ?? []).filter((file) =>
                sameFile(path.join(root, file), path.join(root, `${base}${path.extname(file)}`)) !== false);
        },
    };
}

/**
 * The folders cleanup reads, each with the folders that must be real
 * directories before it enters, and the extension of a derivative's exact
 * name there. The /api/image cache has none, since its names carry a width
 * and a quality.
 */
function scannedFolders(paths: LibraryPaths): { dir: string; guards: string[]; ext: string | null }[] {
    return [
        ...DERIVATIVE_DIRS.map((key) => ({ dir: paths[key], guards: [paths[key]], ext: DERIVATIVE_FOLDERS[FOLDER_OF[key]] as string })),
        { dir: paths.dynamicCache, guards: [path.dirname(paths.dynamicCache), paths.dynamicCache], ext: null },
    ];
}

/**
 * With `only`, look up the photo's derivatives by their exact names in a
 * folder cleanup can't list, since a takedown mustn't leave one there. Looks
 * up `requested` as given and without a source extension, the two names
 * `only` can resolve to. Returns the files found, or null when the folder
 * can't be searched either.
 */
function lookUpByName(dir: string, ext: string | null, requested: string): string[] | null {
    if (ext === null) return null;
    const found: string[] = [];
    for (const base of new Set([requested, isSourceFile(requested) ? baseNameOf(requested) : requested])) {
        const file = path.join(dir, `${base}${ext}`);
        try {
            fs.lstatSync(file);
            found.push(file);
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return null;
        }
    }
    return found;
}
    
/** lstat, so a symlink never counts as a folder and cleanup never follows one out of the library. */
function folderState(dir: string): 'ok' | 'missing' | 'unsafe' {
    try {
        return fs.lstatSync(dir).isDirectory() ? 'ok' : 'unsafe';
    } catch (error) {
        return hasErrorCode(error, 'ENOENT') ? 'missing' : 'unsafe';
    }
}

function guardState(guards: string[]): { state: 'ok' | 'missing' | 'unsafe'; at: string } {
    for (const guard of guards) {
        const state = folderState(guard);
        if (state !== 'ok') return { state, at: guard };
    }
    return { state: 'ok', at: '' };
}

/** The base name a derivative or `/api/image` cache file belongs to. Null for a temp file or an unrecognized cache file. */
function ownerBase(file: string, paths: LibraryPaths): string | null {
    const name = path.basename(file);
    if (path.dirname(file) === paths.dynamicCache) return DYNAMIC_CACHE_FILE.exec(name)?.[1] ?? null;
    return TEMP_FILE.test(name) ? null : baseNameOf(name);
}

/** Whether a derivative, temp, or cache file belongs to the base name `only`, matched exactly. */
function matchesOnly(file: string, paths: LibraryPaths, only: string): boolean {
    const name = path.basename(file);
    if (path.dirname(file) !== paths.dynamicCache && TEMP_FILE.test(name)) return name.startsWith(tempFilePrefix(only));
    return ownerBase(file, paths) === only;
}

function classify(
    file: string,
    paths: LibraryPaths,
    sources: SourceSet,
    { allowEmptyLibrary, only, now }: { allowEmptyLibrary: boolean; only: string | null; now: number },
): Verdict {
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(file);
    } catch {
        return KEEP; // Already gone, or the library is
    }
    if (!stat.isFile()) return KEEP;
    if (only !== null && !matchesOnly(file, paths, only)) return KEEP;

    const name = path.basename(file);
    // The route that wrote these is gone, so all of them go
    if (path.dirname(file) === paths.dynamicCache) {
        return { kind: 'delete', reason: 'unused since /api/image was removed', bytes: stat.size };
    }
    if (TEMP_FILE.test(name)) {
        return now - stat.mtimeMs >= STALE_TEMP_FILE_MS
            ? { kind: 'delete', reason: 'stale temp file', bytes: stat.size }
            : { kind: 'young-temp' };
    }

    const base = baseNameOf(name);
    const owners = sources.of(base);
    // A takedown removes the set even when a sibling shares it, such as a.png
    // next to a deleted a.jpg. The watcher rebuilds it from the sibling.
    if (only !== null && owners.length > 0) {
        return { kind: 'delete', reason: `rebuilt from ${[...owners].sort().join(', ')} when the watcher starts`, bytes: stat.size };
    }
    if (owners.length > 0) return KEEP;
    // A library that lost every source is more likely unmounted or mid-sync than retired.
    if (!sources.any && !allowEmptyLibrary) return KEEP;
    return { kind: 'delete', reason: `no source named ${base}.*`, bytes: stat.size };
}

function listFiles(dir: string): string[] {
    return listNames(dir).sort();
}

function relativeTo(root: string, file: string): string {
    return path.relative(root, file).split(path.sep).join('/');
}

function planHash(root: string, allowEmptyLibrary: boolean, only: string | null, entries: OrphanEntry[]): string {
    const canonical = JSON.stringify({
        root,
        allowEmptyLibrary,
        only,
        entries: entries.map(({ relativePath, reason, bytes }) => [relativePath, reason, bytes]),
    });
    return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

/** `only` as given when a file matches it exactly, else with a source extension stripped. */
function resolveOnly(requested: string, scanned: string[], paths: LibraryPaths): string {
    if (!isSourceFile(requested) || scanned.some((file) => matchesOnly(file, paths, requested))) return requested;
    return baseNameOf(requested);
}

/** With nothing under `only` exactly, the sets whose names differ from it only in case or Unicode form. */
function caseVariants(only: string, scanned: string[], paths: LibraryPaths): string[] {
    if (scanned.some((file) => matchesOnly(file, paths, only))) return [];
    const variants = new Set<string>();
    for (const file of scanned) {
        const owner = ownerBase(file, paths);
        if (owner !== null && owner !== only && foldName(owner) === foldName(only)) variants.add(owner);
    }
    return [...variants].sort();
}

/** The other sets no source needs, which a takedown may also want gone as earlier names of the photo. */
function orphanedSets(only: string, scanned: string[], paths: LibraryPaths, sources: SourceSet): string[] {
    const bases = new Set<string>();
    for (const file of scanned) {
        if (path.dirname(file) === paths.dynamicCache) continue;
        const owner = ownerBase(file, paths);
        if (owner !== null && owner !== only && sources.of(owner).length === 0) bases.add(owner);
    }
    return [...bases].sort();
}

/**
 * Plan which derivatives no source needs anymore, without touching anything.
 * Refuses a missing root, and a root with no sources unless
 * `allowEmptyLibrary`, because either would make every derivative look orphaned.
 */
export function planOrphanCleanup(
    { allowEmptyLibrary = false, only: requested = null }: OrphanCleanupOptions = {},
): OrphanCleanupPlan {
    const paths = libraryPaths();
    if (!libraryRootExists(paths.root)) {
        throw new CleanupRefusedError(
            `library root not found: ${paths.root}. Check the mount or PHOTOGRAPHY_LIBRARY_DIR.`,
        );
    }
    const { files: sourceFiles, unreadable } = cleanupSources(paths.root);
    if (sourceFiles.length === 0 && !allowEmptyLibrary) {
        throw new CleanupRefusedError(
            `${paths.root} has no source photos, so every derivative would count as an orphan. ` +
            'Pass --allow-empty-library if the library is meant to be empty.',
        );
    }

    const sources = sourceSet(paths.root, sourceFiles);
    const skippedFolders: string[] = [];
    const uncheckedFolders: string[] = [];
    const scanned: string[] = [];
    for (const { dir, guards, ext } of scannedFolders(paths)) {
        const guard = guardState(guards);
        if (guard.state === 'unsafe') {
            skippedFolders.push(relativeTo(paths.root, guard.at));
            // Looking inside would follow it, maybe out of the library
            if (requested !== null) uncheckedFolders.push(relativeTo(paths.root, guard.at));
        }
        if (guard.state !== 'ok') continue;
        let names: string[];
        try {
            names = listFiles(dir);
        } catch {
            // Its files are kept, the same as a folder that is a symlink, except a takedown's, looked up by name.
            skippedFolders.push(relativeTo(paths.root, dir));
            if (requested === null) continue;
            const found = lookUpByName(dir, ext, requested);
            if (found === null) uncheckedFolders.push(relativeTo(paths.root, dir));
            else scanned.push(...found);
            continue;
        }
        scanned.push(...names.map((name) => path.join(dir, name)));
    }

    const only = requested === null ? null : resolveOnly(requested, scanned, paths);
    const options = { allowEmptyLibrary, only, now: Date.now() };
    const entries: OrphanEntry[] = [];
    const youngTempFiles: string[] = [];
    for (const file of scanned) {
        const relativePath = relativeTo(paths.root, file);
        const verdict = classify(file, paths, sources, options);
        if (verdict.kind === 'delete') {
            entries.push({ path: file, relativePath, reason: verdict.reason, bytes: verdict.bytes });
        } else if (verdict.kind === 'young-temp') {
            youngTempFiles.push(relativePath);
        }
    }
    
    return {
        root: paths.root,
        allowEmptyLibrary,
        only,
        entries,
        youngTempFiles,
        skippedFolders,
        uncheckedFolders,
        unreadableSources: unreadable,
        onlyVariants: only === null ? [] : caseVariants(only, scanned, paths),
        otherOrphans: only === null ? [] : orphanedSets(only, scanned, paths, sources),
        hash: planHash(paths.root, allowEmptyLibrary, only, entries),
    };
}

/**
 * Delete a plan's entries, re-checking each one right before deleting it.
 * Lists the sources once, fresh, and keeps everything if it can't. An entry
 * that no longer qualifies for the same reason (its source came back, its
 * folder became a symlink, a temp file was touched) is skipped.
 */
export function applyOrphanCleanup(plan: OrphanCleanupPlan): OrphanCleanupResult {
    const paths = libraryPaths();
    if (paths.root !== plan.root) {
        throw new CleanupRefusedError(`the plan is for ${plan.root}, but the library root is now ${paths.root}.`);
    }
    
    const result: OrphanCleanupResult = { deleted: [], skipped: [], failed: [] };
    let sources: SourceSet;
    try {
        sources = sourceSet(paths.root, cleanupSources(paths.root).files);
    } catch {
        result.skipped.push(...plan.entries);
        return result;
    }

    const options = { allowEmptyLibrary: plan.allowEmptyLibrary, only: plan.only, now: Date.now() };
    const folders = scannedFolders(paths);
    for (const entry of plan.entries) {
        const folder = folders.find(({ dir }) => dir === path.dirname(entry.path));
        const verdict = folder && guardState(folder.guards).state === 'ok'
            ? classify(entry.path, paths, sources, options)
            : KEEP;
        if (verdict.kind !== 'delete' || verdict.reason !== entry.reason) {
            result.skipped.push(entry);
            continue;
        }
        try {
            fs.unlinkSync(entry.path);
            result.deleted.push({ ...entry, bytes: verdict.bytes });
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) {
                result.skipped.push(entry);
            } else {
                result.failed.push({ entry, error: error as Error });
            }
        }
    }
    return result;
}

/** A WebP header's first 30 bytes hold its size, in any of the three formats. */
const WEBP_HEADER_BYTES = 30;

/**
 * The width and height a WebP file's first 30 bytes declare, or null when
 * they aren't a WebP header.
 */
export function webpSize(header: Buffer): { width: number; height: number } | null {
    if (header.length < WEBP_HEADER_BYTES) return null;
    if (header.toString('latin1', 0, 4) !== 'RIFF' || header.toString('latin1', 8, 12) !== 'WEBP') return null;
    switch (header.toString('latin1', 12, 16)) {
        case 'VP8X': // Extended: the canvas size, each side less one, in 24 bits
            return { width: header.readUIntLE(24, 3) + 1, height: header.readUIntLE(27, 3) + 1 };
        case 'VP8 ': // Lossy: 14-bit sides after the key frame's start code
            if (header.readUIntBE(23, 3) !== 0x9d012a) return null;
            return { width: header.readUInt16LE(26) & 0x3fff, height: header.readUInt16LE(28) & 0x3fff };
        case 'VP8L': { // Lossless: 14-bit sides, each less one, after the signature byte
            if (header[20] !== 0x2f) return null;
            const bits = header.readUInt32LE(21);
            return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
        }
        default:
            return null;
    }
}

/**
 * The size of a source's optimized WebP, which the Lightbox loads. It is
 * smaller than the photo once the photo is wider than 1920 px. Read from the
 * file's header, not through Sharp: libvips caches what it loads by file name,
 * so in a long-running server a file the watcher replaced would keep its old
 * size. Throws when the file is missing or isn't a WebP.
 */
export async function optimizedSize(filename: string, paths: LibraryPaths = libraryPaths()): Promise<{ width: number; height: number }> {
    const file = path.join(paths.optimized, outputName('optimized', baseNameOf(filename)));
    const handle = await fs.promises.open(file, 'r');
    try {
        const header = Buffer.alloc(WEBP_HEADER_BYTES);
        const { bytesRead } = await handle.read(header, 0, WEBP_HEADER_BYTES, 0);
        const size = webpSize(header.subarray(0, bytesRead));
        if (!size) throw new Error(`${file} is not a WebP file.`);
        return size;
    } finally {
        await handle.close();
    }
}

/**
 * Get LQIP base64 string for an image
 */
export function getLqipBase64(filename: string, paths: LibraryPaths = libraryPaths()): string | null {
    const lqipPath = path.join(paths.lqip, outputName('lqip', baseNameOf(filename)));
    
    if (fs.existsSync(lqipPath)) {
        return fs.readFileSync(lqipPath, 'utf-8');
    }
    
    return null;
}