import type { Metadata } from 'next';
import styles from '../site.module.css';

/**
 * A stand-in for the preview's visitor Viewer of one photograph, framed by
 * the mockup's panel. Round 2 showed that a `#photo-<id>` fragment on the
 * series page scrolls the Publish page itself in Chromium, so the panel
 * takes the spec's fallback and opens the changed photograph's Viewer
 * (`<basePath>/work/<slug>/photo/<photoId>`). Generated image only. Not for merge.
 */
export const metadata: Metadata = { title: 'Preview · Breakwater, first light', robots: { index: false, follow: false } };

export default function StandInViewer() {
    return (
        <div className={styles.site}>
            <header className={styles.nav}>
                <span className={styles.mark}>KG</span>
                <nav aria-label="Site">
                    <a href="#work">Work</a>
                    <a href="#about">About</a>
                </nav>
            </header>
            <main className={styles.viewer}>
                <img src="/mockup-publish/breakwater-first-light.jpg" alt="" />
                <p className={styles.viewerTitle}>Breakwater, first light</p>
                <p className={styles.viewerMeta}>Low Tide Hours · 05 of 6</p>
            </main>
        </div>
    );
}
