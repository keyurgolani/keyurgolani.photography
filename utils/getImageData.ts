import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import exifFromBuffer from 'exif-reader';
import {
    encodeLqip,
    ensureDirectories,
    getImagePaths,
    getLqipBase64,
    getPhotoFiles,
    isMarkedStale,
    libraryPaths,
    libraryRootExists,
} from './imageOptimizer';

export interface ImageItem {
    id: number;
    src: string;
    thumbnail: string;
    medium: string;
    optimized: string;
    thumbnailAvif?: string;
    mediumAvif?: string;
    optimizedAvif?: string;
    width: number;
    height: number;
    caption?: string;
    date: number;
    lqip: string;
}

export async function getGalleryImages(): Promise<ImageItem[]> {
    const paths = libraryPaths();
    const photosDir = paths.root;
    
    // Return empty if photos directory doesn't exist
    if (!libraryRootExists(photosDir)) {
        return [];
    }
    
    // Try to ensure subdirectories exist, but don't fail if we can't create them
    // (they may be on a mounted volume with different permissions)
    try {
        ensureDirectories(paths);
    } catch (error) {
        console.warn('Could not create thumbnail/optimized directories:', error);
        // Continue anyway - thumbnails might already exist or will be created by watcher
    }

    // The same source list the watcher and images:cleanup use, so dot-files never count
    const files = getPhotoFiles(photosDir);

    const readItem = async (file: string, index: number): Promise<ImageItem> => {
        const filePath = path.join(photosDir, file);
        // Use sharp with file path to avoid reading full buffer into memory
        const metadata = await sharp(filePath).metadata();
        
        // Get paths for all image versions
        const imagePaths = getImagePaths(file, paths);
        // A stale mark means no current set. The derivatives may show a deleted
        // photo that had this name, so serve the original until they are redone.
        const current = !isMarkedStale(file, paths);
        
        // Get LQIP base64
        let lqip = current ? getLqipBase64(file, paths) : null;
        if (!lqip) {
            // Generate on-the-fly if not available (using filePath, not buffer)
            try {
                lqip = await encodeLqip(filePath);
            } catch {
                // Fallback to empty placeholder
                lqip = 'data:image/webp;base64,UklGRlYAAABXRUJQVlA4IEoAAADQAQCdASoKAAoAAUAmJYgCdAEO9ACA/v9P9f96f1AAAAAAfQ==';
            }
        }
        
        let exifData: Record<string, unknown> = {};
        if (metadata.exif) {
            try {
                exifData = exifFromBuffer(metadata.exif) as Record<string, unknown>;
            } catch (e) {
                console.error(`Error parsing EXIF for ${file}`, e);
            }
        }

        // Extract relevant fields
        // Date: Try Photo.DateTimeOriginal, then Image.ModifyDate
        let dateTaken = new Date(0);
        // keys are capitalized in some versions of exif-reader result
        const exifTags = (exifData.exif || exifData.Photo || {}) as Record<string, unknown>;
        const imageTags = (exifData.image || exifData.Image || {}) as Record<string, unknown>;
        
        if (exifTags.DateTimeOriginal) dateTaken = new Date(exifTags.DateTimeOriginal as string | number | Date);
        else if (imageTags.ModifyDate) dateTaken = new Date(imageTags.ModifyDate as string | number | Date);
        else {
            const stats = fs.statSync(filePath);
            dateTaken = stats.birthtime;
        }

        const camera = imageTags.Model || '';
        const fNumber = exifTags.FNumber;
        const exposure = exifTags.ExposureTime;
        const iso = exifTags.ISO;
        const focal = exifTags.FocalLength;

        // Format settings string (e.g. "35mm f/1.8 1/200s ISO 100")
        const settingsParts: string[] = [];
        if (focal) settingsParts.push(`${focal}mm`);
        if (fNumber) settingsParts.push(`f/${fNumber}`);
        if (exposure) {
             const shutter = (exposure as number) >= 1 ? exposure : `1/${Math.round(1/(exposure as number))}`;
             settingsParts.push(`${shutter}s`);
        }
        if (iso) settingsParts.push(`ISO ${iso}`);
        
        // Final Caption: "Sony A7III | 35mm f/1.8 ..."
        let caption = camera as string;
        if (settingsParts.length > 0) {
            caption = caption ? `${caption} | ${settingsParts.join(' ')}` : settingsParts.join(' ');
        }
        
        // Fallback if empty
        if (!caption) caption = '';

        // `src` is the original source path. The gallery and carousel load the pre-generated `optimized` and `thumbnail` WebP files.
        const src = imagePaths.original;
        
        return {
            id: index,
            src: src,
            thumbnail: current && imagePaths.hasThumbnail ? imagePaths.thumbnail : imagePaths.original,
            medium: current && imagePaths.hasMedium ? imagePaths.medium : src,
            optimized: current && imagePaths.hasOptimized ? imagePaths.optimized : imagePaths.original,
            thumbnailAvif: current && imagePaths.hasThumbnailAvif ? imagePaths.thumbnailAvif : undefined,
            mediumAvif: current && imagePaths.hasMediumAvif ? imagePaths.mediumAvif : undefined,
            optimizedAvif: current && imagePaths.hasOptimizedAvif ? imagePaths.optimizedAvif : undefined,
            width: metadata.width || 800,
            height: metadata.height || 600,
            caption: caption,
            date: dateTaken.getTime(),
            lqip: lqip,
        };
    };

    // One undecodable or vanished file is logged and left out, so the others still list
    const images = await Promise.all(files.map(async (file, index) => {
        try {
            return await readItem(file, index);
        } catch (error) {
            console.error(`[getGalleryImages] Skipping ${file}: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }));

    // If every photo failed, throw instead of returning an empty list, so the
    // ISR cache keeps serving the last good one
    const listed = images.filter((image): image is ImageItem => image !== null);
    if (files.length > 0 && listed.length === 0) {
        throw new Error(`Could not read any of the photos in ${photosDir} (${files.length} found).`);
    }

    // Sort: Newest First
    return listed.sort((a, b) => b.date - a.date);
}