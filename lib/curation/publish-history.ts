import type { ChangeSet, RevisionChanges } from '@/lib/catalog/history';
import type { RollbackOutcome } from '@/lib/catalog/rollback';
import type { Activation, Issue } from '@/lib/catalog/types';
import { actorPhrase, dayOf, timeOf } from './publish-facts';

// Times. The server words History, and the browser names its times, in the owner's zone, as 16-3's answers do: a
// time or a day goes into the text as a token, and localize() fills it in where it's rendered.
const TOKEN = /\{\{(day|time):([^}]+)\}\}/g;
export const dayToken = (iso: string) => `{{day:${iso}}}`;
export const timeToken = (iso: string) => `{{time:${iso}}}`;

/** "26 October", from an ISO time, in `timeZone`. */
export function dayIn(iso: string, timeZone = 'UTC'): string {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return iso;
    try {
        return new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'long' }).format(at);
    } catch {
        return dayOf(iso);
    }
}

/**
 * The text with its day and time tokens named in `timeZone`. A time in UTC
 * says so: that's the server's render, before the page knows the browser's
 * zone, and what a page without JavaScript keeps.
 */
export function localize(text: string, timeZone = 'UTC'): string {
    return text.replace(TOKEN, (_, kind: string, iso: string) => (kind === 'time' ? `${timeOf(iso, timeZone)}${timeZone === 'UTC' ? ' UTC' : ''}` : dayIn(iso, timeZone)));
}

/**
 * #15's 15-4: History and restore on the Publish screen. The view the
 * section and its restore dialog render, already in the owner's words, and
 * the pure functions that make it from 15-2's library results:
 * `readHistory()`'s rows, `planRollback()`'s plans and `rollback()`'s
 * outcomes. Client-safe, as publish-facts.ts is: types and pure functions
 * only. app/curation/publish/history-load.ts reads the data root, and
 * ./actions.ts runs the restore. Spec: photography-15-4-spec.md revision 2.
 */

/** 16-3's fixed reason for a publish from the screen, never shown as if the owner wrote it. */
export const SCREEN_REASON = 'Publish screen';

/** Entries a load shows by default, and the most it shows at all. */
export const HISTORY_STEP = 10;
export const HISTORY_CAP = 100;
/** The most planRollback() calls one load makes (spec, Long history: the planning budget). */
export const PLAN_BUDGET = 10;

export const HISTORY_LEAD = 'Every publish and restore, newest first. Restoring one makes it live again as a new entry. Nothing is deleted.';
export const SINGLE_LEAD = 'Revision 1 is the first, and the only one so far. Each publish adds an entry here, and any earlier one can be restored.';
export const LIVE_TEXT = "This is what visitors see, so there's nothing to restore.";
export const UNREADABLE_TEXT = "Its saved copy can't be read, so it can't come back. The server log names what failed.";
export const UNCHECKED_TEXT = "It can't be checked right now, so it can't come back yet. The server log names what failed.";

export type EntryKind = 'Publish' | 'Restore';

export type Eligibility =
    /** The newest entry for a revision that may come back: the one Restore for it. */
    | { type: 'restore'; revision: number }
    /** Past the planning budget: a GET that plans this one revision. */
    | { type: 'check'; revision: number; href: string }
    | { type: 'text'; text: string; tone: 'alert' | 'quiet' }
    | { type: 'none' };

export interface EntryView {
    sequence: number;
    title: string;
    badge?: { text: string; tone: 'done' | 'quiet' };
    kind: EntryKind;
    when: string;
    reason?: { text: string; quoted: boolean };
    from: string;
    held?: string;
    extra?: string;
    facts: string;
    eligibility: Eligibility;
}

export interface ImpactLine {
    text: string;
    /** The names past the first 5, behind "and N more". */
    more?: string[];
}

/** One restorable revision's plan, as the dialog shows it. */
export interface PlanView {
    revisionId: string;
    revision: number;
    hash: string;
    /** The active revision the plan was made against: the dialog's compare-and-swap precondition. */
    activeRevisionId: string;
    active: number;
    activeHash: string;
    impact: ImpactLine[];
    /** "The live revision can't be read, so this lists everything revision 5 publishes." */
    impactNote?: string;
    editorial?: string;
    draftNote?: string;
}

