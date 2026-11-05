import type { FieldReviewState } from './review';

/**
 * #16's rules for what a stamp-only review may clear, shared by the Publish
 * screen's view (lib/curation/publish-view.ts), its action, and `photos
 * review`. Pure, with type imports only, so the view stays clear of the
 * writer and the locks (review-write.ts).
 */

type Reason = NonNullable<FieldReviewState['reason']>;

const RESTAMP_LIST = ['active-moved', 'base-unreadable', 'asset-replaced', 'cover-replaced', 'edited', 'no-stamp', 'generated'] as const satisfies readonly Reason[];
export type RestampReason = (typeof RESTAMP_LIST)[number];
/** The reasons a stamp-only review may clear (16-3's decision 2). */
export const RESTAMP_REASONS: ReadonlySet<string> = new Set<string>(RESTAMP_LIST);

/** The reasons only the Inbox settles. */
export const INBOX_REASONS: ReadonlySet<string> = new Set(['item-reopened', 'newer-item', 'item-unreadable', 'inbox-unread']);

/** A described alt nobody has reviewed: marking it ready is its own fix, never a stamp-only review. */
export const isGeneratedAlt = (entry: Pick<FieldReviewState, 'reason' | 'record' | 'field'>) => entry.reason === 'generated' && entry.record.kind === 'photo' && entry.field === 'alt';

/** Whether a stamp-only review may clear this field's state: its reason is one it restamps, and it isn't a generated description. */
export function restampReason(state: FieldReviewState): boolean {
    return state.state !== 'reviewed' && state.reason !== undefined && RESTAMP_REASONS.has(state.reason) && !isGeneratedAlt(state);
}

/** Whether a rebase left `field` of a record in conflict: only an edit that keeps one value settles it. */
export function inConflict(record: { conflicts?: readonly { field: string }[] } | null, field: string): boolean {
    return (record?.conflicts ?? []).some((entry) => field === entry.field || field.startsWith(`${entry.field}[`));
}
