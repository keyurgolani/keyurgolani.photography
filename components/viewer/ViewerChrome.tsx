'use client';

import { ArrowLeft, ArrowRight, X, ZoomIn } from 'lucide-react';
import Link from 'next/link';
import type { ViewerChromeState, ViewerMode } from './viewerContext';
import type { ViewerStep } from './viewerKeys';
import { CLOSE_LABEL, NEXT_LABEL, PREVIOUS_LABEL, ZOOM_LABEL, positionLabel, positionText } from './viewerLabels';
import styles from './StoryViewer.module.css';

/** What the shell does with the controls. Null is the server's form, before the shell takes them over. */
export interface ViewerChromeActions {
    step(step: ViewerStep): void;
    close(): void;
}

export interface ViewerChromeProps {
    state: ViewerChromeState;
    mode: ViewerMode;
    headingId?: string;
    zoomed: boolean;
    onZoom?: () => void;
    actions: ViewerChromeActions | null;
}

const STEPS = {
    previous: { label: PREVIOUS_LABEL, className: styles.previous, icon: <ArrowLeft aria-hidden="true" size={20} /> },
    next: { label: NEXT_LABEL, className: styles.next, icon: <ArrowRight aria-hidden="true" size={20} /> },
} as const;

/**
 * Previous or Next. In the shell it's a button that survives every move, so
 * focus stays on it. At an end it stays a focusable button with
 * `aria-disabled`, never `disabled`, which would drop focus to the document,
 * and pressing it only announces the end. In the server's form, before the
 * shell takes over, a direction that has a photograph is a link that replaces
 * the history entry, so the page moves even before it hydrates.
 */
function Step({ step, href, actions }: { step: ViewerStep; href: string | null; actions: ViewerChromeActions | null }) {
    const { label, className, icon } = STEPS[step];
    const classes = `${styles.step} ${className}`;
    if (actions === null && href !== null) {
        return (
            <Link href={href} replace prefetch={false} className={classes} aria-label={label} data-viewer-step={step}>
                {icon}
            </Link>
        );
    }
    return (
        <button
            type="button"
            className={classes}
            aria-label={label}
            aria-disabled={href === null ? 'true' : undefined}
            data-viewer-step={step}
            onClick={actions === null ? undefined : () => actions.step(step)}
        >
            {icon}
        </button>
    );
}

/**
 * The Viewer's controls (#7, kept apart by #9): the header with Close, the
 * series title and position, and Zoom, then Previous and Next. The shell
 * renders them once and keeps them across moves. Close links back to the
 * series on a page, and in the modal it's a button the shell closes with.
 */
export default function ViewerChrome({ state, mode, headingId, zoomed, onZoom, actions }: ViewerChromeProps) {
    const { seriesTitle, closeHref, previousHref, nextHref, position, total, hasImage } = state;
    return (
        <>
            <header className={styles.header}>
                {mode === 'modal' && actions !== null ? (
                    <button type="button" className={styles.control} onClick={actions.close}>
                        <X aria-hidden="true" size={18} />
                        {CLOSE_LABEL}
                    </button>
                ) : (
                    <Link href={closeHref} prefetch={false} className={styles.control}>
                        <X aria-hidden="true" size={18} />
                        {CLOSE_LABEL}
                    </Link>
                )}
                <div className={styles.heading} id={headingId}>
                    <h1 className={styles.series}>{seriesTitle}</h1>
                    <p className={styles.position}>
                        <span aria-hidden="true">{positionLabel(position, total)}</span>
                        <span className="sr-only">{positionText(position, total)}</span>
                    </p>
                </div>
                {/* With no usable set there's nothing to enlarge. aria-disabled keeps focus on Zoom when a move lands on such a photo. */}
                <button
                    type="button"
                    className={`${styles.control} ${styles.zoom}`}
                    aria-pressed={zoomed && hasImage}
                    aria-disabled={hasImage ? undefined : 'true'}
                    onClick={hasImage ? onZoom : undefined}
                >
                    <ZoomIn aria-hidden="true" size={18} />
                    {ZOOM_LABEL}
                </button>
            </header>
            <Step step="previous" href={previousHref} actions={actions} />
            <Step step="next" href={nextHref} actions={actions} />
        </>
    );
}
