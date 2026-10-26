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

/**
 * The primary action for each type that has one. The mockup's own names,
 * except a new photograph's, which the owner renamed (2026-10-25), since it
 * commits an approval.
 */
export const PRIMARY_ACTION: Partial<Record<CurationEventType, string>> = {
    new: 'Approve into draft',
    replacement: 'Confirm new asset revision',
    missing: 'Resolve source or archive intentionally',
};

/** The button that defers an item (14-1's `defer`), as the owner named it (2026-10-25). */
export const DEFER_LABEL = 'Decide later';

export const STATUS_LABELS: Record<CurationEventStatus, string> = {
    open: 'Draft only',
    // A file that produced nothing isn't a draft of anything.
    failed: 'Not processed',
    // What Decide later leaves it as. "Draft" names only where an approval goes.
    deferred: 'Left for later',
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
    /** The photo ID's head and tail, as the mockup shows it (`ph_7f3a…91c2`). */
    shortId: string;
    /** Library-relative, with anything unprintable escaped. What tells one row from the next. */
    sourcePath: string;
    /** A curator-only URL for the row's thumbnail, the ready set's w400 WebP, or null when no set is ready. */
    thumbnailUrl: string | null;
    waiting: string | null;
    /** What holds its photo, for an item settled by placement, or null. */
    placedBy: string | null;
    /** The series its last approval named, for an approval whose photo nothing holds now, or null. */
    unplacedSeries: string | null;
}

