import styles from './StoryViewer.module.css';

/** True once a stylesheet holding the Viewer's root rule (`.viewer`, from StoryViewer.module.css) applies. */
function viewerStylesApplied(): boolean {
    const root = `.${CSS.escape(styles.viewer)}`;
    for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try {
            rules = sheet.cssRules;
        } catch {
            continue;
        }
        for (const rule of Array.from(rules)) if (rule instanceof CSSStyleRule && rule.selectorText.split(',').some((selector) => selector.trim() === root)) return true;
    }
    return false;
}

/**
 * Settles once the Viewer's styles apply, so viewerShellLoader never hands React a shell that would paint without them.
 * It checks at once (a direct load links them in its head), then on every stylesheet's load and, as a fallback for a
 * load event already gone by, every 50 ms. Neither path gives up: the shell waits for its sheet however long it takes.
 */
export function viewerStylesReady(): Promise<void> {
    if (typeof document === 'undefined' || viewerStylesApplied()) return Promise.resolve();
    return new Promise((resolve) => {
        const check = () => {
            if (!viewerStylesApplied()) return;
            document.removeEventListener('load', check, true);
            window.clearInterval(timer);
            resolve();
        };
        document.addEventListener('load', check, true);
        const timer = window.setInterval(check, 50);
    });
}
