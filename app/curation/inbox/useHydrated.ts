import { useSyncExternalStore } from 'react';

const subscribe = () => () => undefined;

/**
 * False in the server HTML and while React hydrates the component, then true: the store's server snapshot is used for
 * hydration, and React renders again with the client's at once. A component mounted later, on the client, is true from
 * its first render, so a form that mounts again after an answer is never held back.
 */
export function useHydrated(): boolean {
    return useSyncExternalStore(subscribe, () => true, () => false);
}

/**
 * An Inbox form's place at the submit gate (components/site/submitGateScript.ts): `waiting` in the server HTML, where
 * the head's script drops a press, Enter, requestSubmit, a tick or typing on it while scripts run; `ready` once the
 * form has mounted and its handlers are there. Nothing is disabled for it, so without JavaScript the form is the
 * server's markup alone.
 */
export const submitGate = (ready: boolean) => ({ 'data-submit-gate': ready ? 'ready' : 'waiting' });

/**
 * A submit button's off state while an action is out: aria-disabled and data-off, never `disabled`. A focused button
 * that turns disabled drops keyboard focus to the page's body (#1's focus contract), so the form's own submit handler is
 * the guard then.
 */
export const submitOff = (pending: boolean) => ({ 'aria-disabled': pending || undefined, 'data-off': pending ? 'true' : undefined });
