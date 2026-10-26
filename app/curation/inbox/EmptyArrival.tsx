'use client';

import { useEffect, useState } from 'react';
import styles from '../curator.module.css';
import { itemUrl, takeArrival, type Arrival } from './journey';

/**
 * The answer to the last approval or Decide later, when it left nothing
 * else to decide: the page opens on the empty state (owner, 2026-10-25),
 * and this says what was done there, in a polite live region that's in the
 * page from the start, and moves focus to the empty state. `active` is
 * whether nothing needs judgment now; a new item may have arrived since.
 */
export default function EmptyArrival({ active }: { active: boolean }) {
    const [arrival, setArrival] = useState<Arrival | null>(null);
    useEffect(() => {
        if (!active) return;
        const found = takeArrival(null);
        if (found === null) return;
        setArrival(found);
        document.getElementById('inbox-empty')?.focus({ preventScroll: false });
    }, [active]);
    if (!active) return null;
    return (
        <div role="status" aria-live="polite" className={styles.answer}>
            {arrival ? (
                <div className={`${styles.notice} ${styles.arrival}`} data-tone="done" data-state="done">
                    <p>
                        {arrival.message} Nothing else requires judgment.
                    </p>
                    <a className={styles.linkButton} href={itemUrl(arrival.from)}>
                        Open {arrival.fromName} again
                    </a>
                </div>
            ) : null}
        </div>
    );
}