/** One thing that holds a photograph: the active revision, or a working-layer series, by ID. */
export interface HolderRef {
    kind: 'revision' | 'series';
    id: string;
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
    /** The capture date the file holds, or null when it holds none or nothing was read. */
    capturedDate: string | null;
    fromPath: string | null;
    identity: string;
    derivatives: string;
    /** A curator-only URL for the candidate's w800 WebP, or null when no set is ready. */
    previewUrl: string | null;
    facts: { label: string; value: string }[];
    failure: string | null;
    candidates: string[];
    /** Who still shows it: the active revision, or a working-layer series. Null when it can't be told. */
    references: HolderRef[] | null;
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

/** "N items require judgment" (or "N of M items", once other items are listed too), then what waits, what's already placed, and what's no longer placed, counted as `curation list` counts them. */
export function summaryText(view: { needsJudgment: number; waiting: number; placed?: number; unplaced?: number; items?: readonly unknown[] }): string {
    // "All items (N)" counts every item, settled ones too, so once that differs from the count needing judgment, the summary names both.
    const n = view.needsJudgment;
    const total = view.items?.length ?? n;
    const judgment = total === n ? `${n} ${n === 1 ? 'item requires' : 'items require'} judgment` : `${n} of ${total} ${total === 1 ? 'item requires' : n === 1 ? 'items requires' : 'items require'} judgment`;
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

/** Where the page's form takes its starting series from, so the caption under it can say so. */
export type FormStartSource = 'edit' | 'placed' | 'approved' | 'suggestion' | 'none';

/**
 * The series the page's form starts on, and where it comes from:
 * defaultSeries(), except that a reopened item whose photo no series holds
 * now starts on the series its last approval named, while that series is
 * still one of `seriesIds`. That's the series "No longer placed" says to
 * approve it into. The form sends the series it shows, so the approval goes
 * there only if the curator leaves it chosen; the CLI's bare approve still
 * leaves it unassigned, and says to pass --series.
 */
export function formStart(
    detail: Parameters<typeof defaultSeries>[0] & Pick<InboxDetail, 'lastApprovedSeries'>,
    seriesIds: readonly string[],
): { series: string | null | undefined; from: FormStartSource } {
    if (detail.edits?.seriesId !== undefined) return { series: detail.edits.seriesId, from: 'edit' };
    const approvedBefore = detail.decisions?.some((decision) => decision.action === 'approve') ?? false;
    if (approvedBefore && detail.placed) {
        const now = detail.placed.seriesIds[0] ?? null;
        const last = detail.lastApprovedSeries;
        if (now === null && last !== null && seriesIds.includes(last)) return { series: last, from: 'approved' };
        return { series: now, from: 'placed' };
    }
    if (detail.suggestions.series) return { series: detail.suggestions.series.value, from: 'suggestion' };
    return { series: undefined, from: 'none' };
}

/** The series the page's form starts on (formStart() without its source). */
export function formSeries(detail: Parameters<typeof formStart>[0], seriesIds: readonly string[]): string | null | undefined {
    return formStart(detail, seriesIds).series;
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

/** `ph_7f3a…91c2`: an ID's prefix, then the first and last four characters, as the mockup shows IDs and revisions. */
export function headTail(id: string): string {
    const prefix = /^[a-z0-9]+?[_-]/i.exec(id)?.[0] ?? '';
    const rest = id.slice(prefix.length);
    return rest.length <= 10 ? id : `${prefix}${rest.slice(0, 4)}…${rest.slice(-4)}`;
}

/** A photo ID as the list and the detail show it. */
export function shortIdOf(photoId: string | null): string {
    return photoId === null ? 'no photo ID' : headTail(photoId);
}

/** A library path's file name, and its folder when it has one. */
export function fileParts(sourcePath: string): { name: string; folder: string | null } {
    const slash = sourcePath.lastIndexOf('/');
    return slash < 0 ? { name: sourcePath, folder: null } : { name: sourcePath.slice(slash + 1), folder: sourcePath.slice(0, slash) };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The line under the file name: its folder and its capture date, which tell the owner which photograph this is. */
export function identityLine(sourcePath: string, capturedDate: string | null): string {
    const { folder } = fileParts(sourcePath);
    const match = capturedDate === null ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(capturedDate);
    const date = match ? `captured ${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}` : 'no capture date read';
    return `${folder === null ? 'At the top of the library' : `In ${folder}`}, ${date}`;
}

/** A series by its authored title, or its ID when the working layer doesn't hold it now. */
export function seriesName(series: readonly SeriesOption[], seriesId: string): string {
    return series.find((option) => option.id === seriesId)?.label ?? seriesId;
}

const NO_RULES = 'No series rule is set up (curation/rules.json), so nothing is suggested.';

/** A suggestion the rules file couldn't make (none, or not valid), which is a fact about the setup and not a suggestion. */
function rulesProblem(suggested: InboxSuggestion | null): string | null {
    if (suggested === null || suggested.value !== null) return null;
    if (suggested.producedBy === 'rules@none') return NO_RULES;
    if (suggested.producedBy === 'rules@invalid') return suggested.evidence[0] ?? 'curation/rules.json is not valid, so no series is suggested.';
    return null;
}

/** The suggestion's evidence lines, except where rulesProblem() already says the one thing they hold. */
export function suggestionEvidence(suggested: InboxSuggestion | null): string[] {
    return suggested === null || rulesProblem(suggested) !== null ? [] : suggested.evidence;
}

/**
 * The caption under the series select: where the form starts, in words, and
 * what the rules suggested when the start isn't the suggestion. So a reopened
 * form on a chosen series never reads as if it held the suggestion.
 */
export function seriesCaption(
    detail: Pick<InboxDetail, 'suggestions'>,
    start: { series: string | null | undefined; from: FormStartSource },
    labelOf: (seriesId: string) => string,
): string {
    const suggested = detail.suggestions.series;
    const problem = rulesProblem(suggested);
    const named = (value: string | null) => (value === null ? 'leaving it unassigned' : labelOf(value));
    const rules = problem ?? (suggested ? `The rules suggested ${named(suggested.value)}.` : null);
    const withRules = (lead: string) => (rules ? `${lead} ${rules}` : lead);
    switch (start.from) {
        case 'suggestion':
            return problem ?? `Suggested ${named(suggested?.value ?? null)}, ${suggested?.confidence} confidence, by ${suggested?.producedBy}.`;
        case 'edit':
            return withRules(start.series ? `Starts on your saved choice, ${labelOf(start.series)}.` : 'Starts unassigned, as you saved it.');
        case 'placed':
            return withRules(start.series ? `Starts on ${labelOf(start.series)}, where it is now.` : 'Starts unassigned, as it is now.');
        case 'approved':
            return withRules(`Starts on ${labelOf(start.series as string)}, where it was approved.`);
        case 'none':
            return 'No series is suggested. Choose one, or leave it unassigned.';
    }
}

/** The hint under the description field: what the field starts with, and how to withdraw it. */
export function descriptionHint(detail: Pick<InboxDetail, 'edits' | 'placed'>): string {
    const fromEdit = detail.edits?.description !== undefined;
    const saved = defaultDescription(detail);
    if (saved?.kind === 'described') return fromEdit ? 'Your saved description. Clear it to withdraw it.' : 'The description it was approved with, stored as reviewed. Clear it to withdraw it.';
    if (saved?.kind === 'decorative') return fromEdit ? 'Saved as decorative. Uncheck Decorative to withdraw it.' : 'Marked decorative when it was approved. Uncheck Decorative to withdraw it.';
    return 'Nothing is suggested. What you type here is stored as reviewed, and publishing waits until the photograph has a description or is marked decorative.';
}

type StateFacts = Pick<InboxDetail, 'type' | 'status' | 'group' | 'unplacedSeries' | 'placed' | 'lastApprovedSeries' | 'references'>;

/** The status beside the item's identity, from its status and where it sits now, so an approval nothing holds never reads approved. */
export function statusLabel(item: Pick<InboxItem, 'status' | 'group'>): { text: string; tone: 'approved' | 'change' | null } {
    if (item.group === 'unplaced') return { text: 'Approved, no longer placed', tone: 'change' };
    if (item.status === 'approved') return { text: STATUS_LABELS.approved, tone: 'approved' };
    return { text: STATUS_LABELS[item.status], tone: null };
}

/** "and"-joined, for a short list of names. */
function joined(names: string[]): string {
    return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** What the system did with the item, from its status as well as its type. Never a claim about what a visitor sees changing. */
export function systemResponse(item: StateFacts, labelOf: (seriesId: string) => string): string {
    if (item.group === 'unplaced' && item.unplacedSeries) {
        return `It was approved into ${labelOf(item.unplacedSeries)}, but nothing holds its photo now, so it sits in the draft unassigned. Nothing publishes.`;
    }
    if (item.status === 'approved') {
        // Live only when the active revision is known to hold it; when the holders can't be read, it claims nothing about live.
        const live = item.references?.some((ref) => ref.kind === 'revision') ?? false;
        const held = item.placed?.seriesIds ?? [];
        if (live) {
            const draft = item.placed === null ? '' : held.length > 0 ? `, and in ${joined(held.map(labelOf))} in the draft` : ', and unassigned in the draft';
            return `Live in the active revision${draft}. Draft changes publish only when you publish.`;
        }
        if (item.placed === null) return 'Approved into the draft. Nothing publishes until you publish.';
        return held.length > 0 ? `In the draft, in ${joined(held.map(labelOf))}. Nothing publishes until you publish.` : 'In the draft, unassigned. Nothing publishes until you publish.';
    }
    if (item.status === 'dismissed') return 'Dismissed, so it needs no judgment. Nothing a visitor sees changed.';
    return SYSTEM_RESPONSE[item.type];
}

const visibilityNote = (option: SeriesOption | undefined) => (option && option.visibility !== 'published' ? ` (${option.visibility})` : '');

/** What holds a photograph, by title: the live revision apart from the working layer's series, and a draft series marked as one. */
export function referencedByText(references: readonly HolderRef[] | null, series: readonly SeriesOption[]): string {
    if (references === null) return "Can't tell: a revision or working-layer file can't be read.";
    if (references.length === 0) return 'Nothing';
    const revision = references.find((ref) => ref.kind === 'revision');
    const names = references.filter((ref) => ref.kind === 'series').map((ref) => `${seriesName(series, ref.id)}${visibilityNote(series.find((option) => option.id === ref.id))}`);
    const live = revision ? `The live revision (${headTail(revision.id)})` : null;
    if (names.length === 0) return live as string;
    return live ? `${live}; series ${joined(names)}` : `Series ${joined(names)}, not published`;
}

/** A replacement's series, by title and position, as the mockup words it ("At the Waterline, position 05"). */
export function seriesMembershipText(photoId: string | null, references: readonly HolderRef[] | null, series: readonly SeriesOption[]): string {
    if (references === null) return "Can't tell: a revision or working-layer file can't be read.";
    const rows = references
        .filter((ref) => ref.kind === 'series')
        .map((ref) => {
            const option = series.find((entry) => entry.id === ref.id);
            const index = option?.members.findIndex((member) => member.photoId === photoId) ?? -1;
            return index < 0 ? seriesName(series, ref.id) : `${option?.label}, position ${String(index + 1).padStart(2, '0')}`;
        });
    return rows.length === 0 ? 'In no series' : rows.join('; ');
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
          /** The form field the answer is about, when it's about one, so the page shows it there. */
          field?: 'description' | 'reason';
          /** Counts up, so the page can tell one answer from the next. */
          serial: number;
      };

export const IDLE: InboxActionState = { status: 'idle' };