export interface DoneView {
    heading: string;
    body: string[];
    /** The conflicted row a restore left in the draft, for "Go to the change". */
    jump?: { label: string; target: string };
}

export interface HistoryView {
    lead: string;
    entries: EntryView[];
    total: number;
    more: { label: string; href: string } | null;
    /** "Showing the newest 10 of 48 entries." and, past the cap, where the rest are. */
    count: string | null;
    /** Restorable revisions' plans, by revision number. */
    plans: Record<number, PlanView>;
    done?: DoneView;
}

export type ResultAction = 'cancel' | 'close' | 'retry' | 'reload' | 'finish';

export interface RestoreResult {
    tone: 'done' | 'alert' | 'change';
    clock?: boolean;
    heading: string;
    body: string[];
    list?: string[];
    actions: ResultAction[];
    /** The answer found the pointer moved: the dialog's fixed facts follow it (spec, Facts after the answer). */
    moved?: { impact: 'past' | 'hide' };
}

/** `rebased: false`: the working layer was busy, so the draft moves onto the restored revision at the next publish. */
export type RestoreAnswer = { kind: 'restored'; sequence: number; rebased: boolean } | { kind: 'reason-missing' } | { kind: 'result'; result: RestoreResult };

/** What the restore action returns. `serial` grows with every answer, so the dialog moves focus once per answer. */
export interface RestoreState {
    serial: number;
    answer: RestoreAnswer | null;
}

export const RESTORE_IDLE: RestoreState = { serial: 0, answer: null };

// Words.

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const hashOf = (revisionId: string) => revisionId.slice(4, 12);

/**
 * " by you, from this screen" for the web actor, " by you, from the command
 * line" otherwise. The owner is the only one who publishes or restores, so
 * History never names the command's actor (v1.2.1).
 */
export function byPhrase(actor: string): string {
    return ` by you, ${actorPhrase(actor)}`;
}

function counts(set: ChangeSet, noun: string, nouns: string, verbs: { added: string; removed: string; changed: string }, order: ('removed' | 'added' | 'changed')[]): string[] {
    const parts: string[] = [];
    for (const key of order) {
        const n = set[key].length;
        if (n === 0) continue;
        // The noun goes on the first count only: "2 photographs added, 1 removed".
        parts.push(parts.length === 0 ? verbs[key].replace('%', `${n} ${n === 1 ? noun : nouns}`) : verbs[key].replace('%', String(n)));
    }
    return parts;
}

/**
 * Which of the site's two lists changed, Home's featured series and the
 * order of series on Work, read apart from the two revisions, as the dialog
 * reads them. Absent when either revision can't be read.
 */
export interface SiteChange {
    featured: boolean;
    order: boolean;
}

/** The site's part of a change, in a list's or a restore's words. */
function siteWords(changed: boolean, site: SiteChange | undefined, restore: boolean): string[] {
    if (!changed) return [];
    if (!site || (!site.featured && !site.order)) return [restore ? "changed Home's featured series or the order of series on Work" : "Home's featured series or the order of series on Work changed"];
    return [
        ...(site.featured ? [restore ? "changed Home's featured series" : "Home's featured series changed"] : []),
        ...(site.order ? [restore ? 'changed the order of series on Work' : 'the order of series on Work changed'] : []),
    ];
}

/** A publish's change against its parent: "2 photographs added, 1 removed, 1 series changed". Null when nothing differs. */
export function publishWords(changes: RevisionChanges, site?: SiteChange): string | null {
    const verbs = { added: '% added', removed: '% removed', changed: '% changed' };
    const order: ('added' | 'removed' | 'changed')[] = ['added', 'removed', 'changed'];
    const parts = [...counts(changes.photos, 'photograph', 'photographs', verbs, order), ...counts(changes.series, 'series', 'series', verbs, order), ...siteWords(changes.site, site, false)];
    return parts.length ? parts.join(', ') : null;
}

/** A restore's change against the revision it replaced, in the dialog's verbs: "removed 2 photographs, brought back 1, changed 1 series". */
export function restoreWords(changes: RevisionChanges, site?: SiteChange): string | null {
    const verbs = { removed: 'removed %', added: 'brought back %', changed: 'changed %' };
    const order: ('removed' | 'added' | 'changed')[] = ['removed', 'added', 'changed'];
    const parts = [...counts(changes.photos, 'photograph', 'photographs', verbs, order), ...counts(changes.series, 'series', 'series', verbs, order), ...siteWords(changes.site, site, true)];
    return parts.length ? parts.join(', ') : null;
}

