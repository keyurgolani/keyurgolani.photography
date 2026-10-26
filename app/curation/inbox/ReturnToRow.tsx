'use client';

import { useEffect } from 'react';
import { rememberedRow, rememberRow } from './journey';

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
    if (!(target instanceof HTMLElement)) return;
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

/** On the list: remembers the row a click leaves from, and, on the list view, returns to it. */
export default function ReturnToRow({ listView }: { listView: boolean }) {
    useEffect(() => {
        const unmark = listView ? currentOnlyWhenShown() : () => undefined;
        const list = document.getElementById('inbox-list');
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
            list?.removeEventListener('click', leave);
            window.removeEventListener('pageshow', shown);
        };
    }, [listView]);
    return null;
}
