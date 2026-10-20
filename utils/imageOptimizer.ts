import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

export interface LibraryPaths {
    root: string;
    thumbnails: string;
    medium: string;
    optimized: string;
    thumbnailsAvif: string;
    mediumAvif: string;
    optimizedAvif: string;
    lqip: string;
    /** Written only by the removed `/api/image` route. Nothing reads it now. */
    dynamicCache: string;
}

/**
 * Resolve the library root and its derivative folders. Reads
 * PHOTOGRAPHY_LIBRARY_DIR on every call, so tests and tools can point the
 * pipeline at another root without reloading this module.
 */
export function libraryPaths(): LibraryPaths {
    const root = path.resolve(
        process.env.PHOTOGRAPHY_LIBRARY_DIR || path.join(process.cwd(), 'public/assets/photos'),
    );
    return {
        root,
        thumbnails: path.join(root, 'thumbnails'),
        medium: path.join(root, 'medium'),
        optimized: path.join(root, 'optimized'),
        thumbnailsAvif: path.join(root, 'thumbnails-avif'),
        mediumAvif: path.join(root, 'medium-avif'),
        optimizedAvif: path.join(root, 'optimized-avif'),
        lqip: path.join(root, 'lqip'),
        dynamicCache: path.join(root, 'cache', 'dynamic'),
    };
}

const THUMBNAIL_WIDTH = 400;
const MEDIUM_WIDTH = 800;
const OPTIMIZED_WIDTH = 1920;
const LQIP_SIZE = 20;

/** `images:cleanup` deletes a leftover temp file only once it is this old, so it never races a running job. */
export const STALE_TEMP_FILE_MS = 10 * 60 * 1000;

const SOURCE_FILE = /\.(jpg|jpeg|png|webp)$/i;

/**
 * Matches the `.<base hash>.<pid>.<random>.tmp` files writeVariants() stages
 * beside each output. Hashing the base name keeps the length fixed, so a long
 * but valid photo name never makes the temp name too long.
 */
const TEMP_FILE = /^\.[0-9a-f]{16}\.\d+\.[0-9a-f]{8}\.tmp$/;

/** markStale() dates a thumbnail at the epoch. */
const STALE_TIME = new Date(0);

/**
 * A thumbnail dated before this counts as marked stale. FAT and exFAT can't
 * store 1970, so the epoch lands on 1980-01-01 there.
 */
const STALE_BEFORE_MS = Date.UTC(1980, 0, 2);

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

type DerivativeDir = Exclude<keyof LibraryPaths, 'root' | 'dynamicCache'>;

interface Variant {
    dir: DerivativeDir;
    ext: '.webp' | '.avif' | '.txt';
    encode(input: Buffer): Promise<Buffer | string>;
}

function resized(input: Buffer, width: number) {
    return sharp(input).resize(width, undefined, {
        fit: 'inside',
        withoutEnlargement: true,
    });
}

/** The Low Quality Image Placeholder, a tiny WebP as a data URL. Takes the image bytes or a file path. */
export async function encodeLqip(input: Buffer | string): Promise<string> {
    const lqipBuffer = await sharp(input)
        .resize(LQIP_SIZE, LQIP_SIZE, { fit: 'inside' })
        .webp({ quality: 20 })
        .toBuffer();
    return `data:image/webp;base64,${lqipBuffer.toString('base64')}`;
}

// The seven outputs and their encoder settings, in the order they are written.
const VARIANTS: readonly Variant[] = [
    { dir: 'thumbnails', ext: '.webp', encode: (input) => resized(input, THUMBNAIL_WIDTH).webp({ quality: 80 }).toBuffer() },
    { dir: 'medium', ext: '.webp', encode: (input) => resized(input, MEDIUM_WIDTH).webp({ quality: 85 }).toBuffer() },
    { dir: 'optimized', ext: '.webp', encode: (input) => resized(input, OPTIMIZED_WIDTH).webp({ quality: 85 }).toBuffer() },
    { dir: 'thumbnailsAvif', ext: '.avif', encode: (input) => resized(input, THUMBNAIL_WIDTH).avif({ quality: 60, effort: 4 }).toBuffer() },
    { dir: 'mediumAvif', ext: '.avif', encode: (input) => resized(input, MEDIUM_WIDTH).avif({ quality: 60, effort: 4 }).toBuffer() },
    { dir: 'optimizedAvif', ext: '.avif', encode: (input) => resized(input, OPTIMIZED_WIDTH).avif({ quality: 60, effort: 4 }).toBuffer() },
    { dir: 'lqip', ext: '.txt', encode: encodeLqip },
];

