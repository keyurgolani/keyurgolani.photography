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
    openAncestors(target);
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start', behavior: 'instant' });
}

/** A9: open every collapsed group around `element`, so focus lands on something shown. */
export function openAncestors(element: Element): void {
    for (let details = element.closest('details'); details; details = details.parentElement?.closest('details') ?? null) details.open = true;
}
