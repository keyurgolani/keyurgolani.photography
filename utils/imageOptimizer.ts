import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

export const PHOTOS_DIR = path.join(process.cwd(), 'public/assets/photos');
export const THUMBNAILS_DIR = path.join(process.cwd(), 'public/assets/photos/thumbnails');
export const MEDIUM_DIR = path.join(process.cwd(), 'public/assets/photos/medium');
export const OPTIMIZED_DIR = path.join(process.cwd(), 'public/assets/photos/optimized');
export const LQIP_DIR = path.join(process.cwd(), 'public/assets/photos/lqip');
export const CACHE_DIR = path.join(process.cwd(), 'public/assets/photos/cache');

// AVIF directories
export const AVIF_THUMBNAILS_DIR = path.join(process.cwd(), 'public/assets/photos/thumbnails-avif');
export const AVIF_MEDIUM_DIR = path.join(process.cwd(), 'public/assets/photos/medium-avif');
export const AVIF_OPTIMIZED_DIR = path.join(process.cwd(), 'public/assets/photos/optimized-avif');

export const THUMBNAIL_WIDTH = 400;
export const MEDIUM_WIDTH = 800;
export const OPTIMIZED_WIDTH = 1920;
export const LQIP_SIZE = 20;

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

const ALL_DIRS = [
    THUMBNAILS_DIR,
    MEDIUM_DIR,
    OPTIMIZED_DIR,
    LQIP_DIR,
    CACHE_DIR,
    AVIF_THUMBNAILS_DIR,
    AVIF_MEDIUM_DIR,
    AVIF_OPTIMIZED_DIR,
];

/**
 * Ensure all required directories exist
 */
export function ensureDirectories(): void {
    // First ensure the parent photos directory exists
    if (!fs.existsSync(PHOTOS_DIR)) {
        fs.mkdirSync(PHOTOS_DIR, { recursive: true });
    }
    
    for (const dir of ALL_DIRS) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
}

/**
 * Get file paths for all versions of an image
 */
export function getImagePaths(filename: string): ProcessedImagePaths {
    const baseName = path.basename(filename, path.extname(filename));
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
        hasThumbnail: fs.existsSync(path.join(THUMBNAILS_DIR, `${baseName}${webpExt}`)),
        hasMedium: fs.existsSync(path.join(MEDIUM_DIR, `${baseName}${webpExt}`)),
        hasOptimized: fs.existsSync(path.join(OPTIMIZED_DIR, `${baseName}${webpExt}`)),
        hasThumbnailAvif: fs.existsSync(path.join(AVIF_THUMBNAILS_DIR, `${baseName}${avifExt}`)),
        hasMediumAvif: fs.existsSync(path.join(AVIF_MEDIUM_DIR, `${baseName}${avifExt}`)),
        hasOptimizedAvif: fs.existsSync(path.join(AVIF_OPTIMIZED_DIR, `${baseName}${avifExt}`)),
        hasLqip: fs.existsSync(path.join(LQIP_DIR, `${baseName}.txt`)),
    };
}

/**
 * Process a single image: generate all sizes and formats
 */
export async function processImage(filename: string): Promise<ProcessedImagePaths> {
    ensureDirectories();
    
    const inputPath = path.join(PHOTOS_DIR, filename);
    const baseName = path.basename(filename, path.extname(filename));
    
    // WebP paths
    const thumbnailPath = path.join(THUMBNAILS_DIR, `${baseName}.webp`);
    const mediumPath = path.join(MEDIUM_DIR, `${baseName}.webp`);
    const optimizedPath = path.join(OPTIMIZED_DIR, `${baseName}.webp`);
    
    // AVIF paths
    const thumbnailAvifPath = path.join(AVIF_THUMBNAILS_DIR, `${baseName}.avif`);
    const mediumAvifPath = path.join(AVIF_MEDIUM_DIR, `${baseName}.avif`);
    const optimizedAvifPath = path.join(AVIF_OPTIMIZED_DIR, `${baseName}.avif`);
    
    // LQIP path
    const lqipPath = path.join(LQIP_DIR, `${baseName}.txt`);
    
    // WebP sizes configuration
    const webpSizes = [
        { path: thumbnailPath, width: THUMBNAIL_WIDTH, quality: 80 },
        { path: mediumPath, width: MEDIUM_WIDTH, quality: 85 },
        { path: optimizedPath, width: OPTIMIZED_WIDTH, quality: 85 },
    ];
    
    // Process WebP variants
    for (const { path: outPath, width, quality } of webpSizes) {
        if (!fs.existsSync(outPath)) {
            await sharp(inputPath)
                .resize(width, undefined, {
                    fit: 'inside',
                    withoutEnlargement: true,
                })
                .webp({ quality })
                .toFile(outPath);
        }
    }
    
    // AVIF sizes configuration
    const avifSizes = [
        { path: thumbnailAvifPath, width: THUMBNAIL_WIDTH },
        { path: mediumAvifPath, width: MEDIUM_WIDTH },
        { path: optimizedAvifPath, width: OPTIMIZED_WIDTH },
    ];
    
    // Process AVIF variants
    for (const { path: outPath, width } of avifSizes) {
        if (!fs.existsSync(outPath)) {
            await sharp(inputPath)
                .resize(width, undefined, {
                    fit: 'inside',
                    withoutEnlargement: true,
                })
                .avif({ quality: 60, effort: 4 })
                .toFile(outPath);
        }
    }
    
    // Generate LQIP (Low Quality Image Placeholder)
    if (!fs.existsSync(lqipPath)) {
        const lqipBuffer = await sharp(inputPath)
            .resize(LQIP_SIZE, LQIP_SIZE, { fit: 'inside' })
            .webp({ quality: 20 })
            .toBuffer();
        const lqipBase64 = `data:image/webp;base64,${lqipBuffer.toString('base64')}`;
        fs.writeFileSync(lqipPath, lqipBase64);
    }
    
    return getImagePaths(filename);
}

