'use client';

import { useEffect, useState } from 'react';
import styles from '../curator.module.css';
import { ArrivalNote } from './ArrivalStrip';
import { takeArrival, type Arrival } from './journey';

/**
 * The answer to the last approval or Decide later when it left nothing else
 * to decide: the page opens on the list (owner, 2026-10-25), and this says
 * what was done there, in a polite live region that's in the page from the
 * start. When nothing needs judgment (`empty`), focus moves to the empty
 * state. If a new item arrived in between, the answer still shows here, at
 * the top of the list, rather than being dropped; focus stays put then.
 */
export default function EmptyArrival({ empty }: { empty: boolean }) {
    const [arrival, setArrival] = useState<Arrival | null>(null);
    useEffect(() => {
        const found = takeArrival(null);
        if (found === null) return;
        setArrival(found);
        if (empty) document.getElementById('inbox-empty')?.focus({ preventScroll: false });
    }, [empty]);
    return (
        <div role="status" aria-live="polite" className={styles.answer}>
            {arrival ? <ArrivalNote arrival={arrival} /> : null}
        </div>
    );
}
