import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

export const PHOTOS_DIR = path.join(process.cwd(), 'public/assets/photos');
export const THUMBNAILS_DIR = path.join(process.cwd(), 'public/assets/photos/thumbnails');
export const OPTIMIZED_DIR = path.join(process.cwd(), 'public/assets/photos/optimized');

export const THUMBNAIL_WIDTH = 400;
export const OPTIMIZED_WIDTH = 1920;

export interface ProcessedImagePaths {
    original: string;
    thumbnail: string;
    optimized: string;
    hasThumbnail: boolean;
    hasOptimized: boolean;
}

/**
 * Ensure thumbnail and optimized directories exist
 */
export function ensureDirectories(): void {
    if (!fs.existsSync(THUMBNAILS_DIR)) {
        fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
    }
    if (!fs.existsSync(OPTIMIZED_DIR)) {
        fs.mkdirSync(OPTIMIZED_DIR, { recursive: true });
    }
}

/**
 * Get file paths for original, thumbnail, and optimized versions
 */
export function getImagePaths(filename: string): ProcessedImagePaths {
    const baseName = path.basename(filename, path.extname(filename));
    const ext = '.webp'; // Convert to webp for better compression
    
    return {
        original: `/assets/photos/${filename}`,
        thumbnail: `/assets/photos/thumbnails/${baseName}${ext}`,
        optimized: `/assets/photos/optimized/${baseName}${ext}`,
        hasThumbnail: fs.existsSync(path.join(THUMBNAILS_DIR, `${baseName}${ext}`)),
        hasOptimized: fs.existsSync(path.join(OPTIMIZED_DIR, `${baseName}${ext}`)),
    };
}

/**
 * Process a single image: generate thumbnail and optimized version
 */
export async function processImage(filename: string): Promise<ProcessedImagePaths> {
    ensureDirectories();
    
    const inputPath = path.join(PHOTOS_DIR, filename);
    const baseName = path.basename(filename, path.extname(filename));
    
    const thumbnailPath = path.join(THUMBNAILS_DIR, `${baseName}.webp`);
    const optimizedPath = path.join(OPTIMIZED_DIR, `${baseName}.webp`);
    
    // Generate thumbnail
    await sharp(inputPath)
        .resize(THUMBNAIL_WIDTH, undefined, {
            fit: 'inside',
            withoutEnlargement: true,
        })
        .webp({ quality: 80 })
        .toFile(thumbnailPath);
    
    // Generate optimized version
    await sharp(inputPath)
        .resize(OPTIMIZED_WIDTH, undefined, {
            fit: 'inside',
            withoutEnlargement: true,
        })
        .webp({ quality: 85 })
        .toFile(optimizedPath);
    
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
 * Get list of files that need processing (no thumbnail/optimized version)
 */
export function getUnprocessedFiles(): string[] {
    ensureDirectories();
    const files = getPhotoFiles();
    
    return files.filter(file => {
        const paths = getImagePaths(file);
        return !paths.hasThumbnail || !paths.hasOptimized;
    });
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
 * Clean up orphaned thumbnails/optimized files (no corresponding original)
 */
export function cleanupOrphaned(): string[] {
    ensureDirectories();
    const photoFiles = new Set(getPhotoFiles().map(f => path.basename(f, path.extname(f))));
    const cleaned: string[] = [];
    
    // Clean thumbnails
    if (fs.existsSync(THUMBNAILS_DIR)) {
        fs.readdirSync(THUMBNAILS_DIR).forEach(file => {
            const baseName = path.basename(file, path.extname(file));
            if (!photoFiles.has(baseName)) {
                fs.unlinkSync(path.join(THUMBNAILS_DIR, file));
                cleaned.push(`thumbnails/${file}`);
            }
        });
    }
    
    // Clean optimized
    if (fs.existsSync(OPTIMIZED_DIR)) {
        fs.readdirSync(OPTIMIZED_DIR).forEach(file => {
            const baseName = path.basename(file, path.extname(file));
            if (!photoFiles.has(baseName)) {
                fs.unlinkSync(path.join(OPTIMIZED_DIR, file));
                cleaned.push(`optimized/${file}`);
            }
        });
    }
    
    return cleaned;
}