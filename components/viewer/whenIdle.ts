/** Runs `task` once the browser is idle, or soon where it can't say; returns the cancel. */
export function whenIdle(task: () => void): () => void {
    if (typeof window.requestIdleCallback === 'function') {
        const handle = window.requestIdleCallback(task, { timeout: 2000 });
        return () => window.cancelIdleCallback(handle);
    }
    const handle = window.setTimeout(task, 200);
    return () => window.clearTimeout(handle);
}
