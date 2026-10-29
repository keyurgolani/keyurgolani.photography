import type { HistoryView } from './publish-history';

/**
 * #16's Publish screen (16-3): the view the page renders and the facts that
 * follow its state. Client-safe: types and pure functions only, no Node
 * imports, so the screen's client component shares them with the server.
 * lib/curation/publish-view.ts builds the ledger and the blocker list (the
 * join), app/curation/publish/load.ts reads the data root, and the screen
 * renders what displayFacts() says for the page and its latest answer.
 */

export type ReviewLabel = 'reviewed' | 'not-reviewed' | 'stale' | 'generated' | 'automatic' | 'confirmed' | 'published' | 'conflict';

export type KindLabel = 'New' | 'Removed' | 'Changed' | 'Moved' | 'Hidden' | 'Route' | 'New image' | 'Recalculated' | 'Source health';

export interface Picture {
    src: string;
    alt: string;
}

/** An order compare: both full orders and the move. The screen shows a window around both ends (orderRuns()). */
export interface OrderCompare {
    type: 'list';
    before: string[];
    after: string[];
    /** The moved entry, by name, and its 1-based positions. `from` is 0 for an entry the draft adds. */
    moved: string;
    from: number;
    to: number;
}

export type Compare =
    | { type: 'text'; before: string | null; after: string | null }
    | { type: 'images'; before: Picture | null; after: Picture | null }
    | OrderCompare
    /** A new photograph's description, on its own: there is no published one to set it beside. */
    | { type: 'description'; label: 'Description' | 'Generated description'; text: string };

/** The record a stamp-only review writes, and exactly what the screen showed of it. */
export interface ReviewTarget {
    kind: 'site' | 'series' | 'photo';
    id: string;
    /** The record version the page read. */
    version: number;
    /** Each field the review stamps, with the hashValue() of the value shown. */
    hashes: Record<string, string>;
}

export type Fix =
    | {
          type: 'description';
          /** The photograph's name, for the action's accessible name. */
          record: string;
          /** The full photo ID, so the command can be copied and run. */
          photoId: string;
          /** The photograph's Inbox item, for itemUrl(); null leaves the Inbox clause out. */
          inboxItem: string | null;
          picture: Picture | null;
          text: string;
          suggested: string;
          version: number;
          valueHash: string;
      }
    | { type: 'restamp'; record: string; label: string; target: ReviewTarget; field: string }
    | { type: 'inbox'; record: string; eventId: string }
    /** `command`: the photos command with the record's full ID, which a rebase conflict's fix carries (15-4). */
    | { type: 'hint'; text: string; command?: string };

export interface LedgerRow {
    id: string;
    kind: KindLabel;
    review: ReviewLabel;
    summary: string;
    detail?: string;
    blocks: boolean;
    compare?: Compare;
    fix?: Fix;
}

export interface Ledger {
    authored: LedgerRow[];
    derived: LedgerRow[];
    health: LedgerRow[];
}

export type BlockerLink = { type: 'description'; name: string } | { type: 'restamp'; name: string } | { type: 'inbox'; record: string; eventId: string } | { type: 'row'; record: string } | { type: 'none' };

export interface Blocker {
    key: string;
    /** The row the blocker marks, or null for a rule not tied to one change. */
    rowId: string | null;
    record: string;
    field: string;
    message: string;
    link: BlockerLink;
}

/** A revision as the page names it. */
export interface RevisionFacts {
    revisionId: string;
    number: number;
    /** The 8 hex after `rev_`. */
    hash: string;
}

export interface PanelView {
    /** The most affected series' name and photo counts, or null when the candidate changes none. */
    count: string;
    copyLine: string;
    /** The frame's address for a pending draft: the preview's page of the most affected series. */
    draftSrc: string | null;
    /** The same page on the live site. */
    liveSrc: string;
    /** The first changed photograph's entry on that page, which the frame scrolls its own window to. */
    scrollToId?: string;
}