// The list.

/** One row of readHistory(), as the page needs it, plus a restore's change against the revision it replaced. */
export interface EntryInput {
    activation: Pick<Activation, 'sequence' | 'kind' | 'status' | 'revisionId' | 'revisionNumber' | 'previousRevisionId' | 'actor' | 'reason' | 'startedAt' | 'committedAt' | 'acceptedRules' | 'lockTakeover'>;
    state: 'committed' | 'interrupted';
    live: boolean;
    summary: { parentRevisionId: string | null; seriesCount: number; photoCount: number; changes: RevisionChanges | null } | null;
    /** A committed restore's change against the revision it replaced; null when one of them can't be read. */
    replaced?: RevisionChanges | null;
    /** For a shown entry whose change touched the site: which of its two lists changed. */
    site?: SiteChange;
}

/** What one planRollback() said about a revision, for its entry. */
export type PlanStatus = { outcome: 'READY' } | { outcome: 'VALIDATION_FAILED'; reasons: string[] } | { outcome: Exclude<RollbackOutcome, 'READY' | 'VALIDATION_FAILED'> };

/**
 * The revisions the shown entries could restore, newest first, each once:
 * committed, readable, not live, and the newest entry for its revision. The
 * page plans the first PLAN_BUDGET of them.
 */
export function restorableRevisions(rows: readonly EntryInput[], shown: number): string[] {
    const newest = [...rows].reverse().slice(0, shown);
    const live = rows.find((row) => row.live)?.activation.revisionId ?? null;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const row of newest) {
        const { revisionId } = row.activation;
        if (row.state !== 'committed' || seen.has(revisionId)) continue;
        seen.add(revisionId);
        if (revisionId === live || row.summary === null) continue;
        out.push(revisionId);
    }
    return out;
}

/** The row reason for a plan that refused: the first problem in owner words, and how many more. */
export function blockedText(reasons: readonly string[]): string {
    if (reasons.length === 0) return "It can't come back as it was.";
    const more = reasons.length > 1 ? `, and ${plural(reasons.length - 1, 'more problem')}` : '';
    return `It can't come back as it was: ${reasons[0]}${more}.`;
}

/**
 * The blocking issues of a refused plan in owner words, one per rule family,
 * in the order the plan listed them: "2 of its photographs no longer have
 * their image files: Tide gauge, Ferry steps".
 */
export function blockingReasons(issues: readonly Pick<Issue, 'code' | 'record'>[], photoName: (photoId: string) => string): string[] {
    const families = new Map<string, Set<string>>();
    for (const issue of issues) {
        const family = issue.code.startsWith('assets.') ? 'assets' : issue.code;
        const ids = families.get(family) ?? new Set<string>();
        if (issue.record.kind === 'photo') ids.add(issue.record.id);
        families.set(family, ids);
    }
    return [...families].map(([family, ids]) => {
        switch (family) {
            case 'assets': {
                const names = [...ids].map(photoName);
                const n = names.length;
                return n ? `${n} of its photographs no longer ${n === 1 ? 'has its' : 'have their'} image files: ${names.slice(0, 5).join(', ')}${n > 5 ? `, and ${n - 5} more` : ''}` : 'its image files are missing';
            }
            case 'privacy.path':
                return 'a description in it names a file on this computer';
            case 'privacy.source-name':
                return 'it shows an original file name';
            case 'privacy.private-key':
                return "it publishes camera or location details today's privacy checks refuse";
            default:
                return `today's checks refuse it (${family})`;
        }
    });
}

export interface HistoryViewInput {
    /** readHistory()'s rows, oldest first. */
    rows: readonly EntryInput[];
    /** How many to show, already clamped to HISTORY_STEP..HISTORY_CAP. */
    shown: number;
    /** The plans made, by revision ID. A restorable revision without one gets Check revision N. */
    planned: ReadonlyMap<string, PlanStatus>;
    plans: Record<number, PlanView>;
    /** Where Check revision N goes, and Show older. */
    hrefs: { check: (revision: number, sequence: number) => string; more: (shown: number, firstNew: number) => string };
    done?: DoneView;
}

