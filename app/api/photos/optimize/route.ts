import { NextResponse } from 'next/server';
import { 
    processAllImages, 
    getUnprocessedFiles, 
    getPhotoFiles,
    cleanupOrphaned,
    ensureDirectories 
} from '@/utils/imageOptimizer';

export const dynamic = 'force-dynamic';

/**
 * GET /api/photos/optimize
 * Get status of image optimization
 */
export async function GET() {
    try {
        ensureDirectories();
        const allFiles = getPhotoFiles();
        const unprocessedFiles = getUnprocessedFiles();
        
        return NextResponse.json({
            total: allFiles.length,
            unprocessed: unprocessedFiles.length,
            processed: allFiles.length - unprocessedFiles.length,
            unprocessedFiles,
        });
    } catch (error) {
        console.error('Error getting optimization status:', error);
        return NextResponse.json(
            { error: 'Failed to get optimization status' },
            { status: 500 }
        );
    }
}

/**
 * POST /api/photos/optimize
 * Process all unprocessed images
 */
export async function POST(request: Request) {
    try {
        const body = await request.json().catch(() => ({}));
        const { cleanup = false } = body;
        
        // Clean up orphaned files if requested
        if (cleanup) {
            const cleaned = cleanupOrphaned();
            return NextResponse.json({ 
                message: 'Cleanup completed', 
                cleanedFiles: cleaned 
            });
        }
        
        // Process all unprocessed images
        const result = await processAllImages((current, total, file) => {
            console.log(`Processing ${current}/${total}: ${file}`);
        });
        
        return NextResponse.json({
            message: 'Processing completed',
            processed: result.processed.length,
            errors: result.errors.length,
            processedFiles: result.processed,
            errorDetails: result.errors.map(e => ({
                file: e.file,
                error: e.error.message
            })),
        });
    } catch (error) {
        console.error('Error processing images:', error);
        return NextResponse.json(
            { error: 'Failed to process images' },
            { status: 500 }
        );
    }
}