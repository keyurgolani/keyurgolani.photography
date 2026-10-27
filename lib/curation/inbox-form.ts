import { REVISION_ID_RE, SERIES_ID_RE } from '../catalog/schema';
import { PHOTO_ID_RE } from '../identity/ids';
import { dataRootStatus, libraryRoot } from '../storage/config';
import { approveEvent, deferEvent, dismissEvent, editEvent, reopenEvent, retryEvent, type ActionInput, type ActionOutcome, type Choices } from './actions';
import { scrub } from './commands';
import { EVENT_ID_RE, type CuratorDescription } from './events';
import { DONE_ANSWER, parsePlacementValue, type InboxActionKind, type InboxActionState } from './inbox-view';
import { MAX_DESCRIPTION_LENGTH, MAX_REASON_LENGTH, ownerText } from './text';

/**
 * The inbox page's forms, read into 14-1's actions (lib/curation/actions.ts)
 * and their answers read back for the page. app/curation/inbox/actions.ts
 * calls runInboxAction() only after requireCurator() lets the request in.
 *
 * Every form carries the event version and the active revision the page
 * showed, and the action compares both under the curation lock, so an item
 * that moved since the page loaded is `stale` and nothing is written.
 *
 * Descriptions: only text the curator typed in the description field, or the
 * decorative flag, reaches an action, and 14-1 stores either as reviewed.
 * Nothing generated is ever read from the form, since no field carries it.
 */

/** Who the web curator acts as. There's no session, so there's no name: the SSH tunnel is the way in (docs/curator.md). */
export const WEB_ACTOR = 'curator:web';

export class InboxFormError extends Error {
    /** The field the refusal is about, so the page shows it beside that field. */
    readonly field: 'description' | 'reason' | undefined;

    constructor(message: string, field?: 'description' | 'reason') {
        super(message);
        this.field = field;
    }
}

const invalid = (message: string, field?: 'description' | 'reason'): never => {
    throw new InboxFormError(message, field);
};

function field(form: FormData, name: string): string | null {
    const value = form.get(name);
    if (value === null) return null;
    if (typeof value !== 'string') return invalid(`${name} must be text.`);
    return value;
}

function text(value: string, label: string, max: number, field: 'description' | 'reason'): string {
    const checked = ownerText(value, { field: label, max });
    if (!checked.ok) invalid(checked.problem, field);
    return (checked as { text: string }).text;
}

/** The fields every item form carries: the event, its version, and the active revision, as the page showed them. */
function itemFields(form: FormData): Pick<ActionInput, 'eventId' | 'expectedVersion' | 'expectedBase'> {
    const eventId = field(form, 'eventId') ?? '';
    if (!EVENT_ID_RE.test(eventId)) invalid('The form names no inbox item. Refresh the inbox.');
    const version = field(form, 'version') ?? '';
    if (!/^[1-9]\d{0,9}$/.test(version)) invalid('The form carries no item version. Refresh the inbox.');
    const base = field(form, 'base') ?? '';
    if (base !== 'none' && !REVISION_ID_RE.test(base)) invalid('The form carries no active revision. Refresh the inbox.');
    return { eventId, expectedVersion: Number(version), expectedBase: base === 'none' ? null : base };
}

/**
 * The curator's choices, from the fields the form sends:
 * - `series`, the series the page shows, every time one is shown, so an
 *   approval stores what the curator saw. `seriesTouched` says they changed
 *   it, which is what Save edits counts.
 * - `placement` only once the curator picks a position, so a suggested
 *   position stays a suggestion as 14-1 resolves it.
 * - `decorative`, `on` or `off` every time, and `descriptionWas`, the kind
 *   of description already saved, so an unchecked box or an emptied field
 *   clears it.
 */
export function choicesFrom(form: FormData, kind: 'approve' | 'edit'): Choices {
    const choices: Choices = {};
    const series = field(form, 'series');
    const countsSeries = kind === 'approve' || field(form, 'seriesTouched') !== null;
    if (series !== null && series !== '' && countsSeries) {
        if (series === 'unassigned') choices.seriesId = null;
        else if (SERIES_ID_RE.test(series)) choices.seriesId = series;
        else invalid('That series is not one the working layer holds. Refresh the inbox.');
    }
    const placement = field(form, 'placement');
    if (placement !== null && placement !== '') {
        const parsed = parsePlacementValue(placement);
        if (parsed === null || (typeof parsed === 'object' && !PHOTO_ID_RE.test(parsed.after))) invalid('That position is not one the series offers. Refresh the inbox.');
        choices.placement = parsed as NonNullable<Choices['placement']>;
    }
    if (choices.seriesId === null && choices.placement !== undefined) delete choices.placement;
    const decorative = field(form, 'decorative') === 'on';
    const description = field(form, 'description') ?? '';
    const saved = field(form, 'descriptionWas') !== null;
    if (decorative) choices.description = { kind: 'decorative' };
    else {
        if (description.trim() === '') {
            // An unchecked box or an emptied field clears what was saved. An approval then places the photo with no description, and #13's gate holds it back.
            if (saved) choices.description = null;
        } else {
            const typed: CuratorDescription = { kind: 'described', text: text(description, 'The description', MAX_DESCRIPTION_LENGTH, 'description') };
            choices.description = typed;
        }
    }
    if (kind === 'edit' && choices.seriesId === undefined && choices.placement === undefined && choices.description === undefined) {
        invalid('Nothing changed, so there is nothing to save.');
    }
    return choices;
}

