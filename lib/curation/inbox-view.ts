/**
 * What the curator's inbox page shows, as plain data a client component can
 * take: no Node imports, no paths outside the library, and nothing a public
 * route loads. lib/curation/inbox.ts builds it on the server, and the
 * page's forms read the event versions and the active revision from it, so
 * every action is checked against what the curator saw.
 */

import type { CurationEventStatus, CurationEventType, Placement } from './events';

/** The watcher's reasons for making nothing from a file, as lib/curation/events.ts's FAILURE_REASONS names them. */
export type FailureCode = 'unsupported-format' | 'digest-collision' | 'undecodable';

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

/**
 * #17: a settled missing item's title, so the list's settled group never reads "Source file missing" for a source
 * that's back or a photograph that's archived. Null for every other item, which keeps its type's title.
 */
export function settledMissingTitle(status: CurationEventStatus, cause: ResolvedCause | null): string | null {
    // Only #17's archive approves a missing item, and only a source present again resolves one. The watcher dismisses
    // one when the same bytes come back at its own path, which resolvedCauseOf() reads as `same-file`.
    if (status === 'approved') return 'Photograph archived';
    if (status === 'resolved') return cause?.kind === 'bound' ? 'Bound to a new file' : 'Source file back';
    if (status === 'dismissed' && cause?.kind === 'same-file') return 'Source file back';
    return null;
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

/**
 * What Decide later says after "Left for later." (or "Left <file> for later.") about the draft, by what it did. Only a
 * replacement (#17) gets the last two: `putBack` when leaveInDraft() put the earlier version back, `keepsNew` when the
 * draft already used the new version and still does.
 */
const DEFER_TAIL = {
    defer: 'Nothing in the draft changed.',
    putBack: 'The draft is back on the earlier version of this photograph, and the next publish uses that one.',
    keepsNew: 'The draft already uses the new version of this photograph, so the next publish uses it too.',
} as const;

/** What an approval, Decide later, and Reopen answer on the item they were taken on. Any later notes from the action follow. */
export const DONE_ANSWER = {
    approve: 'Approved into the draft. Nothing is published until you publish.',
    defer: `Left for later. ${DEFER_TAIL.defer}`,
    putBack: `Left for later. ${DEFER_TAIL.putBack}`,
    keepsNew: `Left for later. ${DEFER_TAIL.keepsNew}`,
    /** Reopen on a confirmed replacement whose Decide later would put the earlier version back. */
    reopenedPutBack: 'Reopened. The draft still uses the new version until you decide.',
} as const;

type ArrivalAnswer = 'approve' | keyof typeof DEFER_TAIL;

/** What each answer says on the page it opens, which names the file it decided. The same words as under the button. */
const ARRIVAL_HEAD: Record<ArrivalAnswer, (fileName: string) => string> = {
    approve: (fileName) => `Approved ${fileName} into the draft. Nothing is published until you publish.`,
    defer: (fileName) => `Left ${fileName} for later. ${DEFER_TAIL.defer}`,
    putBack: (fileName) => `Left ${fileName} for later. ${DEFER_TAIL.putBack}`,
    keepsNew: (fileName) => `Left ${fileName} for later. ${DEFER_TAIL.keepsNew}`,
};

/**
 * The answer an approval or Decide later carries to the page it opens. That
 * page shows another item, or none, so the answer names the file it decided
 * (design review, 2026-10-25). `message` is the action's own answer; any
 * notes after its first sentences, such as a missing description, follow.
 */
export function arrivalMessage(action: 'approve' | 'defer', fileName: string, message: string): string {
    const answer: ArrivalAnswer = action === 'approve' ? 'approve' : (['putBack', 'keepsNew'] as const).find((kind) => message.startsWith(DONE_ANSWER[kind])) ?? 'defer';
    const head = ARRIVAL_HEAD[answer](fileName);
    const notes = message.startsWith(DONE_ANSWER[answer]) ? message.slice(DONE_ANSWER[answer].length).trim() : '';
    return notes ? `${head} ${notes}` : head;
}

export const STATUS_LABELS: Record<CurationEventStatus, string> = {
    open: 'Draft only',
    // A file that produced nothing isn't a draft of anything.
    failed: 'Not processed',
    // What Decide later leaves it as. "Draft" names only where an approval goes.
    deferred: 'Left for later',
    dismissed: 'Dismissed',
    approved: 'Suggestion approved',
    // #17's: the watcher, a bind, or an archive closed it, since what it reported is over.
    resolved: 'Resolved',
};

/** The status of a confirmed replacement (#17), which was never a suggestion. */
export const CONFIRMED_LABEL = 'New version confirmed';

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
    /** What the file holds, in words. A date carries its `YYYY-MM-DD` as `dateTime`, for the page's `<time>`. */
    facts: { label: string; value: string; dateTime?: string }[];
    /** Why the watcher made nothing from the file, in words, and the reason's code. */
    failure: string | null;
    failureCode: FailureCode | null;
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
    /**
     * The hint under the actions while the type's primary action isn't in the inbox and Decide later is offered: why
     * it isn't, or for a replacement, what Decide later does with the draft now. For a new photograph a pending bind
     * merges, why it can't be approved yet. Null when none applies.
     */
    primaryUnavailable: string | null;
    /** For a replacement of a known photo and revision, what its draft holds and what Decide later does with it. Null otherwise. */
    replacement: ReplacementDraft | null;
    /**
     * #17: what closed a resolved item, or a missing item the watcher dismissed because the same bytes came back at
     * its path (`same-file`). Null for any other status, or when the page can't tell.
     */
    resolvedBy: ResolvedCause | null;
    /** #17: a bind decision waiting for the watcher's next pass that involves this item's photograph, or null. */
    bindWaiting: BindWaiting | null;
}

