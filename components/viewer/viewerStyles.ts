import styles from './StoryViewer.module.css';

/** How long an open waits for the Viewer's styles before it gives up and loads the photo's own page instead. */
export const VIEWER_STYLES_DEADLINE = 8000;

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
 * It checks at once (a direct load links them in its head), then on each stylesheet's load and, in case that event
 * went by unseen, every 50 ms. It rejects after VIEWER_STYLES_DEADLINE, or when `signal` aborts, and either way it
 * clears its timers and its listener first.
 */
export function viewerStylesReady(signal?: AbortSignal): Promise<void> {
    if (typeof document === 'undefined' || viewerStylesApplied()) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new Error("The Viewer's styles stopped loading."));
    return new Promise((resolve, reject) => {
        const finish = (error?: Error) => {
            document.removeEventListener('load', onLoad, true);
            signal?.removeEventListener('abort', onAbort);
            window.clearInterval(poll);
            window.clearTimeout(deadline);
            if (error) reject(error);
            else resolve();
        };
        const check = () => {
            if (viewerStylesApplied()) finish();
        };
        // Load events from images don't bubble but do reach a capturing listener: only a stylesheet's counts.
        const onLoad = (event: Event) => {
            if (event.target instanceof HTMLLinkElement || event.target instanceof HTMLStyleElement) check();
        };
        const onAbort = () => finish(new Error("The Viewer's styles stopped loading."));
        document.addEventListener('load', onLoad, true);
        signal?.addEventListener('abort', onAbort, { once: true });
        const poll = window.setInterval(check, 50);
        const deadline = window.setTimeout(() => finish(new Error(`The Viewer's styles didn't apply in ${VIEWER_STYLES_DEADLINE} ms.`)), VIEWER_STYLES_DEADLINE);
    });
}
