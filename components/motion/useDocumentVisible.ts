import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
    if (typeof document === 'undefined') return () => {};
    document.addEventListener('visibilitychange', onChange);
    // A page restored from the back-forward cache reports its visibility here.
    window.addEventListener('pageshow', onChange);
    return () => {
        document.removeEventListener('visibilitychange', onChange);
        window.removeEventListener('pageshow', onChange);
    };
}

const getSnapshot = () => document.visibilityState === 'visible';

const getServerSnapshot = () => true;

/** Whether the document is visible, live. A background tab reads false. */
export function useDocumentVisible(): boolean {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
