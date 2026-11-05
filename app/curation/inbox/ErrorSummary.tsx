'use client';

import { useEffect, useRef, type MouseEvent } from 'react';
import { CircleAlert } from 'lucide-react';
import styles from '../curator.module.css';

export interface SummaryEntry {
    /** The link's words: the record or the field it goes to. */
    text: string;
    href: string;
    /** An element on this page to focus when the link is followed, as a field or a heading. */
    target?: string;
    /** What went wrong there, after the link, when nothing beside the field says it already. */
    note?: string;
}

/**
 * #14 (A8): the Inbox's error summary. One per failed submit: a named region whose heading says what failed, and a
 * link to each record and field it's about. A link to something on this page moves focus there, as a fragment link
 * alone doesn't for a form field. `focusKey`, when set, takes focus to the summary each time it changes, so a
 * screen reader reads it once from there; a summary that doesn't take focus sits in the polite region it's placed in.
 */
export default function ErrorSummary({ id, title, entries, focusKey, state }: { id: string; title: string; entries: SummaryEntry[]; focusKey?: number; state?: string }) {
    const ref = useRef<HTMLElement>(null);
    useEffect(() => {
        if (focusKey !== undefined) ref.current?.focus();
    }, [focusKey]);
    const follow = (target: string | undefined) => (event: MouseEvent<HTMLAnchorElement>) => {
        const element = target ? document.getElementById(target) : null;
        if (element === null) return;
        event.preventDefault();
        element.focus();
        element.scrollIntoView?.({ block: 'center' });
    };
    return (
        <section ref={ref} className={`${styles.notice} ${styles.errorSummary}`} data-tone="alert" data-state={state} aria-labelledby={`${id}-title`} tabIndex={focusKey === undefined ? undefined : -1}>
            <h3 className={styles.errorTitle} id={`${id}-title`}>
                <CircleAlert size={17} aria-hidden="true" />
                <span>{title}</span>
            </h3>
            {entries.length > 0 ? (
                <ul className={styles.errorList}>
                    {entries.map((entry) => (
                        <li key={`${entry.href} ${entry.text}`}>
                            <a href={entry.href} onClick={follow(entry.target)}>
                                {entry.text}
                            </a>
                            {entry.note ? <span>: {entry.note}</span> : null}
                        </li>
                    ))}
                </ul>
            ) : null}
        </section>
    );
}
