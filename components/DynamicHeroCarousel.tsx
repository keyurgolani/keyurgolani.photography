'use client';

import React, { useEffect, useState } from 'react';
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

    useEffect(() => {
        const fetchImages = async () => {
            try {
                const response = await fetch('/api/photos');
                if (!response.ok) {
                    throw new Error('Failed to fetch images');
                }
                const data: ImageItem[] = await response.json();
                setImages(data.map(img => ({
                    thumbnail: img.thumbnail,
                    optimized: img.optimized,
                    src: img.src,
                })));
                
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

    // Loading splash screen with animation
    if (isLoading && images.length > 0) {
        return (
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
        );
    }

    // Show minimal loader if no images yet
    if (isLoading && images.length === 0) {
        return (
            <div className={styles.loadingScreen}>
                <div className={styles.loadingContent}>
                    <div className={styles.logoContainer}>
                        <div className={styles.logoRing}>
                            <div className={styles.logoRingInner}></div>
                        </div>
                        <span className={styles.logoText}>KG</span>
                    </div>
                </div>
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
            onFirstImageLoaded={handleFirstImageLoaded}
        />
    );
};

export default DynamicHeroCarousel;