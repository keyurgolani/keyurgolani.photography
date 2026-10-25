import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { CACHE_FOLDER, DERIVATIVE_FOLDERS } from '../lib/derivativeFolders.mjs';
import { foldName } from '../lib/foldName';
import { atomicWriteFile } from '../lib/storage/atomicWrite';
import { libraryRoot } from '../lib/storage/config';
import { hasErrorCode } from '../lib/storage/fsx';
import { baseNameOf, sameFile, setGroups, setKeyOf, sharesSet } from './derivativeSets';

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

const SOURCE_FILE = /\.(jpg|jpeg|png|webp)$/i;

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

/** The shared errno check, re-exported for callers of the image pipeline. */
export { hasErrorCode };

/** The set grouping, which lives in derivativeSets.ts so the web process can use it without Sharp. */
export { baseNameOf, setGroups, setKeyOf, sharesSet };

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

/**
 * `.<base hash>.<pid>.<random>.tmp` beside `target`. Hashing the base name
 * keeps the length fixed, so a long but valid photo name never makes the temp
 * name too long.
 */
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
 * Before the first rename it records in `cache/set-sources` that a build
 * from this source started, and after the last one that it finished, so a
 * build killed partway is rebuilt at the next start. When that first record
 * can't be written and the set was last built whole from another source
 * that's still in the library, it renames nothing.
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

    // Recorded before the first rename, so a build killed or failed partway leaves a record that says so, not
    // the source the set showed before, and the next start rebuilds the set even if the source it took over from
    // is gone by then.
    try {
        await recordSetSource(filename, paths, { finished: false });
    } catch (error) {
        // Without the record, a build stopped partway over a set last built whole from another source that's
        // still here would leave it part each, while the old record still says the other built it, and once that
        // source is removed nothing says the set needs rebuilding. So that set keeps the other source's outputs.
        // Any other set goes ahead: its old outputs show this source, or one that's gone or replaced, so keeping
        // them protects nothing.
        const built = lastBuiltFrom(filename, paths);
        if (built !== null && built !== filename && setMembers(filename, paths).includes(built)) {
            await removeQuietly(order.map(({ temp }) => temp));
            console.error(`[imageOptimizer] Couldn't record that ${filename}'s set is being rebuilt, so it keeps the outputs of ${built}, which built it last: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    let renamed = 0;
    try {
        for (const { temp, target, dir } of order) {
            await matchSpelling(target, index.get(dir));
            await fs.promises.rename(temp, target);
            renamed++;
        }
    } catch (error) {
        // The record still says the build didn't finish, so the next start rebuilds the set.
        await removeQuietly(order.slice(renamed).map(({ temp }) => temp));
        console.error(
            `[imageOptimizer] Renaming ${filename}'s new outputs failed after replacing ${renamed} of ${order.length}.` +
            (renamed > 0 ? ' Its derivatives may mix old and new versions until it is processed again.' : ''),
        );
        throw error;
    }

    if (overwrite) purgeDynamicCache(baseName, paths);
    // A fill of only the missing outputs leaves a set some other source may have built the rest of.
    if (order.length === VARIANTS.length) {
        try {
            await recordSetSource(filename, paths, { finished: true });
        } catch (error) {
            // The record still says the build didn't finish, so the next start rebuilds the set.
            console.error(`[imageOptimizer] Couldn't record that ${filename}'s set was built from it: ${error instanceof Error ? error.message : String(error)}`);
        }
    } else {
        forgetSetSource(filename, paths);
    }
    return order.map(({ target }) => target);
}

/** Whether each folder is a real directory. lstat, so a symlink never counts and nothing follows one out of the library. */
function realFolders(dirs: string[]): boolean {
    return dirs.every((dir) => {
        try {
            return fs.lstatSync(dir).isDirectory();
        } catch {
            return false;
        }
    });
}

