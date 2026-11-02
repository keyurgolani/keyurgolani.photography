'use client';

import Link from 'next/link';
import type { RefObject } from 'react';
import styles from '../curator.module.css';
import type { OrderActionState, SeriesActionState } from '@/lib/curation/series-view';

const TONE: Record<Exclude<SeriesActionState | OrderActionState, { status: 'idle' }>['status'], 'done' | 'change' | 'alert'> = {
    done: 'done',
    stale: 'change',
    busy: 'change',
    refused: 'alert',
    invalid: 'alert',
    failed: 'alert',
};

/**
 * A polite live region, there from the start, so an answer put in it is read
 * out, as the Inbox's AnswerRegion is. New series and Save use it, and so
 * does each of 2b's ordering sections. It takes focus after every answer
 * that isn't about one field, so focus never drops to the page's body and
 * the way on (Open, Refresh) is next. An answer about a field shows by that
 * field instead, and the field takes focus.
 */
export default function SeriesAnswer({ state, regionRef, refreshHref }: { state: SeriesActionState | OrderActionState; regionRef: RefObject<HTMLDivElement | null>; refreshHref: string }) {
    const show = state.status !== 'idle' && state.field === undefined;
    const href = state.status !== 'idle' && 'href' in state ? state.href : undefined;
    return (
        <div role="status" aria-live="polite" ref={regionRef} tabIndex={-1}>
            {show ? (
                <div className={styles.notice} data-tone={TONE[state.status]} data-state={state.status}>
                    <p>{state.message}</p>
                    {state.status === 'done' && href && 'title' in state ? (
                        <Link className={styles.linkButton} href={href}>
                            Open {state.title}
                        </Link>
                    ) : null}
                    {/* A plain link, so the page is read again in full, as the Inbox's Refresh and review again is. */}
                    {state.status === 'stale' ? (
                        <a className={styles.linkButton} href={refreshHref}>
                            Refresh
                        </a>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
