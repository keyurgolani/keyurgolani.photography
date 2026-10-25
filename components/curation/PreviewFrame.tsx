import styles from './PreviewFrame.module.css';

export interface PreviewFrameProps {
    /** The preview's visitor site, `/curation/preview/<draftId>/site` or a page under it. Same-origin. */
    src: string;
    /** The frame's height, any CSS length. Fills the rest of the viewport by default. */
    height?: string;
}

/**
 * #16's curator frame: the "Preview · not public" marker on a toolbar above
 * a same-origin iframe of the draft's visitor site. The marker sits outside
 * the visitor viewport, so the site inside renders as visitors get it, and
 * idle Home stays photo-only (#18). Only the site subtree may be framed
 * (`frame-ancestors 'self'`), so the frame itself can't be. The full-page
 * preview renders it alone, and #16's Publish screen embeds it as its
 * visitor preview panel.
 */
export default function PreviewFrame({ src, height }: PreviewFrameProps) {
    return (
        <section className={styles.frame} aria-label="Visitor preview" style={height ? { height } : undefined}>
            <p className={styles.toolbar}>
                <span className={styles.marker}>Preview · not public</span>
            </p>
            <iframe className={styles.site} src={src} title="Visitor preview of the draft catalog" referrerPolicy="no-referrer" />
        </section>
    );
}
