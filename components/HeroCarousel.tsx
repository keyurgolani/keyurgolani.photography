'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import styles from './HeroCarousel.module.css';

interface CarouselImage {
    thumbnail: string;
    optimized: string;
    src: string;
}

interface HeroCarouselProps {
  images: CarouselImage[];
  autoScroll?: boolean;
  interval?: number;
  onFirstImageLoaded?: () => void;
}

const HeroCarousel: React.FC<HeroCarouselProps> = ({
  images,
  autoScroll = true,
  interval = 6000,
  onFirstImageLoaded,
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loadedImages, setLoadedImages] = useState<Set<number>>(new Set());
  const [optimizedImages, setOptimizedImages] = useState<Set<number>>(new Set());
  const [preloadedImages, setPreloadedImages] = useState<Set<number>>(new Set());
  const firstImageRef = useRef(false);

  const nextSlide = useCallback(() => {
    setCurrentIndex((prev) => (prev === images.length - 1 ? 0 : prev + 1));
  }, [images.length]);

  const prevSlide = useCallback(() => {
    setCurrentIndex((prev) => (prev === 0 ? images.length - 1 : prev - 1));
  }, [images.length]);

  const goToSlide = (index: number) => {
    setCurrentIndex(index);
  };

  const handleImageLoad = (index: number, isOptimized: boolean = false) => {
    if (isOptimized) {
        setOptimizedImages(prev => new Set(prev).add(index));
    } else {
        setLoadedImages(prev => new Set(prev).add(index));
    }
    
    // Notify parent when first image thumbnail is loaded
    if (index === 0 && !firstImageRef.current && !isOptimized) {
      firstImageRef.current = true;
      onFirstImageLoaded?.();
    }
  };

  // Preload next/previous images when current slide changes
  useEffect(() => {
    if (images.length === 0) return;
    
    const nextIndex = (currentIndex + 1) % images.length;
    const prevIndex = (currentIndex - 1 + images.length) % images.length;
    
    // Preload adjacent images
    [nextIndex, prevIndex].forEach(idx => {
      if (!preloadedImages.has(idx)) {
        // Preload both thumbnail and optimized for adjacent slides
        const thumbImg = new Image();
        thumbImg.src = images[idx].thumbnail;
        
        const optImg = new Image();
        optImg.src = images[idx].optimized;
        
        setPreloadedImages(prev => new Set(prev).add(idx));
      }
    });
    
    // Also preload optimized version for current slide if only thumbnail is shown
    if (loadedImages.has(currentIndex) && !optimizedImages.has(currentIndex)) {
        const optImg = new Image();
        optImg.src = images[currentIndex].optimized;
    }
  }, [currentIndex, images, preloadedImages, loadedImages, optimizedImages]);

  useEffect(() => {
    if (!autoScroll) return;
    const slideInterval = setInterval(nextSlide, interval);
    return () => clearInterval(slideInterval);
  }, [autoScroll, interval, nextSlide]);

  if (!images || images.length === 0) return null;

  return (
    <div className={styles.carousel}>
      {images.map((img, index) => {
        // Only render image elements for current slide, adjacent slides, and loaded images
        const shouldRender = Math.abs(index - currentIndex) <= 1 || loadedImages.has(index);
        const isLoaded = loadedImages.has(index);
        const hasOptimized = optimizedImages.has(index);
        
        return (
          <div
            key={index}
            className={`${styles.slide} ${index === currentIndex ? styles.active : ''}`}
            aria-hidden={index !== currentIndex}
          >
            {shouldRender && (
              <>
                {/* Thumbnail layer (loads first) */}
                <img
                  src={img.thumbnail}
                  alt={`Slide ${index + 1}`}
                  className={`${styles.slideImage} ${styles.thumbnailLayer}`}
                  loading={index === 0 ? 'eager' : 'lazy'}
                  onLoad={() => handleImageLoad(index, false)}
                  style={{ opacity: isLoaded && !hasOptimized ? 1 : hasOptimized ? 0 : 0 }}
                />
                {/* Optimized layer (loads on top) */}
                <img
                  src={img.optimized}
                  alt={`Slide ${index + 1}`}
                  className={`${styles.slideImage} ${styles.optimizedLayer}`}
                  loading={index === 0 ? 'eager' : 'lazy'}
                  onLoad={() => handleImageLoad(index, true)}
                  style={{ opacity: hasOptimized ? 1 : 0 }}
                />
              </>
            )}
            {/* Placeholder while loading */}
            {!isLoaded && index === currentIndex && (
              <div className={styles.slidePlaceholder} />
            )}
          </div>
        );
      })}

      <button
        className={`${styles.navButton} ${styles.prev}`}
        onClick={prevSlide}
        aria-label="Previous Slide"
      >
        <ChevronLeft size={24} />
      </button>

      <button
        className={`${styles.navButton} ${styles.next}`}
        onClick={nextSlide}
        aria-label="Next Slide"
      >
        <ChevronRight size={24} />
      </button>

      <div className={styles.indicators}>
        {images.map((_, index) => (
          <button
            key={index}
            className={`${styles.indicator} ${index === currentIndex ? styles.active : ''}`}
            onClick={() => goToSlide(index)}
            aria-label={`Go to slide ${index + 1}`}
          />
        ))}
      </div>
    </div>
  );
};

export default HeroCarousel;