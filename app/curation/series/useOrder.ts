'use client';

import { startTransition, useActionState, useRef, type FormEvent } from 'react';
import { IDLE_ORDER, type OrderActionState } from '@/lib/curation/series-view';

/**
 * What #150's 2b ordering sections share: one server action each, its
 * answer, and the two ways a section sends a form. A row's buttons send
 * their few fields from code, as `<button type="button">`s (contract rule
 * 1); a form with fields of its own submits them by hand, not through
 * `<form action>`, so React never resets it after a refusal. Either way the
 * form carries what the page showed: the version of the record it changes
 * and the live revision, which the server checks under the lock.
 */

/** What a button says while an action is out, or when it can't act here: unavailable, but focusable still (#1's focus contract). */
export const offWhile = (off: boolean) => ({ 'aria-disabled': off || undefined, 'data-off': off ? 'true' : undefined });

type OrderAction = (previous: OrderActionState, form: FormData) => Promise<OrderActionState>;

export function useOrder(action: OrderAction, carried: Record<string, string>) {
    const [state, dispatch, pending] = useActionState(action, IDLE_ORDER);
    const answerRef = useRef<HTMLDivElement>(null);
    const dispatchWith = (form: FormData, op: string, fields: Record<string, string | readonly string[]>) => {
        for (const [name, value] of Object.entries({ ...carried, op })) form.set(name, value);
        for (const [name, value] of Object.entries(fields)) for (const one of [value].flat()) form.append(name, one);
        startTransition(() => dispatch(form));
    };
    /** A row's button: the operation and its fields. Nothing while an action is out. */
    const send = (op: string, fields: Record<string, string> = {}) => {
        if (pending) return;
        dispatchWith(new FormData(), op, fields);
    };
    /** A form's submit: the operation, its fields, and any the form doesn't hold. */
    const submit = (op: string, fields: Record<string, string> = {}) => (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (pending) return;
        dispatchWith(new FormData(event.currentTarget), op, fields);
    };
    return { state, pending, send, submit, answerRef };
}

/** The answer's words when it's about `name`, shown by that field. */
export const errorFor = (state: OrderActionState, name: string) => (state.status === 'invalid' && state.field === name ? state.message : null);