/** Everything a page load knows: Unvalidated, or one of the Nothing states. */
export interface ScreenView {
    draftId: string;
    draftNumber: number;
    draftHash: string;
    active: RevisionFacts;
    /** The activation before the active one, what `photos rollback` returns to now. */
    previous: RevisionFacts | null;
    /** 'ledger' with changes, or one of the Nothing states. */
    kind: 'ledger' | 'nothing' | 'no-visible-change';
    ledger: Ledger;
    /** The blockers the review context shows on load, before any Validate. */
    blockers: Blocker[];
    panel: PanelView;
}

export type Answer =
    | { kind: 'blocked'; lead: string; blockers: Blocker[]; ledger: Ledger }
    | { kind: 'blocked-at-publish'; lead: string; blockers: Blocker[]; ledger: Ledger }
    | { kind: 'valid'; stakes: string }
    /** 15-4: `history` is History read again, on every answer that moved the pointer or found it moved. */
    | { kind: 'published'; live: RevisionFacts; previous: RevisionFacts | null; history?: HistoryView }
    | { kind: 'already-live'; live: RevisionFacts; previous: RevisionFacts | null; by: Publisher | null; history?: HistoryView }
    | { kind: 'changed'; body: string }
    | { kind: 'someone-published'; live: RevisionFacts; previous: RevisionFacts | null; by: Publisher | null; history?: HistoryView }
    /** `lock`: the catalog lock (a publish or rollback) or the authored lock (any working-catalog write). `since`: when its holder took it. */
    | { kind: 'busy'; lock: 'catalog' | 'authored'; since: string | null; retry: 'validate' | 'publish' }
    | { kind: 'failed'; heading: string; body: string; live: RevisionFacts | null; previous: RevisionFacts | null; retry: 'validate' | 'publish'; history?: HistoryView }
    | { kind: 'not-validated' }
    | { kind: 'fixed'; rowId: string }
    | { kind: 'fix-refused'; rowId: string; text: string };

/** Who made the active revision live, read from its activation: a publish or a rollback, by an actor, at a time. */
export interface Publisher {
    actor: string;
    kind: 'publish' | 'rollback';
    at: string;
}

export type Intent = 'validate' | 'publish' | 'mark-description' | 'mark-reviewed';

/**
 * What the screen's one action returns. `serial` grows with every answer, so
 * the screen moves focus once per answer. `answer` is the latest one;
 * `result` is what the result slot shows, the latest answer to Validate or
 * Publish. A fix clears it, and a refused fix leaves it as it was.
 */
export interface PublishState {
    serial: number;
    intent: Intent | null;
    answer: Answer | null;
    result: Answer | null;
}

export const IDLE_STATE: PublishState = { serial: 0, intent: null, answer: null, result: null };

export type ActionState = 'available' | 'unavailable' | 'hidden';

/** The screen's fixed facts for the page and its latest answer (spec, Facts by state). */
export interface DisplayFacts {
    mode: 'draft' | 'out-of-date' | 'live' | 'nothing';
    heading: string;
    lead?: string;
    countLine?: string;
    /** Failed with the pointer moved: the count line says so in the alert tone. */
    countAlert?: boolean;
    revision: { current: string; hashes: string };
    ledgerHeading: string;
    outOfDate?: string;
    groups: { authored: string; derived: string };
    compareLabels: { before: string; after: string };
    /** Live: every row reads "Published". */
    publishedLabels: boolean;
    showFixes: boolean;
    panel: {
        title: string;
        link: { label: string; href: string } | null;
        marker: string;
        frameTitle: string;
        frameSrc: string | null;
        frameNote?: string;
        scrollToId?: string;
        count?: string;
        copyLine?: string;
        rollback: string | null;
    };
    bar: { validate: ActionState; publish: ActionState; reason?: string; loadUpdated: boolean } | null;
    /** The ledger and blockers to show: the latest answer's when it carries a fresh join, else the page's. */
    ledger: Ledger;
    blockers: Blocker[];
    /** True while Publish may go: a validation of this candidate passed on this page and still holds. */
    validated: boolean;
}

