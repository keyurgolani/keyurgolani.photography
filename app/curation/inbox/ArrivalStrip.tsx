'use client';

import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import styles from '../curator.module.css';
import { itemUrl, takeArrival, type Arrival } from './journey';

/**
 * What the last approval or Decide later did, at the top of the item it
 * opened, above the photograph and the form (design review, 2026-10-25), so
 * it's on the first screen at every size. It names the file it decided, since
 * the heading under it names this one, and links back to it, where Reopen is.
 *
 * It's the arrival's only copy and its polite live region, in the page from
 * the start, so the answer is read once. It stays until the next action on
 * this item, whose own answer shows by the buttons, or the next page load.
 */
export default function ArrivalStrip({ itemId }: { itemId: string }) {
    const [arrival, setArrival] = useState<Arrival | null>(null);
    useEffect(() => {
        // Reading it clears it, so Strict Mode's second run finds nothing; only a found one is set.
        const found = takeArrival(itemId);
        if (found) setArrival(found);
    }, [itemId]);
    useEffect(() => {
        if (arrival === null) return;
        const item = document.getElementById('item');
        // LandOnItem put the item at the top before the strip was in it, and the browser's scroll anchoring then kept the
        // photograph where it was, pushing the strip above the screen. Landing again puts the strip back on the first screen.
        if (window.location.hash === '#item') item?.scrollIntoView({ block: 'start' });
        const clear = () => setArrival(null);
        item?.addEventListener('submit', clear);
        return () => item?.removeEventListener('submit', clear);
    }, [arrival]);
    return (
        <div role="status" aria-live="polite" className={styles.arrivalStrip}>
            {arrival ? <ArrivalNote arrival={arrival} /> : null}
        </div>
    );
}

/** The answer and the way back to the item it decided, in the done tone. The list's empty state shows the same. */
export function ArrivalNote({ arrival }: { arrival: Arrival }) {
    return (
        <div className={`${styles.notice} ${styles.arrival}`} data-tone="done" data-state="done">
            <Check size={17} aria-hidden="true" />
            <p>{arrival.message}</p>
            <a className={styles.linkButton} href={itemUrl(arrival.from)}>
                Open {arrival.fromName} again
            </a>
        </div>
    );
}
