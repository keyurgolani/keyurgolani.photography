import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { 
    PHOTOS_DIR, 
    THUMBNAILS_DIR, 
    MEDIUM_DIR, 
    OPTIMIZED_DIR,
    CACHE_DIR,
    THUMBNAIL_WIDTH,
    MEDIUM_WIDTH,
    OPTIMIZED_WIDTH
} from '@/utils/imageOptimizer';

const DYNAMIC_CACHE_DIR = path.join(CACHE_DIR, 'dynamic');

const ALLOWED_WIDTHS = [THUMBNAIL_WIDTH, MEDIUM_WIDTH, 1200, OPTIMIZED_WIDTH];
const DEFAULT_QUALITY = { webp: 85, avif: 60, jpeg: 85 };

// Map width to directory for pre-optimized files
const WIDTH_TO_DIR: Record<number, { webp: string; avif: string }> = {
    [THUMBNAIL_WIDTH]: { webp: THUMBNAILS_DIR, avif: path.join(PHOTOS_DIR, 'thumbnails-avif') },
    [MEDIUM_WIDTH]: { webp: MEDIUM_DIR, avif: path.join(PHOTOS_DIR, 'medium-avif') },
    [OPTIMIZED_WIDTH]: { webp: OPTIMIZED_DIR, avif: path.join(PHOTOS_DIR, 'optimized-avif') },
};

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const src = searchParams.get('src');
    const requestedWidth = parseInt(searchParams.get('width') || '800');
    const requestedQuality = parseInt(searchParams.get('quality') || '0') || undefined;

    if (!src) {
        return NextResponse.json({ error: 'src is required' }, { status: 400 });
    }

    // Extract filename from src (handle both full paths and bare filenames)
    const srcFilename = path.basename(src);
    const ext = path.extname(srcFilename);
    const baseName = path.basename(srcFilename, ext);

    // Negotiate format from Accept header
    const accept = request.headers.get('accept') || '';
    let format: 'avif' | 'webp' | 'jpeg' = 'jpeg';
    if (accept.includes('image/avif')) format = 'avif';
    else if (accept.includes('image/webp')) format = 'webp';

    // Clamp width to nearest allowed breakpoint
    const width = ALLOWED_WIDTHS.reduce((prev, curr) =>
        Math.abs(curr - requestedWidth) < Math.abs(prev - requestedWidth) ? curr : prev
    );

    const quality = requestedQuality || DEFAULT_QUALITY[format];
    const cacheKey = `${baseName}-${width}-${quality}.${format}`;
    const cachePath = path.join(DYNAMIC_CACHE_DIR, cacheKey);

    // Generate ETag
    const etag = `"${baseName}-${width}-${quality}-${format}"`;
    const ifNoneMatch = request.headers.get('if-none-match');

    // Check for 304 Not Modified
    if (ifNoneMatch === etag && fs.existsSync(cachePath)) {
        return new Response(null, {
            status: 304,
            headers: {
                'Cache-Control': 'public, max-age=31536000, immutable',
                'ETag': etag,
            },
        });
    }

    // Serve from disk cache if available
    if (fs.existsSync(cachePath)) {
        const buffer = fs.readFileSync(cachePath);
        return new Response(buffer, {
            headers: {
                'Content-Type': `image/${format}`,
                'Cache-Control': 'public, max-age=31536000, immutable',
                'ETag': etag,
                'X-Cache': 'HIT',
            },
        });
    }

    // Try to serve from pre-optimized directories first
    const dirConfig = WIDTH_TO_DIR[width];
    if (dirConfig) {
        const formatDir = format === 'avif' ? dirConfig.avif : dirConfig.webp;
        const preoptimizedPath = path.join(formatDir, `${baseName}.${format}`);
        
        if (fs.existsSync(preoptimizedPath)) {
            const buffer = fs.readFileSync(preoptimizedPath);
            return new Response(buffer, {
                headers: {
                    'Content-Type': `image/${format}`,
                    'Cache-Control': 'public, max-age=31536000, immutable',
                    'ETag': etag,
                    'X-Cache': 'PREOPTIMIZED',
                },
            });
        }
        
        // If requesting AVIF but only WebP exists, serve WebP
        if (format === 'avif') {
            const webpPath = path.join(dirConfig.webp, `${baseName}.webp`);
            if (fs.existsSync(webpPath)) {
                const buffer = fs.readFileSync(webpPath);
                return new Response(buffer, {
                    headers: {
                        'Content-Type': 'image/webp',
                        'Cache-Control': 'public, max-age=31536000, immutable',
                        'ETag': etag,
                        'X-Cache': 'PREOPTIMIZED-WEBP',
                    },
                });
            }
        }
    }

    // Fall back to processing from source file
    const sourcePath = path.resolve(PHOTOS_DIR, srcFilename);
    
    // Security check: ensure path stays within PHOTOS_DIR
    if (!sourcePath.startsWith(PHOTOS_DIR)) {
        return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
    }
    
    if (!fs.existsSync(sourcePath)) {
        console.error(`Source image not found: ${sourcePath}`);
        return NextResponse.json({ error: 'Image not found' }, { status: 404 });
    }

    // Generate and cache
    try {
        fs.mkdirSync(DYNAMIC_CACHE_DIR, { recursive: true });

        let pipeline = sharp(sourcePath)
            .resize(width, undefined, { fit: 'inside', withoutEnlargement: true });

        if (format === 'avif') pipeline = pipeline.avif({ quality, effort: 4 });
        else if (format === 'webp') pipeline = pipeline.webp({ quality });
        else pipeline = pipeline.jpeg({ quality, progressive: true });

        const buffer = await pipeline.toBuffer();
        fs.writeFileSync(cachePath, buffer);

        return new Response(buffer, {
            headers: {
                'Content-Type': `image/${format}`,
                'Cache-Control': 'public, max-age=31536000, immutable',
                'ETag': etag,
                'X-Cache': 'MISS',
            },
        });
    } catch (err) {
        console.error('Image processing error:', err);
        return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
    }
}