'use client';

import React, { useEffect, useState } from 'react';
import Gallery from './Gallery';
import { ImageItem } from '@/utils/getImageData';

interface GalleryImage {
    id: number;
    src: string;
    thumbnail?: string;
    width: number;
    height: number;
    caption?: string;
    lqip?: string;
}

export default function DynamicGallery() {
    const [images, setImages] = useState<GalleryImage[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchImages = async () => {
            try {
                const response = await fetch('/api/photos');
                if (!response.ok) {
                    throw new Error('Failed to fetch images');
                }
                const data: ImageItem[] = await response.json();
                setImages(data.map((img, index) => ({
                    id: index,
                    src: img.optimized,  // Use pre-optimized 1920px WebP
                    thumbnail: img.thumbnail,  // Pre-optimized 400px WebP
                    width: img.width,
                    height: img.height,
                    caption: img.caption || undefined,
                    lqip: img.lqip,
                })));
            } catch (error) {
                console.error('Error fetching gallery images:', error);
                setImages([]);
            } finally {
                setLoading(false);
            }
        };

        fetchImages();
    }, []);

    if (loading) {
        return (
            <div className="space-y-8">
                <div className="text-center text-primary/60 py-8">
                    <p>Loading gallery...</p>
                </div>
                
                {/* Skeleton grid */}
                <div className="grid grid-cols-4 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12 auto-rows-[50px] gap-3 grid-flow-dense">
                    <div className="col-span-4 row-span-5 bg-white/10 rounded-xl animate-pulse" />
                    <div className="col-span-4 row-span-4 bg-white/10 rounded-xl animate-pulse" />
                    <div className="col-span-4 row-span-6 bg-white/10 rounded-xl animate-pulse" />
                    <div className="col-span-4 row-span-4 bg-white/10 rounded-xl animate-pulse" />
                    <div className="col-span-4 row-span-5 bg-white/10 rounded-xl animate-pulse" />
                    <div className="col-span-4 row-span-4 bg-white/10 rounded-xl animate-pulse" />
                    <div className="col-span-4 row-span-6 bg-white/10 rounded-xl animate-pulse" />
                    <div className="col-span-4 row-span-5 bg-white/10 rounded-xl animate-pulse" />
                    <div className="col-span-4 row-span-4 bg-white/10 rounded-xl animate-pulse" />
                </div>
            </div>
        );
    }

    if (images.length === 0) {
        return (
            <div className="space-y-8">
                <div className="text-center text-primary/60 py-8">
                    <p>No images found in the gallery.</p>
                </div>
                
                {/* Skeleton grid */}
                <div className="grid grid-cols-4 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12 auto-rows-[50px] gap-3 grid-flow-dense">
                    <div className="col-span-4 row-span-5 bg-white/10 rounded-xl animate-pulse" />
                    <div className="col-span-4 row-span-4 bg-white/10 rounded-xl animate-pulse" />
                    <div className="col-span-4 row-span-6 bg-white/10 rounded-xl animate-pulse" />
                    <div className="col-span-4 row-span-4 bg-white/10 rounded-xl animate-pulse" />
                    <div className="col-span-4 row-span-5 bg-white/10 rounded-xl animate-pulse" />
                    <div className="col-span-4 row-span-4 bg-white/10 rounded-xl animate-pulse" />
                    <div className="col-span-4 row-span-6 bg-white/10 rounded-xl animate-pulse" />
                    <div className="col-span-4 row-span-5 bg-white/10 rounded-xl animate-pulse" />
                    <div className="col-span-4 row-span-4 bg-white/10 rounded-xl animate-pulse" />
                </div>
            </div>
        );
    }

    return <Gallery images={images} />;
}