/**
 * #17: what the watcher's close on a resolved item says happened. `same-file` and `other-bytes` are a missing
 * source back, `bound` one back through a bind, `merged` a new photograph a bind gave to another, whose file is
 * `into` (library-relative, or null when the registry can't say), `archived` an archived photograph, and `built`,
 * `gone` and `moved` a failed build that built, whose photograph the registry dropped, or whose file moved on.
 */
export type ResolvedCause =
    | { kind: 'same-file' | 'other-bytes' | 'bound' | 'archived' | 'built' | 'gone' | 'moved' }
    | { kind: 'merged'; into: string | null };

/**
 * #17: a pending bind for the item's photograph. `merge`: it makes this new photograph's file the new version of the
 * photograph at `into` (library-relative, or null when the registry can't say). `bind`: it gives this missing
 * photograph the file at `path`.
 */
export type BindWaiting = { kind: 'merge'; into: string | null } | { kind: 'bind'; path: string };

/** The last sentence of every word on a pending merge, the hint and approve's refusal alike. */
export const BIND_WAITING_NEXT = "Refresh after the watcher runs: this item closes if the bind went through, and you can approve it if it didn't.";

/**
 * #17: the photograph a bind merges this file into, by the path it was at. A file replaced in place shares its path
 * with that photograph, so the sentence then says "this path" rather than naming the item's own file as the other one.
 */
function mergedIntoText(into: string | null, ownPath: string | null): string {
    if (into === null) return 'another photograph';
    return into === ownPath ? 'the photograph that was at this path' : `the photograph that was at ${into}`;
}

/** What the page says about a pending bind, before any click. `ownPath` is the item's own source path. */
export function bindWaitingText(waiting: BindWaiting, ownPath: string | null = null): string {
    if (waiting.kind === 'merge') {
        return `A bind waiting for the watcher's next pass makes this file the new version of ${mergedIntoText(waiting.into, ownPath)}. ${BIND_WAITING_NEXT}`;
    }
    return `A bind waiting for the watcher's next pass gives this photograph the file at ${waiting.path}. Refresh after the watcher runs: this item closes once the bind goes through.`;
}

