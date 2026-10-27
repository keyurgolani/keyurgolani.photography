import styles from './PreviewFrame.module.css';

export interface PreviewFrameProps {
    /** The preview's visitor site, `/curation/preview/<draftId>/site` or a page under it. Same-origin. */
    src: string;
    /** The frame's height, any CSS length. Fills the rest of the viewport by default. */
    height?: string;
    /**
     * False makes the iframe inert, for the Publish screen's panel: out of the
     * Tab order and the accessibility tree, a picture of the site, with "Open
     * full preview" as the way in (16-3, decision 4). `tabindex="-1"` alone
     * would leave the site's links focusable inside a frame no key reaches,
     * which axe refuses (frame-focusable-content). Defaults to true, as the
     * full-page preview has it.
     */
    focusable?: boolean;
    /** The toolbar's marker. "Preview · not public" by default; the Publish screen's live states pass "Live, revision N". */
    marker?: string;
    /** The iframe's title, in the embedding state's terms. */
    title?: string;
    /**
     * True when another region already names the frame (the Publish screen's
     * "Visitor preview" panel). The frame then drops its own region label, so
     * a screen reader doesn't hear two regions with one name, and the marker
     * takes the panel's inset, not the site gutter.
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
 */
export default function PreviewFrame({ src, height, focusable = true, marker = 'Preview · not public', title = 'Visitor preview of the draft catalog', embedded = false }: PreviewFrameProps) {
    const Frame = embedded ? 'div' : 'section';
    return (
        <Frame className={styles.frame} aria-label={embedded ? undefined : 'Visitor preview'} data-embedded={embedded ? 'true' : undefined} style={height ? { height } : undefined}>
            <p className={styles.toolbar}>
                <span className={styles.marker}>{marker}</span>
            </p>
            <iframe className={styles.site} src={src} title={title} referrerPolicy="no-referrer" inert={!focusable || undefined} />
        </Frame>
    );
}