function entryOf(row: EntryInput, index: Map<string, EntryInput>, liveRow: EntryInput | undefined, input: HistoryViewInput): EntryView {
    const { activation, state, live, summary } = row;
    const restore = activation.kind === 'rollback';
    const at = activation.committedAt ?? activation.startedAt;
    const numberOf = (revisionId: string | null) => (revisionId === null ? null : index.get(revisionId)?.activation.revisionNumber ?? null);
    const replacedNumber = numberOf(activation.previousRevisionId);
    const replaced = replacedNumber === null ? 'Replaced an earlier revision' : `Replaced revision ${replacedNumber}`;

    if (state === 'interrupted') {
        return {
            sequence: activation.sequence,
            title: restore ? "A restore that didn't finish" : "A publish that didn't finish",
            badge: { text: "Didn't finish", tone: 'quiet' },
            kind: restore ? 'Restore' : 'Publish',
            when: `Started ${dayToken(at)} at ${timeToken(at)}${byPhrase(activation.actor)}.`,
            ...(activation.reason !== SCREEN_REASON ? { reason: { text: activation.reason, quoted: restore } } : {}),
            from: 'It never went live, so visitors never saw it.',
            facts: `Entry ${activation.sequence}`,
            eligibility: { type: 'none' },
        };
    }

    let from: string;
    if (restore) {
        const words = row.replaced ? restoreWords(row.replaced, row.site) : null;
        from = row.replaced === undefined || row.replaced === null ? `${replaced}.` : `${replaced}: ${words ?? 'nothing visitors see changed'}.`;
    } else if (summary === null) {
        from = activation.previousRevisionId === null ? 'The first revision.' : `${replaced}.`;
    } else if (summary.parentRevisionId === null) {
        from = 'The first revision.';
    } else {
        const parent = numberOf(summary.parentRevisionId);
        const lead = parent === null ? 'Replaced an earlier revision' : `Replaced revision ${parent}`;
        from = summary.changes === null ? `${lead}.` : `${lead}: ${publishWords(summary.changes, row.site) ?? 'nothing visitors see changed'}.`;
    }

    const extra = [
        activation.lockTakeover ? 'It took over a lock another command left behind.' : '',
        activation.acceptedRules.length ? `Accepted at restore: ${acceptedWords(activation.acceptedRules)}.` : '',
    ].filter(Boolean).join(' ');

    const eligibility = ((): Eligibility => {
        if (live) return { type: 'text', text: LIVE_TEXT, tone: 'quiet' };
        if (summary === null) return { type: 'text', text: UNREADABLE_TEXT, tone: 'alert' };
        if (liveRow && liveRow.activation.revisionId === activation.revisionId) {
            const day = dayToken(liveRow.activation.committedAt ?? liveRow.activation.startedAt);
            return { type: 'text', text: `Live now: ${liveRow.activation.kind === 'rollback' ? 'restored' : 'published'} on ${day}, above.`, tone: 'quiet' };
        }
        const newest = newestFor(input.rows, activation.revisionId);
        if (newest && newest.activation.sequence !== activation.sequence) {
            return { type: 'text', text: `Restore it from its newest entry, ${dayToken(newest.activation.committedAt ?? newest.activation.startedAt)}, above.`, tone: 'quiet' };
        }
        const plan = input.planned.get(activation.revisionId);
        if (!plan) return { type: 'check', revision: activation.revisionNumber, href: input.hrefs.check(activation.revisionNumber, activation.sequence) };
        if (plan.outcome === 'READY') return { type: 'restore', revision: activation.revisionNumber };
        if (plan.outcome === 'VALIDATION_FAILED') return { type: 'text', text: blockedText(plan.reasons), tone: 'alert' };
        return { type: 'text', text: UNCHECKED_TEXT, tone: 'alert' };
    })();

    return {
        sequence: activation.sequence,
        title: `Revision ${activation.revisionNumber}`,
        ...(live ? { badge: { text: 'Live now', tone: 'done' as const } } : {}),
        kind: restore ? 'Restore' : 'Publish',
        when: `${restore ? 'Restored' : 'Published'} ${dayToken(at)} at ${timeToken(at)}${byPhrase(activation.actor)}.`,
        ...(restore || activation.reason !== SCREEN_REASON ? { reason: { text: activation.reason, quoted: restore } } : {}),
        from,
        ...(summary ? { held: `${plural(summary.seriesCount, 'series', 'series')}, ${plural(summary.photoCount, 'photograph')} in all.` } : {}),
        ...(extra ? { extra } : {}),
        facts: `Entry ${activation.sequence} · ${hashOf(activation.revisionId)}`,
        eligibility,
    };
}

