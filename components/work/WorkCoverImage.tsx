'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import ResponsivePhoto from '@/components/ResponsivePhoto';
// Types only: the projection modules pull node:crypto in through lib/media/url.ts, which must stay out of the client bundle.
import type { WorkCover } from '@/lib/catalog/projections/work';
import styles from './SeriesCatalog.module.css';

export interface WorkCoverImageProps {
    /** The projection's cover, or null when it can't be shown. */
    cover: WorkCover | null;
    /** The first cover: load at once at high priority, preloaded from the head, instead of lazily. */
    eager?: boolean;
}

/** Wide entries take about 60% of the row above 768 px; below it every entry is full width. */
export const COVER_SIZES = '(min-width: 768px) 60vw, 100vw';

/**
 * A series cover in its reserved box on the dark ground, cropped around its
 * focal point. Decorative: the entry's text names the link. When there is no
 * cover, or the image fails, the box holds a plain text fallback instead of a
 * broken image. An image that fails before hydration never fires onError, so
 * the mount check looks too. An empty currentSrc means a lazy image that
 * hasn't started, which isn't a failure.
 */
export default function WorkCoverImage({ cover, eager = false }: WorkCoverImageProps) {
    const image = useRef<HTMLImageElement>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        const element = image.current;
        if (element && element.complete && element.naturalWidth === 0 && element.currentSrc !== '') setFailed(true);
    }, []);

    if (cover === null || failed) {
        return (
            <div className={`${styles.frame} ${styles.fallback}`} data-cover="unavailable">
                {/* Hidden from the link's name, which the title starts, as the cover itself is decorative. */}
                <span className={styles.fallbackText} aria-hidden="true">
                    Cover unavailable
                </span>
            </div>
        );
    }

    const focal = { '--focal-x': `${cover.focalPoint.x * 100}%`, '--focal-y': `${cover.focalPoint.y * 100}%` } as CSSProperties;
    return (
        <div className={styles.frame} style={focal} data-cover={cover.crop}>
            <ResponsivePhoto
                ref={image}
                asset={cover}
                alt=""
                sizes={COVER_SIZES}
                loading={eager ? 'eager' : 'lazy'}
                fetchPriority={eager ? 'high' : undefined}
                preload={eager}
                onError={() => setFailed(true)}
                className={styles.cover}
            />
        </div>
    );
}
