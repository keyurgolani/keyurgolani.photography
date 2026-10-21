import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void) {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** Whether the browser says it's online. The server and the first client render say yes. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
}

export const ERROR_HEADING = 'Something went wrong';

/** The error pages' one sentence, offline or not. */
export function errorCopy(online: boolean): string {
  return online ? "This page didn't load. Try again in a moment." : "You're offline. Reconnect, then try again.";
}
