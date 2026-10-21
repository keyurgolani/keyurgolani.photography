import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import exifFromBuffer from 'exif-reader';
import {
    baseNameOf,
    encodeLqip,
    ensureDirectories,
    getImagePaths,
    getLqipBase64,
    getPhotoFiles,
    isCompleteSet,
    libraryPaths,
    libraryRootExists,
    optimizedSize,
    pickOwner,
    readDerivativeIndex,
    setGroups,
    type LibraryPaths,
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
    /** The photo's upright size. */
    width: number;
    height: number;
    /** The size of the optimized WebP, which is smaller than the photo once it is wider than 1920 px. */
    optimizedWidth: number;
    optimizedHeight: number;
    caption?: string;
    date: number;
    lqip: string;
}

const EMPTY_LQIP = 'data:image/webp;base64,UklGRlYAAABXRUJQVlA4IEoAAADQAQCdASoKAAoAAUAmJYgCdAEO9ACA/v9P9f96f1AAAAAAfQ==';

/** On-the-fly placeholders by source path, reused while the file keeps its inode, size, and mtime. */
const placeholders = new Map<string, { version: string; lqip: string }>();

async function placeholderFor(filePath: string): Promise<string> {
    try {
        const { ino, size, mtimeMs } = fs.statSync(filePath);
        const version = `${ino}:${size}:${mtimeMs}`;
        const cached = placeholders.get(filePath);
        if (cached?.version === version) return cached.lqip;
        // Generate on-the-fly (using filePath, not buffer)
        const lqip = await encodeLqip(filePath);
        placeholders.set(filePath, { version, lqip });
        return lqip;
    } catch {
        // Fallback to empty placeholder
        return EMPTY_LQIP;
    }
}

/**
 * Sources that share one set of legacy derivatives, such as IMG_1.jpg and
 * IMG_1.png, or Beach.jpg and beach.png on a disk that resolves both names to
 * one file, are listed once: by the source that owns the set, the first by
 * path that decodes, which is the one the watcher builds it from. The others
 * are logged. The migration dry run's "Basename collisions" section lists
 * them.
 */
async function setOwners(files: string[], paths: LibraryPaths): Promise<string[]> {
    const owners: string[] = [];
    for (const group of setGroups(files, paths.root)) {
        const { owner, undecodable } = await pickOwner(group, paths);
        owners.push(owner);
        for (const file of group) {
            if (file === owner) continue;
            if (undecodable.includes(file)) {
                console.warn(`[getGalleryImages] Skipping ${file}: it can't be decoded, so ${owner} has the derivatives they share.`);
            } else {
                const folded = baseNameOf(file) === baseNameOf(owner) ? '' : ', since their base names differ only by case or Unicode form';
                console.warn(`[getGalleryImages] Skipping ${file}: it shares its derivatives with ${owner}${folded}.`);
            }
        }
    }
    return owners;
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
    const files = await setOwners(getPhotoFiles(photosDir), paths);
    // Each derivative folder read once, so a set counts only under its exact name
    const derivatives = readDerivativeIndex(paths);

    const readItem = async (file: string, index: number): Promise<ImageItem | 'incomplete'> => {
        const filePath = path.join(photosDir, file);
        // Use sharp with file path to avoid reading full buffer into memory
        const metadata = await sharp(filePath).metadata();
        // The derivatives are upright, so report the size after the EXIF Orientation is applied.
        const upright = metadata.autoOrient ?? metadata;

        // Get paths for all image versions
        const imagePaths = getImagePaths(file, paths, derivatives);
        // Original files are never served, so a photo is listed only with a complete
        // set, all seven by exact name. Anything less, such as a set cleanup only
        // partly removed, leaves it out until the watcher writes the set again.
        if (!isCompleteSet(imagePaths)) return 'incomplete';
        // The Lightbox's slide gets the size of the file it loads. One that can't be read can't be shown either.
        const optimized = await optimizedSize(file, paths);

        // Get LQIP base64. An on-the-fly placeholder is upright, as encodeLqip() turns it.
        const lqip = getLqipBase64(file, paths) || await placeholderFor(filePath);
        
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

        return {
            id: index,
            src: imagePaths.optimized,
            thumbnail: imagePaths.thumbnail,
            medium: imagePaths.medium,
            optimized: imagePaths.optimized,
            thumbnailAvif: imagePaths.thumbnailAvif,
            mediumAvif: imagePaths.mediumAvif,
            optimizedAvif: imagePaths.optimizedAvif,
            width: upright.width || 800,
            height: upright.height || 600,
            optimizedWidth: optimized.width,
            optimizedHeight: optimized.height,
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
    // ISR cache keeps serving the last good one. A photo still waiting for its
    // set hasn't failed: before the watcher's first run, the list is empty.
    if (files.length > 0 && images.every((image) => image === null)) {
        throw new Error(`Could not read any of the photos in ${photosDir} (${files.length} found).`);
    }

    // Sort: Newest First
    return images
        .filter((image): image is ImageItem => image !== null && image !== 'incomplete')
        .sort((a, b) => b.date - a.date);
}