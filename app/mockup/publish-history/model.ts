/**
 * The 15-4 mockup's view model: what the History section and its restore
 * dialog render, already in the owner's words. The build computes the same
 * shapes in `lib/curation/publish-history.ts` from 15-2's `readHistory()`,
 * `knownGood()` and `planRollback()` (spec, Server side). Not for merge.
 */

/** A noun, so an interrupted row reads "Didn't finish · Publish" (review r1 P2-8). */
export type EntryKind = 'Publish' | 'Restore';

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
    /**
     * What it changed for visitors, leading with the change: a publish against
     * its parent, a restore against the revision it replaced (review r1 P2-7,
     * P3-8). "The first revision." / "It never went live…" otherwise.
     */
    from: string;
    /** "3 series, 26 photographs in all." */
    held?: string;
    /** A lock takeover or the editorial rules a restore accepted. */
    extra?: string;
    /** "Entry 7 · 3fa1c2d9" */
    facts: string;
    eligibility: Eligibility;
}

export interface ImpactLine {
    text: string;
    /** The names past the first 5, behind "and N more". */
    more?: string[];
}

/** One planRollback() for a restorable revision, in owner words. */
export interface Plan {
    revision: number;
    hash: string;
    active: number;
    activeHash: string;
    /** Removals first, then what comes back, then changes. Names past 5 sit in a disclosure (review r1 P2-5). */
    impact: ImpactLine[];
    /** Only while a draft is pending. */
    draftNote?: string;
    /** The editorial rules the target fails, which restoring accepts. */
    editorial?: string;
}

export type ResultAction = 'cancel' | 'close' | 'close-reload' | 'retry' | 'reload' | 'finish';

export interface Result {
    tone: 'done' | 'alert' | 'change';
    /** The clock for a held lock, as 16-3's busy answer. */
    clock?: boolean;
    heading: string;
    body: string[];
    list?: string[];
    actions: ResultAction[];
    /**
     * The answer carries a pointer other than the one the dialog was opened
     * against (ACTIVE_CHANGED, NO_CHANGES, interrupted with the pointer moved):
     * the fixed facts say what they were, and the impact list is kept as
     * history or hidden (review r1 P2-1).
     */
    moved?: { impact: 'past' | 'hide' };
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
    done?: { heading: string; body: string[]; jump?: { label: string; target: string } };
    /**
     * What a 16-3 answer that moved the pointer carries (Published, Already
     * live, Someone else published, Failed with the pointer moved): History
     * read again, the new live revision marked and without Restore (spec,
     * History by 16-3 state).
     */
    afterAnswer?: HistoryModel;
    /** A state shot with the dialog open. */
    dialog?: DialogState;
    /** Every restorable revision's plan, by revision number, for the dialog. */
    plans: Record<number, Plan>;
}
