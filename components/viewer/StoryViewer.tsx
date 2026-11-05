'use client';

import { SlidersHorizontal } from 'lucide-react';
import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import ResponsivePhoto from '@/components/ResponsivePhoto';
// Types only: the projection pulls the catalog schema and node:crypto in, which must stay out of the client bundle.
import type { PublishedViewerPhoto } from '@/lib/catalog/projections/viewer';
import ViewerChrome from './ViewerChrome';
import { ViewerContext, peekKey, type ViewerChromeState, type ViewerPeek } from './viewerContext';
import {
    DESCRIPTION_LABEL,
    FAILED_LABEL,
    HIDE_TECHNICAL,
    RETRY_LABEL,
    SHOW_TECHNICAL,
    TECHNICAL_SOURCE,
    UNAVAILABLE_LABEL,
    accentValue,
    positionText,
    technicalFacts,
} from './viewerLabels';
import { fitSizes, zoomWidth } from './viewerSizes';
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

type ViewerImage = NonNullable<PublishedViewerPhoto['photo']['image']>;

/**
 * The photograph in its fitted box, reserved from the record's shape before
 * the file arrives. If the file fails (ResponsivePhoto retries a failed AVIF
 * file with WebP first, and catches a failure from before hydration), the box
 * keeps its place and shape and says so, with the alt, so the description is
 * still there for everyone, and Retry, which loads the same files again in a
 * new image. Previous, Next, Close, and the reading area stay where they were.
 */
