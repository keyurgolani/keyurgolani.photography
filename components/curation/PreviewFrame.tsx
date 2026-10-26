import styles from './PreviewFrame.module.css';

export interface PreviewFrameProps {
    /** The preview's visitor site, `/curation/preview/<draftId>/site` or a page under it. Same-origin. */
    src: string;
    /** The frame's height, any CSS length. Fills the rest of the viewport by default. */
    height?: string;
    /**
     * 16-3 mockup addition (owner question 4): false takes the iframe out of
     * the Tab order, for the Publish screen's panel, whose "Open full
     * preview" is the keyboard way in. Defaults to true, as 16-2 ships it.
     */
    focusable?: boolean;
}

/**
 * #16's curator frame: the "Preview · not public" marker on a toolbar above
 * a same-origin iframe of the draft's visitor site. The marker sits outside
 * the visitor viewport, so the site inside renders as visitors get it, and
 * idle Home stays photo-only (#18). Only the site subtree may be framed
 * (`frame-ancestors 'self'`), so the frame itself can't be. The full-page
 * preview renders it alone, and #16's Publish screen embeds it as its
 * visitor preview panel.
 *
 * Copied from 16-2 (`fd2d6841`) for the 16-3 mockup, with `focusable` added.
 */
export default function PreviewFrame({ src, height, focusable = true }: PreviewFrameProps) {
    return (
        <section className={styles.frame} aria-label="Visitor preview" style={height ? { height } : undefined}>
            <p className={styles.toolbar}>
                <span className={styles.marker}>Preview · not public</span>
            </p>
            <iframe className={styles.site} src={src} title="Visitor preview of the draft catalog" referrerPolicy="no-referrer" tabIndex={focusable ? undefined : -1} />
        </section>
    );
}
