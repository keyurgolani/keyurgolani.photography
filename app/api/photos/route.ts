import { NextResponse } from 'next/server';
import { getGalleryImages } from '@/utils/getImageData';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
    const images = await getGalleryImages();
    return NextResponse.json(images);
}