/** Spec: the approved line while a draft is pending. */
export const DRAFT_LEAD = 'Authored changes require approval. Derived facts refresh from the validated catalog.';
export const OUT_OF_DATE_COUNT = 'Out of date. Load the updated ledger to see what publishes now.';
export const FAILED_MOVED_COUNT = "The publish didn't finish. Publish again to finish it.";

const changes = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'}`;

/** "9 changes for visitors: 5 authored, 4 derived. 2 block publishing." Health rows never count. */
export function countLine(ledger: Ledger, blockers: number, live = false): string {
    const authored = ledger.authored.length;
    const derived = ledger.derived.length;
    const total = authored + derived;
    const head = live ? `${changes(total)} went live: ${authored} authored, ${derived} derived.` : `${changes(total)} for visitors: ${authored} authored, ${derived} derived.`;
    if (live || blockers === 0) return head;
    return `${head} ${blockers} ${blockers === 1 ? 'blocks' : 'block'} publishing.`;
}

/** The rows that block, counted once each. */
export function blockingRows(ledger: Ledger): number {
    return [...ledger.authored, ...ledger.derived].filter((row) => row.blocks).length;
}

/** The Publish screen's and the Inbox's actor (lib/curation/inbox-form.ts's WEB_ACTOR), repeated here so this module stays client-safe. */
const WEB_ACTOR = 'curator:web';

/**
 * Where a thing was done from, in the owner's words: "from this screen" for
 * the web actor, "from the command line" otherwise. The owner is the only
 * one who publishes, so the screen never names the CLI's actor (v1.2.1).
 */
export function actorPhrase(actor: string): string {
    return actor === WEB_ACTOR ? 'from this screen' : 'from the command line';
}

/**
 * Who made the active revision live, as one sentence: a rollback says so,
 * and a publish from this screen in another tab or window says that.
 * `elsewhere`: the answer is about a revision this page didn't publish.
 */
export function publisherLine(by: Publisher | null, timeZone: string, elsewhere: boolean): string {
    if (by === null) return elsewhere ? 'It went live from the command line.' : 'It is live now.';
    const at = timeOf(by.at, timeZone);
    // 15-4: the screen's word for a rollback is Restore (spec, Decided 3); the command keeps its name.
    // The owner is the only one who publishes or restores, so every line is his, in the second person (v1.2.1).
    const where = actorPhrase(by.actor);
    if (by.kind === 'rollback') return `You restored it ${where} at ${at}.`;
    return by.actor === WEB_ACTOR && elsewhere ? `You published it ${where} at ${at}, in another tab or window.` : `You published it ${where} at ${at}.`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "25 October", from an ISO time, in UTC so the server and the browser agree. */
export function dayOf(iso: string): string {
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? iso : `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
}

/**
 * "14:05", from an ISO time, in `timeZone`. The screen passes the browser's
 * zone, which is the owner's, as the Inbox's LocalTime does; the server's
 * default is UTC, and an answer is only ever rendered in the browser.
 */
export function timeOf(iso: string, timeZone = 'UTC'): string {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return iso;
    try {
        const part = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((entry) => [entry.type, entry.value]));
        return `${part.hour}:${part.minute}`;
    } catch {
        return `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
    }
}

/** The positions an order compare shows: one either side of both ends of the move, runs that touch merged. */
export function orderRuns({ before, after, from, to }: Pick<OrderCompare, 'before' | 'after' | 'from' | 'to'>): number[][] {
    const length = Math.max(before.length, after.length);
    const keep = new Set<number>();
    for (const end of [from, to]) {
        for (let position = end - 1; position <= end + 1; position++) {
            if (position >= 1 && position <= length) keep.add(position);
        }
    }
    const runs: number[][] = [];
    for (const position of [...keep].sort((a, b) => a - b)) {
        const run = runs.at(-1);
        if (run && run.at(-1) === position - 1) run.push(position);
        else runs.push([position]);
    }
    return runs;
}

