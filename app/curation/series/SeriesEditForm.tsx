'use client';

import { startTransition, useActionState, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { Save } from 'lucide-react';
import styles from '../curator.module.css';
import { submitGate, useHydrated } from '../inbox/useHydrated';
import { saveSeries } from './actions';
import SeriesAnswer from './SeriesAnswer';
import series from './series.module.css';
import { IDLE_SERIES, NOTHING_PUBLIC, VISIBILITIES, VISIBILITY_HINT, VISIBILITY_LABEL, type SeriesActionState, type SeriesDetail, type SeriesField } from '@/lib/curation/series-view';

/** What the submit button says while an action is out: unavailable, but focusable still (#1's focus contract). */
const offWhile = (pending: boolean) => ({ 'aria-disabled': pending || undefined, 'data-off': pending ? 'true' : undefined });

type Refs = Record<'title' | 'statement' | 'shortStatement', RefObject<HTMLInputElement | HTMLTextAreaElement | null>> & { visibility: RefObject<HTMLFieldSetElement | null> };

/** What takes focus for a refusal about `field`: the field, or for visibility the chosen radio, else the first. */
function focusTarget(refs: Refs, field: SeriesField): HTMLElement | null {
    if (field === 'visibility') {
        const group = refs.visibility.current;
        return group?.querySelector<HTMLInputElement>('input:checked') ?? group?.querySelector<HTMLInputElement>('input') ?? null;
    }
    return field === 'slug' ? null : refs[field].current;
}

/** The answer's words when it's about `name`, shown by that field. */
const errorFor = (state: SeriesActionState, name: SeriesField) => (state.status === 'invalid' && state.field === name ? state.message : null);

/**
 * The four fields, opened on the version the page showed. Keyed by what
 * they show, so the refresh after a save opens them on what was stored, the
 * text as the cleaning left it, while a change to the series' order (2b),
 * which bumps the version but not the text, keeps what was typed here.
 */
function Fields({ detail, activeRevisionId, state, refs }: { detail: SeriesDetail; activeRevisionId: string | null; state: SeriesActionState; refs: Refs }) {
    const [shortStatement, setShortStatement] = useState(detail.shortStatement);
    const titleError = errorFor(state, 'title');
    const statementError = errorFor(state, 'statement');
    const shortError = errorFor(state, 'shortStatement');
    const visibilityError = errorFor(state, 'visibility');
    return (
        <>
            {/* The series, the version and the live revision the page showed, which the save checks under the lock. */}
            <input type="hidden" name="seriesId" value={detail.id} />
            <input type="hidden" name="version" value={detail.version} />
            <input type="hidden" name="base" value={activeRevisionId ?? 'none'} />
            <label className={styles.label}>
                Title
                <input
                    ref={refs.title as RefObject<HTMLInputElement | null>}
                    className={styles.control}
                    name="title"
                    defaultValue={detail.title}
                    autoComplete="off"
                    aria-invalid={titleError ? true : undefined}
                    aria-describedby={titleError ? 'series-title-error' : undefined}
                />
            </label>
            {titleError ? (
                <p className={styles.fieldError} id="series-title-error" data-state="invalid">
                    {titleError}
                </p>
            ) : null}
            {/* Beside its label, not inside it, so the label's text is the field's whole name, never its text too. */}
            <label className={styles.label} htmlFor="series-statement">
                Statement
            </label>
            <textarea
                id="series-statement"
                ref={refs.statement as RefObject<HTMLTextAreaElement | null>}
                rows={8}
                className={`${styles.control} ${series.statement}`}
                name="statement"
                defaultValue={detail.statement}
                aria-invalid={statementError ? true : undefined}
                aria-describedby={statementError ? 'series-statement-error series-statement-hint' : 'series-statement-hint'}
            />
            {statementError ? (
                <p className={styles.fieldError} id="series-statement-error" data-state="invalid">
                    {statementError}
                </p>
            ) : null}
            <p className={`${styles.hint} ${series.clear}`} id="series-statement-hint">
                The series&apos; page opens with it. A blank line starts a new paragraph.
            </p>
            <label className={styles.label} htmlFor="series-short-statement">
                Short statement
            </label>
            {/* One paragraph, as the server stores it: Enter adds no line break, and a pasted run of them becomes one space. */}
            <textarea
                id="series-short-statement"
                ref={refs.shortStatement as RefObject<HTMLTextAreaElement | null>}
                rows={3}
                className={styles.control}
                name="shortStatement"
                value={shortStatement}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault();
                }}
                onChange={(event) => setShortStatement(event.target.value.replace(/[^\S\r\n]*(?:\r\n|[\r\n])+\s*/g, ' '))}
                aria-invalid={shortError ? true : undefined}
                aria-describedby={shortError ? 'series-short-error series-short-hint' : 'series-short-hint'}
            />
            {shortError ? (
                <p className={styles.fieldError} id="series-short-error" data-state="invalid">
                    {shortError}
                </p>
            ) : null}
            <p className={`${styles.hint} ${series.clear}`} id="series-short-hint">
                A sentence or two, with no line break: the series&apos; line on Work, and its description in search results.
            </p>
            <fieldset
                ref={refs.visibility}
                className={`${styles.sequence} ${series.visibility}`}
                role="radiogroup"
                aria-labelledby="series-visibility-legend"
                aria-invalid={visibilityError ? true : undefined}
                aria-describedby={visibilityError ? 'series-visibility-error' : undefined}
            >
                <legend id="series-visibility-legend">Visibility</legend>
                {VISIBILITIES.map((value) => (
                    <div key={value} className={series.choice}>
                        <label className={styles.slot}>
                            <input
                                type="radio"
                                name="visibility"
                                value={value}
                                defaultChecked={detail.visibility === value}
                                // The refusal first, so the radio that takes focus reads it out.
                                aria-describedby={visibilityError ? `series-visibility-error series-visibility-${value}` : `series-visibility-${value}`}
                            />
                            {VISIBILITY_LABEL[value]}
                        </label>
                        <p className={`${styles.hint} ${series.choiceHint}`} id={`series-visibility-${value}`}>
                            {VISIBILITY_HINT[value]}
                        </p>
                    </div>
                ))}
            </fieldset>
            {visibilityError ? (
                <p className={styles.fieldError} id="series-visibility-error" data-state="invalid">
                    {visibilityError}
                </p>
            ) : null}
        </>
    );
}

