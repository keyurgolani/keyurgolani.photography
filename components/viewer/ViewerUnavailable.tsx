'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useContext, useLayoutEffect } from 'react';
import { useSiteRoutes } from '@/components/site/siteRoutesContext';
import { ViewerContext } from './viewerContext';
import { UNAVAILABLE_BACK, UNAVAILABLE_HEADING, UNAVAILABLE_TEXT } from './viewerLabels';
import styles from './StoryViewer.module.css';

/**
 * A photograph unpublished, or moved to another series, while the Viewer was
 * open (#178): the intercepted route's not-found, so it renders inside the
 * shell that outlives every move, never the site's not-found page outside
 * it. That covers a move onto a neighbour a publish dropped, and the revision
 * check's refresh of a photograph it dropped (ViewerShell's `revised`).
 *
 * It tells the shell it's showing, so the shell drops the controls for a
 * photograph that isn't there, opens the modal if nothing had yet, moves
 * focus to this heading and announces it. The heading names the dialog. The
 * way back to the series is the modal's one Back to the series page under
 * it, or, on a page, a link to the series.
 */
export default function ViewerUnavailable() {
    const shell = useContext(ViewerContext);
    const { seriesHref } = useSiteRoutes();
    const { slug } = useParams<{ slug: string }>();
    const reportUnavailable = shell?.reportUnavailable;
    useLayoutEffect(() => {
        if (reportUnavailable === undefined) return;
        reportUnavailable(true);
        return () => reportUnavailable(false);
    }, [reportUnavailable]);
    return (
        <div className={styles.unavailable} data-viewer-unavailable="">
            <h1 id={shell?.headingId} className={styles.unavailableHeading} tabIndex={-1} data-viewer-unavailable-heading="">
                {UNAVAILABLE_HEADING}
            </h1>
            <p className={styles.unavailableText}>{UNAVAILABLE_TEXT}</p>
            {shell?.mode === 'modal' ? (
                <button type="button" className={styles.control} onClick={shell.close}>
                    {UNAVAILABLE_BACK}
                </button>
            ) : (
                <Link href={seriesHref(slug)} prefetch={false} className={styles.control}>
                    {UNAVAILABLE_BACK}
                </Link>
            )}
        </div>
    );
}
