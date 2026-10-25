// The Viewer's key rule and route test (#9), with no imports, so a unit test reads them alone.

export type ViewerStep = 'previous' | 'next';

/** Form fields and editable text keep their own arrow keys. */
const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function isEditable(target: EventTarget | null): boolean {
    if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
    return target.closest(EDITABLE) !== null || (target instanceof HTMLElement && target.isContentEditable);
}

export type StepKey = Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'target'>;

/**
 * The move an arrow key asks for, or null when it isn't one. Left and Right
 * move inside the series. A modifier means the key belongs to someone else
 * (Alt+Left is the browser's Back), an editable field keeps its caret keys,
 * and while the photograph is zoomed the arrows belong to its scroll region.
 */
export function stepForKey(event: StepKey, zoomed: boolean): ViewerStep | null {
    const step = event.key === 'ArrowLeft' ? 'previous' : event.key === 'ArrowRight' ? 'next' : null;
    if (step === null) return null;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
    if (zoomed || isEditable(event.target)) return null;
    return step;
}

/** A Viewer URL, `/work/<slug>/photo/<photoId>`, so the host knows which links open it and when one is on screen. */
export function isViewerPath(pathname: string | null): boolean {
    return pathname !== null && /^\/work\/[^/]+\/photo\/[^/]+\/?$/.test(pathname);
}
