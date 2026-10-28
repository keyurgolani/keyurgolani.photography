/**
 * A configurable document.visibilityState, which jsdom fixes at 'visible'.
 * vitest.setup.ts installs it before each test with the page visible.
 */

let state: DocumentVisibilityState = 'visible';

export function installDocumentVisibility(): void {
    state = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => state !== 'visible' });
}

/** Sets the visibility and dispatches visibilitychange, like switching tabs. */
export function setDocumentVisibility(next: DocumentVisibilityState): void {
    if (state === next) return;
    state = next;
    document.dispatchEvent(new Event('visibilitychange'));
}