/** The seven derivative folders, taken from VARIANTS so the two never drift apart. */
const DERIVATIVE_DIRS: readonly DerivativeDir[] = VARIANTS.map((variant) => variant.dir);

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

function baseNameOf(filename: string): string {
    return path.basename(filename, path.extname(filename));
}

function hasErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code;
}

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
 * Get file paths for all versions of an image
 */
export function getImagePaths(filename: string, paths: LibraryPaths = libraryPaths()): ProcessedImagePaths {
    const baseName = baseNameOf(filename);
    const webpExt = '.webp';
    const avifExt = '.avif';
    
    return {
        original: `/assets/photos/${filename}`,
        thumbnail: `/assets/photos/thumbnails/${baseName}${webpExt}`,
        medium: `/assets/photos/medium/${baseName}${webpExt}`,
        optimized: `/assets/photos/optimized/${baseName}${webpExt}`,
        thumbnailAvif: `/assets/photos/thumbnails-avif/${baseName}${avifExt}`,
        mediumAvif: `/assets/photos/medium-avif/${baseName}${avifExt}`,
        optimizedAvif: `/assets/photos/optimized-avif/${baseName}${avifExt}`,
        lqip: `/assets/photos/lqip/${baseName}.txt`,
        hasThumbnail: fs.existsSync(path.join(paths.thumbnails, `${baseName}${webpExt}`)),
        hasMedium: fs.existsSync(path.join(paths.medium, `${baseName}${webpExt}`)),
        hasOptimized: fs.existsSync(path.join(paths.optimized, `${baseName}${webpExt}`)),
        hasThumbnailAvif: fs.existsSync(path.join(paths.thumbnailsAvif, `${baseName}${avifExt}`)),
        hasMediumAvif: fs.existsSync(path.join(paths.mediumAvif, `${baseName}${avifExt}`)),
        hasOptimizedAvif: fs.existsSync(path.join(paths.optimizedAvif, `${baseName}${avifExt}`)),
        hasLqip: fs.existsSync(path.join(paths.lqip, `${baseName}.txt`)),
    };
}

/**
 * Whether a source's derivatives are marked stale: they may show another file
 * that had this name, or a swap that never finished. Also true when the
 * thumbnail can't be checked, so nothing unverified is served as current.
 */
export function isMarkedStale(filename: string, paths: LibraryPaths = libraryPaths()): boolean {
    try {
        const thumbnail = fs.statSync(path.join(paths.thumbnails, `${baseNameOf(filename)}.webp`), { throwIfNoEntry: false });
        return thumbnail !== undefined && thumbnail.mtimeMs < STALE_BEFORE_MS;
    } catch {
        return true;
    }
}

/** The start of every temp file name writeVariants() uses for `baseName`. */
export function tempFilePrefix(baseName: string): string {
    return `.${createHash('sha256').update(baseName).digest('hex').slice(0, 16)}.`;
}

