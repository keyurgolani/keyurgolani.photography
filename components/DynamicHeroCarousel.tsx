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
    interval = 6000,
}) => {
    const [images, setImages] = useState<CarouselImage[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isExiting, setIsExiting] = useState(false);

    // Preload first image for LCP
    const preloadFirstImage = useCallback((optimized: string) => {
        if (typeof document === 'undefined') return;
        
        const link = document.createElement('link');
        link.rel = 'preload';
        link.as = 'image';
        link.href = optimized;
        link.setAttribute('fetchpriority', 'high');
        document.head.appendChild(link);
        
        // Cleanup after a reasonable time
        setTimeout(() => {
            try {
                document.head.removeChild(link);
            } catch {
                // Link may have been removed already
            }
        }, 10000);
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
                
                // Preload first image for better LCP
                if (carouselImages.length > 0) {
                    preloadFirstImage(carouselImages[0].optimized);
                }
                
                // If no images, stop loading immediately
                if (data.length === 0) {
                    setIsLoading(false);
                }
            } catch (error) {
                console.error('Error fetching gallery images:', error);
                setImages([]);
                setIsLoading(false);
            }
        };

        fetchImages();
    }, []);

    const handleFirstImageLoaded = () => {
        // Start exit animation
        setIsExiting(true);
        
        // Remove loading screen after animation completes
        setTimeout(() => {
            setIsLoading(false);
        }, 800); // Match animation duration
    };

    if (images.length === 0 && !isLoading) {
        return null;
    }

    return (
        <>
            {/* Loading splash screen with animation - rendered on top of carousel */}
            {isLoading && (
                <div className={`${styles.loadingScreen} ${isExiting ? styles.exiting : ''}`}>
                    <div className={styles.loadingContent}>
                        <div className={styles.logoContainer}>
                            <div className={styles.logoRing}>
                                <div className={styles.logoRingInner}></div>
                            </div>
                            <span className={styles.logoText}>KG</span>
                        </div>
                        <div className={styles.loadingBar}>
                            <div className={styles.loadingProgress}></div>
                        </div>
                        <p className={styles.loadingText}>Loading Experience</p>
                    </div>
                </div>
            )}
            
            {/* Carousel rendered behind loader so images can start loading */}
            {images.length > 0 && (
                <HeroCarousel 
                    images={images} 
                    autoScroll={autoScroll} 
                    interval={interval}
                    onFirstImageLoaded={handleFirstImageLoaded}
                />
            )}
        </>
    );
};

export default DynamicHeroCarousel;