'use client';

import { startTransition, useActionState, type FormEvent, type ReactNode } from 'react';
import styles from '../curator.module.css';
import { bulkItems } from './actions';
import ErrorSummary, { type SummaryEntry } from './ErrorSummary';
import { BULK_IDLE, DEFER_LABEL } from '@/lib/curation/inbox-view';

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
    children: ReactNode;
}

const UNASSIGNED_HINT = 'Leave selected unassigned approves each selected new photograph into the draft with no series, keeping any description saved on it. Nothing is published until you publish.';

/**
 * #14 (A8): the list's bulk Decide later (the mockup's "Leave in draft") and Leave unassigned. The rows it wraps carry
 * a checkbox each, whose value is the row's item and the version the page showed, so the server checks every item
 * against what the curator saw, as one action does. What went through is said once in the polite region. What was
 * left alone, or a selection the server refused, is an error summary that takes focus and links each record, or the
 * checkboxes. The answers stay until the next press.
 */
export default function BulkActions({ base, rows, canDefer, canUnassign, firstPick, children }: BulkActionsProps) {
    const [state, dispatch, pending] = useActionState(bulkItems, BULK_IDLE);
    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        // As ItemActions: aria-disabled, never `disabled`, so a focused button keeps focus while the action is out.
        if (pending) return;
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        const form = new FormData(event.currentTarget);
        if (submitter instanceof HTMLButtonElement && submitter.name) form.set(submitter.name, submitter.value);
        startTransition(() => dispatch(form));
    };
    const off = { 'aria-disabled': pending || undefined, 'data-off': pending ? 'true' : undefined };
    const answered = state.status === 'idle' ? null : state;
    const left = answered?.results.filter((result) => result.status !== 'done') ?? [];
    const leftTitle = left.length === 1 ? '1 item was left as it is' : `${left.length} items were left as they are`;
    const entries: SummaryEntry[] = left.map((result) => ({ text: rows[result.eventId]?.label ?? 'An item no longer on this page', href: rows[result.eventId]?.href ?? `/curation/inbox?item=${result.eventId}#item`, note: result.message }));
    return (
        <form method="post" onSubmit={submit} aria-label="Bulk actions" id="inbox-bulk" className={styles.bulk}>
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
                {answered && answered.status !== 'invalid' ? <p key={answered.serial}>{answered.message}</p> : null}
            </div>
            {answered?.status === 'invalid' ? (
                <ErrorSummary id="bulk-summary" title={answered.message} focusKey={answered.serial} state="invalid" entries={firstPick ? [{ text: 'The items to select', href: `#${firstPick}`, target: firstPick }] : []} />
            ) : answered && left.length > 0 ? (
                <ErrorSummary id="bulk-summary" title={leftTitle} focusKey={answered.serial} state={answered.status} entries={entries} />
            ) : null}
            {children}
        </form>
    );
}
