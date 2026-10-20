import { randomBytes } from 'crypto';
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

export const THUMBNAIL_WIDTH = 400;
export const MEDIUM_WIDTH = 800;
export const OPTIMIZED_WIDTH = 1920;
export const LQIP_SIZE = 20;

/** `images:cleanup` deletes a leftover temp file only once it is this old, so it never races a running job. */
export const STALE_TEMP_FILE_MS = 10 * 60 * 1000;

const SOURCE_FILE = /\.(jpg|jpeg|png|webp)$/i;

/** Matches the `.<base>.<pid>.<random>.tmp` files writeVariants() stages beside each output. */
const TEMP_FILE = /^\..+\.\d+\.[0-9a-f]+\.tmp$/;

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

const DERIVATIVE_DIRS: readonly DerivativeDir[] = [
    'thumbnails',
    'medium',
    'optimized',
    'lqip',
    'thumbnailsAvif',
    'mediumAvif',
    'optimizedAvif',
];

export class LibraryRootMissingError extends Error {
    readonly root: string;

    constructor(root: string) {
        super(`Library root not found: ${root}`);
        this.name = 'LibraryRootMissingError';
        this.root = root;
    }
}

export function libraryRootExists(root: string = libraryPaths().root): boolean {
    try {
        return fs.statSync(root).isDirectory();
    } catch {
        return false;
    }
}