function tempPathFor(target: string, baseName: string): string {
    const name = `${tempFilePrefix(baseName)}${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    return path.join(path.dirname(target), name);
}

/**
 * Mark a source's derivatives stale by dating its thumbnail at the epoch, so the
 * next run regenerates them from whatever source then has that name, whatever
 * its mtime. Setting a file's times needs its owner, so this returns the error
 * instead of throwing. Returns null when it marked the set or there was none.
 */
export function markStale(filename: string): Error | null {
    const thumbnail = path.join(libraryPaths().thumbnails, `${baseNameOf(filename)}.webp`);
    try {
        fs.utimesSync(thumbnail, STALE_TIME, STALE_TIME);
        return null;
    } catch (error) {
        return hasErrorCode(error, 'ENOENT') ? null : (error as Error);
    }
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

/**
 * Generate an image's derivatives without exposing a partial set. Reads the
 * source once, encodes each needed output (all seven with `overwrite`, else
 * only the missing ones), writes it to a temp file beside its target with
 * fsync, and renames the temp files over the targets only after every one is
 * written. On failure it removes this attempt's temp files and rethrows, so
 * the previous outputs stay as they were. If the source changed or went away
 * while it encoded, as in a takedown, it discards the attempt the same way and
 * throws an error with `code` SOURCE_CHANGED.
 *
 * Returns the paths it replaced or created.
 */
export async function writeVariants(filename: string, { overwrite }: { overwrite: boolean }): Promise<string[]> {
    const paths = libraryPaths();
    ensureDirectories(paths);
    const baseName = baseNameOf(filename);
    const sourcePath = path.join(paths.root, filename);
    const needed = VARIANTS
        .map((variant) => ({ variant, target: path.join(paths[variant.dir], `${baseName}${variant.ext}`) }))
        .filter(({ target }) => overwrite || !fs.existsSync(target));
    if (needed.length === 0) return [];

    // Checked before the read and again before the swap, so a change in between is caught
    const before = await fs.promises.stat(sourcePath);
    const input = await fs.promises.readFile(sourcePath);

    const staged: { temp: string; target: string; dir: DerivativeDir }[] = [];
    try {
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

        // Dated no earlier than its source, so the next start doesn't take a source
        // dated in the future for a newer one and encode it again. The extra
        // millisecond covers utimes() rounding down.
        const thumbnail = staged.find(({ dir }) => dir === 'thumbnails');
        if (thumbnail) {
            const time = new Date(Math.max(Date.now(), Math.ceil(before.mtimeMs) + 1));
            await fs.promises.utimes(thumbnail.temp, time, time);
        }

        // A takedown or a newer save may have landed while this job encoded
        const after = await fs.promises.stat(sourcePath).catch(() => undefined);
        if (!sameFileVersion(before, after)) {
            throw Object.assign(
                new Error(`${filename} changed or was removed while it was processed, so its new outputs were discarded.`),
                { code: SOURCE_CHANGED },
            );
        }
    } catch (error) {
        await removeQuietly(staged.map(({ temp }) => temp));
        throw error;
    }

    // isSourceNewer() compares the source with the thumbnail, so mark the old one
    // stale and rename it last. An interrupted swap then gets redone on the next run.
    const order = [
        ...staged.filter(({ dir }) => dir !== 'thumbnails'),
        ...staged.filter(({ dir }) => dir === 'thumbnails'),
    ];
    if (order.length > 0 && order[order.length - 1].dir === 'thumbnails') {
        const failure = markStale(filename);
        if (failure) {
            console.error(
                `[imageOptimizer] Could not mark ${filename}'s old thumbnail stale before replacing it: ${failure.message}. ` +
                'If this swap is interrupted, the next run may not redo it.',
            );
        }
    }

    let renamed = 0;
    try {
        for (const { temp, target } of order) {
            await fs.promises.rename(temp, target);
            renamed++;
        }
    } catch (error) {
        await removeQuietly(order.slice(renamed).map(({ temp }) => temp));
        console.error(
            `[imageOptimizer] Renaming ${filename}'s new outputs failed after replacing ${renamed} of ${order.length}.` +
            (renamed > 0 ? ' Its derivatives may mix old and new versions until it is processed again.' : ''),
        );
        throw error;
    }

    return order.map(({ target }) => target);
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
function isSourceNewer(filename: string): boolean {
    const paths = libraryPaths();
    const sourcePath = path.join(paths.root, filename);
    const baseName = baseNameOf(filename);
    const thumbnailPath = path.join(paths.thumbnails, `${baseName}.webp`);
    
    // A file removed mid-check counts as missing instead of throwing
    const source = fs.statSync(sourcePath, { throwIfNoEntry: false });
    if (!source) return false;
    const thumbnail = fs.statSync(thumbnailPath, { throwIfNoEntry: false });
    if (!thumbnail) return true;
    
    // Marked stale when an event was queued, on unlink, or before a swap that may not have finished
    if (thumbnail.mtimeMs < STALE_BEFORE_MS) return true;
    
    return source.mtimeMs > thumbnail.mtimeMs;
}

/**
 * Get list of files that need processing
 */
