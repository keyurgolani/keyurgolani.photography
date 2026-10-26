import type { Metadata } from 'next';
import styles from './site.module.css';

/**
 * A stand-in for the preview's visitor Series page, framed by the mockup's
 * panel. The real panel frames 16-2's `/curation/preview/<draftId>/site/...`.
 * Generated images only. Not for merge.
 */
export const metadata: Metadata = { title: 'Preview · Low Tide Hours', robots: { index: false, follow: false } };

const PHOTOS = ['low-tide-01', 'low-tide-02', 'low-tide-03', 'low-tide-04', 'breakwater-first-light', 'low-tide-05'];

export default function StandInSeries() {
    return (
        <div className={styles.site}>
            <header className={styles.nav}>
                <span className={styles.mark}>KG</span>
                <nav aria-label="Site">
                    <a href="#work">Work</a>
                    <a href="#about">About</a>
                </nav>
            </header>
            <main className={styles.main}>
                <p className={styles.eyebrow}>Series · 6 photographs</p>
                <h1>Low Tide Hours</h1>
                <p className={styles.statement}>Mornings on the estuary, in the hour before the water comes back. The posts, the wall, and what the light does to them.</p>
                <ol className={styles.grid}>
                    {PHOTOS.map((name, index) => (
                        <li key={name}>
                            <img src={`/mockup-publish/${name}.jpg`} alt="" />
                            <span>{String(index + 1).padStart(2, '0')}</span>
                        </li>
                    ))}
                </ol>
            </main>
        </div>
    );
}