export function isSourceFile(filename: string): boolean {
    return SOURCE_FILE.test(filename);
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
export function ensureDirectories(): void {
    const paths = libraryPaths();
    if (!libraryRootExists(paths.root)) {
        throw new LibraryRootMissingError(paths.root);
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
export function getImagePaths(filename: string): ProcessedImagePaths {
    const paths = libraryPaths();
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

// The seven outputs and their encoder settings, in the order they are written.
const VARIANTS: readonly Variant[] = [
    { dir: 'thumbnails', ext: '.webp', encode: (input) => resized(input, THUMBNAIL_WIDTH).webp({ quality: 80 }).toBuffer() },
    { dir: 'medium', ext: '.webp', encode: (input) => resized(input, MEDIUM_WIDTH).webp({ quality: 85 }).toBuffer() },
    { dir: 'optimized', ext: '.webp', encode: (input) => resized(input, OPTIMIZED_WIDTH).webp({ quality: 85 }).toBuffer() },
    { dir: 'thumbnailsAvif', ext: '.avif', encode: (input) => resized(input, THUMBNAIL_WIDTH).avif({ quality: 60, effort: 4 }).toBuffer() },
    { dir: 'mediumAvif', ext: '.avif', encode: (input) => resized(input, MEDIUM_WIDTH).avif({ quality: 60, effort: 4 }).toBuffer() },
    { dir: 'optimizedAvif', ext: '.avif', encode: (input) => resized(input, OPTIMIZED_WIDTH).avif({ quality: 60, effort: 4 }).toBuffer() },
    {
        dir: 'lqip',
        ext: '.txt',
        // Low Quality Image Placeholder, stored as a data URL
        encode: async (input) => {
            const lqipBuffer = await sharp(input)
                .resize(LQIP_SIZE, LQIP_SIZE, { fit: 'inside' })
                .webp({ quality: 20 })
                .toBuffer();
            return `data:image/webp;base64,${lqipBuffer.toString('base64')}`;
        },
    },
];

function tempPathFor(target: string, baseName: string): string {
    const name = `.${baseName}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    return path.join(path.dirname(target), name);
}

async function removeQuietly(files: string[]): Promise<void> {
    await Promise.all(files.map((file) => fs.promises.rm(file, { force: true }).catch(() => undefined)));
}

/**
 * Generate an image's derivatives without exposing a partial set. Reads the
 * source once, encodes each needed output (all seven with `overwrite`, else
 * only the missing ones), writes it to a temp file beside its target with
 * fsync, and renames the temp files over the targets only after every one is
 * written. On failure it removes this attempt's temp files and rethrows, so
 * the previous outputs stay as they were.
 *
 * Returns the paths it replaced or created.
 */
export async function writeVariants(filename: string, { overwrite }: { overwrite: boolean }): Promise<string[]> {
    ensureDirectories();
    const paths = libraryPaths();
    const baseName = baseNameOf(filename);
    const needed = VARIANTS
        .map((variant) => ({ variant, target: path.join(paths[variant.dir], `${baseName}${variant.ext}`) }))
        .filter(({ target }) => overwrite || !fs.existsSync(target));
    if (needed.length === 0) return [];

    const input = await fs.promises.readFile(path.join(paths.root, filename));

    const staged: { temp: string; target: string }[] = [];
    try {
        for (const { variant, target } of needed) {
            const data = await variant.encode(input);
            const temp = tempPathFor(target, baseName);
            const handle = await fs.promises.open(temp, 'wx');
            staged.push({ temp, target });
            try {
                await handle.writeFile(data);
                await handle.sync();
            } finally {
                await handle.close();
            }
        }
    } catch (error) {
        await removeQuietly(staged.map(({ temp }) => temp));
        throw error;
    }

    let renamed = 0;
    try {
        for (const { temp, target } of staged) {
            await fs.promises.rename(temp, target);
            renamed++;
        }
    } catch (error) {
        await removeQuietly(staged.slice(renamed).map(({ temp }) => temp));
        console.error(
            `[imageOptimizer] Renaming ${filename}'s new outputs failed after replacing ${renamed} of ${staged.length}.` +
            (renamed > 0 ? ' Its derivatives may mix old and new versions until it is processed again.' : ''),
        );
        throw error;
    }

    return staged.map(({ target }) => target);
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
export function getPhotoFiles(): string[] {
    const { root } = libraryPaths();
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
    
    if (!fs.existsSync(sourcePath)) return false;
    
    const sourceMtime = fs.statSync(sourcePath).mtimeMs;
    
    // Check against thumbnail as representative of all processed files
    const thumbnailPath = path.join(paths.thumbnails, `${baseName}.webp`);
    if (!fs.existsSync(thumbnailPath)) return true;
    
    const thumbMtime = fs.statSync(thumbnailPath).mtimeMs;
    return sourceMtime > thumbMtime;
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

/** The sources processAllImages() works on: every source with `force`, else the unprocessed ones. */
export function filesToProcess({ force = false }: { force?: boolean } = {}): string[] {
    return force ? getPhotoFiles() : getUnprocessedFiles();
}

/**
 * processAllImages()'s overwrite rule for one source: regenerate all seven
 * outputs when forced or when the source is newer than its outputs, and
 * otherwise only fill in missing ones.
 */
export function refreshImage(filename: string, { force = false }: { force?: boolean } = {}): Promise<string[]> {
    return writeVariants(filename, { overwrite: force || isSourceNewer(filename) });
}

/**
 * Process all unprocessed images. `force` regenerates every source.
 */
export async function processAllImages(progressCallback?: (current: number, total: number, file: string) => void, { force = false }: { force?: boolean } = {}): Promise<{
    processed: string[];
    errors: { file: string; error: Error }[];
}> {
    const files = filesToProcess({ force });
    const processed: string[] = [];
    const errors: { file: string; error: Error }[] = [];
    
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
            progressCallback?.(i + 1, files.length, file);
            await refreshImage(file, { force });
            processed.push(file);
        } catch (error) {
            errors.push({ file, error: error as Error });
        }
    }
    
    return { processed, errors };
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

export interface OrphanCleanupPlan {
    root: string;
    allowEmptyLibrary: boolean;
    entries: OrphanEntry[];
    /** Temp files kept because a running job may still own them */
    youngTempFiles: string[];
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

/** Answers whether the library holds any source, and one named `<base>.*`. */
type SourceLookup = (base: string) => { any: boolean; forBase: boolean };

function sourceSet(bases: Set<string>): SourceLookup {
    return (base) => ({ any: bases.size > 0, forBase: bases.has(base) });
}

/** Lists the root on every call, so a re-check sees sources restored since the plan. */
function freshSources(root: string): SourceLookup {
    return (base) => {
        let names: string[];
        try {
            names = fs.readdirSync(root);
        } catch {
            return { any: false, forBase: false };
        }

        let any = false;
        for (const name of names) {
            if (!isSourceFile(name)) continue;
            const matchesBase = baseNameOf(name) === base;
            if (any && !matchesBase) continue;
            try {
                if (fs.statSync(path.join(root, name)).isDirectory()) continue;
            } catch {
                continue;
            }
            any = true;
            if (matchesBase) return { any, forBase: true };
        }
        return { any, forBase: false };
    };
}

function classify(
    file: string,
    paths: LibraryPaths,
    sources: SourceLookup,
    allowEmptyLibrary: boolean,
    now: number,
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
        return { kind: 'delete', reason: 'unused since /api/image was removed', bytes: stat.size };
    }
    if (TEMP_FILE.test(name)) {
        return now - stat.mtimeMs >= STALE_TEMP_FILE_MS
            ? { kind: 'delete', reason: 'stale temp file', bytes: stat.size }
            : { kind: 'young-temp' };
    }

    const base = baseNameOf(name);
    const found = sources(base);
    if (found.forBase) return KEEP;
    // A library that lost every source is more likely unmounted or mid-sync than retired.
    if (!found.any && !allowEmptyLibrary) return KEEP;
    return { kind: 'delete', reason: `no source named ${base}.*`, bytes: stat.size };
}

function listFiles(dir: string): string[] {
    try {
        return fs.readdirSync(dir).sort();
    } catch {
        return [];
    }
}

/**
 * Plan which derivatives no source needs anymore, without touching anything.
 * Refuses a missing root, and a root with no sources unless
 * `allowEmptyLibrary`, because either would make every derivative look orphaned.
 */
export function planOrphanCleanup(
    { allowEmptyLibrary = false, now = Date.now() }: { allowEmptyLibrary?: boolean; now?: number } = {},
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

    const sources = sourceSet(new Set(sourceFiles.map(baseNameOf)));
    const entries: OrphanEntry[] = [];
    const youngTempFiles: string[] = [];
    for (const dir of [...DERIVATIVE_DIRS.map((key) => paths[key]), paths.dynamicCache]) {
        for (const name of listFiles(dir)) {
            const file = path.join(dir, name);
            const relativePath = path.relative(paths.root, file).split(path.sep).join('/');
            const verdict = classify(file, paths, sources, allowEmptyLibrary, now);
            if (verdict.kind === 'delete') {
                entries.push({ path: file, relativePath, reason: verdict.reason, bytes: verdict.bytes });
            } else if (verdict.kind === 'young-temp') {
                youngTempFiles.push(relativePath);
            }
        }
    }

    return { root: paths.root, allowEmptyLibrary, entries, youngTempFiles };
}

/**
 * Delete a plan's entries, re-checking each one right before deleting it.
 * An entry that no longer qualifies for the same reason (its source came
 * back, the library emptied, a temp file was touched) is skipped.
 */
export function applyOrphanCleanup(
    plan: OrphanCleanupPlan,
    { now = Date.now() }: { now?: number } = {},
): OrphanCleanupResult {
    const paths = libraryPaths();
    if (paths.root !== plan.root) {
        throw new CleanupRefusedError(`the plan is for ${plan.root}, but the library root is now ${paths.root}.`);
    }

    const sources = freshSources(paths.root);
    const result: OrphanCleanupResult = { deleted: [], skipped: [], failed: [] };
    for (const entry of plan.entries) {
        const verdict = classify(entry.path, paths, sources, plan.allowEmptyLibrary, now);
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
export function getLqipBase64(filename: string): string | null {
    const lqipPath = path.join(libraryPaths().lqip, `${baseNameOf(filename)}.txt`);
    
    if (fs.existsSync(lqipPath)) {
        return fs.readFileSync(lqipPath, 'utf-8');
    }
    
    return null;
}