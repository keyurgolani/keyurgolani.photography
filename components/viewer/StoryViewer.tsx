'use client';

import { ArrowLeft, ArrowRight, SlidersHorizontal, X, ZoomIn } from 'lucide-react';
import Link from 'next/link';
import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import ResponsivePhoto from '@/components/ResponsivePhoto';
// Types only: the projection pulls the catalog schema and node:crypto in, which must stay out of the client bundle.
import type { PublishedViewerPhoto } from '@/lib/catalog/projections/viewer';
import {
    CLOSE_LABEL,
    DESCRIPTION_LABEL,
    HIDE_TECHNICAL,
    NEXT_LABEL,
    PREVIOUS_LABEL,
    SHOW_TECHNICAL,
    TECHNICAL_LABELS,
    TECHNICAL_SOURCE,
    UNAVAILABLE_LABEL,
    ZOOM_LABEL,
    accentValue,
    positionLabel,
    positionText,
} from './viewerLabels';
import styles from './StoryViewer.module.css';

export interface StoryViewerProps {
    viewer: PublishedViewerPhoto;
    /** The series page Close returns to. */
    closeHref: string;
    /** Null at the first photograph, where the Viewer stops. */
    previousHref: string | null;
    /** Null at the last photograph. */
    nextHref: string | null;
    /** The neutral copy, only when the description is pending (a draft preview). The page passes it, so this file never imports the projection. */
    pendingCopy: string | null;
}

/** The fitted photograph is at most about four fifths of a wide viewport, and the full width of a narrow one. */
export const FIT_SIZES = '(min-width: 48rem) 80vw, 100vw';

/**
 * Previous or Next inside the series. A move replaces the history entry, so
 * one Back from the Viewer returns to wherever the visitor entered it from.
 * No prefetch: a prefetched page stays cached and could show a revision
 * that's no longer active. At an end the control stays in place, disabled,
 * and the Viewer stops there.
 */
function Step({ href, label, icon, className }: { href: string | null; label: string; icon: ReactNode; className: string }) {
    if (href === null) {
        return (
            <button type="button" className={`${styles.step} ${className}`} aria-label={label} disabled>
                {icon}
            </button>
        );
    }
    return (
        <Link href={href} replace prefetch={false} className={`${styles.step} ${className}`} aria-label={label}>
            {icon}
        </Link>
    );
}

/**
 * The Viewer (#7) in Chromatic Chapters: the series title and position over
 * the photograph at decisive scale, Previous and Next beside it, and a
 * bounded reading area that keeps authored copy apart from the camera facts,
 * which stay collapsed until asked for. Its own dark ground under both site
 * themes, and no SiteNav. Authored text renders as text nodes only. When the
 * revision holds no usable set for the photo, the stage keeps a reserved box
 * with the series page's missing-image copy, Previous and Next stay beside it,
 * and Zoom is disabled, since there's nothing to enlarge.
 */
