import type { Metadata } from 'next';
import styles from './site.module.css';

/**
 * A stand-in for the preview's visitor Series page, framed by the mockup's
 * panel. The real panel frames 16-2's `/curation/preview/<draftId>/site/...`.
 * Generated images only. Not for merge.
 */
export const metadata: Metadata = { title: 'Preview · Low Tide Hours', robots: { index: false, follow: false } };

// Each photograph carries the series page's own `id="photo-<photoId>"` anchor, so the Publish panel's frame opens on the changed one.
const PHOTOS = [
    { image: 'low-tide-01', id: 'ph_1c0e4a9b2d7f4e6a8c3b5d1f0e9a2b44' },
    { image: 'low-tide-02', id: 'ph_2d8f1b3c6e0a4d9b7f2c8e5a1b3d6c51' },
    { image: 'low-tide-03', id: 'ph_3e2a7c5d9f1b4e8a6c0d2f7b9e4a1c68' },
    { image: 'low-tide-04', id: 'ph_4f6b0d8e2a3c4f1b9d5e7a0c2f8b3d72' },
    { image: 'breakwater-first-light', id: 'ph_7f3a2b8c4d5e6f7a8b9c0d1e2f3a91c2' },
    { image: 'low-tide-05', id: 'ph_5a9c3e1f7b2d4a6c8e0f4b9d1a7c5e83' },
];

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
                    {PHOTOS.map(({ image, id }, index) => (
                        <li key={id} id={`photo-${id}`}>
                            <img src={`/mockup-publish/${image}.jpg`} alt="" />
                            <span>{String(index + 1).padStart(2, '0')}</span>
                        </li>
                    ))}
                </ol>
            </main>
        </div>
    );
}
