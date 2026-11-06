'use client';

import { startTransition, useActionState, type FormEvent } from 'react';
import styles from '../curator.module.css';
import { bulkItems } from './actions';
import ErrorSummary, { type SummaryEntry } from './ErrorSummary';
import { BULK_FORM_ID, BULK_IDLE, DEFER_LABEL } from '@/lib/curation/inbox-view';

export interface BulkRow {
    /** The row's name of its own (rowLabels()), which its checkbox says after "Select". */
    label: string;
    /** The row's link, which the error summary repeats for an item it left alone. */
    href: string;
}

interface BulkActionsProps {
    /** The active revision the page showed, which every item is checked against. */
    base: string | null;
    rows: Record<string, BulkRow>;
    canDefer: boolean;
    canUnassign: boolean;
    /** The first checkbox's ID, which a refusal about the selection links to. */
    firstPick: string | null;
}

const UNASSIGNED_HINT = 'Leave selected unassigned approves each selected new photograph into the draft with no series, keeping any description saved on it. Nothing is published until you publish.';

/**
 * #14 (A8): the list's bulk Decide later (the mockup's "Leave in draft") and Leave unassigned, above the rows it acts
 * on. The rows stay in the list's own lists, as before A8, and each one a bulk action can take has a checkbox that
 * belongs to this form by its `form` attribute (BULK_FORM_ID). Its value is the row's item and the version the page
 * showed, so the server checks every item against what the curator saw, as one action does. What went through is said once in the polite region. What was
 * left alone, or a selection the server refused, is an error summary that takes focus and links each record, or the
 * checkboxes. The answers stay until the next press.
 */
export default function BulkActions({ base, rows, canDefer, canUnassign, firstPick }: BulkActionsProps) {
    const [state, dispatch, pending] = useActionState(bulkItems, BULK_IDLE);
    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        // As ItemActions: aria-disabled, never `disabled`, so a focused button keeps focus while the action is out.
        if (pending) return;
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        // A8 review N5: only a bulk button sends this form. Enter in a checkbox submits it with no submitter, or the first
        // button, which it never meant to press, so a submit no bulk button made sends nothing. The form's data takes
        // the checked boxes the form owns by their `form` attribute, outside it in the rows.
        if (!(submitter instanceof HTMLButtonElement) || submitter.name !== 'intent' || (submitter.value !== 'defer' && submitter.value !== 'unassigned')) return;
        const form = new FormData(event.currentTarget);
        form.set(submitter.name, submitter.value);
        startTransition(() => dispatch(form));
    };
    const off = { 'aria-disabled': pending || undefined, 'data-off': pending ? 'true' : undefined };
    const answered = state.status === 'idle' ? null : state;
    const left = answered?.results.filter((result) => result.status !== 'done') ?? [];
    const leftTitle = left.length === 1 ? '1 item was left as it is' : `${left.length} items were left as they are`;
    const entries: SummaryEntry[] = left.map((result) => ({ text: rows[result.eventId]?.label ?? 'An item no longer on this page', href: rows[result.eventId]?.href ?? `/curation/inbox?item=${result.eventId}#item`, note: result.message }));
    // A8 review S1: items that went through with an answer of their own, said with the headline, once.
    const noted = answered?.results.filter((result) => result.status === 'done' && result.note) ?? [];
    return (
        <form method="post" onSubmit={submit} aria-label="Bulk actions" id={BULK_FORM_ID} className={styles.bulk}>
            <input type="hidden" name="base" value={base ?? 'none'} />
            <div className={styles.bulkBar}>
                {canDefer ? (
                    <button type="submit" name="intent" value="defer" className={styles.button} {...off}>
                        {DEFER_LABEL} on selected
                    </button>
                ) : null}
                {canUnassign ? (
                    <button type="submit" name="intent" value="unassigned" className={styles.button} aria-describedby="bulk-unassigned-hint" {...off}>
                        Leave selected unassigned
                    </button>
                ) : null}
            </div>
            {canUnassign ? (
                <p className={styles.hint} id="bulk-unassigned-hint">
                    {UNASSIGNED_HINT}
                </p>
            ) : null}
            {/* What went through, said once. A refusal of the whole selection is the summary's alone. */}
            <div role="status" aria-label="Bulk answer" className={styles.bulkAnswer}>
                {answered && answered.status !== 'invalid' ? (
                    <div key={answered.serial}>
                        <p>{answered.message}</p>
                        {noted.length > 0 ? (
                            <ul className={styles.errorList}>
                                {noted.map((result) => (
                                    <li key={result.eventId}>
                                        <a href={rows[result.eventId]?.href ?? `/curation/inbox?item=${result.eventId}#item`}>{rows[result.eventId]?.label ?? 'An item no longer on this page'}</a>
                                        <span>: {result.message}</span>
                                    </li>
                                ))}
                            </ul>
                        ) : null}
                    </div>
                ) : null}
            </div>
            {answered?.status === 'invalid' ? (
                <ErrorSummary id="bulk-summary" title={answered.message} focusKey={answered.serial} state="invalid" entries={firstPick ? [{ text: 'The items to select', href: `#${firstPick}`, target: firstPick }] : []} />
            ) : answered && left.length > 0 ? (
                <ErrorSummary id="bulk-summary" title={leftTitle} focusKey={answered.serial} state={answered.status} entries={entries} />
            ) : null}
        </form>
    );
}
