'use client';

import React, { useEffect, useState, useCallback } from 'react';
import HeroCarousel from './HeroCarousel';
import { ImageItem } from '@/utils/getImageData';
import styles from './DynamicHeroCarousel.module.css';

interface CarouselImage {
    thumbnail: string;
    optimized: string;
    src: string;
}

interface DynamicHeroCarouselProps {
    autoScroll?: boolean;
    interval?: number;
}

const DynamicHeroCarousel: React.FC<DynamicHeroCarouselProps> = ({
    autoScroll = true,
    interval = 18000, // 3x the original 6000ms
}) => {
    const [images, setImages] = useState<CarouselImage[]>([]);

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
                // Route through /api/image for format negotiation (AVIF/WebP)
                const carouselImages = data.map(img => ({
                    thumbnail: `/api/image?src=${encodeURIComponent(img.src)}&width=400`,
                    optimized: `/api/image?src=${encodeURIComponent(img.src)}&width=1920`,
                    src: img.src,
                }));
                setImages(carouselImages);
                
                // Preload first 2 high-quality images for better LCP
                if (carouselImages.length > 0) {
                    preloadImages(carouselImages.map(img => img.optimized));
                }
            } catch (error) {
                console.error('Error fetching gallery images:', error);
                setImages([]);
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
            interval={interval}
            preloadImages={preloadImages}
        />
    );
};

export default DynamicHeroCarousel;