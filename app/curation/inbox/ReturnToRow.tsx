'use client';

import { useEffect } from 'react';
import { listPlace, rememberedRow, rememberListPlace, rememberRow } from './journey';

const ROW_HASH = /^#row-(evt_[0-9a-f]{24})$/;

function cameBack(): boolean {
    try {
        const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        return entry?.type === 'back_forward';
    } catch {
        return false;
    }
}

/**
 * Put the list back where the curator left it, with the row they came from
 * focused: after "Back to inbox" (`#row-<id>`) and after the browser's Back.
 * A phone shows one item at a time, so it leaves the list to open one; this
 * makes coming back land on the same row, not the top. Any other visit to
 * the list is left alone.
 */
function restore(fromCache: boolean) {
    const asked = ROW_HASH.exec(window.location.hash)?.[1] ?? null;
    const row = rememberedRow();
    const id = asked ?? (fromCache || cameBack() ? (row?.id ?? null) : null);
    if (id === null) return;
    const target = document.getElementById(`row-${id}`);
    if (!(target instanceof HTMLElement)) {
        // The URL names a row this page doesn't hold: it moved to another page, or out of the filters, while its item was
        // open (#248). Focus goes to the list's heading, the top of the list the curator asked for: a screen reader names
        // the list and reads on into its summary, and the next Tab goes on through Refresh, the filters and the rows, as on
        // a fresh visit. The first row would claim a row they didn't come from. A browser Back with no row in the URL is
        // left alone: the row it remembers may be from another page of the list, and the browser puts its own place back.
        if (asked !== null) document.getElementById('inbox-heading')?.focus();
        return;
    }
    if (row?.id === id) window.scrollTo(0, row.scrollY);
    // The list can change while the item is open (a decision moves its row to another group), so the row has to end up in view.
    const box = target.getBoundingClientRect();
    if (row?.id !== id || box.bottom <= 0 || box.top >= window.innerHeight) target.scrollIntoView({ block: 'center' });
    target.focus({ preventScroll: true });
}

/** The phone layout's width, where the list view shows the list alone. As the stylesheet's breakpoint. */
const PHONE = '(max-width: 767px)';

/**
 * On a phone's list view no item is open, so the row the server marked
 * selected (the first that needs judgment, which a wide screen shows beside
 * the list) isn't current there (design review, 2026-10-25). Only the focused
 * row reads as where the curator is then. A wide screen keeps the mark.
 */
function currentOnlyWhenShown(): () => void {
    const row = document.querySelector<HTMLElement>('#inbox-list a[data-row][aria-current="true"]');
    if (row === null || typeof window.matchMedia !== 'function') return () => undefined;
    const phone = window.matchMedia(PHONE);
    const sync = () => {
        if (phone.matches) row.removeAttribute('aria-current');
        else row.setAttribute('aria-current', 'true');
    };
    sync();
    phone.addEventListener('change', sync);
    return () => phone.removeEventListener('change', sync);
}

/**
 * A wide screen's list scrolls on its own (#145), and every row's link is a
 * page load, so the list would start at the top each time another item
 * opens. It goes back to where it was instead, and if the item now open
 * isn't in view there, just far enough to show its row.
 */
function keepListPlace(list: HTMLElement): () => void {
    if (typeof window.matchMedia !== 'function' || window.matchMedia(PHONE).matches) return () => undefined;
    const top = listPlace();
    if (top !== null) list.scrollTop = top;
    const current = list.querySelector<HTMLElement>('a[data-row][aria-current="true"]');
    if (current) {
        const row = current.getBoundingClientRect();
        const box = list.getBoundingClientRect();
        if (row.top < box.top || row.bottom > box.bottom) current.scrollIntoView({ block: 'nearest' });
    }
    const save = () => rememberListPlace(list.scrollTop);
    window.addEventListener('pagehide', save);
    return () => {
        save();
        window.removeEventListener('pagehide', save);
    };
}

/** On the list: remembers the row a click leaves from, and, on the list view, returns to it. */
export default function ReturnToRow({ listView }: { listView: boolean }) {
    useEffect(() => {
        const unmark = listView ? currentOnlyWhenShown() : () => undefined;
        const list = document.getElementById('inbox-list');
        const unkeep = list ? keepListPlace(list) : () => undefined;
        const leave = (event: MouseEvent) => {
            const row = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[data-row]') : null;
            if (row?.dataset.row) rememberRow(row.dataset.row, window.scrollY);
        };
        list?.addEventListener('click', leave);
        // A page the browser kept whole (the back-forward cache) runs no effect again, so it returns on pageshow.
        const shown = (event: PageTransitionEvent) => {
            if (event.persisted && listView) restore(true);
        };
        window.addEventListener('pageshow', shown);
        if (listView) restore(false);
        return () => {
            unmark();
            unkeep();
            list?.removeEventListener('click', leave);
            window.removeEventListener('pageshow', shown);
        };
    }, [listView]);
    return null;
}
