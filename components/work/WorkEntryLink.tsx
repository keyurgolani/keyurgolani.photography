'use client';

import type { FocusEvent } from 'react';
import IntentPrefetchLink, { type IntentPrefetchLinkProps } from '@/components/IntentPrefetchLink';

export type WorkEntryLinkProps = Omit<IntentPrefetchLinkProps, 'onFocus'>;

/**
 * Brings a Work entry, its list item, cover and copy, into view when keyboard
 * focus lands on its link and some of it is off screen. The browser scrolls
 * only the title link into view, so Shift+Tab back up the list could leave the
 * cover's top above the screen (B3's body, item 93). Nearest, so it moves only
 * as far as it must, and instant, so it never animates, under reduced motion
 * or not. Focus from a click or a tap, which isn't :focus-visible, never
 * scrolls. An entry taller than the screen keeps the nearest edge, which
 * leaves the focused title in view.
 */
function revealEntry(link: HTMLElement): void {
    if (!link.matches(':focus-visible')) return;
    const entry = link.closest('li');
    if (entry === null) return;
    const { top, bottom } = entry.getBoundingClientRect();
    if (top >= 0 && bottom <= window.innerHeight) return;
    entry.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
}

/** Work's entry link (#171): B3's heading link, prefetching on intent (B10), and bringing its entry into view on keyboard focus. */
export default function WorkEntryLink(props: WorkEntryLinkProps) {
    return <IntentPrefetchLink {...props} onFocus={(event: FocusEvent<HTMLAnchorElement>) => revealEntry(event.currentTarget)} />;
}
