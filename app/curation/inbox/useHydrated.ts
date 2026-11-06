import { useEffect, useState } from 'react';

/**
 * False in the server HTML and while the page hydrates, then true, as SameOriginPostForm's `ready`. The Inbox's forms
 * post by hand and have no plain-post route, so what would send one waits for this: a press before the page hydrates
 * does nothing, never a POST to /curation/inbox that nothing handles.
 */
export function useHydrated(): boolean {
    const [ready, setReady] = useState(false);
    useEffect(() => setReady(true), []);
    return ready;
}

/**
 * A submit button's off state. `disabled` before hydration, when nothing can have focus on it yet. While an action is
 * out, aria-disabled and data-off, never `disabled`: a focused button that turns disabled drops keyboard focus to the
 * page's body (#1's focus contract), so the form's own submit handler is the guard then.
 */
export const submitOff = (ready: boolean, pending: boolean) => ({ disabled: !ready, 'aria-disabled': pending || undefined, 'data-off': pending ? 'true' : undefined });