function Photograph({ image, alt, zoomed, largest }: { image: ViewerImage; alt: string; zoomed: boolean; largest: number }) {
    const frame = useRef<HTMLElement>(null);
    const retryButton = useRef<HTMLButtonElement>(null);
    const [failed, setFailed] = useState(false);
    /** Each Retry is a new image: a failed one doesn't fetch again. */
    const [attempt, setAttempt] = useState(0);
    /** Set by Retry, whose button goes with the failure, so focus lands on the photograph's box instead of the page. */
    const [refocus, setRefocus] = useState(false);
    /**
     * The photograph's fitted width, for zoomWidth(), kept current while it isn't zoomed: read at once, then whenever the
     * box resizes. In the modal the first read comes before showModal() gives the box its place, so the observer's
     * later reads are the ones that count.
     */
    const [fitted, setFitted] = useState<number | null>(null);
    useLayoutEffect(() => {
        const element = frame.current;
        if (zoomed || failed || element === null) return;
        const take = (width: number) => {
            if (width > 0) setFitted(width);
        };
        take(element.getBoundingClientRect().width);
        if (typeof ResizeObserver === 'undefined') {
            const onResize = () => take(element.getBoundingClientRect().width);
            window.addEventListener('resize', onResize);
            return () => window.removeEventListener('resize', onResize);
        }
        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) take(entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, [zoomed, failed, attempt]);
    // After Retry, focus goes where the visitor can act: the photograph's box once it shows, or Retry again if it failed again.
    useEffect(() => {
        if (!refocus) return;
        if (failed) retryButton.current?.focus({ preventScroll: true });
        else frame.current?.focus({ preventScroll: true });
    }, [refocus, failed, attempt]);
    const shape = { '--ratio': `${image.width} / ${image.height}` } as CSSProperties;
    if (failed) {
        return (
            <div className={`${styles.missing} ${styles.failed}`} style={shape} data-photo="unavailable" data-viewer-current="">
                <p className={styles.failedLabel}>{FAILED_LABEL}</p>
                {alt !== '' && <p className={styles.failedAlt}>{alt}</p>}
                <button
                    ref={retryButton}
                    type="button"
                    className={styles.control}
                    onClick={() => {
                        setRefocus(true);
                        setAttempt((value) => value + 1);
                        setFailed(false);
                    }}
                >
                    {RETRY_LABEL}
                </button>
            </div>
        );
    }
    const zoomedWidth = zoomed ? zoomWidth(fitted, largest) : null;
    return (
        <figure
            ref={frame}
            className={styles.frame}
            style={zoomedWidth === null ? shape : ({ ...shape, '--zoom-width': `${zoomedWidth}px` } as CSSProperties)}
            tabIndex={refocus ? -1 : undefined}
            data-viewer-current=""
        >
            <ResponsivePhoto
                key={attempt}
                asset={image}
                alt={alt}
                sizes={zoomedWidth === null ? fitSizes(image.width, image.height) : `${zoomedWidth}px`}
                loading="eager"
                fetchPriority="high"
                preload={zoomedWidth === null}
                onError={() => setFailed(true)}
                className={styles.image}
            />
        </figure>
    );
}

/**
 * A neighbor peeking in beside the photograph while it follows the finger
 * (9a), in its own fitted box, at the same sizes the photograph asks for, so
 * the file it loads is the one the photograph shows once the move lands.
 * Decorative: it's the next photograph's picture, not its content, so it's
 * hidden from assistive technology, and its box isn't a figure.
 */
function Peek({ side, peek }: { side: 'previous' | 'next'; peek: ViewerPeek }) {
    const { image } = peek;
    const [failed, setFailed] = useState(false);
    return (
        <div className={styles.peek} data-viewer-peek={side} aria-hidden="true">
            {image === null || failed ? (
                <div className={styles.missing} style={image === null ? undefined : ({ '--ratio': `${image.width} / ${image.height}` } as CSSProperties)}>
                    <span className={styles.missingLabel}>{UNAVAILABLE_LABEL}</span>
                </div>
            ) : (
                <div className={styles.frame} style={{ '--ratio': `${image.width} / ${image.height}` } as CSSProperties}>
                    <ResponsivePhoto
                        asset={image}
                        alt=""
                        sizes={fitSizes(image.width, image.height)}
                        loading="eager"
                        fetchPriority="low"
                        onError={() => setFailed(true)}
                        className={styles.image}
                    />
                </div>
            )}
        </div>
    );
}

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
    // In the shell the panel stays open across moves within a visit (#7, decided). Outside one there's one photograph.
    const [ownTechnical, setOwnTechnical] = useState(false);
    const technicalOpen = shell === null ? ownTechnical : shell.technicalOpen;
    const setTechnicalOpen = shell === null ? setOwnTechnical : shell.setTechnicalOpen;
    const technicalId = useId();
    const readingId = useId();

    const accent = accentValue(photo.accent, series.accent);
    const placeOnly = photo.namedByPlace && photo.title === null;
    const { image } = photo;
    const chrome = useMemo<ViewerChromeState>(
        () => ({
            photoId: photo.id,
            seriesTitle: series.title,
            closeHref,
            previousHref,
            nextHref,
            position,
            total,
            hasImage: image !== null,
            namedByPlace: photo.namedByPlace && photo.title === null,
            accent,
            seriesSlug: series.slug,
            revisionId: viewer.catalogRevision,
            previousPhotoId: viewer.previousPhotoId,
            nextPhotoId: viewer.nextPhotoId,
            image,
        }),
        [photo.id, photo.namedByPlace, photo.title, series.title, series.slug, closeHref, previousHref, nextHref, position, total, image, accent, viewer.catalogRevision, viewer.previousPhotoId, viewer.nextPhotoId],
    );
    const report = shell?.report;
    // Before paint, so the shell's controls replace these in the same frame and show this photograph's state.
    useLayoutEffect(() => {
        report?.(chrome);
    }, [report, chrome]);

    const claimed = shell?.claimed ?? false;
    const zoomed = shell === null ? ownZoom : shell.claimed && shell.zoomed;
    const surface = (accent === null ? undefined : { '--cc-accent': accent }) as CSSProperties | undefined;
    const facts = technicalFacts(photo.technical);
    // The alt is the description (viewer.ts), so while an element carrying it is on the page, the photograph or its
    // failed box, the reading area's copy is for the eye only: a screen reader hears it once (bug 9). With no usable
    // set no element carries it, and the reading area says it. A caption takes the reading area's place for it.
    const altShown = image !== null;
    const showDescription = photo.description !== null && (photo.caption === null || !altShown);
    const largest = image === null ? null : image.variants.w1920.webp.width;
    const zoomedIn = zoomed && largest !== null;
    // The neighbors that peek in while the photograph follows the finger (9a), once the shell has them. Never zoomed.
    const peeks = shell?.peeks;
    const peekOf = (photoId: string | null) => (zoomedIn || photoId === null ? undefined : peeks?.get(peekKey(viewer.catalogRevision, photoId)));
    const previousPeek = peekOf(viewer.previousPhotoId);
    const nextPeek = peekOf(viewer.nextPhotoId);

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
                // Where a swipe can start (#9's useSwipe), and only there: the controls and the reading area sit outside it.
                data-viewer-stage=""
                data-zoomed={zoomedIn ? 'true' : undefined}
                // Zoomed, the photograph can overflow its box, and a scroll region has to be reachable by keyboard.
                tabIndex={zoomedIn ? 0 : undefined}
                role={zoomedIn ? 'region' : undefined}
                aria-label={zoomedIn ? 'Zoomed photograph' : undefined}
            >
                {/* The strip the swipe moves (9a's StageMotion): the photograph, with its neighbors beside it once they peek in. */}
                <div className={styles.track} data-viewer-track="">
                    {previousPeek && <Peek key={viewer.previousPhotoId} side="previous" peek={previousPeek} />}
                    {image === null ? (
                        <div className={styles.missing} data-photo="unavailable" data-viewer-current="">
                            <span className={styles.missingLabel}>{UNAVAILABLE_LABEL}</span>
                        </div>
                    ) : (
                        // Keyed on the file, so the next photograph starts without the last one's failure.
                        <Photograph key={image.variants.w1200.webp.url} image={image} alt={photo.alt} zoomed={zoomedIn} largest={largest ?? image.variants.w1920.webp.width} />
                    )}
                    {nextPeek && <Peek key={viewer.nextPhotoId} side="next" peek={nextPeek} />}
                </div>
            </div>

            {/* An untitled photograph named by its place says it on the image alone: no heading, so no region named the same. */}
            <section className={styles.reading} aria-labelledby={placeOnly ? undefined : readingId} data-viewer-reading="">
                {/* The title line, which the first screen keeps in view on a wide screen, the same height with or without them. */}
                <div className={styles.lead}>
                    {!placeOnly && (
                        <h2 id={readingId} className={photo.title === null ? 'sr-only' : styles.title}>
                            {photo.title ?? positionText(position, total)}
                        </h2>
                    )}
                    {photo.caption !== null && <p className={styles.caption}>{photo.caption}</p>}
                </div>
                {(showDescription || (photo.description === null && pendingCopy !== null)) && (
                    // The label goes with the text: hidden together, or heard together. The pending copy is never an alt.
                    <div className={styles.description} aria-hidden={showDescription && altShown ? true : undefined}>
                        <p className={styles.label}>{DESCRIPTION_LABEL}</p>
                        {showDescription ? (
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
                            onClick={() => setTechnicalOpen(!technicalOpen)}
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
    // Once the shell has them, its root carries the accent for both rules, so a move can change them together at the lift.
    return (
        <div className={styles.content} style={claimed ? undefined : surface} data-viewer-photo={photo.id}>
            {content}
        </div>
    );
}