export function getUnprocessedFiles(): string[] {
    ensureDirectories();
    const files = getPhotoFiles();
    
    return files.filter(file => {
        const paths = getImagePaths(file);
        
        // Check if any version is missing
        const needsProcessing = !paths.hasThumbnail || 
            !paths.hasMedium || 
            !paths.hasOptimized ||
            !paths.hasThumbnailAvif || 
            !paths.hasMediumAvif || 
            !paths.hasOptimizedAvif ||
            !paths.hasLqip;
        
        if (needsProcessing) return true;
        
        // Check if source is newer (cache-bust)
        return isSourceNewer(file);
    });
}

/**
 * Regenerate all seven outputs from the current source bytes. The old outputs
 * keep serving until every new one is written.
 */
export async function reprocessImage(filename: string): Promise<ProcessedImagePaths> {
    await writeVariants(filename, { overwrite: true });
    return getImagePaths(filename);
}
    
/** The sources the watcher's startup batch works on: every source with `force`, else the unprocessed ones. */
export function filesToProcess({ force = false }: { force?: boolean } = {}): string[] {
    return force ? getPhotoFiles() : getUnprocessedFiles();
}

/**
 * The startup batch's overwrite rule for one source: regenerate all seven
 * outputs when forced, when any of them is missing, or when the source is
 * newer than them. A missing one next to existing ones may come from a
 * different version, so filling in only the gap could leave a mixed set.
 */
export function refreshImage(filename: string, { force = false }: { force?: boolean } = {}): Promise<string[]> {
    const outputs = getImagePaths(filename);
    const complete = outputs.hasThumbnail && outputs.hasMedium && outputs.hasOptimized &&
        outputs.hasThumbnailAvif && outputs.hasMediumAvif && outputs.hasOptimizedAvif && outputs.hasLqip;
    return writeVariants(filename, { overwrite: force || !complete || isSourceNewer(filename) });
}

export type OrphanReason =
    | `no source named ${string}.*`
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
    /** Limit the plan to one photo's base name, for a takedown. */
    only?: string | null;
    now?: number;
}

