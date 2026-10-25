'use client';

import { SlidersHorizontal } from 'lucide-react';
import { useContext, useId, useLayoutEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import ResponsivePhoto from '@/components/ResponsivePhoto';
// Types only: the projection pulls the catalog schema and node:crypto in, which must stay out of the client bundle.
import type { PublishedViewerPhoto } from '@/lib/catalog/projections/viewer';
import ViewerChrome from './ViewerChrome';
import { ViewerContext, type ViewerChromeState } from './viewerContext';
import {
    DESCRIPTION_LABEL,
    HIDE_TECHNICAL,
    SHOW_TECHNICAL,
    TECHNICAL_LABELS,
    TECHNICAL_SOURCE,
    UNAVAILABLE_LABEL,
    accentValue,
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
 * One photograph in the Viewer (#7) in Chromatic Chapters: the photograph at
 * decisive scale and a bounded reading area that keeps authored copy apart
 * from the camera facts, which stay collapsed until asked for. Authored text
 * renders as text nodes only. When the revision holds no usable set for the
 * photo, the stage keeps a reserved box with the series page's missing-image
 * copy, and Zoom has nothing to enlarge.
 *
 * Inside #9's ViewerShell, which outlives every move, this component tells
 * the shell its position and neighbors, and the shell renders the header and
 * Previous and Next, so focus stays on them when the photograph changes.
 * Until the shell takes them over (the server HTML and hydration), and
 * outside a shell, this component renders them itself, in the same places,
 * with the links working before hydration. Outside a shell it is the whole
 * Viewer, with its own surface root.
 */
export default function StoryViewer({ viewer, closeHref, previousHref, nextHref, pendingCopy }: StoryViewerProps) {
    const { series, photo, position, total } = viewer;
    const shell = useContext(ViewerContext);
    const [ownZoom, setOwnZoom] = useState(false);
    const [technicalOpen, setTechnicalOpen] = useState(false);
    const technicalId = useId();
    const readingId = useId();

    const accent = accentValue(photo.accent, series.accent);
    const { image } = photo;
    const chrome = useMemo<ViewerChromeState>(
        () => ({ photoId: photo.id, seriesTitle: series.title, closeHref, previousHref, nextHref, position, total, hasImage: image !== null, accent }),
        [photo.id, series.title, closeHref, previousHref, nextHref, position, total, image, accent],
    );
    const report = shell?.report;
    // Before paint, so the shell's controls replace these in the same frame and show this photograph's state.
    useLayoutEffect(() => {
        report?.(chrome);
    }, [report, chrome]);

    const claimed = shell?.claimed ?? false;
    const zoomed = shell === null ? ownZoom : shell.claimed && shell.zoomed;
    const surface = (accent === null ? undefined : { '--cc-accent': accent }) as CSSProperties | undefined;
    const facts = (Object.keys(TECHNICAL_LABELS) as (keyof typeof TECHNICAL_LABELS)[]).flatMap((key) => {
        const value = photo.technical[key];
        return typeof value === 'string' ? [{ key, label: TECHNICAL_LABELS[key], value }] : [];
    });
    const largest = image === null ? null : image.variants.w1920.webp.width;
    const zoomedIn = zoomed && largest !== null;

    const content: ReactNode = (
        <>
            {!claimed && (
                <ViewerChrome
                    state={chrome}
                    mode={shell?.mode ?? 'page'}
                    headingId={shell?.headingId}
                    zoomed={zoomedIn}
                    onZoom={shell === null ? () => setOwnZoom((value) => !value) : undefined}
                    actions={null}
                />
            )}
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
                            data-viewer-focus="technical"
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
        </>
    );

    // Outside a shell this is the whole Viewer, on its own surface root.
    if (shell === null) {
        return (
            <main data-surface="viewer" data-viewer-mode="page" className={styles.viewer} style={surface}>
                {content}
            </main>
        );
    }
    // In the shell its pieces sit in the shell's grid, and the accent reaches the controls it renders before the shell takes them.
    return (
        <div className={styles.content} style={surface} data-viewer-photo={photo.id}>
            {content}
        </div>
    );
}
