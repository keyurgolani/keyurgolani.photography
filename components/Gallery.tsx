'use client';

import React, { useState, useRef, useEffect, useMemo } from 'react';
import Lightbox from 'yet-another-react-lightbox';
import 'yet-another-react-lightbox/styles.css';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';
import Slideshow from 'yet-another-react-lightbox/plugins/slideshow';
import Thumbnails from 'yet-another-react-lightbox/plugins/thumbnails';
import 'yet-another-react-lightbox/plugins/thumbnails.css';
import Image from 'next/image';

interface ImageItem {
    id: number;
    src: string;
    thumbnail?: string;
    width: number;
    height: number;
    caption?: string;
    lqip?: string;
}

interface GalleryProps {
    images: ImageItem[];
    className?: string;
}

// Compute sizes attribute based on column span
const getSizes = (colSpan: number): string => {
    // 12-column grid at desktop: each col ≈ 8.33vw
    const desktopVw = Math.round((colSpan / 12) * 100);
    // 10-column grid at md (768px–1024px)
    const mdVw = Math.min(100, Math.round((colSpan / 10) * 100));
    // 8-column grid at sm (640px–768px)
    const smVw = Math.min(100, Math.round((colSpan / 8) * 100));
    // 4-column grid at mobile
    const mobileVw = Math.min(100, Math.round((colSpan / 4) * 100));
    return `(max-width: 640px) ${mobileVw}vw, (max-width: 768px) ${smVw}vw, (max-width: 1024px) ${mdVw}vw, ${desktopVw}vw`;
};

// Lazy-loaded gallery tile component
function LazyGalleryTile({ 
    img, 
    index, 
    colSpan, 
    rows, 
    onClick 
}: { 
    img: ImageItem; 
    index: number; 
    colSpan: number; 
    rows: number; 
    onClick: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [isVisible, setIsVisible] = useState(index < 8); // First 8 load eagerly

    useEffect(() => {
        if (isVisible) return; // Already visible, no need to observe
        
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) {
                    setIsVisible(true);
                    observer.disconnect();
                }
            },
            { rootMargin: '400px' } // Start loading 400px before entering viewport
        );
        
        if (ref.current) observer.observe(ref.current);
        return () => observer.disconnect();
    }, [isVisible]);

    const sizes = useMemo(() => getSizes(colSpan), [colSpan]);

    return (
        <div 
            ref={ref}
            style={{ gridColumn: `span ${colSpan}`, gridRow: `span ${rows}` }}
            className="relative group cursor-pointer overflow-hidden rounded-xl shadow-lg border border-white/20 dark:border-white/10 transition-all duration-500 hover:shadow-2xl hover:scale-[1.01] hover:z-10"
            onClick={onClick}
        >
            {isVisible ? (
                <Image
                    src={img.src}
                    alt={img.caption || `Gallery Image ${index + 1}`}
                    fill
                    placeholder="blur"
                    blurDataURL={img.lqip || 'data:image/webp;base64,UklGRlYAAABXRUJQVlA4IEoAAADQAQCdASoKAAoAAUAmJYgCdAEO9ACA/v9P9f96f1AAAAAAfQ=='}
                    sizes={sizes}
                    className="object-cover transition-transform duration-700 group-hover:scale-110"
                />
            ) : (
                <div className="absolute inset-0 bg-neutral-200/50 dark:bg-white/10 animate-pulse" />
            )}
            {/* Overlay with details */}
            {isVisible && (
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-4 pointer-events-none">
                    <p className="text-white text-xs font-light tracking-wider opacity-90 translate-y-2 group-hover:translate-y-0 transition-transform duration-300">
                        {img.caption}
                    </p>
                </div>
            )}
        </div>
    );
}

export default function Gallery({ images, className = '' }: GalleryProps) {
    const [index, setIndex] = useState(-1);

    // Use pre-optimized image paths directly (already WebP format)
    const photos = images.map(img => ({
        src: img.src,  // Pre-optimized 1920px WebP
        thumbnail: img.thumbnail || img.src,  // Pre-optimized 400px WebP
        width: img.width,
        height: img.height,
    }));

    // Granular "Best Fit" Layout Logic
    // mapped to a 4-column base (mobile) -> 12-column (desktop) system.
    // Row height is fixed at 50px.
    // Base "Unit" Width ~100-120px (Desktop).
    
    const getLayout = (width: number, height: number) => {
        const aspectRatio = width / height;
        const unitRatio = 2.0; // 1 Col (100px) is roughly 2x wider than 1 Row (50px)

        // We want to find the integer pair (cols, rows) that closest matches 'aspectRatio'
        // Formula: (cols * unitRatio) / rows ≈ aspectRatio
        // => rows ≈ (cols * unitRatio) / aspectRatio
        
        // Search Range
        const limit = width > 2500 ? 9 : 7;
        const minCols = 4;

        let bestLayout = { cols: 4, rows: 4, error: Infinity };

        for (let c = minCols; c <= limit; c++) {
            // Calculate ideal rows for this column width
            const idealRows = (c * unitRatio) / aspectRatio;
            let r = Math.round(idealRows);
            
            // Constraints
            r = Math.max(3, Math.min(r, 12)); // Min 3 rows, Max 12 rows

            // Calculate exact AR of this tile
            const tileAR = (c * unitRatio) / r;
            const error = Math.abs(tileAR - aspectRatio);

            if (error < bestLayout.error) {
                bestLayout = { cols: c, rows: r, error };
            }
        }

        return { 
            cols: bestLayout.cols, 
            rows: bestLayout.rows,
            gridColumn: `span ${bestLayout.cols}`, 
            gridRow: `span ${bestLayout.rows}` 
        };
    };

    return (
        <div className={`w-full ${className}`}>
            <div className="grid grid-cols-4 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12 auto-rows-[50px] gap-3 grid-flow-dense">
                {images.map((img, i) => {
                    const layout = getLayout(img.width, img.height);
                    return (
                        <LazyGalleryTile
                            key={img.id}
                            img={img}
                            index={i}
                            colSpan={layout.cols}
                            rows={layout.rows}
                            onClick={() => setIndex(i)}
                        />
                    );
                })}
            </div>

            <Lightbox
                slides={photos}
                open={index >= 0}
                index={index}
                close={() => setIndex(-1)}
                plugins={[Zoom, Slideshow, Thumbnails]}
                zoom={{ maxZoomPixelRatio: 3 }}
            />
        </div>
    );
}