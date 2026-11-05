import type { MouseEvent } from 'react';

/**
 * The Publish screen's in-page jump (16-3): instant, and focus moves with it,
 * so the next Tab starts from the target. The ledger's blocker links, the
 * panel's link to History, and History's link to a conflicted row share it.
 * A target inside a collapsed group (A9) opens the group first.
 */
export function jumpTo(event: MouseEvent<HTMLAnchorElement>, id: string): void {
    const target = document.getElementById(id);
    if (!target) return;
    event.preventDefault();
    // A9: a row in a collapsed group opens it first, so focus lands on something shown.
    for (let details = target.closest('details'); details; details = details.parentElement?.closest('details') ?? null) details.open = true;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start', behavior: 'instant' });
}