/**
 * What a resolved item's system response says, by what closed it: never IDs, and never a bare "Resolved". `ownPath`
 * is the item's own source path.
 */
export function resolvedResponse(cause: ResolvedCause | null, type: CurationEventType, ownPath: string | null = null): string {
    switch (cause?.kind) {
        case 'same-file':
            return 'The same file came back, so nothing a visitor sees changed.';
        case 'other-bytes':
            return 'The file came back with other bytes, so its replacement item reviews the new version. Visitors keep the current one until you confirm it and publish.';
        case 'bound':
            return 'Bound to the new file, so its replacement item reviews the new version. Visitors keep the current one until you confirm it and publish.';
        case 'merged':
            return `A bind made this file the new version of ${mergedIntoText(cause.into, ownPath)}, so that photograph's replacement item reviews it.`;
        case 'archived':
            return type === 'processing-failure' ? 'The photograph is archived, so nothing needs retrying.' : 'The photograph is archived, so this file needs no judgment.';
        case 'built':
            return 'Its derivatives built on a later try, so nothing needs retrying.';
        case 'gone':
            return 'The registry no longer holds the photograph, so nothing needs retrying.';
        case 'moved':
            return "The file holds other bytes now, and the photograph's newer items cover them.";
        default:
            return 'The watcher closed it. History says what it found.';
    }
}

/**
 * #17: a replacement item's draft, from the same plan leaveInDraft() acts on
 * (lib/curation/pins.ts draftPlan()), so the page says before the click what
 * Decide later then does. Never an ID: the page names versions as new,
 * earlier, or another.
 */
export interface ReplacementDraft {
    /** Which version the photograph's draft (its photo record) uses: this item's new one, another, or none, with no record yet. */
    draft: 'new' | 'other' | 'none';
    /** The active revision serves this item's new version. */
    live: boolean;
    /**
     * What Decide later does now: puts the earlier version back (`put-back`), refuses since the draft moved to another
     * version after this item's confirm (`refuses`) or the earlier version has no ready set (`blocked`), or writes
     * nothing (`keeps`).
     */
    decideLater: 'put-back' | 'refuses' | 'blocked' | 'keeps';
}

/** The hint under a replacement's actions, by what Decide later does with its draft now. */
export const REPLACEMENT_HINT = {
    /** Never confirmed, or the draft already on another version: Decide later writes nothing. */
    keeps: "Confirming new bytes isn't in the inbox yet, so choose Decide later until it is. The published photograph keeps its current revision.",
    keepsNew: 'The draft already uses the new version, so Decide later keeps it there, and the next publish uses it. Nothing is published until you publish.',
    putBack: 'The draft uses the new version, confirmed earlier. Decide later puts the earlier version back in the draft. Nothing is published until you publish.',
    refuses: "This photograph's draft moved to another version after the new one was confirmed, so Decide later can't tell which one to put back. Set its version with photos edit, or dismiss this item.",
    /** As leaveInDraft()'s refusal says it after the click (lib/curation/inbox-form.ts REFUSAL_WORDING). */
    blocked: "The earlier version of this photograph has no ready derivatives, so Decide later can't put it back. The draft keeps the new version.",
} as const;

/** Why a replacement's Confirm is disabled, for that button alone; the hint beside it is about Decide later. */
export const CONFIRM_UNAVAILABLE = "Confirming new bytes isn't in the inbox yet.";

/** Decide later can't do anything for this draft, so the page shows it disabled with the hint as its reason. */
export function decideLaterRefuses(replacement: ReplacementDraft | null): boolean {
    return replacement?.decideLater === 'refuses' || replacement?.decideLater === 'blocked';
}

