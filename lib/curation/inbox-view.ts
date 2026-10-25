/**
 * What the curator's inbox page shows, as plain data a client component can
 * take: no Node imports, no paths outside the library, and nothing a public
 * route loads. lib/curation/inbox.ts builds it on the server, and the
 * page's forms read the event versions and the active revision from it, so
 * every action is checked against what the curator saw.
 */

import type { CurationEventStatus, CurationEventType, Placement } from './events';

export const BADGE_LABELS: Record<CurationEventType, string> = {
    new: 'New photograph',
    replacement: 'Replacement',
    missing: 'Missing source',
    reappeared: 'Source reappeared',
    ambiguous: 'Ambiguous match',
    'processing-failure': 'Processing failure',
};

/** The item's title in the list, by type. */
export function itemTitle(type: CurationEventType, waiting: boolean): string {
    switch (type) {
        case 'new':
            return 'Uncurated photograph';
        case 'replacement':
            return waiting ? 'Replacement building' : 'Replacement ready';
        case 'missing':
            return 'Source file missing';
        case 'reappeared':
            return 'Source file back';
        case 'ambiguous':
            return 'Identity needs a choice';
        case 'processing-failure':
            return 'Processing failed';
    }
}

/** What the system did with the item, by type. Never a claim about what a visitor sees changing. */
export const SYSTEM_RESPONSE: Record<CurationEventType, string> = {
    new: 'It has a stable ID and waits here as a draft suggestion. Nothing publishes.',
    replacement: 'It keeps its photo ID and its place in the story. The new bytes are a new asset revision, used only after every derivative succeeds.',
    missing: 'The source is marked missing. The site keeps serving the last published derivatives until you resolve it.',
    reappeared: 'The source is back. Nothing a visitor sees changed.',
    ambiguous: 'It matches more than one photograph, so no identity is bound until you choose one.',
    'processing-failure': "The watcher couldn't process it, so nothing was made from it.",
};

/** The primary action the approved mockup names for each type that has one. */
export const PRIMARY_ACTION: Partial<Record<CurationEventType, string>> = {
    new: 'Review series suggestion',
    replacement: 'Confirm new asset revision',
    missing: 'Resolve source or archive intentionally',
};

export const STATUS_LABELS: Record<CurationEventStatus, string> = {
    open: 'Draft only',
    failed: 'Draft only',
    deferred: 'Left in draft',
    dismissed: 'Dismissed',
    approved: 'Suggestion approved',
};

/** Where an item sits in the list. */
/**
 * Where an item sits in the list, the way `curation list` counts it:
 * `placed` is a new photograph's open or deferred item whose photo a series
 * or the live revision already holds, and `unplaced` an approval whose photo
 * nothing holds now (lib/curation/placement.ts).
 */
export type ItemGroup = 'judgment' | 'unplaced' | 'waiting' | 'deferred' | 'placed' | 'settled';

export interface InboxSuggestion {
    /** Null is "Leave unassigned". */
    value: string | null;
    confidence: 'high' | 'medium' | 'low';
    producedBy: string;
    producedAt: string;
    evidence: string[];
}

export interface InboxPlacementSuggestion extends Omit<InboxSuggestion, 'value'> {
    value: Placement;
}

export interface InboxItem {
    id: string;
    version: number;
    type: CurationEventType;
    status: CurationEventStatus;
    group: ItemGroup;
    title: string;
    photoId: string | null;
    shortId: string;
    waiting: string | null;
    /** What holds its photo, for an item settled by placement, or null. */
    placedBy: string | null;
    /** The series its last approval named, for an approval whose photo nothing holds now, or null. */
    unplacedSeries: string | null;
}

export interface SeriesOption {
    id: string;
    /** The authored title, or the ID when it has none. */
    label: string;
    visibility: 'draft' | 'published' | 'hidden';
    /** In authored order. */
    members: { photoId: string; shortId: string }[];
}

