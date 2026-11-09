// The Viewer's key rule and route test (#9), with no imports, so a unit test reads them alone.

export type ViewerStep = 'previous' | 'next';

/** Form fields and editable text keep their own arrow keys. */
const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function isEditable(target: EventTarget | null): boolean {
    if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
    return target.closest(EDITABLE) !== null || (target instanceof HTMLElement && target.isContentEditable);
}

export type StepKey = Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'target'> &
    Partial<Pick<KeyboardEvent, 'repeat' | 'isComposing' | 'defaultPrevented'>>;

/** A key the Viewer leaves alone whatever it is: a held key's auto-repeat, one an input method is composing, or one someone else already took (#178). */
export function keyTaken(event: Partial<Pick<KeyboardEvent, 'repeat' | 'isComposing' | 'defaultPrevented'>>): boolean {
    return event.repeat === true || event.isComposing === true || event.defaultPrevented === true;
}

/**
 * The move an arrow key asks for, or null when it isn't one. Left and Right
 * move inside the series. A modifier means the key belongs to someone else
 * (Alt+Left is the browser's Back), an editable field keeps its caret keys,
 * and while the photograph is zoomed the arrows belong to its scroll region.
 * Holding an arrow down moves once: its auto-repeats are ignored, as are a key
 * an input method is composing and one a handler before this one took (#178).
 */
export function stepForKey(event: StepKey, zoomed: boolean): ViewerStep | null {
    const step = event.key === 'ArrowLeft' ? 'previous' : event.key === 'ArrowRight' ? 'next' : null;
    if (step === null || keyTaken(event)) return null;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
    if (zoomed || isEditable(event.target)) return null;
    return step;
}

/** A Viewer URL, `/work/<slug>/photo/<photoId>`, so the host knows which links open it and when one is on screen. */
export function isViewerPath(pathname: string | null): boolean {
    return pathname !== null && /^\/work\/[^/]+\/photo\/[^/]+\/?$/.test(pathname);
}
