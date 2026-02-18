import { NextResponse } from 'next/server';
import { getGalleryImages } from '@/utils/getImageData';

// Revalidate every 60 seconds (ISR)
export const revalidate = 60;

export async function GET() {
    const images = await getGalleryImages();
    return NextResponse.json(images, {
        headers: {
            'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
        },
    });
}