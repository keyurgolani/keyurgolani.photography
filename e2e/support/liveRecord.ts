import type { Page } from '@playwright/test';

// A live region empties itself once its message has been heard (LIVE_HOLD_MS in components/liveMessage.ts), so a
// check that it's empty passes once a stray message has gone. These record every text the region takes, so a check
// can say nothing was announced at all since the gesture began.

/** The Viewer's polite status. */
export const VIEWER_STATUS = '[data-viewer-announcer]';
/** Home's carousel live paragraph. */
export const HOME_LIVE = '[data-home-carousel] > p[aria-live]';

type Recorders = Record<string, { texts: string[]; flush: () => void }>;

/**
 * Runs in the page: watches the whole document, so a region that mounts later or remounts is covered too, and after
 * each change that touches a region matching `selector` keeps the text of every such region that isn't empty.
 */
function install({ key, selector }: { key: string; selector: string }): void {
    const recorders = ((window as unknown as { kgLive?: Recorders }).kgLive ??= {});
    const texts: string[] = [];
    const touches = (record: MutationRecord) => {
        const node = record.target.nodeType === Node.ELEMENT_NODE ? (record.target as Element) : record.target.parentElement;
        if (node?.closest(selector)) return true;
        return [...record.addedNodes].some((added) => added instanceof Element && (added.matches(selector) || added.querySelector(selector) !== null));
    };
    const take = (records: MutationRecord[]) => {
        if (!records.some(touches)) return;
        for (const region of document.querySelectorAll(selector)) {
            const text = region.textContent ?? '';
            if (text !== '') texts.push(text);
        }
    };
    const observer = new MutationObserver(take);
    observer.observe(document, { subtree: true, childList: true, characterData: true });
    recorders[key] = { texts, flush: () => take(observer.takeRecords()) };
}

let count = 0;

function reader(page: Page, key: string): () => Promise<string[]> {
    return () =>
        page.evaluate((key) => {
            const recorder = (window as unknown as { kgLive?: Recorders }).kgLive?.[key];
            if (!recorder) throw new Error(`No live region recorder ${key} on this page`);
            recorder.flush();
            return [...recorder.texts];
        }, key);
}

/** Records every non-empty text the regions at `selector` take from now on. The reader returns them in order. */
export async function recordLive(page: Page, selector: string): Promise<() => Promise<string[]>> {
    const key = `live-${++count}`;
    await page.evaluate(install, { key, selector });
    return reader(page, key);
}

/**
 * Records from the start of every document the page loads from now on, before any script runs, so the server's HTML
 * and hydration are covered too. The reader reads the current document's record.
 */
export async function recordLiveFromLoad(page: Page, selector: string): Promise<() => Promise<string[]>> {
    const key = `live-${++count}`;
    await page.addInitScript(install, { key, selector });
    return reader(page, key);
}
