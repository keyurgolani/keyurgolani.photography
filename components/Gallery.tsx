'use client';

import React, { useState } from 'react';
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
    width: number;
    height: number;
    caption?: string;
}

interface GalleryProps {
    images: ImageItem[];
    className?: string;
}

export default function Gallery({ images, className = '' }: GalleryProps) {
    const [index, setIndex] = useState(-1);

    // Filter valid images & prepare for Lightbox
    const photos = images.map(img => ({
        src: img.src,
        width: img.width, // Lightbox needs original dimensions
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
        // Increase base size: Start searching from 4 cols (approx 1/3 screen) up to 8 cols
        const limit = width > 2500 ? 9 : 7;
        const minCols = 4;

        let bestLayout = { cols: 4, rows: 4, error: Infinity };

        for (let c = minCols; c <= limit; c++) {
            // Calculate ideal rows for this column width
            const idealRows = (c * unitRatio) / aspectRatio;
            let r = Math.round(idealRows);
            
            // Constraints
            r = Math.max(3, Math.min(r, 12)); // Min 3 rows (150px), Max 10 rows (500px)

            // Calculate exact AR of this tile
            const tileAR = (c * unitRatio) / r;
            const error = Math.abs(tileAR - aspectRatio);

            // Bias towards slightly larger images for high res? No, strict fit.
            if (error < bestLayout.error) {
                bestLayout = { cols: c, rows: r, error };
            }
        }

        return { 
            gridColumn: `span ${bestLayout.cols}`, 
            gridRow: `span ${bestLayout.rows}` 
        };
    };

    return (
        <div className={`w-full ${className}`}>
            {/* 
                Granular Grid Setup:
                - Mobile: 4 Cols.
                - Tablet: 8 Cols.
                - Desktop: 12 Cols.
                - Row Height: 50px (dense packing).
                
                Note: Inline styles for 'span X' will apply to the grid tracks available.
                On Mobile (4 cols), 'span 6' wraps to full width (effectively span 4).
            */}
            <div className="grid grid-cols-4 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12 auto-rows-[50px] gap-3 grid-flow-dense">
                {images.map((img, i) => {
                    const style = getLayout(img.width, img.height);
                    return (
                        <div 
                            key={img.id} 
                            style={style}
                            className={`relative group cursor-pointer overflow-hidden rounded-xl shadow-lg border border-white/20 dark:border-white/10 transition-all duration-500 hover:shadow-2xl hover:scale-[1.01] hover:z-10`}
                            onClick={() => setIndex(i)}
                        >
                            <Image
                                src={img.src}
                                alt={img.caption || `Gallery Image ${i + 1}`}
                                fill
                                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                                className="object-cover transition-transform duration-700 group-hover:scale-110"
                            />
                            {/* Overlay with details */}
                            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-4 pointer-events-none">
                                <p className="text-white text-xs font-light tracking-wider opacity-90 translate-y-2 group-hover:translate-y-0 transition-transform duration-300">
                                    {img.caption}
                                </p>
                            </div>
                        </div>
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
