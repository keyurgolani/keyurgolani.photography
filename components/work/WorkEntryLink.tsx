'use client';

import { useRef, type FocusEvent } from 'react';
import IntentPrefetchLink, { type IntentPrefetchLinkProps } from '@/components/IntentPrefetchLink';

export type WorkEntryLinkProps = Omit<IntentPrefetchLinkProps, 'onFocus' | 'onBlur'>;

/** A resolved length in px: `auto` and anything unparsed count as none. */
const px = (value: string) => parseFloat(value) || 0;

/**
 * Brings a Work entry, its list item, cover and copy, into view once keyboard
 * focus has landed on its link, if some of it is off screen. The browser
 * scrolls only the title into view, and Chromium does that after the focus
 * event, centring it on Tab, so Shift+Tab back up the list could leave the
 * cover's top above the screen, and Tab down it could too (B3's body, item
 * 93). So it measures in the next frame, once the browser has scrolled, and
 * does nothing if focus has moved on. The room is the screen less html's
 * scroll paddings (app/globals.css):
 * - an entry that fits the room scrolls into it, nearest, the paddings kept;
 * - one that fits the screen but not the room meets the screen's edge it ran
 *   past;
 * - one taller than the screen stays where the browser put it, with its
 *   focused title in view.
 * The box is the entry grown by however far the link's ::after, its target
 * and focus ring (B3), reaches past it, max(--work-room, 6 px) in most
 * themes, and rounded outward, so the ring's edge stays on screen too. Every
 * scroll is instant, so nothing animates, under reduced motion or not.
 */
function revealEntry(link: HTMLElement): void {
    requestAnimationFrame(() => {
        if (document.activeElement !== link) return;
        const entry = link.closest('li');
        if (entry === null) return;
        const box = entry.getBoundingClientRect();
        const ring = getComputedStyle(link, '::after');
        const top = Math.floor(box.top - Math.max(0, -px(ring.top)));
        const bottom = Math.ceil(box.bottom + Math.max(0, -px(ring.bottom)));
        const screen = window.innerHeight;
        if (top >= 0 && bottom <= screen) return;
        const root = getComputedStyle(document.documentElement);
        const room = screen - px(root.scrollPaddingTop) - px(root.scrollPaddingBottom);
        const height = bottom - top;
        if (height <= room) entry.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        else if (height <= screen) window.scrollBy({ top: top < 0 ? top : bottom - screen, behavior: 'instant' });
    });
}

/**
 * Work's entry link (#171): B3's heading link, prefetching on intent (B10),
 * and revealing its entry on keyboard focus. Focus from a click or a tap,
 * which isn't :focus-visible, doesn't reveal, and neither does the window
 * coming back into focus onto the link it left.
 */
export default function WorkEntryLink(props: WorkEntryLinkProps) {
    /** Whether focus last left this link with the window, so its coming back is the window's, not the visitor's. */
    const leftWithWindow = useRef(false);
    const onBlur = (event: FocusEvent<HTMLAnchorElement>) => {
        leftWithWindow.current = event.relatedTarget === null && !document.hasFocus();
    };
    const onFocus = (event: FocusEvent<HTMLAnchorElement>) => {
        const refocus = (leftWithWindow.current && event.relatedTarget === null) || (event.relatedTarget === null && !document.hasFocus());
        leftWithWindow.current = false;
        if (refocus || !event.currentTarget.matches(':focus-visible')) return;
        revealEntry(event.currentTarget);
    };
    return <IntentPrefetchLink {...props} onFocus={onFocus} onBlur={onBlur} />;
}
