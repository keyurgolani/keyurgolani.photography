'use server';

import { revalidatePath } from 'next/cache';
import { requireCurator } from '@/lib/curation/auth';
import { runInboxAction } from '@/lib/curation/inbox-form';
import type { InboxActionKind, InboxActionState } from '@/lib/curation/inbox-view';

/**
 * The inbox's server actions, one per 14-1 action. Each calls
 * requireCurator() first, before it reads its arguments, so a request the
 * boundary refuses (the flag, the bind, the `Host`, or the `Origin`) gets a
 * 404 and writes nothing, however it was posted. Then the form goes to
 * lib/curation/inbox-form.ts, which checks the event version and the active
 * revision the page showed. Only a finished action refreshes the page; a
 * stale one leaves it as it was, so the curator refreshes and reviews again.
 */

async function settle(kind: InboxActionKind, form: unknown): Promise<InboxActionState> {
    const state = await runInboxAction(kind, form);
    if (state.status === 'done') revalidatePath('/curation/inbox');
    return state;
}

export async function approveItem(_previous: InboxActionState, form: FormData): Promise<InboxActionState> {
    await requireCurator();
    return settle('approve', form);
}

export async function editItem(_previous: InboxActionState, form: FormData): Promise<InboxActionState> {
    await requireCurator();
    return settle('edit', form);
}

export async function deferItem(_previous: InboxActionState, form: FormData): Promise<InboxActionState> {
    await requireCurator();
    return settle('defer', form);
}

export async function dismissItem(_previous: InboxActionState, form: FormData): Promise<InboxActionState> {
    await requireCurator();
    return settle('dismiss', form);
}

export async function retryItem(_previous: InboxActionState, form: FormData): Promise<InboxActionState> {
    await requireCurator();
    return settle('retry', form);
}

export async function reopenItem(_previous: InboxActionState, form: FormData): Promise<InboxActionState> {
    await requireCurator();
    return settle('reopen', form);
}
