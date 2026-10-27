/**
 * The 16-3 mockup's view model: what the Publish screen would get from
 * `lib/curation/publish-view.ts` once it's built. Fixture data only; nothing
 * here reads the data root. Not for merge.
 *
 * Revision 2: every fixed fact the screen shows (the heading, the group
 * labels, the compare labels, the panel's header and marker, the rollback
 * line) comes from here, so a live or out-of-date revision never reads as a
 * draft (spec, Facts by state).
 */

export type ReviewLabel = 'reviewed' | 'not-reviewed' | 'stale' | 'generated' | 'automatic' | 'confirmed' | 'published';

export type KindLabel = 'New' | 'Removed' | 'Changed' | 'Moved' | 'Hidden' | 'Route' | 'New image' | 'Recalculated' | 'Source health';

export interface Picture {
    src: string;
    alt: string;
}

/**
 * An order compare carries both full orders and the move; the screen shows a
 * window of one position either side of both ends (spec, Change ledger).
 */
export interface OrderCompare {
    type: 'list';
    before: string[];
    after: string[];
    /** The moved entry, by name, and its 1-based positions. */
    moved: string;
    from: number;
    to: number;
}

export type Compare = { type: 'text'; before: string | null; after: string | null } | { type: 'images'; before: Picture; after: Picture } | OrderCompare;

/** The answer a refused fix shows inside the fix, under its action (spec, Fixes on a row). */
export interface Refusal {
    text: string;
    action: string;
}

export type Fix =
    | {
          type: 'description';
          /** The photograph's name, for the action's accessible name. */
          record: string;
          /** The full photo ID, so the command can be copied and run. */
          photoId: string;
          /** The photograph's Inbox item, for `itemUrl()`; null leaves the Inbox clause out. */
          inboxItem: string | null;
          picture: Picture;
          text: string;
          suggested: string;
          open: boolean;
          refusal?: Refusal;
      }
    | { type: 'restamp'; record: string; label: string; refusal?: Refusal }
    | { type: 'inbox'; record: string; eventId: string };

export interface LedgerRow {
    id: string;
    kind: KindLabel;
    review: ReviewLabel;
    summary: string;
    detail?: string;
    blocks?: boolean;
    compare?: Compare;
    fix?: Fix;
}

export interface Ledger {
    authored: LedgerRow[];
    derived: LedgerRow[];
    health: LedgerRow[];
}

/** How the blocker list's one link reads and where it goes, by the blocker's fix. */
export type BlockerLink = { type: 'description'; name: string } | { type: 'restamp'; name: string } | { type: 'inbox'; record: string; eventId: string } | { type: 'none'; record: string };

export interface BlockingError {
    rowId: string;
    record: string;
    field: string;
    message: string;
    link: BlockerLink;
}

/** Every answer to Validate or Publish, all in the one result slot above the bar. */
export type Result =
    | { type: 'blocked'; lead: string; errors: BlockingError[] }
    | { type: 'blocked-at-publish'; lead: string; errors: BlockingError[] }
    | { type: 'valid'; stakes: string }
    | { type: 'published'; number: number }
    | { type: 'changed'; body: string }
    | { type: 'someone-published'; number: number; by: string }
    | { type: 'already-live'; number: number; by: string }
    | { type: 'busy'; body: string }
    | { type: 'failed'; heading: string; body: string };

export interface Panel {
    /** "Visitor preview" or "Live site". */
    title: string;
    /** Open full preview, Open the site, or nothing. */
    link: { label: string; href: string } | null;
    /** The frame toolbar's marker: "Preview · not public", or "Live, revision N". */
    marker: string;
    /** The iframe's title, in the state's terms. */
    frameTitle: string;
    /** A line in place of the frame (out of date). */
    frameNote?: string;
    /** One sans line naming the series: "Low Tide Hours: 6 photographs, was 5". */
    count: string;
    copyLine: string;
    /** The rollback line, by the spec's rule; backticks mark a command. Null when nothing is active. */
    rollback: string | null;
    src: string;
}

export type ActionState = 'available' | 'unavailable' | 'pending' | 'hidden';

export interface ScreenModel {
    /** N in "Publish revision N". */
    draftNumber: number;
    heading: string;
    lead?: string;
    /** "9 changes for visitors: 5 authored, 4 derived. 2 block publishing.", or the state's line. */
    countLine?: string;
    /** "Current public revision M" and the short hashes; null when nothing is active. */
    revision: { current: string; hashes: string } | null;
    ledger: Ledger | null;
    ledgerHeading: string;
    /** Set when the ledger compares against a revision that's no longer the base. */
    outOfDate?: string;
    /** Draft group labels ("Authored · requires judgment") or live ones ("Authored"). */
    groups: 'draft' | 'live';
    compareLabels: { before: string; after: string };
    result?: Result;
    validate: ActionState;
    publish: ActionState;
    publishReason?: string;
    confirm?: boolean;
    /** The one live region's text. */
    status?: string;
    panel: Panel | null;
    /** Nothing to publish and No visible change: Open the Inbox under the lead, one column. */
    inboxLink?: boolean;
    /** A whole-page state in place of the screen. */
    page?: { heading: string; body: string; code?: string; action: string };
}