export interface OrphanCleanupPlan {
    root: string;
    allowEmptyLibrary: boolean;
    only: string | null;
    entries: OrphanEntry[];
    /** Temp files kept because a running job may still own them */
    youngTempFiles: string[];
    /** Folders cleanup didn't enter because they are symlinks or not folders */
    skippedFolders: string[];
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

/** `/api/image` cached files as `<base>-<width>-<quality>.<format>`. */
const DYNAMIC_CACHE_FILE = /^(.+)-\d+-\d+\.(avif|webp|jpeg)$/;

/**
 * Compares base names the way a case-insensitive disk does, so a case-only
 * rename keeps a live photo's derivatives instead of orphaning them.
 */
function sourceKey(base: string): string {
    return base.normalize('NFC').toLowerCase();
}

interface SourceSet {
    any: boolean;
    has(base: string): boolean;
}

function sourceSet(sourceFiles: string[]): SourceSet {
    const keys = new Set(sourceFiles.map((file) => sourceKey(baseNameOf(file))));
    return { any: keys.size > 0, has: (base) => keys.has(sourceKey(base)) };
}

/** The folders cleanup reads, each with the folders that must be real directories before it enters. */
function scannedFolders(paths: LibraryPaths): { dir: string; guards: string[] }[] {
    return [
        ...DERIVATIVE_DIRS.map((key) => ({ dir: paths[key], guards: [paths[key]] })),
        { dir: paths.dynamicCache, guards: [path.dirname(paths.dynamicCache), paths.dynamicCache] },
    ];
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

function classify(
    file: string,
    paths: LibraryPaths,
    sources: SourceSet,
    { allowEmptyLibrary, only, now }: { allowEmptyLibrary: boolean; only: string | null; now: number },
): Verdict {
    if (!libraryRootExists(paths.root)) return KEEP;

    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(file);
    } catch {
        return KEEP; // Already gone
    }
    if (!stat.isFile()) return KEEP;

    const name = path.basename(file);
    if (path.dirname(file) === paths.dynamicCache) {
        const cached = DYNAMIC_CACHE_FILE.exec(name);
        if (only !== null && (!cached || sourceKey(cached[1]) !== sourceKey(only))) return KEEP;
        return { kind: 'delete', reason: 'unused since /api/image was removed', bytes: stat.size };
    }
    if (TEMP_FILE.test(name)) {
        if (only !== null && !name.startsWith(tempFilePrefix(only))) return KEEP;
        return now - stat.mtimeMs >= STALE_TEMP_FILE_MS
            ? { kind: 'delete', reason: 'stale temp file', bytes: stat.size }
            : { kind: 'young-temp' };
    }

    const base = baseNameOf(name);
    if (only !== null && sourceKey(base) !== sourceKey(only)) return KEEP;
    if (sources.has(base)) return KEEP;
    // A library that lost every source is more likely unmounted or mid-sync than retired.
    if (!sources.any && !allowEmptyLibrary) return KEEP;
    return { kind: 'delete', reason: `no source named ${base}.*`, bytes: stat.size };
}

function listFiles(dir: string): string[] {
    try {
        return fs.readdirSync(dir).sort();
    } catch {
        return [];
    }
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

/**
 * Plan which derivatives no source needs anymore, without touching anything.
 * Refuses a missing root, and a root with no sources unless
 * `allowEmptyLibrary`, because either would make every derivative look orphaned.
 */
export function planOrphanCleanup(
    { allowEmptyLibrary = false, only = null, now = Date.now() }: OrphanCleanupOptions = {},
): OrphanCleanupPlan {
    const paths = libraryPaths();
    if (!libraryRootExists(paths.root)) {
        throw new CleanupRefusedError(
            `library root not found: ${paths.root}. Check the mount or PHOTOGRAPHY_LIBRARY_DIR.`,
        );
    }
    const sourceFiles = getPhotoFiles();
    if (sourceFiles.length === 0 && !allowEmptyLibrary) {
        throw new CleanupRefusedError(
            `${paths.root} has no source photos, so every derivative would count as an orphan. ` +
            'Pass --allow-empty-library if the library is meant to be empty.',
        );
    }

    const sources = sourceSet(sourceFiles);
    const options = { allowEmptyLibrary, only, now };
    const entries: OrphanEntry[] = [];
    const youngTempFiles: string[] = [];
    const skippedFolders: string[] = [];
    for (const { dir, guards } of scannedFolders(paths)) {
        const guard = guardState(guards);
        if (guard.state === 'unsafe') skippedFolders.push(relativeTo(paths.root, guard.at));
        if (guard.state !== 'ok') continue;

        for (const name of listFiles(dir)) {
            const file = path.join(dir, name);
            const relativePath = relativeTo(paths.root, file);
            const verdict = classify(file, paths, sources, options);
            if (verdict.kind === 'delete') {
                entries.push({ path: file, relativePath, reason: verdict.reason, bytes: verdict.bytes });
            } else if (verdict.kind === 'young-temp') {
                youngTempFiles.push(relativePath);
            }
        }
    }
    
    return {
        root: paths.root,
        allowEmptyLibrary,
        only,
        entries,
        youngTempFiles,
        skippedFolders,
        hash: planHash(paths.root, allowEmptyLibrary, only, entries),
    };
}

/**
 * Delete a plan's entries, re-checking each one right before deleting it.
 * Lists the sources once, fresh, and keeps everything if it can't. An entry
 * that no longer qualifies for the same reason (its source came back, its
 * folder became a symlink, a temp file was touched) is skipped.
 */
export function applyOrphanCleanup(
    plan: OrphanCleanupPlan,
    { now = Date.now() }: { now?: number } = {},
): OrphanCleanupResult {
    const paths = libraryPaths();
    if (paths.root !== plan.root) {
        throw new CleanupRefusedError(`the plan is for ${plan.root}, but the library root is now ${paths.root}.`);
    }
    
    const result: OrphanCleanupResult = { deleted: [], skipped: [], failed: [] };
    let sources: SourceSet;
    try {
        sources = sourceSet(getPhotoFiles());
    } catch {
        result.skipped.push(...plan.entries);
        return result;
    }

    const options = { allowEmptyLibrary: plan.allowEmptyLibrary, only: plan.only, now };
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

/**
 * Get LQIP base64 string for an image
 */
export function getLqipBase64(filename: string, paths: LibraryPaths = libraryPaths()): string | null {
    const lqipPath = path.join(paths.lqip, `${baseNameOf(filename)}.txt`);
    
    if (fs.existsSync(lqipPath)) {
        return fs.readFileSync(lqipPath, 'utf-8');
    }
    
    return null;
}