/**
 * The rollback line: while a draft is pending, the active revision (approved
 * line); otherwise the activation before the active one, restored from
 * History below (15-4). `ready` is AC 14's seam: the deferred lastKnownGood()
 * gate sets it false when photos:verify fails for the active revision, and
 * nothing sets it yet, so the line always shows.
 */
function rollbackLine(pending: boolean, active: RevisionFacts, previous: RevisionFacts | null, ready = true): string | null {
    if (pending) return ready ? `Last-known-good revision ${active.number} remains rollback-ready.` : null;
    return previous ? `Revision ${previous.number} is kept. Restore it from History, below.` : null;
}

const PREVIEW_PANEL_TITLE = 'Visitor preview';

/**
 * The page's facts after `answer` (null for a fresh load). Every number comes
 * from the page or the answer, and an answer that moved the pointer carries
 * the new one, so the page never shows a number it no longer believes.
 */
export function displayFacts(view: ScreenView, answer: Answer | null, previewHref: string | null): DisplayFacts {
    const n = view.draftNumber;
    const fresh = answer && (answer.kind === 'blocked' || answer.kind === 'blocked-at-publish') ? answer : null;
    // A passing Validate is the gate's word: no row blocks then, whatever the page predicted on load.
    const cleared = (ledger: Ledger): Ledger => ({ authored: ledger.authored.map((row) => ({ ...row, blocks: false })), derived: ledger.derived.map((row) => ({ ...row, blocks: false })), health: ledger.health });
    const ledger = fresh?.ledger ?? (answer?.kind === 'valid' ? cleared(view.ledger) : view.ledger);
    const blockers = fresh?.blockers ?? (answer?.kind === 'valid' ? [] : view.blockers);
    const draftGroups = { authored: 'Authored · requires judgment', derived: 'Derived · recalculated automatically' };
    const liveGroups = { authored: 'Authored', derived: 'Derived' };
    const draftLabels = { before: 'Published', after: 'This draft' };
    const liveLabels = { before: 'Before', after: 'Now live' };
    const hashes = (live: RevisionFacts, draft: boolean) => (draft ? `Draft ${view.draftHash} · Live ${live.hash}` : `Live ${live.hash}`);

    if (view.kind !== 'ledger') {
        return {
            mode: 'nothing',
            heading: 'Nothing to publish',
            lead: view.kind === 'nothing'
                ? `The working catalog matches revision ${view.active.number}, which is live. New photographs reach this screen once you approve them in the Inbox.`
                : 'No visitor-visible changes. Edits to hidden or draft series stay saved and publish when the series becomes visible.',
            revision: { current: `Current public revision ${view.active.number}`, hashes: hashes(view.active, false) },
            ledgerHeading: '',
            groups: liveGroups,
            compareLabels: liveLabels,
            publishedLabels: true,
            showFixes: false,
            panel: {
                title: 'Live site',
                link: { label: 'Open the site', href: '/' },
                marker: `Live, revision ${view.active.number}`,
                frameTitle: `The live site, revision ${view.active.number}`,
                frameSrc: view.panel.liveSrc,
                count: view.panel.count,
                copyLine: 'What visitors see now.',
                rollback: rollbackLine(false, view.active, view.previous),
            },
            bar: null,
            ledger,
            blockers: [],
            validated: false,
        };
    }

    // `alert`: a publish that failed after the switch. Its Publish is the way to finish, so it holds the validation it ran on.
    const live = (current: RevisionFacts, previous: RevisionFacts | null, ledgerHeading: string, bar: DisplayFacts['bar'], alert = false): DisplayFacts => ({
        mode: 'live',
        heading: `Revision ${current.number} is live`,
        countLine: alert ? FAILED_MOVED_COUNT : countLine(ledger, 0, true),
        ...(alert ? { countAlert: true } : {}),
        revision: { current: `Current public revision ${current.number}`, hashes: hashes(current, false) },
        ledgerHeading,
        groups: liveGroups,
        compareLabels: liveLabels,
        publishedLabels: true,
        showFixes: false,
        panel: {
            title: 'Live site',
            link: null,
            marker: `Live, revision ${current.number}`,
            frameTitle: `The live site, revision ${current.number}`,
            frameSrc: view.panel.liveSrc,
            ...(view.panel.scrollToId ? { scrollToId: view.panel.scrollToId } : {}),
            count: view.panel.count.replace(/, was \d+$/, ''),
            copyLine: 'What visitors see now.',
            rollback: rollbackLine(false, current, previous),
        },
        bar,
        ledger,
        blockers: [],
        validated: alert,
    });

    if (answer?.kind === 'published') return live(answer.live, answer.previous, `Published in revision ${answer.live.number}`, null);
    if (answer?.kind === 'already-live') return live(answer.live, answer.previous, `Live in revision ${answer.live.number}`, null);
    if (answer?.kind === 'failed' && answer.live !== null) {
        return live(answer.live, answer.previous, `Live in revision ${answer.live.number}`, {
            validate: 'hidden',
            publish: 'available',
            reason: `Visitors already see revision ${answer.live.number}. Publishing again finishes the switch.`,
            loadUpdated: false,
        }, true);
    }

    if (answer?.kind === 'changed' || answer?.kind === 'someone-published') {
        const pointer = answer.kind === 'someone-published' ? answer.live : view.active;
        const previous = answer.kind === 'someone-published' ? answer.previous : null;
        return {
            mode: 'out-of-date',
            heading: 'Preview your draft',
            countLine: OUT_OF_DATE_COUNT,
            revision: { current: `Current public revision ${pointer.number}`, hashes: hashes(pointer, false) },
            ledgerHeading: 'Change ledger, out of date',
            outOfDate: `This compares the draft this page loaded against revision ${view.active.number}.`,
            groups: draftGroups,
            compareLabels: draftLabels,
            publishedLabels: false,
            showFixes: false,
            panel: {
                title: PREVIEW_PANEL_TITLE,
                link: null,
                marker: 'Preview · not public',
                frameTitle: 'Visitor preview of the draft catalog',
                frameSrc: null,
                frameNote: 'Load the updated ledger to preview the new draft.',
                rollback: answer.kind === 'someone-published' ? rollbackLine(false, pointer, previous) : rollbackLine(true, view.active, null),
            },
            bar: { validate: 'hidden', publish: 'hidden', loadUpdated: true },
            ledger,
            blockers: [],
            validated: false,
        };
    }

    // A draft is pending: Unvalidated to Failed with the pointer unmoved.
    // A busy or failed Publish leaves the validation it ran on standing, so Publish itself is the retry. A busy or failed Validate doesn't.
    const validated = answer?.kind === 'valid' || (answer?.kind === 'busy' && answer.retry === 'publish') || (answer?.kind === 'failed' && answer.live === null && answer.retry === 'publish');
    const blocking = fresh ? blockers.length : blockingRows(ledger);
    let reason: string | undefined;
    if (fresh) reason = blockers.length === 1 ? 'Fix the change above, then validate again.' : 'Fix the changes above, then validate again.';
    else if (answer?.kind === 'not-validated') reason = 'Validate revision first. Publish unlocks once it passes.';
    else if (!validated) reason = blocking > 0 ? `${blocking === 1 ? '1 change blocks' : `${blocking} changes block`} publishing. ${blocking === 1 ? 'Fix it' : 'Fix them'}, then validate.` : 'Publish unlocks after Validate revision passes.';
    return {
        mode: 'draft',
        heading: `Preview catalog revision ${n}`,
        lead: DRAFT_LEAD,
        countLine: countLine(ledger, blocking),
        revision: { current: `Current public revision ${view.active.number}`, hashes: hashes(view.active, true) },
        ledgerHeading: 'Change ledger',
        groups: draftGroups,
        compareLabels: draftLabels,
        publishedLabels: false,
        showFixes: true,
        panel: {
            title: PREVIEW_PANEL_TITLE,
            link: previewHref ? { label: 'Open full preview', href: previewHref } : null,
            marker: 'Preview · not public',
            frameTitle: 'Visitor preview of the draft catalog',
            // No "can't be previewed" state: the page and the frame compile the same candidate, so the page can't render while the frame fails to.
            frameSrc: view.panel.draftSrc,
            ...(view.panel.scrollToId ? { scrollToId: view.panel.scrollToId } : {}),
            count: view.panel.count,
            copyLine: view.panel.copyLine,
            rollback: rollbackLine(true, view.active, null),
        },
        bar: { validate: 'available', publish: validated ? 'available' : 'unavailable', ...(reason ? { reason } : {}), loadUpdated: false },
        ledger,
        blockers,
        validated,
    };
}

