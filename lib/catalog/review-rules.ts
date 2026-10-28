import { diffCatalog, EMPTY_DIFF_MESSAGE, type CatalogDiff } from './diff';
import { registerRule, shared } from './rules';
import type { ReviewContext } from './review';
import { revisionIdOf } from './schema';
import type { Rule, RuleContext, RuleFinding } from './types';

/**
 * #16's publish gate, two rules over diffCatalog(). Both are `publish`
 * gate errors, `editorial` for a #15 rollback, and silent for a stored
 * revision (`ctx.authored` null): rollback's eligibility check and
 * photos:verify have no working layer to review, and what they check was
 * reviewed when it was first published.
 *
 * - `review.authored-change` refuses a visitor-visible authored change whose
 *   review is missing or stale, naming the record and field and what to do.
 *   An unreviewed suggested description is description.required's to report,
 *   so it isn't reported twice.
 * - `review.empty-diff` refuses a candidate that differs from the active
 *   revision yet changes nothing visitors see, so a publish can't pretend
 *   to publish work. A candidate equal to the active revision never gets
 *   here: publish stops with NO_CHANGES first.
 */

/** The diff the two rules share, worked out once per runRules() call. */
export function ruleDiff(ctx: RuleContext): CatalogDiff {
    return shared(ctx, 'review.diff', () => diffCatalog({ active: ctx.active, candidate: ctx.candidate, authored: ctx.authored, registry: ctx.registry, review: ctx.review }));
}

const HINTS: Record<string, string> = {
    'no-record': 'Restore the record from a backup, or publish without the change.',
    'no-stamp': 'A change made by hand is not reviewed. Check it on the Publish screen and mark it reviewed there, or put the field back as it was and make the change with photos edit, which reviews what it writes.',
    'backfill-unreadable': 'Restore authored/review-backfill.json from the data-root backup, or ask the owner. Never edit or delete it: the next command would write a new one, taking every hand edit made since the upgrade as reviewed.',
    edited: 'A change made by hand is not reviewed. Check it on the Publish screen and mark it reviewed there, or put the field back as it was and make the change with photos edit, which reviews what it writes.',
    generated: 'Read the suggestion, and write the value you want with photos edit.',
    'active-moved': 'The active revision changed since this was reviewed. Check the field against what is live. If it needs a change, make it with photos edit. If it is still right, mark it reviewed on the Publish screen.',
    'base-unreadable': 'Check the field against what is live. If it needs a change, make it with photos edit. If it is still right, mark it reviewed on the Publish screen.',
    'asset-replaced': 'Check it still fits the new bytes. If it needs a change, make it with photos edit. If it is still right, mark it reviewed on the Publish screen.',
    'cover-replaced': 'Check the cover still fits its new bytes. To use another, set it with photos sequence cover. If it is still right, mark it reviewed on the Publish screen.',
    'item-reopened': 'Settle the inbox item again with curation, or leave it in draft.',
    'newer-item': 'Settle the newer inbox item first: confirm its bytes, or leave it in draft.',
    'item-unreadable': 'Fix or restore the inbox item, then settle it again.',
    'inbox-unread': 'Publish reads the inbox. Run it again.',
};

/** What settles a reopened item again, by its type. Only a new photograph is approved. */
const SETTLE_AGAIN: Record<string, string> = {
    new: 'approve it again or leave it in draft. curation list counts a reopened photograph a series still holds as already placed, but this review waits for that decision.',
    replacement: 'confirm it again or leave it in draft.',
    missing: 'archive it again or leave it in draft.',
};

/**
 * The fix for a reason. A reopened item names its `curation show` and what
 * settles it, since `curation list` counts a reopened new photograph as
 * already placed while a series holds it (settledByPlacement()), so the list
 * alone wouldn't point the curator at it.
 */
function hintFor(reason: string | undefined, eventId: string | undefined, review: ReviewContext | undefined): string {
    const settle = reason === 'item-reopened' && eventId !== undefined ? SETTLE_AGAIN[review?.inbox.get(eventId)?.type ?? ''] : undefined;
    if (settle !== undefined) return `Run curation show ${eventId}, then ${settle}`;
    return HINTS[reason ?? ''] ?? 'Review the change, then publish again.';
}

const REVIEW_RULES: Rule[] = [
    {
        id: 'review.authored-change',
        version: 1,
        severity: 'error',
        gate: 'publish',
        rollbackClass: 'editorial',
        check: (ctx) => {
            if (!ctx.authored) return [];
            const findings: RuleFinding[] = [];
            const seen = new Set<string>();
            for (const change of ruleDiff(ctx).changes) {
                if (!change.visible || (change.review.state !== 'unreviewed' && change.review.state !== 'stale')) continue;
                for (const entry of change.review.fields) {
                    if (entry.state === 'reviewed') continue;
                    // description.required reports a suggested description nobody has reviewed.
                    if (entry.reason === 'generated' && entry.record.kind === 'photo' && entry.field === 'alt') continue;
                    const key = `${entry.record.kind}:${entry.record.id}:${entry.field}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    findings.push({
                        record: entry.record,
                        field: entry.field,
                        message: `${entry.state === 'stale' ? 'Stale review' : 'Not reviewed'}: ${entry.detail}`,
                        hint: hintFor(entry.reason, entry.eventId, ctx.review),
                    });
                }
            }
            return findings;
        },
    },
    {
        id: 'review.empty-diff',
        version: 1,
        severity: 'error',
        gate: 'publish',
        rollbackClass: 'editorial',
        check: (ctx) => {
            if (!ctx.authored || revisionIdOf(ctx.candidate) === ctx.active?.revisionId) return [];
            if (!ruleDiff(ctx).empty) return [];
            return [{ record: { kind: 'site', id: 'site' }, field: '', message: `The candidate changes nothing visitors see. ${EMPTY_DIFF_MESSAGE}`, hint: 'There is nothing to publish.' }];
        },
    },
];

for (const rule of REVIEW_RULES) registerRule(rule);
