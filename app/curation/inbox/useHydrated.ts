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
 * A curator form's place at the submit gate (components/site/submitGateScript.ts): `waiting` in the server HTML, where
 * the head's script drops a press, Enter, requestSubmit, a tick or typing on it while scripts run; `ready` once the
 * form has mounted and its handlers are there. The Inbox's, Publish's, History's and the Series screens' forms take it
 * from the component that holds their handler. Nothing is disabled for it, so without JavaScript the form is the
 * server's markup alone.
 */
export const submitGate = (ready: boolean) => ({ 'data-submit-gate': ready ? 'ready' : 'waiting' });

/**
 * A submit button's off state while an action is out: aria-disabled and data-off, never `disabled`. A focused button
 * that turns disabled drops keyboard focus to the page's body (#1's focus contract), so the form's own submit handler is
 * the guard then.
 */
export const submitOff = (pending: boolean) => ({ 'aria-disabled': pending || undefined, 'data-off': pending ? 'true' : undefined });

/** A checkbox, a radio or a select: a control whose own keys choose, where Enter has no job. */
const isChoice = (target: EventTarget | null) => target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio'));

/**
 * Enter on a checkbox, a radio or a select sends its form in Chromium, by the form's first enabled submit button: on a
 * ticked row box that's Decide later on selected, on Decorative it's Save edits, on a file to bind it's Bind. None of
 * them is what the key meant, so each of those controls in an Inbox form takes this as its `onKeyDown`, which stops
 * Enter's default there and nowhere else. Space still ticks, the arrow keys still choose, and Tab still moves on.
 * Buttons and text fields don't take it, so Enter on a button still presses it and Enter in a text field still sends
 * its form. It disables nothing and leaves the submit gate as it is, and without JavaScript the browser's defaults stand.
 */
export function keepEnterOffChoices(event: { key: string; target: EventTarget | null; preventDefault(): void }): void {
    if (event.key === 'Enter' && isChoice(event.target)) event.preventDefault();
}