/** The replacement hint for a draft, as primaryUnavailable carries it. */
export function replacementHint(replacement: ReplacementDraft | null): string {
    if (replacement?.decideLater === 'put-back') return REPLACEMENT_HINT.putBack;
    if (replacement?.decideLater === 'refuses') return REPLACEMENT_HINT.refuses;
    if (replacement?.decideLater === 'blocked') return REPLACEMENT_HINT.blocked;
    return replacement?.draft === 'new' ? REPLACEMENT_HINT.keepsNew : REPLACEMENT_HINT.keeps;
}

/** What Decide later answers when the draft moved after the confirm (the `refuses` plan): what changed, and what to do. */
export const MOVED_ANSWER = "This photograph's draft moved to another version after the new one was confirmed, so Decide later can't tell which one to put back. Nothing was written. Set its version with photos edit, or dismiss this item.";

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
    // Once the list holds more than the items needing judgment (settled ones too), the summary names both counts.
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

/** A `YYYY-MM-DD` date as the Inbox says dates, `4 January 2024`, or null for anything else. */
export function humanDate(date: string): string | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
    return match && month ? `${Number(match[3])} ${month} ${match[1]}` : null;
}

/**
 * A stored timestamp the same way, in `timeZone` with its abbreviation:
 * `1 February 2026, 00:03 UTC` by default, as the server sends it, and the
 * browser's own zone once the page runs. Anything that isn't a timestamp, or
 * a zone the runtime doesn't know, shows as it is.
 */
export function humanTime(iso: string, timeZone = 'UTC'): string {
    const at = new Date(iso);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(iso) || Number.isNaN(at.getTime())) return iso;
    try {
        const format = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
        const part = Object.fromEntries(format.formatToParts(at).map((entry) => [entry.type, entry.value]));
        return `${humanDate(`${part.year}-${part.month}-${part.day}`)}, ${part.hour}:${part.minute} ${part.timeZoneName}`;
    } catch {
        return iso;
    }
}

