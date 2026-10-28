'use client';

import { useEffect, useRef } from 'react';
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
    /**
     * An element of the framed page to bring to the top of the frame once it
     * loads, such as a series page's `photo-<photoId>` entry. Only the
     * frame's own window scrolls, never the page around it, which a
     * `#fragment` in `src` would do (16-3, round 2 of the mockup).
     */
    scrollToId?: string;
}

/** How long a framed page may take to render the element it should show, such as a series page fetching its next entries. */
const SCROLL_WAIT_MS = 5000;

/** Scrolls the frame's own window to `id`, now or once the framed page renders it. Returns a cleanup. */
function scrollFrameTo(frame: HTMLIFrameElement, id: string): () => void {
    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    if (!win || !doc?.body) return () => undefined;
    const place = () => {
        const element = doc.getElementById(id);
        if (!element) return false;
        win.scrollTo({ top: element.getBoundingClientRect().top + win.scrollY - 16, behavior: 'instant' });
        return true;
    };
    if (place()) return () => undefined;
    // The framed page's own MutationObserver, so it watches that document from its own realm.
    const Observer = (win as Window & typeof globalThis).MutationObserver;
    const observer = new Observer(() => {
        if (place()) observer.disconnect();
    });
    observer.observe(doc.body, { childList: true, subtree: true });
    const timer = win.setTimeout(() => observer.disconnect(), SCROLL_WAIT_MS);
    return () => {
        observer.disconnect();
        win.clearTimeout(timer);
    };
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
export default function PreviewFrame({ src, height, focusable = true, marker = 'Preview · not public', title = 'Visitor preview of the draft catalog', embedded = false, scrollToId }: PreviewFrameProps) {
    const Frame = embedded ? 'div' : 'section';
    const ref = useRef<HTMLIFrameElement>(null);
    useEffect(() => {
        const frame = ref.current;
        if (!frame || !scrollToId) return;
        let cleanup = () => {};
        const onLoad = () => {
            cleanup();
            cleanup = scrollFrameTo(frame, scrollToId);
        };
        // The frame can finish loading before this runs, so a loaded frame is placed now.
        if (frame.contentDocument?.readyState === 'complete' && frame.contentWindow?.location.href !== 'about:blank') onLoad();
        frame.addEventListener('load', onLoad);
        return () => {
            frame.removeEventListener('load', onLoad);
            cleanup();
        };
    }, [src, scrollToId]);
    const iframe = <iframe ref={ref} className={styles.site} src={src} title={title} referrerPolicy="no-referrer" inert={!focusable || undefined} />;
    return (
        <Frame className={styles.frame} aria-label={embedded ? undefined : 'Visitor preview'} data-embedded={embedded ? 'true' : undefined} style={height ? { height } : undefined}>
            <p className={styles.toolbar}>
                <span className={styles.marker}>{marker}</span>
            </p>
            {/* inert takes the iframe and its title out of the accessibility tree, so the picture is named here instead. */}
            {focusable ? (
                iframe
            ) : (
                <div className={styles.picture} role="img" aria-label={title}>
                    {iframe}
                </div>
            )}
        </Frame>
    );
}
