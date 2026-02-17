import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import exifFromBuffer from 'exif-reader';
import { unstable_noStore as noStore } from 'next/cache';
import { getImagePaths, ensureDirectories } from './imageOptimizer';

export interface ImageItem {
    id: number;
    src: string;
    thumbnail: string;
    optimized: string;
    width: number;
    height: number;
    caption?: string;
    date: number;
}

export async function getGalleryImages(): Promise<ImageItem[]> {
    noStore(); // Opt out of data caching for dynamic filesystem reads
    
    const photosDir = path.join(process.cwd(), 'public/assets/photos');
    
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
        const buffer = fs.readFileSync(filePath);
        const metadata = await sharp(buffer).metadata();
        
        // Get paths for thumbnail and optimized versions
        const imagePaths = getImagePaths(file);
        
        let exifData: any = {};
        if (metadata.exif) {
            try {
                exifData = exifFromBuffer(metadata.exif);
            } catch (e) {
                console.error(`Error parsing EXIF for ${file}`, e);
            }
        }

        // Extract relevant fields
        // Date: Try Photo.DateTimeOriginal, then Image.ModifyDate
        let dateTaken = new Date(0);
        // keys are capitalized in some versions of exif-reader result
        const exifTags = exifData.exif || exifData.Photo || {};
        const imageTags = exifData.image || exifData.Image || {};
        
        if (exifTags.DateTimeOriginal) dateTaken = new Date(exifTags.DateTimeOriginal);
        else if (imageTags.ModifyDate) dateTaken = new Date(imageTags.ModifyDate);
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
        const settingsParts = [];
        if (focal) settingsParts.push(`${focal}mm`);
        if (fNumber) settingsParts.push(`f/${fNumber}`);
        if (exposure) {
             const shutter = exposure >= 1 ? exposure : `1/${Math.round(1/exposure)}`;
             settingsParts.push(`${shutter}s`);
        }
        if (iso) settingsParts.push(`ISO ${iso}`);
        
        // Final Caption: "Sony A7III | 35mm f/1.8 ..."
        let caption = camera;
        if (settingsParts.length > 0) {
            caption = caption ? `${caption} | ${settingsParts.join(' ')}` : settingsParts.join(' ');
        }
        
        // Fallback if empty
        if (!caption) caption = '';

        // Use optimized image if available, otherwise fall back to original
        const src = imagePaths.hasOptimized ? imagePaths.optimized : imagePaths.original;
        
        return {
            id: index,
            src: src,
            thumbnail: imagePaths.hasThumbnail ? imagePaths.thumbnail : imagePaths.original,
            optimized: imagePaths.hasOptimized ? imagePaths.optimized : imagePaths.original,
            width: metadata.width || 800,
            height: metadata.height || 600,
            caption: caption,
            date: dateTaken.getTime()
        };
    }));

    // Sort: Newest First
    return images.sort((a, b) => b.date - a.date);
}