'use client';

import React, { useEffect, useState, useCallback } from 'react';
import HeroCarousel from './HeroCarousel';
import { ImageItem } from '@/utils/getImageData';
import {
    getCachedHomeHeroImages,
    HeroCarouselImage,
    setCachedHomeHeroImages,
} from '@/utils/homeHeroCache';

interface DynamicHeroCarouselProps {
    autoScroll?: boolean;
    autoScrollEnabled?: boolean;
    interval?: number;
    onFirstImageLoaded?: () => void;
}

// Get carousel interval from env variable (in milliseconds), default 12000ms (12 seconds)
const CAROUSEL_INTERVAL = parseInt(process.env.NEXT_PUBLIC_CAROUSEL_INTERVAL || '12000', 10);

// Fisher-Yates shuffle algorithm for randomizing array order
function shuffleArray<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

function mergeCarouselImages(
    existingImages: HeroCarouselImage[],
    latestImages: HeroCarouselImage[]
) {
    if (existingImages.length === 0) {
        return shuffleArray(latestImages);
    }

    const latestImagesBySrc = new Map(latestImages.map((image) => [image.src, image]));
    const retainedImages = existingImages
        .filter((image) => latestImagesBySrc.has(image.src))
        .map((image) => latestImagesBySrc.get(image.src)!);
    const retainedSrcs = new Set(retainedImages.map((image) => image.src));
    const newImages = latestImages.filter((image) => !retainedSrcs.has(image.src));

    return newImages.length > 0
        ? [...retainedImages, ...shuffleArray(newImages)]
        : retainedImages;
}

const DynamicHeroCarousel: React.FC<DynamicHeroCarouselProps> = ({
    autoScroll = true,
    autoScrollEnabled = true,
    interval = CAROUSEL_INTERVAL,
    onFirstImageLoaded,
}) => {
    const [images, setImages] = useState<HeroCarouselImage[]>(() => getCachedHomeHeroImages());

    // Preload multiple high-quality images for LCP
    const preloadImages = useCallback((imageUrls: string[]) => {
        if (typeof document === 'undefined') return;
        
        imageUrls.slice(0, 2).forEach((url, index) => {
            const link = document.createElement('link');
            link.rel = 'preload';
            link.as = 'image';
            link.href = url;
            link.setAttribute('fetchpriority', index === 0 ? 'high' : 'auto');
            document.head.appendChild(link);
            
            // Cleanup after a reasonable time
            setTimeout(() => {
                try {
                    document.head.removeChild(link);
                } catch {
                    // Link may have been removed already
                }
            }, 15000);
        });
    }, []);

    useEffect(() => {
        const fetchImages = async () => {
            try {
                const response = await fetch('/api/photos');
                if (!response.ok) {
                    throw new Error('Failed to fetch images');
                }
                const data: ImageItem[] = await response.json();
                // Use pre-optimized image paths directly (already WebP format)
                // The /api/image route will serve these if they exist, but direct paths are faster
                const carouselImages = data.map(img => ({
                    thumbnail: img.thumbnail,  // Pre-generated 400px WebP
                    optimized: img.optimized, // Pre-generated 1920px WebP
                    src: img.src,
                }));
                const nextImages = mergeCarouselImages(getCachedHomeHeroImages(), carouselImages);
                setCachedHomeHeroImages(nextImages);
                setImages(nextImages);
                
                // Preload first 2 high-quality images for better LCP
                if (nextImages.length > 0) {
                    preloadImages(nextImages.map(img => img.optimized));
                }
            } catch (error) {
                console.error('Error fetching gallery images:', error);
                if (getCachedHomeHeroImages().length === 0) {
                    setImages([]);
                }
            }
        };

        fetchImages();
    }, [preloadImages]);

    if (images.length === 0) {
        return null;
    }

    return (
        <HeroCarousel
            images={images}
            autoScroll={autoScroll}
            autoScrollEnabled={autoScrollEnabled}
            interval={interval}
            preloadImages={preloadImages}
            onFirstImageLoaded={onFirstImageLoaded}
        />
    );
};

export default DynamicHeroCarousel;