/** The newest committed entry naming a revision. */
function newestFor(rows: readonly EntryInput[], revisionId: string): EntryInput | undefined {
    for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (row.state === 'committed' && row.activation.revisionId === revisionId) return row;
    }
    return undefined;
}

/** History's view: the newest `shown` entries, their eligibility, the count line, and Show older. */
export function historyView(input: HistoryViewInput): HistoryView {
    const { rows, shown } = input;
    const index = new Map<string, EntryInput>();
    for (const row of rows) if (row.state === 'committed' && !index.has(row.activation.revisionId)) index.set(row.activation.revisionId, row);
    const liveRow = rows.find((row) => row.live);
    const newest = [...rows].reverse().slice(0, shown);
    const entries = newest.map((row) => entryOf(row, index, liveRow, input));
    const total = rows.length;
    const rest = total - entries.length;
    let more: HistoryView['more'] = null;
    let count: string | null = null;
    if (rest > 0) {
        count = `Showing the newest ${entries.length} of ${total} entries.`;
        if (entries.length < HISTORY_CAP) {
            const step = Math.min(HISTORY_STEP, rest, HISTORY_CAP - entries.length);
            const firstNew = rows[rows.length - 1 - entries.length].activation.sequence;
            more = { label: step < HISTORY_STEP || step === rest ? (step === 1 ? 'Show the last entry' : `Show the last ${step} entries`) : `Show ${step} older entries`, href: input.hrefs.more(entries.length + step, firstNew) };
        } else {
            count = `${count} photos history lists the rest.`;
        }
    }
    const single = total === 1 && rows[0].live;
    return { lead: single ? SINGLE_LEAD : HISTORY_LEAD, entries, total, more, count, plans: input.plans, ...(input.done ? { done: input.done } : {}) };
}

// The dialog's impact list.

/** Names, the first 5 in the line and the rest behind "and N more". */
function named(prefix: string, names: string[]): ImpactLine {
    const shown = names.slice(0, 5);
    return { text: `${prefix}: ${shown.join(', ')}`, ...(names.length > 5 ? { more: names.slice(5) } : {}) };
}

export interface ImpactInput {
    impact: RevisionChanges;
    /** The live revision can't be read, so everything the target publishes counts as brought back. */
    activeProblem: boolean;
    target: number;
    active: number;
    seriesName: (id: string) => string;
    photoName: (id: string) => string;
    /** The two revisions' featured series and Work order, compared apart. */
    featuredChanged: boolean;
    orderChanged: boolean;
}

/** The impact list: removals, then what comes back, then changes, each with names (spec, The dialog). */
export function impactLines(input: ImpactInput): { lines: ImpactLine[]; note?: string } {
    const { impact, seriesName, photoName } = input;
    const series = (ids: string[]) => ids.map(seriesName);
    const photos = (ids: string[]) => ids.map(photoName);
    if (input.activeProblem) {
        const lines = [
            ...(impact.series.added.length ? [named(`Publishes ${plural(impact.series.added.length, 'series', 'series')}`, series(impact.series.added))] : []),
            ...(impact.photos.added.length ? [named(`Publishes ${plural(impact.photos.added.length, 'photograph')}`, photos(impact.photos.added))] : []),
        ];
        return { lines: lines.length ? lines : [{ text: 'It publishes no series and no photographs.' }], note: `The live revision can't be read, so this lists everything revision ${input.target} publishes.` };
    }
    const lines: ImpactLine[] = [];
    if (impact.series.removed.length) lines.push(named(`Removes ${plural(impact.series.removed.length, 'series', 'series')}`, series(impact.series.removed)));
    if (impact.photos.removed.length) lines.push(named(`Removes ${plural(impact.photos.removed.length, 'photograph')}`, photos(impact.photos.removed)));
    if (impact.series.added.length) lines.push(named(`Brings back ${plural(impact.series.added.length, 'series', 'series')}`, series(impact.series.added)));
    if (impact.photos.added.length) lines.push(named(`Brings back ${plural(impact.photos.added.length, 'photograph')}`, photos(impact.photos.added)));
    if (impact.series.changed.length) lines.push(named(`Changes ${plural(impact.series.changed.length, 'series', 'series')}`, series(impact.series.changed)));
    if (impact.photos.changed.length) lines.push(named(`Changes ${plural(impact.photos.changed.length, 'photograph')}`, photos(impact.photos.changed)));
    if (input.featuredChanged) lines.push({ text: "Changes Home's featured series." });
    if (input.orderChanged) lines.push({ text: 'Changes the order of series on Work.' });
    if (lines.length === 0) lines.push({ text: `Its series and photographs are the same as revision ${input.active}'s.` });
    return { lines };
}