function reasonFrom(form: FormData, required: boolean): string | undefined {
    const reason = field(form, 'reason');
    if (reason === null || reason.trim() === '') {
        if (required) invalid('Dismissing needs a reason.', 'reason');
        return undefined;
    }
    return text(reason, 'The reason', MAX_REASON_LENGTH, 'reason');
}

const STATUS_FOR: Record<Exclude<ActionOutcome, { ok: true }>['code'], Exclude<InboxActionState, { status: 'idle' }>['status']> = {
    stale: 'stale',
    locked: 'busy',
    'not-found': 'stale',
    refused: 'refused',
    'needs-choice': 'invalid',
    'not-ready': 'failed',
    damaged: 'failed',
};

const DONE: Record<InboxActionKind, string> = {
    approve: DONE_ANSWER.approve,
    edit: 'Saved your edits. Nothing in the draft changed.',
    defer: DONE_ANSWER.defer,
    dismiss: 'Dismissed.',
    retry: 'Asked the watcher to process it again on its next pass.',
    reopen: 'Reopened.',
};

/** 14-1's answers that speak to the CLI, in the page's words. */
const PAGE_WORDING: [RegExp, string][] = [
    [/^Nothing chooses a series/, 'Choose a series, or Leave unassigned, before approving. Nothing was written.'],
    [/^A position needs a series/, 'Choose a series before a position. Nothing was written.'],
    [/^A photograph left unassigned has no position/, 'A photograph left unassigned has no position. Nothing was written.'],
    [/^approve needs --base/, "The page didn't carry the active revision. Refresh the inbox and review it again. Nothing was written."],
    [/^--version takes/, 'The form carries no item version. Refresh the inbox.'],
    [/^edit needs a series/, 'Nothing changed, so there is nothing to save.'],
    [/^dismiss needs a reason/, 'Dismissing needs a reason.'],
];

