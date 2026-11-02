'use client';

import { startTransition, useActionState, useEffect, useRef, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import styles from '../curator.module.css';
import { createSeries } from './actions';
import SeriesAnswer from './SeriesAnswer';
import series from './series.module.css';
import { IDLE_SERIES, NOTHING_PUBLIC, SLUG_HINT } from '@/lib/curation/series-view';

/** What the submit button says while an action is out: unavailable, but focusable still (#1's focus contract). */
const offWhile = (pending: boolean) => ({ 'aria-disabled': pending || undefined, 'data-off': pending ? 'true' : undefined });

/**
 * New series (#150's 2a): a title, and a web address if the curator wants
 * one other than the title's. The server makes the series a draft from
 * `photos edit`'s newSeries(), so nothing is public until a publish. A made
 * series empties the form and the answer links to its page; a refusal about
 * a field shows by it, keeping what was typed. The form carries the live
 * revision the page showed, so a publish since answers refresh.
 */
export default function NewSeriesForm({ activeRevisionId }: { activeRevisionId: string | null }) {
    const [state, dispatch, pending] = useActionState(createSeries, IDLE_SERIES);
    const formRef = useRef<HTMLFormElement>(null);
    const titleRef = useRef<HTMLInputElement>(null);
    const slugRef = useRef<HTMLInputElement>(null);
    const answerRef = useRef<HTMLDivElement>(null);
    // Submitting by hand, not through <form action>, so React never resets the form after a refusal, which would lose what was typed.
    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        // While an action is out its button says so with aria-disabled, not `disabled`, which would drop focus to the body.
        if (pending) return;
        const form = new FormData(event.currentTarget);
        startTransition(() => dispatch(form));
    };
    // Each answer is a new state, so this runs once for each.
    useEffect(() => {
        if (state.status === 'idle') return;
        if (state.status === 'done') formRef.current?.reset();
        if (state.field === 'title') titleRef.current?.focus();
        else if (state.field === 'slug') slugRef.current?.focus();
        else answerRef.current?.focus();
    }, [state]);
    const error = (name: 'title' | 'slug') => (state.status === 'invalid' && state.field === name ? state.message : null);
    const titleError = error('title');
    const slugError = error('slug');
    return (
        <section className={`${styles.box} ${series.newSeries}`} aria-labelledby="new-series-heading">
            <h2 className={styles.boxTitle} id="new-series-heading">
                New series
            </h2>
            <p className={styles.hint}>It starts as a draft with no photographs. {NOTHING_PUBLIC}</p>
            <form ref={formRef} method="post" onSubmit={submit} aria-labelledby="new-series-heading">
                <input type="hidden" name="base" value={activeRevisionId ?? 'none'} />
                <label className={styles.label}>
                    Title
                    <input
                        ref={titleRef}
                        className={styles.control}
                        name="title"
                        autoComplete="off"
                        aria-invalid={titleError ? true : undefined}
                        aria-describedby={titleError ? 'new-series-title-error' : undefined}
                    />
                </label>
                {titleError ? (
                    <p className={styles.fieldError} id="new-series-title-error" data-state="invalid">
                        {titleError}
                    </p>
                ) : null}
                <label className={styles.label}>
                    Web address (optional)
                    <input
                        ref={slugRef}
                        className={styles.control}
                        name="slug"
                        // A web address is ASCII, so UTF-16 units are its characters; anything else is refused anyway.
                        maxLength={64}
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        aria-invalid={slugError ? true : undefined}
                        aria-describedby={slugError ? 'new-series-slug-error new-series-slug-hint' : 'new-series-slug-hint'}
                    />
                </label>
                {slugError ? (
                    <p className={styles.fieldError} id="new-series-slug-error" data-state="invalid">
                        {slugError}
                    </p>
                ) : null}
                <p className={styles.hint} id="new-series-slug-hint">
                    {SLUG_HINT}
                </p>
                <div className={styles.actions}>
                    <button type="submit" className={`${styles.button} ${styles.primary}`} {...offWhile(pending)}>
                        <Plus size={16} aria-hidden="true" />
                        Make series
                    </button>
                </div>
            </form>
            <SeriesAnswer state={state} regionRef={answerRef} refreshHref="/curation/series" />
        </section>
    );
}