/** The line under the file name: its folder and its capture date, which tell the owner which photograph this is. */
export function identityLine(sourcePath: string, capturedDate: string | null): string {
    const { folder } = fileParts(sourcePath);
    const day = capturedDate === null ? null : humanDate(capturedDate);
    const date = day ? `captured ${day}` : 'no capture date read';
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

type StateFacts = Pick<InboxDetail, 'type' | 'status' | 'group' | 'unplacedSeries' | 'placed' | 'lastApprovedSeries' | 'references'> & Partial<Pick<InboxDetail, 'replacement' | 'resolvedBy' | 'sourcePath'>>;

/** The status beside the item's identity, from its status and where it sits now, so an approval nothing holds never reads approved. */
export function statusLabel(item: Pick<InboxItem, 'status' | 'group'> & Partial<Pick<InboxItem, 'type'> & Pick<InboxDetail, 'references'>>): { text: string | null; tone: 'approved' | 'change' | null } {
    if (item.group === 'unplaced') return { text: 'Approved, no longer placed', tone: 'change' };
    // Only #17's archive approves a missing item.
    if (item.type === 'missing' && item.status === 'approved') return { text: 'Archived', tone: null };
    // "Draft only" is a new photograph's word. An open missing item's photograph is wherever it was, and the watcher kept all of it.
    if (item.type === 'missing' && item.status === 'open') {
        if (item.references === undefined || item.references === null) return { text: null, tone: null };
        if (item.references.some((ref) => ref.kind === 'revision')) return { text: 'Still live', tone: null };
        return { text: item.references.length > 0 ? 'Draft only' : 'Not shown anywhere', tone: null };
    }
    if (item.status === 'approved') return { text: item.type === 'replacement' ? CONFIRMED_LABEL : STATUS_LABELS.approved, tone: 'approved' };
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
    if (item.status === 'approved' && item.type === 'replacement') {
        // A confirm writes the draft only. Which version the draft and the live revision use is the item's own fact, not the photo ID's.
        const replacement = item.replacement ?? null;
        if (replacement?.draft === 'new') return replacement.live ? 'The draft uses the new version, and so does the live revision.' : 'The draft uses the new version. Visitors keep the current one until you publish.';
        if (replacement) return 'Confirmed earlier, but the draft uses another version of this photograph now. Nothing publishes until you publish.';
        return 'The new version was confirmed into the draft. Nothing publishes until you publish.';
    }
    if (item.type === 'missing' && item.status === 'approved') {
        // #17's archive: out of every series in the draft, and off the site once a publish leaves it out. A rollback, or
        // photos sequence insert, can put it back in a draft series. A publish then refuses any change (`<id> is
        // archived`), and with none, finds the draft already active, so nothing publishes either way.
        if (item.references === null) return "Archived. Can't tell what shows it now: a revision or working-layer file can't be read.";
        const live = item.references.some((ref) => ref.kind === 'revision');
        const listed = item.references.filter((ref) => ref.kind === 'series').map((ref) => labelOf(ref.id));
        if (listed.length > 0) {
            return `Archived, but the draft lists it in ${joined(listed)} again, so nothing publishes until it's taken out.${live ? ' The live site still shows it.' : ''}`;
        }
        if (live) return 'Archived and out of every series in the draft. The live site shows it until you publish.';
        return 'Archived, and nothing shows it any more.';
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
    // #17: the watcher, not the curator, dismisses a missing item whose same bytes came back at its own path.
    if (item.status === 'dismissed' && item.type === 'missing' && item.resolvedBy?.kind === 'same-file') return 'The same file came back at its path, so nothing a visitor sees changed.';
    if (item.status === 'dismissed') return 'Dismissed, so it needs no judgment. Nothing a visitor sees changed.';
    if (item.status === 'resolved') return resolvedResponse(item.resolvedBy ?? null, item.type, item.sourcePath ?? null);
    return SYSTEM_RESPONSE[item.type];
}

/**
 * Why the watcher made nothing from a file, and what the owner can do about
 * it, for the strip at the top of a processing failure, so neither waits in
 * Source facts. Null for every other item. `next` is null once the item is
 * settled. The formats are lib/identity/scan.ts's SOURCE_EXTENSIONS.
 */
export function failureNotice(detail: Pick<InboxDetail, 'type' | 'failure' | 'failureCode' | 'status' | 'can' | 'sourcePath'>): { reason: string; next: string | null } | null {
    if (detail.type !== 'processing-failure') return null;
    // A format it doesn't read is named by the file's own extension, which says more to the owner than "not a format".
    const extension = /\.([a-z0-9]{2,5})$/i.exec(fileParts(detail.sourcePath).name)?.[1];
    const reason =
        detail.failureCode === 'unsupported-format' && extension ? `This is a ${extension.toUpperCase()} file, which the watcher doesn't read.` : (detail.failure ?? "The watcher couldn't process the file.");
    if (detail.status !== 'failed' && detail.status !== 'open' && detail.status !== 'deferred') return { reason, next: null };
    const keep = detail.can.defer ? ' Decide later keeps it here meanwhile.' : '';
    switch (detail.failureCode) {
        case 'unsupported-format':
            return { reason, next: `The watcher reads JPEG, PNG and WebP. Export the photograph as one of those into the library, and it shows up here as a new photograph. Then dismiss this one with a reason.${keep}` };
        case 'digest-collision':
            // The failure doesn't record the other file, so the step can't name it.
            return { reason, next: `Find the other copy in the library and keep the one you mean, or dismiss this one with a reason.${keep}` };
        case 'undecodable':
            return {
                reason,
                // Two ways out, never both: Retry reads this revision again, and a good copy is a new revision the watcher picks up by itself.
                next: detail.can.retry
                    ? `If the file opens, choose Retry processing. If it doesn't, put a good copy in its place in the library, which the watcher picks up as a new revision, then dismiss this one with a reason.${keep}`
                    : `Check that the file opens, and put a good copy in its place in the library, or dismiss this one with a reason.${keep}`,
            };
        default:
            return { reason, next: detail.can.retry ? `Choose Retry processing to try it again, or dismiss it with a reason.${keep}` : `Dismiss it with a reason.${keep}` };
    }
}

/**
 * Whether the item's photograph has a published statement to keep: the
 * active revision holds it, or the holders can't be read, so it may. Only
 * then does the page say the statement remains unchanged; a new photograph
 * nothing holds, or a file with no photo ID, has none.
 */
export function hasPublishedStatement(detail: Pick<InboxDetail, 'photoId' | 'references'>): boolean {
    return detail.photoId !== null && (detail.references?.some((ref) => ref.kind === 'revision') ?? true);
}

/**
 * The hint under an approved item's Reopen: what reopening it is for. A replacement has no series or description to
 * change, and reopening an archived missing item undoes nothing.
 */
export function reopenHint(item: Pick<InboxDetail, 'type' | 'replacement'> & Partial<Pick<InboxDetail, 'references'>>): string {
    if (item.type === 'missing') {
        // #17's archive: the registry keeps the photograph archived, and the series removals stay. When the page can't
        // read what lists it, it claims nothing about series, as the status line says it can't tell.
        if (item.references === null) return "Reopening doesn't undo the archive. The photograph stays archived.";
        const listed = item.references?.some((ref) => ref.kind === 'series') ?? false;
        return listed ? "Reopening doesn't undo the archive. The photograph stays archived." : "Reopening doesn't undo the archive. The photograph stays archived and out of every series.";
    }
    if (item.type !== 'replacement') return 'Reopen it to change its series or description.';
    if (item.replacement?.decideLater === 'put-back') return 'Reopen it to leave the new version out of the draft. Decide later then puts the earlier version back.';
    // Reopening doesn't make the earlier set ready, so no put back is promised.
    if (item.replacement?.decideLater === 'blocked') return "Reopening it changes nothing in the draft, which keeps the new version. The earlier version has no ready derivatives, so Decide later can't put it back.";
    return item.replacement?.draft === 'new' ? 'Reopening it changes nothing in the draft, which keeps the new version.' : 'Reopening it changes nothing in the draft.';
}

const visibilityNote = (option: SeriesOption | undefined) => (option && option.visibility !== 'published' ? ` (${option.visibility})` : '');

/** What holds a photograph, by title: the live revision apart from the working layer's series, and a draft series marked as one. */
export function referencedByText(references: readonly HolderRef[] | null, series: readonly SeriesOption[]): string {
    if (references === null) return "Can't tell: a revision or working-layer file can't be read.";
    if (references.length === 0) return 'Nothing';
    const revision = references.find((ref) => ref.kind === 'revision');
    const names = references.filter((ref) => ref.kind === 'series').map((ref) => `${seriesName(series, ref.id)}${visibilityNote(series.find((option) => option.id === ref.id))}`);
    // The revision's ID is Active revision's, the row below, so it isn't repeated here.
    const live = revision ? 'The live revision' : null;
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

/**
 * The item to open after an approval or Decide later (owner, 2026-10-25):
 * the next one after `currentId` in `seen`, the list order the curator saw,
 * that still needs a decision in `open`, read after the action. It wraps at
 * the end, and skips any item someone else resolved meanwhile. An item that
 * arrived since the page loaded comes after those, in `open`'s order. Null
 * when nothing else needs a decision, so the page shows the empty state.
 */
export function nextItemId(seen: readonly string[], currentId: string, open: readonly string[]): string | null {
    const waiting = new Set(open);
    waiting.delete(currentId);
    if (waiting.size === 0) return null;
    const at = seen.indexOf(currentId);
    for (let step = 1; step <= seen.length; step += 1) {
        const id = seen[(at + step) % seen.length];
        if (waiting.has(id)) return id;
    }
    return open.find((id) => waiting.has(id)) ?? null;
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