export default function StoryViewer({ viewer, closeHref, previousHref, nextHref, pendingCopy }: StoryViewerProps) {
    const { series, photo, position, total } = viewer;
    const [zoomed, setZoomed] = useState(false);
    const [technicalOpen, setTechnicalOpen] = useState(false);
    const technicalId = useId();
    const readingId = useId();

    const accent = accentValue(photo.accent, series.accent);
    const surface = (accent === null ? undefined : { '--cc-accent': accent }) as CSSProperties | undefined;
    const facts = (Object.keys(TECHNICAL_LABELS) as (keyof typeof TECHNICAL_LABELS)[]).flatMap((key) => {
        const value = photo.technical[key];
        return typeof value === 'string' ? [{ key, label: TECHNICAL_LABELS[key], value }] : [];
    });
    const { image } = photo;
    const largest = image === null ? null : image.variants.w1920.webp.width;
    const zoomedIn = zoomed && largest !== null;

    return (
        <div data-surface="viewer" className={styles.viewer} style={surface}>
            <header className={styles.header}>
                <Link href={closeHref} prefetch={false} className={styles.control}>
                    <X aria-hidden="true" size={18} />
                    {CLOSE_LABEL}
                </Link>
                <div className={styles.heading}>
                    <h1 className={styles.series}>{series.title}</h1>
                    <p className={styles.position}>
                        <span aria-hidden="true">{positionLabel(position, total)}</span>
                        <span className="sr-only">{positionText(position, total)}</span>
                    </p>
                </div>
                <button
                    type="button"
                    className={`${styles.control} ${styles.zoom}`}
                    aria-pressed={zoomedIn}
                    disabled={image === null}
                    onClick={() => setZoomed((value) => !value)}
                >
                    <ZoomIn aria-hidden="true" size={18} />
                    {ZOOM_LABEL}
                </button>
            </header>

            <main className={styles.main}>
                <div className={styles.stage}>
                    <Step href={previousHref} label={PREVIOUS_LABEL} icon={<ArrowLeft aria-hidden="true" size={20} />} className={styles.previous} />
                    <div
                        className={styles.viewport}
                        data-zoomed={zoomedIn ? 'true' : undefined}
                        // Zoomed, the photograph can overflow its box, and a scroll region has to be reachable by keyboard.
                        tabIndex={zoomedIn ? 0 : undefined}
                        role={zoomedIn ? 'region' : undefined}
                        aria-label={zoomedIn ? 'Zoomed photograph' : undefined}
                    >
                        {image === null ? (
                            <div className={styles.missing} data-photo="unavailable">
                                <span className={styles.missingLabel}>{UNAVAILABLE_LABEL}</span>
                            </div>
                        ) : (
                            <figure className={styles.frame} style={zoomedIn ? ({ '--zoom-width': `${largest}px` } as CSSProperties) : undefined}>
                                <ResponsivePhoto
                                    asset={image}
                                    alt={photo.alt}
                                    sizes={zoomedIn ? `${largest}px` : FIT_SIZES}
                                    loading="eager"
                                    fetchPriority="high"
                                    className={styles.image}
                                />
                            </figure>
                        )}
                    </div>
                    <Step href={nextHref} label={NEXT_LABEL} icon={<ArrowRight aria-hidden="true" size={20} />} className={styles.next} />
                </div>

                <section className={styles.reading} aria-labelledby={readingId}>
                    <h2 id={readingId} className={photo.title === null ? 'sr-only' : styles.title}>
                        {photo.title ?? positionText(position, total)}
                    </h2>
                    {photo.caption !== null && <p className={styles.caption}>{photo.caption}</p>}
                    {(photo.description !== null || pendingCopy !== null) && (
                        <div className={styles.description}>
                            <p className={styles.label}>{DESCRIPTION_LABEL}</p>
                            {photo.description !== null ? (
                                <p className={styles.descriptionText}>{photo.description}</p>
                            ) : (
                                <p className={styles.pending} data-description="pending">
                                    {pendingCopy}
                                </p>
                            )}
                        </div>
                    )}
                    {facts.length > 0 && (
                        <div className={styles.technical}>
                            <button
                                type="button"
                                className={styles.control}
                                aria-expanded={technicalOpen}
                                aria-controls={technicalId}
                                onClick={() => setTechnicalOpen((value) => !value)}
                            >
                                <SlidersHorizontal aria-hidden="true" size={16} />
                                {technicalOpen ? HIDE_TECHNICAL : SHOW_TECHNICAL}
                            </button>
                            <div id={technicalId} className={styles.panel} hidden={!technicalOpen}>
                                <p className={styles.label}>{TECHNICAL_SOURCE}</p>
                                <dl className={styles.facts}>
                                    {facts.map((fact) => (
                                        <div key={fact.key} className={styles.fact}>
                                            <dt>{fact.label}</dt>
                                            <dd>{fact.value}</dd>
                                        </div>
                                    ))}
                                </dl>
                            </div>
                        </div>
                    )}
                </section>
            </main>
        </div>
    );
}