/** The result's heading and text for an answer (the approved lines where the spec keeps them). */
export function resultCopy(answer: Answer, view: ScreenView, timeZone = 'UTC'): { tone: 'done' | 'change' | 'alert'; heading: string; body: string[] } | null {
    const n = view.draftNumber;
    switch (answer.kind) {
        case 'blocked':
            return { tone: 'alert', heading: 'Publication blocked', body: [answer.lead] };
        case 'blocked-at-publish':
            return { tone: 'alert', heading: 'Nothing was published', body: [answer.lead] };
        case 'valid':
            return { tone: 'done', heading: 'Catalog revision is valid', body: ['All references resolve. The previous public revision remains live.', answer.stakes] };
        case 'published':
            // The owner's words (v1.2.1), in place of the mockup's "published atomically" and its ETag line.
            return { tone: 'done', heading: `Revision ${answer.live.number} is live`, body: ['Visitors get it on their next page load.'] };
        case 'already-live':
            return { tone: 'done', heading: `Revision ${answer.live.number} is already live`, body: [`${publisherLine(answer.by, timeZone, false)} Nothing more to publish, and nothing new was written.`] };
        case 'changed':
            return { tone: 'change', heading: 'The working catalog changed', body: [answer.body] };
        case 'someone-published':
            return { tone: 'change', heading: someoneHeading(answer.live, answer.by), body: [`${publisherLine(answer.by, timeZone, true)} Nothing was published from here.`] };
        case 'busy': {
            const since = answer.since ? `It started at ${timeOf(answer.since, timeZone)}. ` : '';
            const again = answer.retry === 'validate' ? 'Validate again when it finishes.' : 'Publish again when it finishes.';
            const heading = answer.lock === 'catalog' ? 'Another publish or restore is running' : 'Another change to the working catalog is being saved';
            return { tone: 'change', heading, body: [`${since}Nothing changed here. ${again}`] };
        }
        case 'failed':
            return { tone: 'alert', heading: answer.heading, body: [answer.body] };
        case 'not-validated':
            return { tone: 'change', heading: `Revision ${n} isn't validated yet`, body: ['Nothing was published. Validate revision first; Publish unlocks once it passes.'] };
        default:
            return null;
    }
}

/** The heading for a revision another process or page made live: a rollback, this screen elsewhere, or the command line. */
function someoneHeading(live: RevisionFacts, by: Publisher | null): string {
    if (by?.kind === 'rollback') return `Revision ${live.number} is live again`;
    if (by?.actor === WEB_ACTOR) return `Revision ${live.number} went live from another page`;
    return `Revision ${live.number} went live from the command line`;
}