/** Refusals 14-1 words with IDs, in the page's words. The page already says which item. */
const REFUSAL_WORDING: [RegExp, (match: RegExpMatchArray) => string][] = [
    [/is already in .*an approval doesn't take a photograph out of a series/, () => "This photograph is already in a series, and approving doesn't take it out of one. Keep its series to approve it. Nothing was written."],
    [/can't be read, so nothing shows whether one holds/, () => "A series can't be read, so nothing shows whether one still holds this photograph. Nothing was written."],
    [/^There is no series /, () => "That series isn't in the working layer any more. Refresh the inbox. Nothing was written."],
    [/ is (open|deferred|dismissed|approved|failed), so it can't be ([a-z]+)\./, (match) => `This item is ${match[1]}, so it can't be ${match[2]}. Refresh the inbox.`],
    [/^Nothing failed for /, () => "Nothing failed for this photograph, so there's nothing to retry."],
    [/has no photo ID, so there is nothing to retry/, () => "This file has no photo ID, so there's nothing to retry."],
    [/can't be dismissed/, () => "Something still shows this photograph, so it can't be dismissed. Restore the source, or take it out of its series and publish first. Nothing was written."],
    [/photo record pins /, () => "Its photo record holds other bytes, and confirming new bytes isn't an inbox step yet. Nothing was written."],
];

/** What a refusal says when nothing more specific fits: no internal ID, no flag, no command. */
const FALLBACK: Record<'refused' | 'invalid' | 'failed', string> = {
    refused: "The inbox can't do that with this item as it stands. Nothing was written.",
    invalid: 'That needs another choice first. Nothing was written.',
    failed: "Something in the data root can't be read, so nothing was written. The server log names it.",
};

/** Internal IDs, CLI flags and commands, and the CLI's "show it again". */
const NOT_FOR_THE_PAGE = /\b(evt|ph|rev|ser|act|fp|p)_[0-9a-z]|sha256-|(^|\s)--[a-z]|\bphotos (identity|publish|curation)\b|Show it again/;

/** A refusal in the curator's words: never an internal ID, a CLI flag or command, or CLI phrasing. */
export function pageWording(message: string, status: 'refused' | 'invalid' | 'failed' = 'refused'): string {
    for (const [pattern, wording] of PAGE_WORDING) if (pattern.test(message)) return wording;
    for (const [pattern, wording] of REFUSAL_WORDING) {
        const match = message.match(pattern);
        if (match) return wording(match);
    }
    return NOT_FOR_THE_PAGE.test(message) ? FALLBACK[status] : message;
}

/** A stale answer, by what moved. 14-1's own text names IDs and the CLI, so none of it shows. */
function staleWording(code: 'stale' | 'not-found', message: string): string {
    if (code === 'not-found') return "This item isn't in the inbox any more, so nothing was written. Refresh the inbox.";
    if (/active revision/.test(message)) return 'A publish or rollback happened since the page loaded, so nothing was written. Refresh and review it again.';
    if (/source changed/.test(message)) return "The photograph's source changed since the page loaded, so nothing was written. Refresh and review the newer item.";
    return 'This item changed since the page loaded, so nothing was written. Refresh and review it again.';
}

let serial = 0;

/** Run one inbox action from its form. Never throws for anything the form or the data holds; every answer is a state the page shows, with no host path in it. */
export async function runInboxAction(kind: InboxActionKind, form: unknown, options: { actor?: string; clock?: () => number; waitMs?: number } = {}): Promise<InboxActionState> {
    serial += 1;
    const answer = (status: Exclude<InboxActionState, { status: 'idle' }>['status'], eventId: string | null, message: string, field?: 'description' | 'reason'): InboxActionState => {
        return { status, action: kind, eventId, message: scrub(message, [dataRootStatus().root, libraryRoot()]), ...(field ? { field } : {}), serial };
    };
    if (!(form instanceof FormData)) return answer('invalid', null, 'The form was empty. Refresh the inbox.');
    let input: ActionInput;
    try {
        const item = itemFields(form);
        const status = dataRootStatus({ versioned: true });
        if (status.state !== 'ready' || status.root === null) return answer('failed', item.eventId, `The data root is ${status.state}. Nothing was written.`);
        input = { root: status.root, ...item, actor: options.actor ?? WEB_ACTOR, ...(options.clock ? { clock: options.clock } : {}), ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }) };
    } catch (error) {
        if (error instanceof InboxFormError) return answer('invalid', null, error.message);
        throw error;
    }
    let outcome: ActionOutcome;
    try {
        switch (kind) {
            case 'approve':
                outcome = await approveEvent({ ...input, choices: choicesFrom(form, 'approve'), keepPlaced: true });
                break;
            case 'edit':
                outcome = await editEvent({ ...input, choices: choicesFrom(form, 'edit') });
                break;
            case 'defer':
                outcome = await deferEvent({ ...input, reason: reasonFrom(form, false) });
                break;
            case 'dismiss':
                outcome = await dismissEvent({ ...input, reason: reasonFrom(form, true) as string });
                break;
            case 'retry':
                outcome = await retryEvent({ ...input, reason: reasonFrom(form, false) });
                break;
            case 'reopen':
                outcome = await reopenEvent({ ...input, reason: reasonFrom(form, false) });
                break;
        }
    } catch (error) {
        if (error instanceof InboxFormError) return answer('invalid', input.eventId, error.message, error.field);
        // Storage errors can name a host path, so only the kind of failure shows here. The server log keeps the rest.
        console.error(`[curation] The inbox ${kind} on ${input.eventId} failed:`, error);
        return answer('failed', input.eventId, `The inbox couldn't finish that (${error instanceof Error ? error.name : 'an error'}). Refresh and check the item before trying again.`);
    }
    if (outcome.ok) {
        // An approval's later notes say what still holds publishing back, such as a missing or unreviewed description.
        const extra = kind === 'approve' ? outcome.notes.slice(1) : [];
        return answer('done', outcome.event.id, [DONE[kind], ...extra].join(' '));
    }
    if (outcome.code === 'stale' || outcome.code === 'not-found') return answer('stale', input.eventId, staleWording(outcome.code, outcome.message));
    if (outcome.code === 'locked') return answer('busy', input.eventId, 'Another change is being written right now, so nothing was written. Try again in a moment.');
    const status = STATUS_FOR[outcome.code] as 'refused' | 'invalid' | 'failed';
    // 14-1's own words, IDs and all, stay in the server log.
    if (status === 'failed') console.warn(`[curation] The inbox ${kind} on ${input.eventId} failed: ${scrub(outcome.message, [dataRootStatus().root, libraryRoot()])}`);
    return answer(status, input.eventId, pageWording(outcome.message, status));
}
