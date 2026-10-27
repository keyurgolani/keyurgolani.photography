/**
 * The 15-4 mockup's view model: what the History section and its restore
 * dialog render, already in the owner's words. The build computes the same
 * shapes in `lib/curation/publish-history.ts` from 15-2's `readHistory()`,
 * `knownGood()` and `planRollback()` (spec, Server side). Not for merge.
 */

export type EntryKind = 'Published' | 'Restored';

export type Eligibility =
    /** The newest entry for a revision that may come back: the one Restore button for it. */
    | { type: 'restore'; revision: number }
    /** Why not, or that it's live, as a sentence. */
    | { type: 'text'; text: string; tone: 'done' | 'alert' | 'quiet' }
    | { type: 'none' };

export interface Entry {
    sequence: number;
    title: string;
    badge?: { text: string; tone: 'done' | 'quiet' };
    kind: EntryKind;
    /** "Published 26 October at 14:05, from this screen." */
    when: string;
    /** The owner's own reason (a restore), quoted; or a CLI publish's note. */
    reason?: { text: string; quoted: boolean };
    /** "Replaced revision 5." / "The first revision." / "It never went live…" */
    from: string;
    /** "3 series, 26 photographs. Against revision 5: …" */
    held?: string;
    /** A lock takeover or the editorial rules a restore accepted. */
    extra?: string;
    /** "Entry 7 · 3fa1c2d9" */
    facts: string;
    eligibility: Eligibility;
}

/** One planRollback() for a restorable revision, in owner words. */
export interface Plan {
    revision: number;
    hash: string;
    active: number;
    activeHash: string;
    impact: string[];
    /** Only while a draft is pending. */
    draftNote?: string;
    /** The editorial rules the target fails, which restoring accepts. */
    editorial?: string;
}

export type ResultAction = 'cancel' | 'close' | 'retry' | 'reload' | 'finish';

export interface Result {
    tone: 'done' | 'alert' | 'change';
    /** The clock for a held lock, as 16-3's busy answer. */
    clock?: boolean;
    heading: string;
    body: string[];
    list?: string[];
    actions: ResultAction[];
}

export type Phase = 'review' | 'reason-missing' | 'pending' | 'result';

export interface DialogState {
    plan: Plan;
    /** The entry whose Restore button opened it, for focus return. */
    opener: number;
    phase: Phase;
    reason: string;
    result?: Result;
}

export interface HistoryModel {
    lead: string;
    entries: Entry[];
    /** Long history: how many entries there are in all, and the link that shows more. */
    total?: number;
    more?: { label: string; href: string };
    /** The page after a restore (`?restored=`): its notice at the top of History. */
    done?: { heading: string; body: string[] };
    /** A state shot with the dialog open. */
    dialog?: DialogState;
    /** Every restorable revision's plan, by revision number, for the dialog. */
    plans: Record<number, Plan>;
}
