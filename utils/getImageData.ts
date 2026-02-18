import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import exifFromBuffer from 'exif-reader';
import { getImagePaths, ensureDirectories, getLqipBase64, PHOTOS_DIR } from './imageOptimizer';

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
    const photosDir = PHOTOS_DIR;
    
    // Return empty if photos directory doesn't exist
    if (!fs.existsSync(photosDir)) {
        return [];
    }
    
    // Try to ensure subdirectories exist, but don't fail if we can't create them
    // (they may be on a mounted volume with different permissions)
    try {
        ensureDirectories();
    } catch (error) {
        console.warn('Could not create thumbnail/optimized directories:', error);
        // Continue anyway - thumbnails might already exist or will be created by watcher
    }

    const files = fs.readdirSync(photosDir).filter(file => 
        /\.(jpg|jpeg|png|webp)$/i.test(file) &&
        !fs.statSync(path.join(photosDir, file)).isDirectory()
    );

    const images = await Promise.all(files.map(async (file, index) => {
        const filePath = path.join(photosDir, file);
        // Use sharp with file path to avoid reading full buffer into memory
        const metadata = await sharp(filePath).metadata();
        
        // Get paths for all image versions
        const imagePaths = getImagePaths(file);
        
        // Get LQIP base64
        let lqip = getLqipBase64(file);
        if (!lqip) {
            // Generate on-the-fly if not available (using filePath, not buffer)
            try {
                const lqipBuffer = await sharp(filePath)
                    .resize(20, 20, { fit: 'inside' })
                    .webp({ quality: 20 })
                    .toBuffer();
                lqip = `data:image/webp;base64,${lqipBuffer.toString('base64')}`;
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

        // Always use original source path - /api/image handles format negotiation (AVIF/WebP)
        const src = imagePaths.original;
        
        return {
            id: index,
            src: src,
            thumbnail: imagePaths.hasThumbnail ? imagePaths.thumbnail : imagePaths.original,
            medium: imagePaths.hasMedium ? imagePaths.medium : src,
            optimized: imagePaths.hasOptimized ? imagePaths.optimized : imagePaths.original,
            thumbnailAvif: imagePaths.hasThumbnailAvif ? imagePaths.thumbnailAvif : undefined,
            mediumAvif: imagePaths.hasMediumAvif ? imagePaths.mediumAvif : undefined,
            optimizedAvif: imagePaths.hasOptimizedAvif ? imagePaths.optimizedAvif : undefined,
            width: metadata.width || 800,
            height: metadata.height || 600,
            caption: caption,
            date: dateTaken.getTime(),
            lqip: lqip,
        };
    }));

    // Sort: Newest First
    return images.sort((a, b) => b.date - a.date);
}