export const draftNoteFor = (target: number) =>
    `Your draft stays, and this screen then compares it against revision ${target}. If a change in it clashes with revision ${target}, Publish stays locked until you settle that change.`;

/** The editorial rules a restore accepted, in the owner's words, with no rule IDs (spec, copy rules). */
const ACCEPTED_WORDS: Record<string, string> = {
    'accent.contrast': "an accent color that's hard to read on the Viewer's dark bands",
    'accent.format': "an accent color the site can't show",
};

export function acceptedWords(codes: readonly string[]): string {
    const words = [...new Set(codes.map((code) => ACCEPTED_WORDS[code] ?? "a style today's checks flag"))];
    return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0];
}

const ACCENT_WORDS: Record<string, string> = {
    'accent.contrast': "accent color: it's hard to read on the Viewer's dark bands",
    'accent.format': "accent color: it isn't a color the site can show",
};

/** The editorial notice: "Today's checks flag Salt Roads' accent color: …". */
export function editorialText(issues: readonly Pick<Issue, 'code' | 'record'>[], editorial: readonly string[], seriesName: (id: string) => string): string | undefined {
    if (editorial.length === 0) return undefined;
    const parts = editorial.map((code) => {
        const records = issues.filter((issue) => issue.code === code && issue.record.kind === 'series').map((issue) => seriesName(issue.record.id));
        const owner = records.length ? `${records.join(' and ')}' ` : 'an ';
        return `${owner}${ACCENT_WORDS[code] ?? `style (${code})`}`;
    });
    return `Today's checks flag ${parts.join('; and ')}.`;
}

// The restore's answers.

export interface OutcomeFacts {
    target: number;
    /** The active revision the dialog was opened against, its number and its ID. */
    active: number;
    activeRevisionId: string;
    /** The pointer read again after the answer, or null when it couldn't be read. */
    pointer: { revisionId: string; number: number | null } | null;
    targetRevisionId: string;
    /** Who made the revision that's live now, and when, for "You published it from the command line at 09:10." */
    liveBy: { actor: string; kind: 'publish' | 'rollback'; at: string } | null;
    holderSince: string | null;
    reasons: string[];
    /** NO_CHANGES settled an interrupted record on the way. */
    settled: boolean;
}

/**
 * Who made the live revision live, in one sentence, the way 16-3's answers
 * say it (publish-facts.ts's publisherLine()), so one fact reads the same
 * everywhere on the screen. The time is a token, named where it's rendered.
 */
export function liveByLine(by: OutcomeFacts['liveBy']): string {
    if (by === null) return 'It is live now.';
    const at = timeToken(by.at);
    return `You ${by.kind === 'rollback' ? 'restored' : 'published'} it ${actorPhrase(by.actor)} at ${at}.`;
}

/** The answer for a pointer that moved off the revision the dialog was opened against. */
function movedResult(facts: OutcomeFacts, why: string): RestoreResult {
    const now = facts.pointer?.number ?? null;
    return {
        tone: 'change',
        heading: now === null ? 'Another revision went live while this was open' : `Revision ${now} went live while this was open`,
        body: [`${facts.liveBy ? `${liveByLine(facts.liveBy)} ` : ''}${why}`],
        actions: ['reload'],
        moved: { impact: 'past' },
    };
}

