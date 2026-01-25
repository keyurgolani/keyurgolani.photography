'use client';

import React, { useEffect, useState } from 'react';
import HeroCarousel from './HeroCarousel';
import { ImageItem } from '@/utils/getImageData';

interface DynamicHeroCarouselProps {
    autoScroll?: boolean;
    interval?: number;
}

const DynamicHeroCarousel: React.FC<DynamicHeroCarouselProps> = ({
    autoScroll = true,
    interval = 6000,
}) => {
    const [images, setImages] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchImages = async () => {
            try {
                const response = await fetch('/api/photos');
                if (!response.ok) {
                    throw new Error('Failed to fetch images');
                }
                const data: ImageItem[] = await response.json();
                setImages(data.map(img => img.src));
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
            <div className="w-full h-full flex items-center justify-center bg-black">
                <div className="animate-pulse text-white/50">Loading...</div>
            </div>
        );
    }

    if (images.length === 0) {
        return null;
    }

    return (
        <HeroCarousel 
            images={images} 
            autoScroll={autoScroll} 
            interval={interval} 
        />
    );
};

export default DynamicHeroCarousel;