/**
 * Get list of all photo files in the directory
 */
export function getPhotoFiles(): string[] {
    if (!fs.existsSync(PHOTOS_DIR)) {
        return [];
    }
    
    return fs.readdirSync(PHOTOS_DIR).filter(file => 
        /\.(jpg|jpeg|png|webp)$/i.test(file) && 
        !fs.statSync(path.join(PHOTOS_DIR, file)).isDirectory()
    );
}

/**
 * Check if source file is newer than processed versions (for cache-busting)
 */
function isSourceNewer(filename: string): boolean {
    const sourcePath = path.join(PHOTOS_DIR, filename);
    const baseName = path.basename(filename, path.extname(filename));
    
    if (!fs.existsSync(sourcePath)) return false;
    
    const sourceMtime = fs.statSync(sourcePath).mtimeMs;
    
    // Check against thumbnail as representative of all processed files
    const thumbnailPath = path.join(THUMBNAILS_DIR, `${baseName}.webp`);
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
 * Reprocess an image (delete old versions first)
 */
export async function reprocessImage(filename: string): Promise<ProcessedImagePaths> {
    const baseName = path.basename(filename, path.extname(filename));
    
    // Delete existing processed files
    const filesToDelete = [
        path.join(THUMBNAILS_DIR, `${baseName}.webp`),
        path.join(MEDIUM_DIR, `${baseName}.webp`),
        path.join(OPTIMIZED_DIR, `${baseName}.webp`),
        path.join(AVIF_THUMBNAILS_DIR, `${baseName}.avif`),
        path.join(AVIF_MEDIUM_DIR, `${baseName}.avif`),
        path.join(AVIF_OPTIMIZED_DIR, `${baseName}.avif`),
        path.join(LQIP_DIR, `${baseName}.txt`),
    ];
    
    for (const filePath of filesToDelete) {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }
    
    // Also clean dynamic cache
    const dynamicCacheDir = path.join(CACHE_DIR, 'dynamic');
    if (fs.existsSync(dynamicCacheDir)) {
        const cacheFiles = fs.readdirSync(dynamicCacheDir).filter(f => f.startsWith(baseName));
        for (const cacheFile of cacheFiles) {
            fs.unlinkSync(path.join(dynamicCacheDir, cacheFile));
        }
    }
    
    return processImage(filename);
}

/**
 * Process all unprocessed images
 */
export async function processAllImages(progressCallback?: (current: number, total: number, file: string) => void): Promise<{
    processed: string[];
    errors: { file: string; error: Error }[];
}> {
    const files = getUnprocessedFiles();
    const processed: string[] = [];
    const errors: { file: string; error: Error }[] = [];
    
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
            progressCallback?.(i + 1, files.length, file);
            await processImage(file);
            processed.push(file);
        } catch (error) {
            errors.push({ file, error: error as Error });
        }
    }
    
    return { processed, errors };
}

/**
 * Clean up orphaned files (no corresponding original)
 */
export function cleanupOrphaned(): string[] {
    ensureDirectories();
    const photoFiles = new Set(getPhotoFiles().map(f => path.basename(f, path.extname(f))));
    const cleaned: string[] = [];
    
    const dirsToClean = [
        { dir: THUMBNAILS_DIR, name: 'thumbnails' },
        { dir: MEDIUM_DIR, name: 'medium' },
        { dir: OPTIMIZED_DIR, name: 'optimized' },
        { dir: AVIF_THUMBNAILS_DIR, name: 'thumbnails-avif' },
        { dir: AVIF_MEDIUM_DIR, name: 'medium-avif' },
        { dir: AVIF_OPTIMIZED_DIR, name: 'optimized-avif' },
        { dir: LQIP_DIR, name: 'lqip' },
    ];
    
    for (const { dir, name } of dirsToClean) {
        if (fs.existsSync(dir)) {
            fs.readdirSync(dir).forEach(file => {
                const baseName = path.basename(file, path.extname(file));
                if (!photoFiles.has(baseName)) {
                    fs.unlinkSync(path.join(dir, file));
                    cleaned.push(`${name}/${file}`);
                }
            });
        }
    }
    
    return cleaned;
}

/**
 * Get LQIP base64 string for an image
 */
export function getLqipBase64(filename: string): string | null {
    const baseName = path.basename(filename, path.extname(filename));
    const lqipPath = path.join(LQIP_DIR, `${baseName}.txt`);
    
    if (fs.existsSync(lqipPath)) {
        return fs.readFileSync(lqipPath, 'utf-8');
    }
    
    return null;
}