/** The dialog's answer for each rollback() outcome but ROLLED_BACK, which navigates (spec, Every result). */
export function restoreResult(outcome: RollbackOutcome, facts: OutcomeFacts): RestoreResult {
    const n = facts.target;
    const m = facts.active;
    switch (outcome) {
        case 'ACTIVE_CHANGED':
            return movedResult(facts, 'This page is out of date, so nothing was restored.');
        case 'CATALOG_LOCKED': {
            // The holder can have moved the pointer already: its steps 10 to 12 run while it holds the lock.
            if (facts.pointer && facts.pointer.revisionId !== facts.activeRevisionId) return movedResult(facts, 'Another command is still finishing, and nothing was restored. Load the updated page once it does.');
            const since = facts.holderSince ? `It started at ${timeToken(facts.holderSince)}. ` : '';
            const live = facts.pointer?.number ?? m;
            return { tone: 'change', clock: true, heading: 'Another publish or restore is running', body: [`${since}Nothing changed, and revision ${live} stays live. Restore again once it finishes, usually within a minute.`], actions: ['cancel', 'retry'] };
        }
        case 'VALIDATION_FAILED':
            return {
                tone: 'alert',
                heading: `Revision ${n} can't come back`,
                body: [`Today's checks refuse it, so nothing was restored. Revision ${m} stays live.`],
                ...(facts.reasons.length ? { list: facts.reasons.slice(0, 5).map((reason) => `${capitalised(reason)}.`) } : {}),
                actions: ['close', 'reload'],
            };
        case 'NOT_ELIGIBLE':
            return { tone: 'alert', heading: `Revision ${n} never went live, so it can't come back`, body: ['Nothing was restored. Load the page again for the current list.'], actions: ['close', 'reload'] };
        case 'NOTHING_ACTIVE':
            return { tone: 'alert', heading: 'Nothing is live yet', body: ['There is nothing to restore from. Nothing was restored.'], actions: ['reload'] };
        case 'NO_CHANGES': {
            const body = [`${liveByLine(facts.liveBy)} Nothing more to do.`];
            if (facts.settled) body.push('History now records the restore that was interrupted.');
            return { tone: 'done', heading: `Revision ${n} is already live`, body, actions: ['reload'], moved: { impact: 'hide' } };
        }
        case 'DATA_ROOT_NOT_READY':
            return { tone: 'alert', heading: "The catalog folder isn't ready", body: ['Nothing was restored. The server log names what failed.'], actions: ['close'] };
        case 'CONFIRMATION_REQUIRED':
        case 'DECLINED':
        case 'READY':
        case 'ROLLED_BACK':
        case 'STORAGE_ERROR':
        case 'INTEGRITY_MISMATCH':
        case 'LOCK_LOST':
        default: {
            // Interrupted: the facts say whether the target went live before the stop.
            if (facts.pointer?.revisionId === facts.targetRevisionId) {
                return { tone: 'alert', heading: `Revision ${n} is live, but the restore didn't finish`, body: [`Visitors see revision ${n}. Finish restoring it so History records it.`], actions: ['reload', 'finish'], moved: { impact: 'hide' } };
            }
            const still = facts.pointer?.number ? `Revision ${facts.pointer.number} is still live, and visitors see no change. ` : '';
            return { tone: 'alert', heading: `The restore stopped before revision ${n} went live`, body: [`${still}The server log names what failed. Restore again to retry.`], actions: ['cancel', 'retry'] };
        }
    }
}

/** The done notice the page shows for `?restored=<sequence>`, only for a committed restore that's live. */
export function doneView(row: EntryInput | undefined, replacedNumber: number | null, conflict: { rowId: string; record: string } | null, conflicts: number, rebased = true): DoneView | undefined {
    if (!row || row.state !== 'committed' || !row.live || row.activation.kind !== 'rollback') return undefined;
    const n = row.activation.revisionNumber;
    const body = [`Visitors see it on their next page load.${replacedNumber === null ? '' : ` Revision ${replacedNumber} is kept in History.`}`];
    // The page's `?rebased=0`, which only ever changes this line: the restore itself is read from History.
    if (!rebased) body.push(`Your draft moves onto revision ${n} at the next publish.`);
    if (conflicts > 0) body.push(`${conflicts === 1 ? '1 change in your draft clashes' : `${conflicts} changes in your draft clash`} with revision ${n}.`);
    return {
        heading: `Revision ${n} is live again`,
        body,
        ...(conflict ? { jump: { label: `${conflicts > 1 ? 'Go to the first change' : 'Go to the change'}: ${conflict.record}`, target: `${conflict.rowId}-summary` } } : {}),
    };
}
