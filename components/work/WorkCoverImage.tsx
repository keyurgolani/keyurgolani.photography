'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import ResponsivePhoto from '@/components/ResponsivePhoto';
// Types only: the projection modules pull node:crypto in through lib/media/url.ts, which must stay out of the client bundle.
import type { WorkCover } from '@/lib/catalog/projections/work';
import { coverSizes, type CoverSpan } from './coverSizes';
import styles from './SeriesCatalog.module.css';

export interface WorkCoverImageProps {
    /** The projection's cover, or null when it can't be shown. */
    cover: WorkCover | null;
    /**
     * `lead` for the first cover: at once, at high priority, preloaded from the head. `eager` for the second: at once,
     * at low priority, so the lead has a slow link to itself first (#172's LCP bar). The rest load lazily (#3).
     */
    loading?: 'lead' | 'eager' | 'lazy';
    /** Its entry's share of the row above 768 px (coverSpan()). */
    span?: CoverSpan;
}

/**
 * A series cover in its reserved box on the dark ground, cropped around its
 * focal point. Decorative, outside the link: the title names it. When there is no
 * cover, or the image fails, the box holds a plain text fallback instead of a
 * broken image. An image that fails before hydration never fires onError, so
 * the mount check looks too. An empty currentSrc means a lazy image that
 * hasn't started, which isn't a failure.
 */
export default function WorkCoverImage({ cover, loading = 'lazy', span = 'wide' }: WorkCoverImageProps) {
    const image = useRef<HTMLImageElement>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        const element = image.current;
        if (element && element.complete && element.naturalWidth === 0 && element.currentSrc !== '') setFailed(true);
    }, []);

    if (cover === null || failed) {
        return (
            <div className={`${styles.frame} ${styles.fallback}`} data-cover="unavailable">
                {/* Hidden from assistive tech, as the cover itself is decorative: the title names the entry's link. */}
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
                sizes={coverSizes(cover, span)}
                loading={loading === 'lazy' ? 'lazy' : 'eager'}
                fetchPriority={loading === 'lead' ? 'high' : loading === 'eager' ? 'low' : undefined}
                preload={loading === 'lead'}
                onError={() => setFailed(true)}
                className={styles.cover}
            />
        </div>
    );
}
