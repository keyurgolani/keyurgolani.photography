'use server';

import { revalidatePath } from 'next/cache';
import { requireCurator } from '@/lib/curation/auth';
import { runInboxBulk } from '@/lib/curation/inbox-bulk';
import { runInboxAction } from '@/lib/curation/inbox-form';
import type { BulkKind, InboxActionKind, InboxActionState, InboxBulkState } from '@/lib/curation/inbox-view';

/**
 * The inbox's server actions, one per 14-1 action, and #118's three for #17's
 * resolutions: Confirm, Bind and Archive. Each calls
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

export async function confirmItem(_previous: InboxActionState, form: FormData): Promise<InboxActionState> {
    await requireCurator();
    return settle('confirm', form);
}

export async function bindItem(_previous: InboxActionState, form: FormData): Promise<InboxActionState> {
    await requireCurator();
    return settle('bind', form);
}

export async function archiveItem(_previous: InboxActionState, form: FormData): Promise<InboxActionState> {
    await requireCurator();
    return settle('archive', form);
}

/**
 * #14 (v2.0.0 A8): the list's bulk Decide later and Leave unassigned. The form's submit button names which as
 * `intent`; anything else is refused before any item is read. Each checked row carries its own item and version, and
 * lib/curation/inbox-bulk.ts runs them one by one through the same writers and checks as a single action, capped at
 * one page. The page refreshes when any went through.
 */
export async function bulkItems(_previous: InboxBulkState, form: FormData): Promise<InboxBulkState> {
    await requireCurator();
    const intent = form instanceof FormData ? form.get('intent') : null;
    const kind: BulkKind | null = intent === 'defer' || intent === 'unassigned' ? intent : null;
    const state = await runInboxBulk(kind ?? ('none' as BulkKind), form);
    if (state.status === 'done' || state.status === 'partial') revalidatePath('/curation/inbox');
    return state;
}
