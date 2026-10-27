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
    /**
     * 16-3 mockup addition: the toolbar's marker. "Preview · not public" by
     * default; the Publish screen's live states pass "Live, revision N".
     */
    marker?: string;
    /** 16-3 mockup addition: the iframe's title, in the embedding state's terms. */
    title?: string;
    /**
     * 16-3 mockup addition: true when another region already names the frame
     * (the Publish screen's "Visitor preview" panel). The frame then drops
     * its own region label, so a screen reader doesn't hear two regions with
     * one name, and its marker takes the panel's inset, not the site gutter.
     */
    embedded?: boolean;
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
 * Copied from 16-2 (`fd2d6841`) for the 16-3 mockup, with `focusable`,
 * `marker`, `title` and `embedded` added.
 */
export default function PreviewFrame({ src, height, focusable = true, marker = 'Preview · not public', title = 'Visitor preview of the draft catalog', embedded = false }: PreviewFrameProps) {
    const Frame = embedded ? 'div' : 'section';
    return (
        <Frame className={styles.frame} aria-label={embedded ? undefined : 'Visitor preview'} data-embedded={embedded ? 'true' : undefined} style={height ? { height } : undefined}>
            <p className={styles.toolbar}>
                <span className={styles.marker}>{marker}</span>
            </p>
            <iframe className={styles.site} src={src} title={title} referrerPolicy="no-referrer" tabIndex={focusable ? undefined : -1} />
        </Frame>
    );
}