/**
 * Delete `/api/image`'s cached copies of one photo, which still serve its
 * previous version as static files. Matches the cached file's base exactly, so
 * `landscape` leaves `landscape-edited` alone, and never follows a symlinked
 * cache folder out of the library.
 */
function purgeDynamicCache(baseName: string, paths: LibraryPaths): void {
    if (!realFolders([path.dirname(paths.dynamicCache), paths.dynamicCache])) return;
    let names: string[];
    try {
        names = listNames(paths.dynamicCache);
    } catch {
        return; // Best effort, after the new set is in place.
    }
    for (const name of names) {
        if (DYNAMIC_CACHE_FILE.exec(name)?.[1] !== baseName) continue;
        try {
            fs.unlinkSync(path.join(paths.dynamicCache, name));
        } catch {
            // Gone already, or not removable.
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

/** The library's sources that write `filename`'s set, in path order, `filename` among them while it exists. */
export function setMembers(filename: string, paths: LibraryPaths = libraryPaths()): string[] {
    return getPhotoFiles(paths.root).filter((file) => sharesSet(filename, file, paths.root)).sort();
}

/** What decodes() found for each path, kept while the file keeps its inode, size, and times. */
const decoded = new Map<string, { version: string; ok: boolean }>();

/**
 * The source that last wrote `owner`'s set whole, from its record in
 * `cache/set-sources`, or null when that's unknown, as after a partial fill,
 * a build that failed or was killed partway, or a set written before the
 * record. A builder that only shares the set's key, as two spellings do on a
 * case-sensitive disk, doesn't count.
 */
export function lastBuiltFrom(owner: string, paths: LibraryPaths = libraryPaths()): string | null {
    const record = readSetSource(owner, paths);
    return record !== null && record.finished && sharesSet(record.source, owner, paths.root) ? record.source : null;
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

/**
 * Where the watcher records, once per library, that it rebuilt the sets of
 * the orientation-tagged photos: in the cache folder, which nothing serves
 * and the scans skip.
 */
export function uprightMarkerPath(paths: LibraryPaths = libraryPaths()): string {
    return path.join(path.dirname(paths.dynamicCache), 'upright-rebuild.json');
}

/** Create each folder in turn, one level at a time, so a missing library root is never created. */
function makeFolders(...dirs: string[]): void {
    for (const dir of dirs) {
        try {
            fs.mkdirSync(dir);
        } catch (error) {
            if (!hasErrorCode(error, 'EEXIST')) throw error;
        }
    }
}

/**
 * Record that the one-time rebuild is done, apart from `retry`, the photos
 * whose rebuild failed, which later starts rebuild until it works. Creates
 * the cache folder, never the library root.
 */
export function writeUprightMarker(photos: number, paths: LibraryPaths = libraryPaths(), now: Date = new Date(), retry: readonly string[] = []): void {
    const file = uprightMarkerPath(paths);
    makeFolders(path.dirname(file));
    const record = { rebuiltAt: now.toISOString(), photos, ...(retry.length > 0 ? { retry: [...retry].sort() } : {}) };
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * The photos the one-time rebuild still has to turn upright: null when it
 * never ran, so every orientation-tagged photo needs it, else the ones its
 * record lists to retry. A record that can't be parsed counts as done with
 * nothing to retry, as a record written before the list was.
 */
export function readUprightRetry(paths: LibraryPaths = libraryPaths()): string[] | null {
    const file = uprightMarkerPath(paths);
    let text: string;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return null;
        return [];
    }
    try {
        const { retry } = JSON.parse(text) as { retry?: unknown };
        return Array.isArray(retry) ? retry.filter((file): file is string => typeof file === 'string') : [];
    } catch {
        return [];
    }
}

/**
 * Whether the watcher can write the library's cache folder, where it records
 * the one-time rebuild and the source each shared set was built from: the
 * folder is writable, or it doesn't exist yet and the library root is.
 */
export function cacheFolderWritable(paths: LibraryPaths = libraryPaths()): boolean {
    const dir = path.dirname(paths.dynamicCache);
    try {
        if (!fs.statSync(dir).isDirectory()) return false;
        fs.accessSync(dir, fs.constants.W_OK);
        return true;
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) return false;
    }
    try {
        fs.accessSync(paths.root, fs.constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

/** `cache/set-sources`, where each set records the source it was last built from. */
function setSourcesDir(paths: LibraryPaths): string {
    return path.join(path.dirname(paths.dynamicCache), 'set-sources');
}

/**
 * Where a set records the source it was last built from:
 * `cache/set-sources/<base name>.json`, which nothing serves and the scans
 * skip. Named like the set's files, so sources that share a set share it.
 */
function setSourceFile(filename: string, paths: LibraryPaths): string {
    return path.join(setSourcesDir(paths), `${baseNameOf(filename)}.json`);
}

/**
 * What `cache/set-sources` records for the set `filename` writes: the source
 * a build of it started from, and whether that build finished. Null when
 * nothing records it. An unfinished one may have left the set partly that
 * source's and partly what it showed before.
 */
export interface SetSourceRecord {
    source: string;
    finished: boolean;
}

/** The record of the set `filename` writes, or null when nothing records it. */
export function readSetSource(filename: string, paths: LibraryPaths = libraryPaths()): SetSourceRecord | null {
    try {
        const value = JSON.parse(fs.readFileSync(setSourceFile(filename, paths), 'utf8')) as { source?: unknown; complete?: unknown } | null;
        return typeof value?.source === 'string' ? { source: value.source, finished: value.complete !== false } : null;
    } catch {
        return null;
    }
}

/**
 * Record that a build of `filename`'s set from it starts, or with `finished`
 * that it just wrote the whole set. Creates the folders under the library
 * root, never the root. Replaces the record atomically and fsyncs it and its
 * folder, so once it returns the record is on disk ahead of any rename that
 * follows, and a write torn by a crash leaves the old record, not an empty one.
 * Readable like the set's outputs, not only by its owner, and staged under
 * the outputs' fixed-length temp name.
 */
async function recordSetSource(filename: string, paths: LibraryPaths, { finished }: { finished: boolean }): Promise<void> {
    const file = setSourceFile(filename, paths);
    makeFolders(path.dirname(path.dirname(file)), path.dirname(file));
    const record = finished ? { source: filename } : { source: filename, complete: false };
    await atomicWriteFile(file, `${JSON.stringify(record)}\n`, { mode: 0o666, tempPath: tempPathFor(file, baseNameOf(filename)) });
}

/** Drop `filename`'s set's record, when the set may no longer be all its own. */
function forgetSetSource(filename: string, paths: LibraryPaths): void {
    try {
        fs.rmSync(setSourceFile(filename, paths), { force: true });
    } catch (error) {
        console.error(`[imageOptimizer] Couldn't remove the record of which source ${filename}'s set was built from: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Whether `filename`'s set may show another source: when it was last built
 * from one, such as the owner before it, or a build of it didn't finish.
 * False when nothing records it.
 */
function builtFromAnother(filename: string, paths: LibraryPaths): boolean {
    const record = readSetSource(filename, paths);
    return record !== null && (!record.finished || record.source !== filename);
}

/** Whether a source's file carries an EXIF orientation other than 1, which its set turns upright. Null when it can't be read, so nobody knows. */
export async function isOrientationTagged(filename: string, paths: LibraryPaths = libraryPaths()): Promise<boolean | null> {
    try {
        const { orientation } = await sharp(path.join(paths.root, filename)).metadata();
        return orientation !== undefined && orientation !== 1;
    } catch {
        return null;
    }
}

export interface SourcePlan {
    /** The owners whose sets need building: all of them with `force`, else those needsRefresh() names and those in `upright` and `reowned`. */
    files: string[];
    /**
     * The owners whose set shows another source, rebuilt whatever their state:
     * one last built from `from`, such as an owner removed while the watcher
     * was down, one whose build from `from` didn't finish, marked
     * `unfinished`, and a shared set nothing records the source of, with
     * `from` null, since sets written before the record could show either
     * source.
     */
    reowned: { file: string; from: string | null; unfinished?: true }[];
    /**
     * The owners whose files carry an orientation tag, or can't be read to
     * tell, rebuilt once whatever their state: a set written before
     * derivatives were turned upright shows its photo turned or mirrored, and
     * still looks current. Once the marker records the rebuild done, only the
     * ones it lists to retry, and null when it lists none.
     */
    upright: string[] | null;
    /** The sources left out because another one owns their set, and whether each was passed over for not decoding. */
    shared: { file: string; owner: string; undecodable: boolean }[];
}

/** What the watcher's startup batch builds, and which sources it leaves out. Throws on a missing root. */
export async function planSources({ force = false }: { force?: boolean } = {}): Promise<SourcePlan> {
    const paths = libraryPaths();
    ensureDirectories(paths);
    // Null: the rebuild never ran, so every owner is a candidate.
    const retry = readUprightRetry(paths);
    const upright: string[] | null = retry === null || retry.length > 0 ? [] : null;
    const candidate = (owner: string) => retry === null || retry.includes(owner);
    const plan: SourcePlan = { files: [], reowned: [], upright, shared: [] };
    const index = force ? null : readDerivativeIndex(paths);
    for (const group of setGroups(getPhotoFiles(paths.root), paths.root)) {
        const { owner, undecodable } = await pickOwner(group, paths);
        for (const file of group) if (file !== owner) plan.shared.push({ file, owner, undecodable: undecodable.includes(file) });
        const tagged = upright !== null && candidate(owner) && (await isOrientationTagged(owner, paths)) !== false;
        if (tagged) upright.push(owner);
        // A removal or an addition while the watcher was down can change a set's owner without touching its files.
        // So can a build that didn't finish, even of a set that has one source now.
        const recorded = readSetSource(owner, paths);
        const unfinished = recorded !== null && !recorded.finished;
        const reowned = recorded === null ? group.length > 1 : unfinished || recorded.source !== owner;
        if (reowned) plan.reowned.push({ file: owner, from: recorded?.source ?? null, ...(unfinished ? { unfinished: true as const } : {}) });
        if (index === null || tagged || reowned || needsRefresh(owner, paths, index)) plan.files.push(owner);
    }
    return plan;
}

/**
 * The sources the watcher's startup batch works on: the owner of each set,
 * every one with `force`, else the unprocessed ones, those whose set shows
 * another source, and, until the one-time upright rebuild is recorded, the
 * orientation-tagged ones. Both throw on a missing root.
 */
export async function filesToProcess({ force = false }: { force?: boolean } = {}): Promise<string[]> {
    return (await planSources({ force })).files;
}

/**
 * The overwrite rule the startup batch and a live `add` use: regenerate all
 * seven outputs when forced, when needsRefresh() says so, or when the set was
 * last built from another source, and otherwise do nothing. A source that
 * sorts ahead of a set's owner takes it over even with an older modification
 * time. A missing one next to existing ones may come from a different
 * version, so filling in only the gap could leave a mixed set. A source whose
 * set another source owns writes nothing. `owns` skips that check, for a
 * caller that just made it.
 *
 * Returns the paths it replaced, none when the set was already current.
 */
export async function refreshImage(filename: string, { force = false, owns = false }: { force?: boolean; owns?: boolean } = {}): Promise<string[]> {
    const paths = libraryPaths();
    if (!owns && await ownerOf(filename, paths) !== filename) return [];
    if (!force && !needsRefresh(filename, paths) && !builtFromAnother(filename, paths)) return [];
    return writeVariants(filename, { overwrite: true, paths });
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