export interface InboxDetail extends InboxItem {
    assetRevision: string | null;
    observedAt: string;
    lastObservedAt: string;
    /** Library-relative, with anything unprintable escaped. */
    sourcePath: string;
    fromPath: string | null;
    identity: string;
    derivatives: string;
    /** A curator-only URL for the candidate's w800 WebP, or null when no set is ready. */
    previewUrl: string | null;
    facts: { label: string; value: string }[];
    failure: string | null;
    candidates: string[];
    /** Who still shows it: the active revision, or a working-layer series. Null when it can't be told. */
    references: string[] | null;
    suggestions: { series: InboxSuggestion | null; placement: InboxPlacementSuggestion | null };
    edits: {
        seriesId?: string | null;
        placement?: Placement;
        description?: { kind: 'described'; text: string } | { kind: 'decorative' } | null;
        editedAt: string;
        editedBy: string;
    } | null;
    /**
     * What the working layer already holds for this photograph, once an
     * approval placed it: its reviewed description or the decorative flag
     * (an unreviewed description shows as none), and the series that hold it.
     * Null before any approval. A reopened form starts from it.
     */
    placed: { alt: { kind: 'described'; text: string } | { kind: 'decorative' } | null; seriesIds: string[] } | null;
    /** The series the last approval on this item named, or null when none did or it left the photo unassigned. */
    lastApprovedSeries: string | null;
    decisions: { action: string; at: string; by: string; detail: string }[];
    reviewedAt: string | null;
    reviewedBy: string | null;
    /** What each action would do now, so the page offers only those that can work. */
    can: { approve: boolean; edit: boolean; defer: boolean; dismiss: boolean; retry: boolean; reopen: boolean };
    /** Why the type's primary action isn't offered here, when it isn't. */
    primaryUnavailable: string | null;
}

export type InboxView =
    | { state: 'not-ready'; message: string }
    | {
          state: 'ready';
          /** The active revision every action is checked against. Null before the first publish. */
          activeRevisionId: string | null;
          needsJudgment: number;
          waiting: number;
          /** Items settled by placement, and approvals no longer placed, as `curation list` counts them. */
          placed: number;
          unplaced: number;
          /** The placement lookup couldn't tell, so every item counts by its stored status. */
          placementUnknown: boolean;
          items: InboxItem[];
          /** Event folders that couldn't be read, by ID and reason. Never a path. */
          problems: { id: string; message: string }[];
          series: SeriesOption[];
          /** A problem reading the working layer's series, which empties the series choices. */
          seriesProblem: string | null;
          selected: InboxDetail | null;
          /** The `item` the URL asked for, when no event has that ID. */
          missingSelection: string | null;
      };

/** "N items require judgment", then what waits, what's already placed, and what's no longer placed, as `curation list` says it. */
export function summaryText(view: { needsJudgment: number; waiting: number; placed?: number; unplaced?: number }): string {
    const judgment = `${view.needsJudgment} ${view.needsJudgment === 1 ? 'item requires' : 'items require'} judgment`;
    const rest = [
        ...(view.waiting > 0 ? [`${view.waiting} waiting`] : []),
        ...((view.placed ?? 0) > 0 ? [`${view.placed} already placed`] : []),
        ...((view.unplaced ?? 0) > 0 ? [`${view.unplaced} approved but no longer placed`] : []),
    ];
    return [judgment, ...rest].join(', ');
}

const PLACEMENT_RE = /^(start|end|after:ph_[0-9a-f-]{36})$/;

/** A placement as a form value: `start`, `end`, or `after:<photoId>`. */
export function placementValue(placement: Placement): string {
    return typeof placement === 'string' ? placement : `after:${placement.after}`;
}

/** The placement a form value names, or null for anything else. */
export function parsePlacementValue(value: string): Placement | null {
    if (!PLACEMENT_RE.test(value)) return null;
    if (value === 'start' || value === 'end') return value;
    return { after: value.slice('after:'.length) };
}

