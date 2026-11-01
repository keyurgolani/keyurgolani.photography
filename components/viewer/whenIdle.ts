/**
 * Runs `task` once the browser is idle, or soon where it can't say; returns the cancel. With `afterLoad`, for work
 * that mustn't compete with the page's own images, it waits for the window's load first, gives the idle callback 4 s,
 * and where there's none (Safari) waits 1.5 s after the load instead.
 */
export function whenIdle(task: () => void, { afterLoad = false }: { afterLoad?: boolean } = {}): () => void {
    if (!afterLoad) return idle(task, 2000, 200);
    let cancel = () => {};
    const start = () => (cancel = idle(task, 4000, 1500));
    if (document.readyState === 'complete') start();
    else {
        window.addEventListener('load', start, { once: true });
        cancel = () => window.removeEventListener('load', start);
    }
    return () => cancel();
}

function idle(task: () => void, timeout: number, fallback: number): () => void {
    if (typeof window.requestIdleCallback === 'function') {
        const handle = window.requestIdleCallback(task, { timeout });
        return () => window.cancelIdleCallback(handle);
    }
    const handle = window.setTimeout(task, fallback);
    return () => window.clearTimeout(handle);
}
