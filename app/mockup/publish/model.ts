/**
 * The 16-3 mockup's view model: what the Publish screen would get from
 * `lib/curation/publish-view.ts` once it's built. Fixture data only; nothing
 * here reads the data root. Not for merge.
 */

export type ReviewLabel = 'reviewed' | 'not-reviewed' | 'stale' | 'generated' | 'automatic' | 'confirmed' | 'published';

export type KindLabel = 'New' | 'Removed' | 'Changed' | 'Moved' | 'Hidden' | 'Route' | 'New image' | 'Recalculated' | 'Source health';

export interface Picture {
    src: string;
    alt: string;
}

export type Compare =
    | { type: 'text'; before: string | null; after: string | null }
    | { type: 'images'; before: Picture; after: Picture }
    | { type: 'list'; before: string[]; after: string[] };

export type Fix =
    | {
          type: 'description';
          /** The photograph's name, for the action's accessible name. */
          record: string;
          photoId: string;
          picture: Picture;
          text: string;
          suggested: string;
          open: boolean;
      }
    | { type: 'restamp'; record: string; label: string }
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

export interface BlockingError {
    rowId: string;
    record: string;
    field: string;
    message: string;
    fix?: Fix;
}

export type Result =
    | { type: 'blocked'; lead: string; errors: BlockingError[] }
    | { type: 'valid' }
    | { type: 'published'; number: number };

export interface Notice {
    tone: 'done' | 'change' | 'alert';
    heading: string;
    body: string;
    action?: string;
}

export interface Panel {
    series: string;
    count: string;
    copyLine: string;
    /** The rollback-ready note, or null when nothing is active. */
    rollback: string | null;
    src: string;
}

export type ActionState = 'available' | 'unavailable' | 'pending' | 'hidden';

export interface ScreenModel {
    draftNumber: number;
    liveNumber: number | null;
    draftHash: string;
    liveHash: string | null;
    heading?: string;
    lead?: string;
    notice?: Notice;
    ledger: Ledger | null;
    ledgerHeading?: string;
    result?: Result;
    validate: ActionState;
    publish: ActionState;
    publishReason?: string;
    confirm?: boolean;
    status?: string;
    panel: Panel | null;
    /** A whole-page state in place of the screen. */
    page?: { heading: string; body: string; code?: string; action: string };
}