/**
 * A series' page form (#150's 2a): its title, statements and visibility,
 * saved to the draft through `photos edit`'s path with the version the page
 * showed. A series that moved since answers refresh, and nothing is written.
 */
export default function SeriesEditForm({ detail, activeRevisionId }: { detail: SeriesDetail; activeRevisionId: string | null }) {
    const [state, dispatch, pending] = useActionState(saveSeries, IDLE_SERIES);
    // The form submits by hand, so it waits at the submit gate until it has mounted.
    const ready = useHydrated();
    const refs: Refs = { title: useRef(null), statement: useRef(null), shortStatement: useRef(null), visibility: useRef(null) };
    const answerRef = useRef<HTMLDivElement>(null);
    // Submitting by hand, not through <form action>, so React never resets the form after a refusal, which would lose what was typed.
    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (pending) return;
        const form = new FormData(event.currentTarget);
        startTransition(() => dispatch(form));
    };
    // Each answer is a new state, so this runs once for each: the field it's about takes focus, or the answer does.
    useEffect(() => {
        if (state.status === 'idle') return;
        ((state.field ? focusTarget(refs, state.field) : null) ?? answerRef.current)?.focus();
        // The refs are stable; only a new answer moves focus.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state]);
    return (
        <>
            {detail.carriedOver ? (
                <p className={styles.hint}>
                    This series was carried over from the legacy Gallery at the launch, so it may go without a statement until you write one. Writing either statement ends that, and then a publish needs both.
                </p>
            ) : null}
            <form method="post" onSubmit={submit} aria-label="Edit series" {...submitGate(ready)}>
                <Fields key={JSON.stringify([detail.title, detail.statement, detail.shortStatement, detail.visibility])} detail={detail} activeRevisionId={activeRevisionId} state={state} refs={refs} />
                <p className={styles.hint}>Saving changes the draft only. {NOTHING_PUBLIC}</p>
                <div className={styles.actions}>
                    <button type="submit" className={`${styles.button} ${styles.primary}`} {...offWhile(pending)}>
                        <Save size={16} aria-hidden="true" />
                        Save
                    </button>
                </div>
            </form>
            <SeriesAnswer state={state} regionRef={answerRef} refreshHref={`/curation/series/${detail.id}`} />
        </>
    );
}
