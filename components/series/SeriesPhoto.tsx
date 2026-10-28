'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import ResponsivePhoto from '@/components/ResponsivePhoto';
// Types only: the projection pulls node:crypto in through lib/media/url.ts, which must stay out of the client bundle.
import type { SeriesImage } from '@/lib/catalog/projections/series';
import styles from './SeriesPage.module.css';

export interface SeriesPhotoProps {
    /** The projection's image, or null when its set can't be shown. */
    image: SeriesImage | null;
    /** The image's own alt. Empty inside a named link. */
    alt: string;
    sizes: string;
    /** The cover loads at once at high priority, preloaded from the head. Sequence thumbnails load as they near the viewport. */
    priority?: boolean;
    /** Where the crop centers, 0 to 1 on each axis. */
    focalPoint?: { x: number; y: number };
    crop?: 'cover' | 'contain';
    /**
     * What the box says when there's no image. Left out inside a named link,
     * where any text would have to be part of the link's name (WCAG 2.5.3), so
     * the box shows the missing-image mark alone.
     */
    fallbackLabel?: string;
    /** The box's class, which reserves its shape. */
    frameClassName: string;
    /** Size the box from the photograph's own aspect ratio, as the cover does, and hand the class that ratio as --ratio. Otherwise the class sets it. */
    intrinsic?: boolean;
}

/**
 * One series photograph in a reserved box on the dark ground. When the set
 * can't be shown, or the image fails to load, the box holds a plain text
 * fallback instead of a broken image, and whatever surrounds it (position,
 * text, Viewer link) stays put. An image that fails before hydration never
 * fires onError, so the mount check looks too. An empty currentSrc is a lazy
 * image that hasn't started, which isn't a failure.
 */
export default function SeriesPhoto({ image, alt, sizes, priority = false, focalPoint, crop = 'cover', fallbackLabel, frameClassName, intrinsic = false }: SeriesPhotoProps) {
    const element = useRef<HTMLImageElement>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        const img = element.current;
        if (img && img.complete && img.naturalWidth === 0 && img.currentSrc !== '') setFailed(true);
    }, []);

    if (image === null || failed) {
        return (
            <span className={`${frameClassName} ${styles.fallback}`} data-photo="unavailable">
                {fallbackLabel !== undefined && <span className={styles.fallbackText}>{fallbackLabel}</span>}
            </span>
        );
    }

    const style = {
        // --ratio lets the class cap the width too, so a height cap never crops the box away from the photograph's shape.
        ...(intrinsic ? { aspectRatio: `${image.width} / ${image.height}`, '--ratio': `${image.width} / ${image.height}` } : {}),
        ...(focalPoint ? { '--focal-x': `${focalPoint.x * 100}%`, '--focal-y': `${focalPoint.y * 100}%` } : {}),
    } as CSSProperties;
    return (
        <span className={frameClassName} style={style} data-photo={crop}>
            <ResponsivePhoto
                ref={element}
                asset={image}
                alt={alt}
                sizes={sizes}
                loading={priority ? 'eager' : 'lazy'}
                fetchPriority={priority ? 'high' : undefined}
                preload={priority}
                onError={() => setFailed(true)}
                className={styles.image}
            />
        </span>
    );
}