/**
 * The series the form starts on, the way lib/curation/actions.ts resolves an
 * approval with nothing chosen: the saved edit; then, once an earlier
 * approval placed the photo, where it is now (the series that holds it, or
 * unassigned when none does); then the suggestion. Undefined when none names one.
 */
export function defaultSeries(detail: Pick<InboxDetail, 'edits' | 'suggestions'> & { placed?: InboxDetail['placed']; decisions?: InboxDetail['decisions'] }): string | null | undefined {
    if (detail.edits?.seriesId !== undefined) return detail.edits.seriesId;
    const approvedBefore = detail.decisions?.some((decision) => decision.action === 'approve') ?? false;
    if (approvedBefore && detail.placed) return detail.placed.seriesIds[0] ?? null;
    if (detail.suggestions.series) return detail.suggestions.series.value;
    return undefined;
}

/**
 * The series the page's form starts on: defaultSeries(), except that a
 * reopened item whose photo no series holds now starts on the series its last
 * approval named, while that series is still one of `seriesIds`. That's the
 * series "No longer placed" says to approve it into. The form sends the series
 * it shows, so the approval goes there only if the curator leaves it chosen;
 * the CLI's bare approve still leaves it unassigned, and says to pass --series.
 */
export function formSeries(detail: Parameters<typeof defaultSeries>[0] & Pick<InboxDetail, 'lastApprovedSeries'>, seriesIds: readonly string[]): string | null | undefined {
    const series = defaultSeries(detail);
    const last = detail.lastApprovedSeries;
    if (series === null && detail.edits?.seriesId === undefined && detail.placed?.seriesIds.length === 0 && last !== null && seriesIds.includes(last)) return last;
    return series;
}

/** The description the form starts on: the saved edit, then what the photo record holds. */
export function defaultDescription(detail: Pick<InboxDetail, 'edits' | 'placed'>): { kind: 'described'; text: string } | { kind: 'decorative' } | null {
    if (detail.edits?.description !== undefined) return detail.edits.description;
    return detail.placed?.alt ?? null;
}

/**
 * The position an approval would use for `seriesId` with no new choice, the
 * way lib/curation/actions.ts resolves it: a saved position for that series,
 * then the suggested one when it's for the same series, then the end.
 */
export function defaultPlacement(detail: Pick<InboxDetail, 'edits' | 'suggestions'>, seriesId: string): Placement {
    const edits = detail.edits;
    const suggested = detail.suggestions.series?.value;
    if (edits?.placement !== undefined && (edits.seriesId ?? suggested) === seriesId) return edits.placement;
    if (suggested === seriesId && detail.suggestions.placement) return detail.suggestions.placement.value;
    return 'end';
}

/** A position in words, for a select or a message. */
export function placementLabel(placement: Placement, members: readonly { photoId: string; shortId: string }[]): string {
    if (placement === 'start') return 'At the start';
    if (placement === 'end') return 'At the end';
    const index = members.findIndex((member) => member.photoId === placement.after);
    if (index < 0) return `After ${placement.after.slice(0, 11)}`;
    return `After photograph ${String(index + 1).padStart(2, '0')} (${members[index].shortId})`;
}

/** What a curator action answered, as the page shows it. */
export type InboxActionKind = 'approve' | 'edit' | 'defer' | 'dismiss' | 'retry' | 'reopen';

export type InboxActionState =
    | { status: 'idle' }
    | {
          /** `stale`: the event, the active revision, or the source moved since the page loaded, and nothing was written. */
          status: 'done' | 'stale' | 'busy' | 'refused' | 'invalid' | 'failed';
          action: InboxActionKind;
          eventId: string | null;
          message: string;
          /** Counts up, so the page can tell one answer from the next. */
          serial: number;
      };

export const IDLE: InboxActionState = { status: 'idle' };
